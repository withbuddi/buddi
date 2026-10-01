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
import { findAction, loadTargets, performAction, undoAction } from './actions.js';
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
  /** The plain server's connections, counted; those listed here fail like a dropped network. */
  let plainConnects = 0;
  let failPlainConnects = new Set<number>();
  let runs: string[] = [];
  let accounts: Record<string, AccountRecord> = {};

  const connect: ImapClientFactory = async (account) => {
    if (refuseLogin === account.address) {
      const err = new Error('Command failed') as Error & { authenticationFailed: boolean; responseText: string };
      err.authenticationFailed = true;
      err.responseText = 'Invalid credentials (Failure)';
      throw err;
    }
    if (account.address === PLAIN) {
      plainConnects += 1;
      if (failPlainConnects.has(plainConnects)) throw new Error('connect ECONNRESET');
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
    plainConnects = 0;
    failPlainConnects = new Set();
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

    it("a learned rule's Undo and put back revokes it and puts back what it moved on arrival, through the trail", async () => {
      // A rule that kept itself, archiving on arrival.
      await setPolicy.execute({ account: PLAIN, scope: 'sender', matcher: 'news@list.test', action: 'ignore', onArrival: 'archive' }, ctx);
      await pool.query(`update email.policies set kept_by = 'auto', auto_reason = 'bulk', kept_at = $1 where matcher = 'news@list.test'`, [NOW]);
      plain.add('INBOX', fakeMessage({ messageId: '<n-1@list.test>', from: 'news@list.test', to: [PLAIN], subject: 'Weekly 1' }));
      plain.add('INBOX', fakeMessage({ messageId: '<n-2@list.test>', from: 'news@list.test', to: [PLAIN], subject: 'Weekly 2' }));
      await poll();
      expect(plain.whereIs('<n-1@list.test>')[0]!.mailbox).toBe('Archive');
      expect(plain.whereIs('<n-2@list.test>')[0]!.mailbox).toBe('Archive');
      const trail = await pool.query(`select id from email.mailbox_actions where policy_id is not null and kind = 'archive'`);
      expect(trail.rows.length).toBeGreaterThan(0);

      // Learned offers the put back.
      const learnedQuery = (manifest.queries ?? []).find((q) => q.name === 'learned_rules')!;
      const learned = (await learnedQuery.produce({}, pageQueryContext(ctx))) as { rules: Array<Record<string, any>> };
      const rule = learned.rules.find((r) => r.title === 'Quieted news@list.test')!;
      expect(rule).toMatchObject({ undoable: true, canPutBack: true });

      const out = await call('email.undo_learned', { id: rule.id, putBack: true }, { agentId: 'owner' });
      expect(out).toMatchObject({ revoked: true, putBack: 2 });
      expect(out.note).toContain('Stopped quieting news@list.test');
      expect(out.note).toContain('Put back 2 messages.');
      expect(plain.whereIs('<n-1@list.test>')).toEqual([expect.objectContaining({ mailbox: 'INBOX' })]);
      expect(plain.whereIs('<n-2@list.test>')).toEqual([expect.objectContaining({ mailbox: 'INBOX' })]);
      for (const id of await idsOf(PLAIN)) expect((await rowOf(id)).folder).toBe('INBOX');
      const { rows: [policy] } = await pool.query(`select revoked_at from email.policies where matcher = 'news@list.test'`);
      expect(policy.revoked_at).not.toBeNull();

      // Learned shows it undone, with nothing left to put back; the next poll moves nothing again.
      const after = (await learnedQuery.produce({}, pageQueryContext(ctx))) as { rules: Array<Record<string, any>> };
      expect(after.rules.find((r) => r.id === rule.id)).toMatchObject({ state: 'undone', undoable: false, canPutBack: false });
      const count = await messageCount();
      await poll();
      expect(await messageCount()).toBe(count);
      expect(plain.whereIs('<n-1@list.test>')[0]!.mailbox).toBe('INBOX');
    });

    it('an on-arrival action whose connection fails is retried on the next poll, once, and gives up after five tries', async () => {
      await setPolicy.execute({ account: PLAIN, scope: 'sender', matcher: 'promo@deals.test', action: 'notify', onArrival: 'archive' }, ctx);
      plain.add('INBOX', fakeMessage({ messageId: '<deal-9@deals.test>', from: 'promo@deals.test', to: [PLAIN], subject: 'Retry me' }));
      // The poll's reader is the next plain connection; the writer after it fails.
      failPlainConnects = new Set([plainConnects + 2]);
      await poll();
      const id = (await idsOf(PLAIN, 'Retry me'))[0]!;
      expect((await rowOf(id)).folder).toBe('INBOX');
      expect(runs).toContain(`triage:${id}`);
      const pending = await pool.query(`select attempts, last_error from email.arrival_pending where message_id = $1`, [id]);
      expect(pending.rows).toEqual([{ attempts: 1, last_error: expect.stringMatching(/ECONNRESET/) }]);

      await poll();
      expect(plain.whereIs('<deal-9@deals.test>')).toEqual([{ mailbox: 'Archive', uid: 1 }]);
      expect((await pool.query(`select 1 from email.arrival_pending`)).rows).toHaveLength(0);
      const trail = await pool.query(`select kind, message_ids from email.mailbox_actions where policy_id is not null`);
      expect(trail.rows).toEqual([{ kind: 'archive', message_ids: [id] }]);
      await poll();
      expect((await pool.query(`select 1 from email.mailbox_actions`)).rows).toHaveLength(1);

      // Bounded: a writer that never connects is tried five times, then left.
      plain.add('INBOX', fakeMessage({ messageId: '<deal-10@deals.test>', from: 'promo@deals.test', to: [PLAIN], subject: 'Never' }));
      const from = plainConnects;
      failPlainConnects = new Set(Array.from({ length: 5 }, (_, i) => from + 2 * (i + 1)));
      for (let i = 0; i < 7; i++) await poll();
      // Five polls of reader + failing writer, then two with the reader alone.
      expect(plainConnects - from).toBe(12);
      const never = (await idsOf(PLAIN, 'Never'))[0]!;
      const left = await pool.query(`select attempts from email.arrival_pending where message_id = $1`, [never]);
      expect(left.rows).toEqual([{ attempts: 5 }]);
      expect((await rowOf(never)).folder).toBe('INBOX');
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

  const changesQuery = async (): Promise<any> =>
    (manifest.queries ?? []).find((q) => q.name === 'mailbox_changes')!.produce({}, pageQueryContext(ctx));
  const uidOf = (server: FakeImapServer, messageId: string): number => server.whereIs(messageId)[0]!.uid;

  describe('mail moved in another mail app', () => {
    const threadQuery = async (messageRowId: string): Promise<any> => {
      const { rows } = await pool.query(`select thread_id from email.messages where id = $1`, [messageRowId]);
      return (manifest.queries ?? []).find((q) => q.name === 'thread')!.produce({ id: String(rows[0].thread_id) }, pageQueryContext(ctx));
    };
    const goneOf = async (id: string): Promise<boolean> =>
      (await pool.query(`select gone_at from email.messages where id = $1`, [id])).rows[0].gone_at !== null;
    it('plain IMAP: archived elsewhere is no longer in the inbox — not counted, not selected, said on the Mail page; an unchanged inbox costs no command', async () => {
      const id = (await idsOf(PLAIN, 'Newsletter 7'))[0]!;
      const unreadBefore = await countInboxUnread(ctx as never, [accounts[PLAIN]!.id]);
      const selectedBefore = (await call('email.select_messages', { account: PLAIN })).count;
      plain.moveElsewhere('INBOX', uidOf(plain, `<news-7@${PLAIN}>`), 'Archive');
      await poll();
      expect(await goneOf(id)).toBe(true);
      expect((await rowOf(id)).folder).toBe('INBOX');
      expect(plain.departureChecks.at(-1)).toMatchObject({ mailbox: 'INBOX', via: 'search' });
      expect(await countInboxUnread(ctx as never, [accounts[PLAIN]!.id])).toBe(unreadBefore - 1);
      expect((await call('email.select_messages', { account: PLAIN })).count).toBe(selectedBefore - 1);
      expect((await call('email.select_messages', { account: PLAIN, folder: 'any' })).ids).not.toContain(id);
      const thread = await threadQuery(id);
      expect(thread.messages.at(-1).summary).toContain('no longer in the inbox');
      const recent = await call('email.list_recent', { account: PLAIN });
      expect(recent.messages.find((m: any) => m.id === id).place).toBe('no longer in the inbox');
      expect((await call('email.list_recent', { account: PLAIN, unreadOnly: true })).messages.map((m: any) => m.id)).not.toContain(id);
      // A change naming it skips it, and says why.
      const out = await approve('email.mark', { ids: [id], state: 'read' });
      expect(out.out.changed).toBe(0);
      expect(out.out.note).toContain('moved or deleted in another mail app');

      // Nothing changed on the server: UIDNEXT and EXISTS say so, no command is sent.
      const checks = plain.departureChecks.length;
      await poll();
      expect(plain.departureChecks.length).toBe(checks);
    });

    it('Gmail: finds where it went — archived to All Mail, trashed, labelled — and a message moved back is the same row, not a second one', async () => {
      const archivedId = (await idsOf(GMAIL, 'Newsletter 1'))[0]!;
      const trashedId = (await idsOf(GMAIL, 'Newsletter 2'))[0]!;
      const labelledId = (await idsOf(GMAIL, 'Dinner?'))[0]!;
      gmail.moveElsewhere('INBOX', uidOf(gmail, `<news-1@${GMAIL}>`), '[Gmail]/All Mail');
      gmail.moveElsewhere('INBOX', uidOf(gmail, `<news-2@${GMAIL}>`), '[Gmail]/Trash');
      const dinner = uidOf(gmail, `<friend@${GMAIL}>`);
      gmail.storeLabels('INBOX', [dinner], ['Receipts'], 'add');
      gmail.storeLabels('INBOX', [dinner], ['\\Inbox'], 'remove');
      const count = await messageCount();
      await poll();

      expect(await rowOf(archivedId)).toMatchObject({ folder: '[Gmail]/All Mail', uid: uidOf(gmail, `<news-1@${GMAIL}>`), uidvalidity: 11 });
      expect((await rowOf(trashedId)).folder).toBe('[Gmail]/Trash');
      expect((await rowOf(labelledId)).folder).toBe('Receipts');
      const labels = async (id: string): Promise<string[]> =>
        (await pool.query(`select labels from email.messages where id = $1`, [id])).rows[0].labels;
      expect((await labels(archivedId)).sort()).toEqual(['Newsletters', '\\Important'].sort());
      expect(await labels(trashedId)).toEqual([]);
      expect(await labels(labelledId)).toEqual(['Receipts']);
      for (const id of [archivedId, trashedId, labelledId]) expect(await goneOf(id)).toBe(false);
      // The Mail page says where each one is now.
      expect((await threadQuery(archivedId)).messages.at(-1).summary).toContain('archived');
      expect((await threadQuery(trashedId)).messages.at(-1).summary).toContain('in Trash');
      expect((await threadQuery(labelledId)).messages.at(-1).summary).toContain('in Receipts');
      // A label is selectable by name.
      expect((await call('email.select_messages', { account: GMAIL, folder: 'Receipts' })).ids).toEqual([labelledId]);
      // Not in the inbox: neither selected there nor counted.
      expect((await call('email.select_messages', { account: GMAIL })).ids).not.toContain(labelledId);

      // Moved back to the inbox in the other app: the row follows; no duplicate, no second triage.
      const runsBefore = runs.length;
      gmail.moveElsewhere('[Gmail]/All Mail', uidOf(gmail, `<news-1@${GMAIL}>`), 'INBOX');
      await poll();
      expect(await messageCount()).toBe(count);
      expect(runs.length).toBe(runsBefore);
      expect(await rowOf(archivedId)).toMatchObject({ folder: 'INBOX', uid: uidOf(gmail, `<news-1@${GMAIL}>`) });
      const thread = await pool.query(`select last_folder_id, last_uid from email.threads t join email.messages m on m.thread_id = t.id where m.id = $1`, [archivedId]);
      expect(Number(thread.rows[0].last_uid)).toBe(uidOf(gmail, `<news-1@${GMAIL}>`));
    });

    it('asks QRESYNC for VANISHED uids where the server offers it', async () => {
      gmail.mailbox('INBOX').condstore = true;
      gmail.mailbox('INBOX').qresync = true;
      // A first pass records the modseq; the next one asks what vanished since.
      gmail.add('INBOX', fakeMessage({ messageId: `<late@${GMAIL}>`, from: 'late@people.test', to: [GMAIL], subject: 'Late' }));
      await poll();
      const id = (await idsOf(GMAIL, 'Newsletter 4'))[0]!;
      gmail.moveElsewhere('INBOX', uidOf(gmail, `<news-4@${GMAIL}>`), '[Gmail]/All Mail');
      await poll();
      expect(gmail.departureChecks.at(-1)).toMatchObject({ via: 'vanished' });
      expect((await rowOf(id)).folder).toBe('[Gmail]/All Mail');
    });

    it('undo leaves a message the owner moved since where he put it, and says so', async () => {
      const [first, second] = (await idsOf(PLAIN)).slice(0, 2);
      const { out } = await approve('email.mark', { ids: [first!, second!], state: 'read' });
      plain.moveElsewhere('INBOX', uidOf(plain, `<news-1@${PLAIN}>`), 'Receipts');
      await poll();
      const recent = await changesQuery();
      expect(recent.changes[0].undoLine).toContain('1 of them has since been moved in another mail app and will stay where it is');
      const undo = await approve('email.undo', { change: out.change.id });
      expect(undo.out.changed).toBe(1);
      expect(undo.out.note).toContain('1 message could not be put back: 1 moved in another mail app since, so left where you put it');
      expect(plain.find('Receipts', uidOf(plain, `<news-1@${PLAIN}>`))?.flags).toContain('\\Seen');
    });
  });

  describe('Gmail labels', () => {
    it('a move to a label adds it and takes Inbox off, keeping every other label; undo restores the labels exactly', async () => {
      const id = (await idsOf(GMAIL, 'Newsletter 5'))[0]!;
      const { out, preview } = await approve('email.move', { ids: [id], folder: 'Receipts' });
      expect(preview).toContain('Receipts');
      const ops = gmail.writes.map((w) => w.op);
      expect(ops).not.toContain('move');
      expect(gmail.writes).toEqual([
        expect.objectContaining({ op: 'store-labels', mailbox: 'INBOX', labels: ['Receipts'], how: 'add' }),
        expect.objectContaining({ op: 'store-labels', mailbox: 'INBOX', labels: ['\\Inbox'], how: 'remove' }),
      ]);
      const [where] = gmail.whereIs(`<news-5@${GMAIL}>`);
      expect(where?.mailbox).toBe('Receipts');
      expect(gmail.find('Receipts', where!.uid)?.labels?.sort()).toEqual(['Newsletters', 'Receipts', '\\Important'].sort());
      expect(await rowOf(id)).toMatchObject({ folder: 'Receipts', uid: where!.uid });
      const trail = await pool.query(`select state, items from email.mailbox_actions where id = $1`, [out.change.id]);
      expect(trail.rows[0].state).toBe('done');
      expect(trail.rows[0].items[0]).toMatchObject({ via: 'labels', status: 'done', prevLabels: ['Newsletters', '\\Important'].sort() });

      // In the meantime the owner adds a label in the web client; undo puts the set back as it was.
      gmail.storeLabels('Receipts', [where!.uid], ['Later'], 'add');
      gmail.writes.length = 0;
      await approve('email.undo', { change: out.change.id });
      expect(gmail.writes.map((w) => w.op)).not.toContain('move');
      const [back] = gmail.whereIs(`<news-5@${GMAIL}>`);
      expect(back?.mailbox).toBe('INBOX');
      expect(gmail.find('INBOX', back!.uid)?.labels?.sort()).toEqual(['Newsletters', '\\Important'].sort());
      expect(await rowOf(id)).toMatchObject({ folder: 'INBOX', uid: back!.uid });
    });

    it('plain IMAP is unchanged: a MOVE', async () => {
      const id = (await idsOf(PLAIN, 'Newsletter 5'))[0]!;
      await approve('email.move', { ids: [id], folder: 'Receipts' });
      expect(plain.writes.map((w) => w.op)).toEqual(['move']);
    });
  });

  describe('undo safety', () => {
    /** A plain client whose MOVE into `folder` reaches the server and then loses its answer. */
    const failingMove = (folder: string): unknown => {
      const real = plain.client();
      return new Proxy(real, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === 'move') {
            return async (from: string, uids: number[], destination: string) => {
              const result = await (value as Function).call(target, from, uids, destination);
              if (destination !== folder) return result;
              throw new Error('Connection not available');
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    /** A plain client whose connection drops after its first MOVE: the next command fails. */
    const droppingAfterMove = (): unknown => {
      const real = plain.client();
      let moved = false;
      return new Proxy(real, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === 'move') {
            return async (...args: unknown[]) => {
              const result = await (value as Function).apply(target, args);
              moved = true;
              return result;
            };
          }
          if (prop === 'open') {
            return async (...args: unknown[]) => {
              if (moved) throw new Error('Connection not available');
              return (value as Function).apply(target, args);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

    it('an undo stopped part-way records what it put back, marks it partial, and the rest can be undone again', async () => {
      const ids = (await idsOf(PLAIN)).slice(0, 2);
      await approve('email.archive', { ids: [ids[0]!] });
      await pool.query('truncate email.mailbox_actions');
      const { out } = await approve('email.trash', { ids: [ids[1]!, ids[0]!] });
      const change = (await findAction(pool, out.change.id))!;
      // One folder's move back works; then the connection drops before the other's.
      await expect(
        undoAction(pool, droppingAfterMove() as never, {
          account: { id: accounts[PLAIN]!.id, address: PLAIN } as AccountRecord,
          action: change,
          provenance: { origin: 'owner', actor: 'owner' },
          now: NOW,
        }),
      ).rejects.toThrow(/Connection not available/);
      const undoRow = (await pool.query(`select state, changed, note, message_ids from email.mailbox_actions where kind = 'undo'`)).rows[0];
      expect(undoRow).toMatchObject({ state: 'partial', changed: 1 });
      expect(undoRow.note).toMatch(/Partial: stopped by an error after 1 message/);
      // ids[0] goes back to Archive, ids[1] to INBOX; whichever went first is back, the other still in Trash.
      const [first] = undoRow.message_ids as string[];
      const home = new Map([[ids[0]!, { mid: `<news-1@${PLAIN}>`, folder: 'Archive' }], [ids[1]!, { mid: `<news-2@${PLAIN}>`, folder: 'INBOX' }]]);
      const rest = ids.find((id) => id !== first)!;
      const original = (await findAction(pool, out.change.id))!;
      expect(original.revertedIds).toEqual([first]);
      expect(original.undoneAt).toBeNull();
      expect(plain.whereIs(home.get(first!)!.mid)[0]?.mailbox).toBe(home.get(first!)!.folder);
      expect(plain.whereIs(home.get(rest)!.mid)[0]?.mailbox).toBe('Trash');
      const recent = await changesQuery();
      const row = recent.changes.find((c: any) => c.id === out.change.id);
      expect(row).toMatchObject({ state: 'partly-undone', undoable: true });
      expect(row.undoLine).toContain('Undo the rest of "Move to Trash" on 1 message');

      // Undo again: only the rest.
      const again = await approve('email.undo', { change: out.change.id });
      expect(again.out.changed).toBe(1);
      expect(plain.whereIs(home.get(rest)!.mid)[0]?.mailbox).toBe(home.get(rest)!.folder);
      const done = (await findAction(pool, out.change.id))!;
      expect(done.revertedIds.sort()).toEqual([...ids].sort());
      expect(done.undoneAt).not.toBeNull();
    });

    it('intent first: a change whose answer never came stays "checking" until the next poll settles it with the server', async () => {
      const ids = (await idsOf(PLAIN)).slice(0, 1);
      await expect(
        performAction(pool, failingMove('Archive') as never, {
          account: { id: accounts[PLAIN]!.id, address: PLAIN } as AccountRecord,
          kind: 'archive',
          targets: await loadTargets(pool, ids),
          provenance: { origin: 'owner', actor: 'owner' },
          now: NOW,
        }),
      ).rejects.toThrow(/Connection not available/);
      const pending = (await pool.query(`select id, state, items from email.mailbox_actions`)).rows;
      expect(pending).toHaveLength(1);
      expect(pending[0].state).toBe('pending');
      expect(pending[0].items[0]).toMatchObject({ status: 'planned', toFolder: 'Archive' });
      const shown = (await changesQuery()).changes[0];
      expect(shown).toMatchObject({ state: 'pending', undoable: false });
      await expect(tool('email.undo').describe({ change: String(pending[0].id) }, ctx)).rejects.toThrow(/has not yet checked/);

      await poll();
      const settled = (await pool.query(`select state, changed, note, items from email.mailbox_actions`)).rows[0];
      expect(settled).toMatchObject({ state: 'done', changed: 1 });
      expect(settled.items[0]).toMatchObject({ status: 'done', toFolder: 'Archive', toUid: uidOf(plain, `<news-1@${PLAIN}>`) });
      expect(settled.note).toContain('buddi stopped while making this change');
      expect((await rowOf(ids[0]!)).folder).toBe('Archive');
      const undo = await approve('email.undo', {});
      expect(undo.out.changed).toBe(1);
      expect(plain.whereIs(`<news-1@${PLAIN}>`)[0]?.mailbox).toBe('INBOX');
    });

    it('after a crash the next poll finalises each planned message from the server: done, never happened, or unknown', async () => {
      const ids = await idsOf(PLAIN);
      const targets = await loadTargets(pool, ids.slice(0, 4));
      // As a process that died mid-change leaves it: pending, every message planned.
      const item = (t: (typeof targets)[number], extra: Record<string, unknown>) => ({
        id: t.id, subject: t.subject, from: t.from, messageId: t.messageId,
        fromFolder: 'INBOX', fromUidValidity: 1, fromUid: t.uid, prevFlags: [], status: 'planned', ...extra,
      });
      // 1: moved before the crash. 2: never moved. 3: gone from both (emptied elsewhere).
      plain.moveElsewhere('INBOX', targets[0]!.uid, 'Archive');
      plain.remove('INBOX', targets[2]!.uid);
      // 4: a read mark that did reach the server.
      plain.setFlags('INBOX', targets[3]!.uid, ['\\Seen']);
      await pool.query(
        `insert into email.mailbox_actions (account_id, kind, destination, origin, actor, message_ids, items, state)
         values ($1, 'archive', 'Archive', 'owner', 'owner', $2::uuid[], $3::jsonb, 'pending'),
                ($1, 'mark-read', null, 'owner', 'owner', $4::uuid[], $5::jsonb, 'pending')`,
        [
          accounts[PLAIN]!.id,
          targets.slice(0, 3).map((t) => t.id),
          JSON.stringify(targets.slice(0, 3).map((t) => item(t, { toFolder: 'Archive', toUidValidity: 0, toUid: null }))),
          [targets[3]!.id],
          JSON.stringify([item(targets[3]!, { wantSeen: true })]),
        ],
      );
      await poll();
      const rows = (await pool.query(`select kind, state, changed, items, message_ids from email.mailbox_actions order by kind`)).rows;
      expect(rows[0]).toMatchObject({ kind: 'archive', state: 'unknown', changed: 1 });
      expect(rows[0].items.map((i: any) => [i.id, i.status])).toEqual([[targets[0]!.id, 'done'], [targets[2]!.id, 'unknown']]);
      expect(rows[1]).toMatchObject({ kind: 'mark-read', state: 'done', changed: 1 });
      expect((await rowOf(targets[0]!.id)).folder).toBe('Archive');
      expect((await rowOf(targets[3]!.id)).flags).toContain('\\Seen');
      const shown = await changesQuery();
      expect(shown.changes.map((c: any) => c.state)).toContain('unknown');
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
