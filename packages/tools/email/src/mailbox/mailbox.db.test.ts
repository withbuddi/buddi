/**
 * Changing the mailbox, over a throwaway database and two fake IMAP servers:
 * one shaped like Gmail (X-GM-EXT-1, All Mail, labels) and one plain server
 * (SPECIAL-USE Archive and Trash). No socket, no real mailbox.
 *
 * What is proved: each action on both kinds of server; the refusals (no
 * Archive folder, an unknown folder, a server without MOVE); that Trash never
 * expunges; the approval card's count, mailbox, sample and criteria; undo of
 * every kind; a rule acting on arrival, and its undo; buddi's rows following
 * the message so a later poll neither reverts nor duplicates; the tiers; and a
 * refused login recorded and shown as "Password needed".
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BuddiHost, CoreToolContext } from '@buddi/core/testing';
import {
  createPluginHost,
  createPool,
  hostBindingOf,
  pageQueryContext,
  runMigrations,
  testDatabaseUrl,
  ToolRegistry,
} from '@buddi/core/testing';
import { secretNameFor, writeGmailAccount } from '../config.js';
import { FakeImapServer, fakeMessage } from '../imap/fake.js';
import { createEmailManifest, manifest as emailManifestForHost } from '../index.js';
import { countInboxUnread } from '../metrics.js';
import { loadTargets, performAction } from './actions.js';
import type { AccountRecord, ImapClientFactory } from '../ports.js';
import { createInboxPollSource } from '../sources/inbox-poll.js';
import { setPolicy } from '../tools/policies.js';
import type { GatedToolDefinition } from '../types.js';
import type { PluginManifest } from '@buddi/core/plugin';

function hosted<C>(facts: C): C & { buddi: BuddiHost } {
  const ctx = { ...facts } as C & { buddi: BuddiHost };
  ctx.buddi = createPluginHost(hostBindingOf(emailManifestForHost), ctx as never);
  return ctx;
}

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_email_mailbox_test_${process.pid}`;

const GMAIL = 'owner@gmail.test';
const PLAIN = 'owner@plain.test';
const ENV = { [secretNameFor(GMAIL)]: 'gmail-app-password', [secretNameFor(PLAIN)]: 'plain-app-password' };
const NOW = new Date('2026-09-21T12:00:00Z');
const DAY = 86_400_000;

function plainServer(): FakeImapServer {
  return new FakeImapServer({
    INBOX: { uidValidity: 1, messages: [] },
    Sent: { uidValidity: 2, messages: [], specialUse: '\\Sent' },
    Archive: { uidValidity: 3, messages: [], specialUse: '\\Archive' },
    Trash: { uidValidity: 4, messages: [], specialUse: '\\Trash' },
    Receipts: { uidValidity: 5, messages: [] },
  });
}

suite('mailbox actions (postgres, fake IMAP)', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;
  let registry: ToolRegistry;
  let manifest: PluginManifest;
  let ctx: CoreToolContext;
  let gmail: FakeImapServer;
  let plain: FakeImapServer;
  let refuseLogin: string | null = null;
  let runs: string[] = [];
  let accounts: Record<string, AccountRecord> = {};

  const connect: ImapClientFactory = async (account) => {
    if (refuseLogin === account.address) {
      const err = new Error('Command failed') as Error & { authenticationFailed: boolean; responseText: string };
      err.authenticationFailed = true;
      err.responseText = 'Invalid credentials (Failure)';
      throw err;
    }
    return (account.address === GMAIL ? gmail : plain).client();
  };

  const tool = (name: string): GatedToolDefinition<any, any, any> =>
    manifest.tools.find((t) => t.name === name) as GatedToolDefinition<any, any, any>;

  /** Describe, then execute under that approval, as the Executor does. */
  const approve = async (name: string, args: unknown): Promise<{ preview: string; out: any; envelope: any }> => {
    const effect = await tool(name).describe(args, ctx);
    const out = await tool(name).execute(args, { ...ctx, actionId: randomUUID(), approvedEffect: effect });
    return { preview: effect.preview ?? '', out, envelope: effect.envelope };
  };

  const call = async (name: string, args: unknown, over: Partial<CoreToolContext> = {}): Promise<any> => {
    const result = await registry.invoke(name, args, { ...ctx, ...over });
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };

  const poll = async (): Promise<void> => {
    const source = createInboxPollSource({ connect, env: ENV, backfill: 1_000 });
    await source.poll(hosted({
      db: pool,
      now: () => NOW,
      timezone: 'UTC',
      log: () => {},
      enqueueRun: async (run: { dedupKey?: string }) => {
        runs.push(run.dedupKey ?? '');
      },
    }) as never);
  };

  const idsOf = async (address: string, subject?: string): Promise<string[]> => {
    const { rows } = await pool.query(
      `select m.id from email.messages m join email.accounts a on a.id = m.account_id
        where a.address = $1 and ($2::text is null or m.subject = $2) order by m.uid`,
      [address, subject ?? null],
    );
    return rows.map((r: any) => String(r.id));
  };

  const rowOf = async (id: string): Promise<{ folder: string; uid: number; uidvalidity: number; flags: string[] }> => {
    const { rows } = await pool.query(
      `select f.name as folder, m.uid, m.uidvalidity, m.flags from email.messages m join email.folders f on f.id = m.folder_id where m.id = $1`,
      [id],
    );
    return { folder: rows[0].folder, uid: Number(rows[0].uid), uidvalidity: Number(rows[0].uidvalidity), flags: rows[0].flags };
  };

  const messageCount = async (): Promise<number> =>
    Number((await pool.query(`select count(*)::int as n from email.messages`)).rows[0].n);

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-email-mailbox-'));
    process.env.BUDDI_DATA_DIR = dataDir;
    manifest = createEmailManifest({ connect, env: ENV });
    await runMigrations(pool, [manifest]);
    registry = new ToolRegistry();
    registry.register(manifest);
    ctx = hosted({ db: pool, ownerId: 'test', now: () => NOW, timezone: 'UTC', agentId: 'mail-triage' });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    delete process.env.BUDDI_DATA_DIR;
  });

  beforeEach(async () => {
    await pool.query(
      'truncate email.mailbox_actions, email.events, email.policies, email.drafts, email.triage, email.messages, email.folders, email.accounts cascade',
    );
    refuseLogin = null;
    runs = [];
    gmail = FakeImapServer.gmail(['Receipts', 'Newsletters']);
    plain = plainServer();
    for (const [server, owner] of [[gmail, GMAIL], [plain, PLAIN]] as const) {
      for (let i = 1; i <= 7; i++) {
        server.add('INBOX', {
          ...fakeMessage({
            messageId: `<news-${i}@${owner}>`,
            from: 'news@shop.test',
            to: [owner],
            subject: `Newsletter ${i}`,
            date: new Date(NOW.getTime() - (20 - i) * DAY),
          }),
          ...(server === gmail ? { labels: ['Newsletters', '\\Important'] } : {}),
        });
      }
      server.add('INBOX', fakeMessage({
        messageId: `<friend@${owner}>`,
        from: 'friend@people.test',
        to: [owner],
        subject: 'Dinner?',
        date: new Date(NOW.getTime() - DAY),
        flags: ['\\Seen'],
      }));
    }
    await writeGmailAccount(pool, GMAIL);
    await pool.query(
      `insert into email.accounts (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name, added_via)
       values ($1, 'imap.plain.test', 993, 'smtp.plain.test', 465, 'app-password', $2, 'page')`,
      [PLAIN, secretNameFor(PLAIN)],
    );
    await poll();
    const { rows } = await pool.query(`select * from email.accounts`);
    accounts = {};
    for (const r of rows) accounts[r.address] = { id: String(r.id) } as AccountRecord;
  });

  describe('selection', () => {
    it('resolves criteria to ids, with a count, a sample and the criteria in words', async () => {
      const selected = await call('email.select_messages', { account: PLAIN, from: 'shop.test', olderThanDays: 15 });
      // Newsletters 1..5 arrived 19..15 days ago; "older than 15 days" is 1..4.
      expect(selected.count).toBe(4);
      expect(selected.ids).toHaveLength(4);
      expect(selected.sample[0]).toMatchObject({ from: 'news@shop.test', account: PLAIN, folder: 'INBOX' });
      expect(selected.criteria).toBe('messages from shop.test older than 15 days in the inbox');
      const unread = await call('email.select_messages', { account: PLAIN, unread: false });
      expect(unread.count).toBe(1);
      expect(unread.sample[0].subject).toBe('Dinner?');
    });

    it("selects a rule's senders", async () => {
      const effect = await setPolicy.describe({ account: PLAIN, scope: 'sender', matcher: 'news@shop.test', action: 'notify' }, ctx);
      expect(effect.preview).toContain('news@shop.test');
      const out = (await setPolicy.execute({ account: PLAIN, scope: 'sender', matcher: 'news@shop.test', action: 'notify' }, ctx)) as any;
      const selected = await call('email.select_messages', { policy: out.policy.id });
      expect(selected.count).toBe(7);
      expect(selected.criteria).toContain('covered by the rule on sender news@shop.test');
    });
  });

  describe('tiers', () => {
    it('marks, archives, moves and undoes may be remembered; trash never; selection is a read', () => {
      expect(tool('email.select_messages').tier).toBe('auto');
      for (const name of ['email.mark', 'email.archive', 'email.move', 'email.undo']) {
        expect(tool(name)).toMatchObject({ tier: 'gated', reusableApproval: true });
        expect(registry.lookup(name)?.reusableApproval).toBe(true);
      }
      expect(tool('email.trash').tier).toBe('gated');
      expect(tool('email.trash').reusableApproval).toBeFalsy();
      expect(registry.lookup('email.trash')?.reusableApproval).toBeFalsy();
      // The Mail page's Undo is the owner's alone.
      expect(registry.list().map((t) => t.name)).not.toContain('email.undo_change');
    });
  });

  describe('bulk approval', () => {
    it('says the count, the mailbox, the criteria and the first five', async () => {
      const ids = await idsOf(PLAIN);
      const result = await registry.invoke('email.archive', { ids: ids.slice(0, 7), criteria: 'newsletters older than a week' }, ctx);
      expect(result).toMatchObject({ ok: false, reason: 'approval-required' });
      const preview = (result as { preview: string }).preview;
      expect(preview).toContain(`Archive 7 messages in ${PLAIN}.`);
      expect(preview).toContain('Which: newsletters older than a week.');
      expect(preview).toContain('- news@shop.test — Newsletter 1');
      expect(preview).toContain('- news@shop.test — Newsletter 5');
      expect(preview).not.toContain('Newsletter 6');
      expect(preview).toContain('…and 2 more.');
    });

    it('refuses more than 500, and two mailboxes in one call', async () => {
      const ids = Array.from({ length: 501 }, () => randomUUID());
      await expect(tool('email.archive').describe({ ids }, ctx)).rejects.toThrow(/at most 500/);
      const both = [...(await idsOf(PLAIN)).slice(0, 1), ...(await idsOf(GMAIL)).slice(0, 1)];
      await expect(tool('email.archive').describe({ ids: both }, ctx)).rejects.toThrow(/more than one mailbox/);
    });
  });

  describe('mark read / unread', () => {
    for (const address of [GMAIL, PLAIN]) {
      it(`marks on the server and in buddi, survives a poll, and undoes (${address === GMAIL ? 'Gmail' : 'plain'})`, async () => {
        const server = address === GMAIL ? gmail : plain;
        const ids = (await idsOf(address)).slice(0, 3);
        const before = await countInboxUnread(ctx, [accounts[address]!.id]);
        const { out } = await approve('email.mark', { ids, state: 'read' });
        expect(out.changed).toBe(3);
        expect(server.mailbox('INBOX').messages.slice(0, 3).every((m) => m.flags.includes('\\Seen'))).toBe(true);
        expect((await rowOf(ids[0]!)).flags).toContain('\\Seen');
        expect(await countInboxUnread(ctx, [accounts[address]!.id])).toBe(before - 3);

        await poll();
        expect(await countInboxUnread(ctx, [accounts[address]!.id])).toBe(before - 3);

        const undo = await approve('email.undo', { change: out.change.id });
        expect(undo.preview).toContain('they become unread again');
        expect(undo.out.changed).toBe(3);
        expect(server.mailbox('INBOX').messages.slice(0, 3).some((m) => m.flags.includes('\\Seen'))).toBe(false);
        expect(await countInboxUnread(ctx, [accounts[address]!.id])).toBe(before);
        await expect(tool('email.undo').describe({ change: out.change.id }, ctx)).rejects.toThrow(/already undone/);
        await expect(tool('email.undo').describe({ change: undo.out.change.id }, ctx)).rejects.toThrow(/does not undo an undo/);
      });
    }
  });

  describe('archive', () => {
    it('Gmail: leaves the inbox for All Mail with its labels, the row follows, a poll changes nothing, undo comes back without a duplicate', async () => {
      const ids = (await idsOf(GMAIL)).slice(0, 2);
      const before = await countInboxUnread(ctx, [accounts[GMAIL]!.id]);
      const { out, preview } = await approve('email.archive', { ids });
      expect(preview).toContain('the Inbox label comes off');
      expect(out.changed).toBe(2);
      expect(gmail.whereIs(`<news-1@${GMAIL}>`)).toEqual([{ mailbox: '[Gmail]/All Mail', uid: 1 }]);
      expect(gmail.find('[Gmail]/All Mail', 1)?.labels).toEqual(['Newsletters', '\\Important']);
      expect(await rowOf(ids[0]!)).toMatchObject({ folder: '[Gmail]/All Mail', uid: 1, uidvalidity: 11 });
      expect(await countInboxUnread(ctx, [accounts[GMAIL]!.id])).toBe(before - 2);

      const count = await messageCount();
      await poll();
      expect(await messageCount()).toBe(count);
      expect((await rowOf(ids[0]!)).folder).toBe('[Gmail]/All Mail');

      const runsBefore = runs.length;
      await approve('email.undo', {});
      const back = await rowOf(ids[0]!);
      expect(back.folder).toBe('INBOX');
      expect(back.uid).toBeGreaterThan(8);
      expect(gmail.whereIs(`<news-1@${GMAIL}>`)).toEqual([{ mailbox: 'INBOX', uid: back.uid }]);
      // The moved-back message is above the inbox cursor: the poll fetches it,
      // finds its row already there, and neither duplicates it nor triages it.
      await poll();
      expect(await messageCount()).toBe(count);
      expect(runs.length).toBe(runsBefore);
      expect(await countInboxUnread(ctx, [accounts[GMAIL]!.id])).toBe(before);
    });

    it('plain IMAP: moves to the server\'s Archive folder', async () => {
      const ids = (await idsOf(PLAIN)).slice(0, 1);
      await approve('email.archive', { ids });
      expect(plain.whereIs(`<news-1@${PLAIN}>`)).toEqual([{ mailbox: 'Archive', uid: 1 }]);
      expect((await rowOf(ids[0]!)).folder).toBe('Archive');
      // Archived already is not a change.
      const again = await approve('email.archive', { ids });
      expect(again.out).toMatchObject({ changed: 0, change: null });
      expect(again.out.note).toMatch(/already in Archive/);
    });

    it('refuses on a server with no Archive folder, naming the folders there are', async () => {
      plain.mailboxes.delete('Archive');
      const ids = (await idsOf(PLAIN)).slice(0, 1);
      await expect(tool('email.archive').describe({ ids }, ctx)).rejects.toThrow(
        /has no Archive folder .*its folders are: INBOX, Sent, Trash, Receipts/,
      );
      expect(plain.writes).toEqual([]);
    });

    it('refuses on a server without MOVE rather than copying and deleting', async () => {
      plain.capabilities = ['IMAP4REV1', 'UIDPLUS'];
      const ids = (await idsOf(PLAIN)).slice(0, 1);
      await expect(tool('email.archive').describe({ ids }, ctx)).rejects.toThrow(/cannot move messages/);
      expect(plain.writes).toEqual([]);
    });
  });

  describe('move', () => {
    it('refuses an unknown folder with the list, and creates nothing', async () => {
      const ids = (await idsOf(PLAIN)).slice(0, 1);
      await expect(tool('email.move').describe({ ids, folder: 'Bills' }, ctx)).rejects.toThrow(
        /no folder called "Bills", and buddi creates none\. Its folders are: INBOX, Sent, Archive, Trash, Receipts/,
      );
      expect(plain.mailboxes.has('Bills')).toBe(false);
    });

    it('refuses a move into Trash, which would dodge the ask-every-time of email.trash', async () => {
      const ids = (await idsOf(GMAIL)).slice(0, 1);
      await expect(tool('email.move').describe({ ids, folder: '[Gmail]/Trash' }, ctx)).rejects.toThrow(/Use email.trash/);
    });

    it('plain IMAP: moves to a folder named in any case, and undoes', async () => {
      const ids = (await idsOf(PLAIN)).slice(0, 2);
      const { out, envelope } = await approve('email.move', { ids, folder: 'receipts' });
      expect(envelope.destination).toBe('Receipts');
      expect(out.changed).toBe(2);
      expect(plain.mailbox('Receipts').messages).toHaveLength(2);
      expect((await rowOf(ids[1]!)).folder).toBe('Receipts');
      await approve('email.undo', { change: out.change.id });
      expect(plain.mailbox('Receipts').messages).toHaveLength(0);
      expect((await rowOf(ids[1]!)).folder).toBe('INBOX');
    });

    it('Gmail: a label is a folder; moving there takes the Inbox off and the label on', async () => {
      const id = (await idsOf(GMAIL, 'Dinner?'))[0]!;
      await approve('email.move', { ids: [id], folder: 'Receipts' });
      const [where] = gmail.whereIs(`<friend@${GMAIL}>`);
      expect(where?.mailbox).toBe('Receipts');
      expect(gmail.find('Receipts', where!.uid)?.labels).toEqual(['Receipts']);
    });
  });

  describe('trash', () => {
    it('plain IMAP: moves to Trash, never expunges or flags \\Deleted, and undo brings it back', async () => {
      const ids = (await idsOf(PLAIN)).slice(0, 2);
      const { out, preview } = await approve('email.trash', { ids });
      expect(preview).toContain('not deleted');
      expect(preview).toContain('Asked every time');
      expect(plain.mailbox('Trash').messages).toHaveLength(2);
      expect(plain.writes.every((w) => w.op !== 'store' || !w.flags.includes('\\Deleted'))).toBe(true);
      expect(plain.writes.map((w) => w.op)).toEqual(['move']);
      await approve('email.undo', { change: out.change.id });
      expect(plain.mailbox('Trash').messages).toHaveLength(0);
      expect((await rowOf(ids[0]!)).folder).toBe('INBOX');
    });

    it('Gmail: Trash drops the labels; undo puts them back', async () => {
      const id = (await idsOf(GMAIL, 'Newsletter 3'))[0]!;
      await approve('email.trash', { ids: [id] });
      const [inTrash] = gmail.whereIs(`<news-3@${GMAIL}>`);
      expect(inTrash?.mailbox).toBe('[Gmail]/Trash');
      expect(gmail.find('[Gmail]/Trash', inTrash!.uid)?.labels).toEqual([]);
      await approve('email.undo', {});
      const [back] = gmail.whereIs(`<news-3@${GMAIL}>`);
      expect(back?.mailbox).toBe('INBOX');
      expect(gmail.find('INBOX', back!.uid)?.labels?.sort()).toEqual(['Newsletters', '\\Important'].sort());
    });

    it('undo skips what was emptied from Trash and says so', async () => {
      const ids = (await idsOf(PLAIN)).slice(0, 2);
      const { out } = await approve('email.trash', { ids });
      const emptied = (await rowOf(ids[0]!)).uid;
      plain.remove('Trash', emptied);
      const undo = await approve('email.undo', { change: out.change.id });
      expect(undo.out.changed).toBe(1);
      expect(undo.out.note).toMatch(/1 message could not be put back/);
    });
    it('a change that fails part-way keeps what it did on the trail, marked partial, and undo puts it back', async () => {
      const ids = (await idsOf(PLAIN)).slice(0, 2);
      await approve('email.archive', { ids: [ids[0]!] });
      await pool.query('truncate email.mailbox_actions');
      // ids[1] is in INBOX, ids[0] in Archive: two folders, and the second one's connection drops.
      const real = plain.client();
      const dropping = new Proxy(real, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === 'open') {
            return async (folder: string) => {
              if (folder === 'Archive') throw new Error('Connection not available');
              return (value as (f: string) => unknown).call(target, folder);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const targets = await loadTargets(pool, [ids[1]!, ids[0]!]);
      await expect(
        performAction(pool, dropping as never, {
          account: { id: accounts[PLAIN]!.id, address: PLAIN } as AccountRecord,
          kind: 'trash',
          targets,
          provenance: { origin: 'owner', actor: 'owner' },
          now: NOW,
        }),
      ).rejects.toThrow(/Connection not available/);
      expect(plain.whereIs(`<news-2@${PLAIN}>`)).toEqual([{ mailbox: 'Trash', uid: 1 }]);
      const { rows } = await pool.query(`select id, kind, message_ids, changed, note from email.mailbox_actions`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'trash', changed: 1 });
      expect(rows[0].message_ids).toEqual([ids[1]]);
      expect(rows[0].note).toMatch(/Partial: stopped by an error after 1 message: Connection not available/);
      expect((await rowOf(ids[1]!)).folder).toBe('Trash');

      const undo = await approve('email.undo', { change: String(rows[0].id) });
      expect(undo.out.changed).toBe(1);
      expect(plain.whereIs(`<news-2@${PLAIN}>`)[0]?.mailbox).toBe('INBOX');
    });

    it('a move whose landing lookup fails still records the move and points the row at the destination', async () => {
      const ids = (await idsOf(PLAIN)).slice(0, 1);
      const real = plain.client();
      let moved = false;
      const dropping = new Proxy(real, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === 'move') {
            return async (...args: unknown[]) => {
              await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
              moved = true;
              return { uidValidity: null, uidMap: new Map() };
            };
          }
          if (prop === 'open' || prop === 'findByMessageId') {
            return async (...args: unknown[]) => {
              if (moved) throw new Error('Socket closed');
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await expect(
        performAction(pool, dropping as never, {
          account: { id: accounts[PLAIN]!.id, address: PLAIN } as AccountRecord,
          kind: 'trash',
          targets: await loadTargets(pool, ids),
          provenance: { origin: 'owner', actor: 'owner' },
          now: NOW,
        }),
      ).rejects.toThrow(/Socket closed/);
      const { rows } = await pool.query(`select id, message_ids, items, note from email.mailbox_actions`);
      expect(rows).toHaveLength(1);
      expect(rows[0].message_ids).toEqual(ids);
      expect(rows[0].items[0]).toMatchObject({ toFolder: 'Trash' });
      expect(rows[0].note).toMatch(/Partial/);
      expect(await rowOf(ids[0]!)).toMatchObject({ folder: 'Trash', uidvalidity: 0 });
      // Undo finds it by Message-ID.
      const undo = await approve('email.undo', { change: String(rows[0].id) });
      expect(undo.out.changed).toBe(1);
      expect(plain.whereIs(`<news-1@${PLAIN}>`)[0]?.mailbox).toBe('INBOX');
    });
  });

  describe('rules on arrival', () => {
    it('archives a matching new message as it arrives, on the trail, and the owner undoes it from the Mail page', async () => {
      const args = { account: PLAIN, scope: 'sender', matcher: 'promo@deals.test', action: 'ignore', onArrival: 'archive' } as const;
      const effect = await setPolicy.describe(args, ctx);
      expect(effect.preview).toContain('When one arrives, buddi will also archive it in your mailbox');
      await setPolicy.execute(args, ctx);

      plain.add('INBOX', fakeMessage({ messageId: '<deal-1@deals.test>', from: 'promo@deals.test', to: [PLAIN], subject: '50% off' }));
      await poll();
      const id = (await idsOf(PLAIN, '50% off'))[0]!;
      expect(plain.whereIs('<deal-1@deals.test>')).toEqual([{ mailbox: 'Archive', uid: 1 }]);
      expect((await rowOf(id)).folder).toBe('Archive');
      const { rows } = await pool.query(`select origin, actor, policy_id, kind from email.mailbox_actions`);
      expect(rows).toEqual([expect.objectContaining({ origin: 'policy', actor: 'rule sender promo@deals.test', kind: 'archive' })]);
      expect(rows[0].policy_id).not.toBeNull();

      // The policy card says it.
      const manifestQueries = manifest.queries ?? [];
      const policies = await manifestQueries.find((q) => q.name === 'policies')!.produce({}, pageQueryContext(ctx));
      expect(JSON.stringify(policies)).toContain('on arrival: archive it in your mailbox');

      // Recent changes, and the owner's Undo.
      const changes = (await manifestQueries.find((q) => q.name === 'mailbox_changes')!.produce({}, pageQueryContext(ctx))) as any;
      expect(changes.changes[0]).toMatchObject({ title: 'Archive · 1 message', undoable: true });
      expect(changes.changes[0].line).toContain('by rule sender promo@deals.test');
      const undone = await call('email.undo_change', { id: changes.changes[0].id }, { agentId: 'owner' });
      expect(undone.changed).toBe(1);
      expect((await rowOf(id)).folder).toBe('INBOX');

      // The next poll neither archives it again nor ingests it twice.
      const count = await messageCount();
      await poll();
      expect(await messageCount()).toBe(count);
      expect((await rowOf(id)).folder).toBe('INBOX');
      const after = (await manifestQueries.find((q) => q.name === 'mailbox_changes')!.produce({}, pageQueryContext(ctx))) as any;
      expect(after.changes.map((c: any) => c.state)).toEqual(['undo', 'undone']);
    });

    it('marks read on arrival, and a rule moving to an unknown folder is refused when set', async () => {
      await setPolicy.execute({ account: GMAIL, scope: 'domain', matcher: 'deals.test', action: 'wake', onArrival: 'mark-read' }, ctx);
      gmail.add('INBOX', fakeMessage({ messageId: '<deal-2@deals.test>', from: 'promo@deals.test', to: [GMAIL], subject: 'Flash sale' }));
      await poll();
      const id = (await idsOf(GMAIL, 'Flash sale'))[0]!;
      expect((await rowOf(id)).flags).toContain('\\Seen');
      const [where] = gmail.whereIs('<deal-2@deals.test>');
      expect(gmail.find(where!.mailbox, where!.uid)?.flags).toContain('\\Seen');

      await expect(
        setPolicy.describe({ account: GMAIL, scope: 'sender', matcher: 'a@b.test', action: 'wake', onArrival: 'move', folder: 'Nowhere' }, ctx),
      ).rejects.toThrow(/no folder called "Nowhere"/);
    });
  });

  describe('failed logins', () => {
    it('records a refused password and shows "Password needed" until a login works', async () => {
      const accountsQuery = (manifest.queries ?? []).find((q) => q.name === 'accounts')!;
      refuseLogin = PLAIN;
      await expect(poll()).rejects.toThrow();
      const { rows } = await pool.query(`select login_failed_at, login_error from email.accounts where address = $1`, [PLAIN]);
      expect(rows[0].login_failed_at).not.toBeNull();
      expect(rows[0].login_error).toBe('Invalid credentials (Failure)');
      const shown = (await accountsQuery.produce({}, pageQueryContext(ctx))) as any;
      expect(shown.accounts.find((a: any) => a.address === PLAIN)).toMatchObject({
        password: 'Password needed',
        passwordNeeded: true,
        loginRefused: 'Invalid credentials (Failure)',
      });
      expect(shown.accounts.find((a: any) => a.address === GMAIL).loginRefused).toBeNull();

      // A mailbox action's login is recorded the same way.
      const ids = (await idsOf(PLAIN)).slice(0, 1);
      await expect(approve('email.mark', { ids, state: 'read' })).rejects.toThrow(/refused its stored password/);

      refuseLogin = null;
      await poll();
      const again = (await accountsQuery.produce({}, pageQueryContext(ctx))) as any;
      expect(again.accounts.find((a: any) => a.address === PLAIN).loginRefused).toBeNull();
      const { rows: cleared } = await pool.query(`select login_failed_at from email.accounts where address = $1`, [PLAIN]);
      expect(cleared[0].login_failed_at).toBeNull();
    });
  });
});
