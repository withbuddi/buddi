/**
 * The one "needs you" rule (`needs-you.ts`, migration 023), over postgres.
 *
 * What it holds: each kind of inbound mail gets the reason the rule gives it
 * (a no-reply alert, a newsletter, a known correspondent, a stranger whom
 * triage judged to be asking something, muted, ignored, stale); the Mail
 * page's labels and its "Needs a reply" / "Notifications" views follow from
 * those reasons; and the page, the widget, the watcher and
 * `email.select_messages` count the same conversations.
 */
import type { BuddiHost, CoreSentinelContext, CoreToolContext } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  createPluginHost,
  createPool,
  findingsOf,
  hostBindingOf,
  pageQueryContext,
  runMigrations,
  testDatabaseUrl,
} from '@buddi/core/testing';
import { markAccountSynced, writeGmailAccount } from './config.js';
import { createEmailManifest, manifest } from './index.js';
import { selectMessages } from './mailbox/select.js';
import { isNotificationAddress, type AttentionReason } from './needs-you.js';
import { waitingOnMe } from './sentinels/index.js';
import { attentionReasons, findThread, joinThread, setThreadState } from './threads.js';

function hosted<C>(facts: C): C & { buddi: BuddiHost } {
  const ctx = { ...facts } as C & { buddi: BuddiHost };
  ctx.buddi = createPluginHost(hostBindingOf(manifest), ctx as never);
  return ctx;
}

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_email_needs_you_test_${process.pid}`;
const OWNER = 'owner@example.test';
const NOW = new Date('2026-09-21T12:00:00Z');
const daysBefore = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

suite('needs you: the one rule (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let accountId: string;
  let inbox: string;
  let sent: string;
  let ctx: CoreToolContext & { buddi: BuddiHost };
  const registry = new ToolRegistry();
  const threads: Record<string, string> = {};
  let uid = 1;

  async function write(over: {
    from: string;
    to?: string;
    key: string;
    at: Date;
    direction?: 'in' | 'out';
    bulk?: boolean;
    listId?: string;
  }): Promise<{ messageId: string; threadId: string }> {
    const direction = over.direction ?? 'in';
    const to = over.to ?? OWNER;
    const n = uid++;
    const { rows } = await pool.query(
      `insert into email.messages
         (account_id, folder_id, uidvalidity, uid, message_id, thread_key, from_addr, to_addrs,
          subject, date, internal_date, snippet, body_text, direction, bulk, list_id, triage_enqueued_at, dates_scanned_at)
       values ($1, $2, 1, $3, $4, $5, $6, $7::jsonb, $8, $9, $9, '', '', $10, $11, $12, now(), now())
       returning id`,
      [accountId, direction === 'out' ? sent : inbox, n, `<m${n}@example.test>`, over.key, over.from,
        JSON.stringify([to]), `About ${over.key}`, over.at, direction, over.bulk ?? false, over.listId ?? null],
    );
    const messageId = String(rows[0].id);
    const thread = await joinThread(pool, {
      accountId, threadKey: over.key, messageRowId: messageId, subject: `About ${over.key}`,
      participants: [over.from, to], at: over.at, folderId: direction === 'out' ? sent : inbox,
      uidValidity: 1, uid: n, direction,
    });
    return { messageId, threadId: thread.id };
  }

  async function verdict(messageId: string, category: string, version: number, at: Date): Promise<void> {
    await pool.query(
      `insert into email.triage (message_id, processing_version, category, urgency, summary, decided_at)
       values ($1, $2, $3, 'normal', 'A verdict.', $4)`,
      [messageId, version, category, at],
    );
  }

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [manifest]);
    registry.register(createEmailManifest());
    ctx = hosted({ db: pool, ownerId: 'owner', now: () => NOW, timezone: 'UTC', agentId: 'owner' });

    const account = await writeGmailAccount(pool, OWNER);
    accountId = account!.id;
    inbox = String((await pool.query(`insert into email.folders (account_id, name, kind, synced) values ($1, 'INBOX', 'inbox', true) returning id`, [accountId])).rows[0].id);
    sent = String((await pool.query(`insert into email.folders (account_id, name, kind, synced) values ($1, '[Gmail]/Sent Mail', 'sent', true) returning id`, [accountId])).rows[0].id);
    await markAccountSynced(pool, accountId, NOW);

    // The owner has written to these people before, in older conversations.
    for (const person of ['agent@letting.test', 'tdorothee@client.test', 'friend@club.test', 'old@pal.test', 'alerts@bank.test']) {
      await write({ from: OWNER, to: person, key: `<old-${person}>`, at: daysBefore(60), direction: 'out' });
    }
    // An earlier, answered matter with someone he wrote to: waiting on them now.
    threads.theirs = (await write({ from: OWNER, to: 'agent@letting.test', key: '<theirs>', at: daysBefore(1), direction: 'out' })).threadId;

    threads.known = (await write({ from: 'Agent <agent@letting.test>', key: '<known>', at: daysBefore(1) })).threadId;
    threads.knownOld = (await write({ from: 'tdorothee@client.test', key: '<known-old>', at: daysBefore(3) })).threadId;
    threads.alert = (await write({ from: 'Google <no-reply@accounts.google.com>', key: '<alert>', at: daysBefore(1) })).threadId;
    threads.store = (await write({ from: 'chromewebstore-noreply@google.com', key: '<store>', at: daysBefore(1) })).threadId;
    threads.ci = (await write({ from: 'ci_activity@noreply.github.com', key: '<ci>', at: daysBefore(1) })).threadId;
    threads.newsletter = (await write({ from: 'news@shop.test', key: '<news>', at: daysBefore(1), bulk: true })).threadId;
    threads.list = (await write({ from: 'someone@lists.test', key: '<list>', at: daysBefore(1), listId: 'dev.lists.test' })).threadId;
    // A known sender whose mail carries List-Unsubscribe is still a notification.
    threads.bulkKnown = (await write({ from: 'alerts@bank.test', key: '<bank>', at: daysBefore(1), bulk: true })).threadId;

    // A stranger asking something: the latest verdict says reply-needed.
    const asking = await write({ from: 'newclient@studio.test', key: '<asking>', at: daysBefore(3) });
    threads.asking = asking.threadId;
    await verdict(asking.messageId, 'personal', 1, daysBefore(3));
    await verdict(asking.messageId, 'reply-needed', 2, daysBefore(2));
    // A stranger whose latest verdict took it back: no reply expected.
    const chatty = await write({ from: 'hello@people.test', key: '<chatty>', at: daysBefore(1) });
    threads.stranger = chatty.threadId;
    await verdict(chatty.messageId, 'reply-needed', 1, daysBefore(1));
    await verdict(chatty.messageId, 'personal', 2, NOW);

    threads.muted = (await write({ from: 'friend@club.test', key: '<muted>', at: daysBefore(3) })).threadId;
    await setThreadState(pool, threads.muted, 'muted');
    // Somebody he wrote to, under an ignore rule he kept on their domain.
    await write({ from: OWNER, to: 'rep@vendor.test', key: '<old-vendor>', at: daysBefore(60), direction: 'out' });
    threads.ignored = (await write({ from: 'rep@vendor.test', key: '<ignored>', at: daysBefore(3) })).threadId;
    await pool.query(
      `insert into email.policies (account_id, scope, matcher, action, params, origin, proposed)
       values ($1, 'domain', 'vendor.test', 'ignore', '{}'::jsonb, 'owner', false)`,
      [accountId],
    );
    threads.stale = (await write({ from: 'old@pal.test', key: '<stale>', at: daysBefore(40) })).threadId;
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  const ask = async (name: string, params: Record<string, unknown> = {}): Promise<any> => {
    const query = (createEmailManifest().queries ?? []).find((q) => q.name === name)!;
    return query.produce(query.params.parse(params), pageQueryContext(ctx));
  };
  const nameOf = (id: string): string => Object.entries(threads).find(([, v]) => v === id)?.[0] ?? id;

  it('gives every kind of conversation its reason', async () => {
    const all = await Promise.all(Object.values(threads).map((id) => findThread(pool, id)));
    const reasons = await attentionReasons(pool, all.filter((t) => t !== null), NOW);
    const named = Object.fromEntries([...reasons].map(([id, reason]) => [nameOf(id), reason]));
    expect(named).toEqual({
      theirs: 'waiting-on-them',
      known: 'known',
      knownOld: 'known',
      alert: 'no-reply',
      store: 'no-reply',
      ci: 'no-reply',
      newsletter: 'bulk',
      list: 'bulk',
      bulkKnown: 'bulk',
      asking: 'asked',
      stranger: 'stranger',
      muted: 'muted',
      ignored: 'ignored',
      stale: 'stale',
    } satisfies Record<string, AttentionReason>);
  });

  it('labels the list and the detail by the rule, not by who wrote last', async () => {
    const page = await ask('threads');
    const pills = Object.fromEntries(page.threads.map((t: any) => [nameOf(t.id), t.pill]));
    expect(pills).toMatchObject({
      known: 'needs-you',
      asking: 'needs-you',
      theirs: 'waiting-on-them',
      muted: 'muted',
      // A notification and a message nobody expects an answer to carry no pill.
      alert: '',
      newsletter: '',
      stranger: '',
      ignored: '',
      stale: '',
    });
    expect((await ask('thread', { id: threads.known })).stateLabel).toBe('Waiting on you — you’ve written to them before.');
    expect((await ask('thread', { id: threads.asking })).stateLabel).toBe('Waiting on you — they asked you something.');
    expect((await ask('thread', { id: threads.alert })).stateLabel).toBe('Notification — no reply expected: a no-reply sender.');
    expect((await ask('thread', { id: threads.newsletter })).stateLabel).toBe('Notification — no reply expected: sent to a list.');
    expect((await ask('thread', { id: threads.stranger })).stateLabel).toBe('They wrote — no reply expected: you haven’t written to them before.');
    expect((await ask('thread', { id: threads.theirs })).stateLabel).toBe('Waiting on them — you wrote last.');
  });

  it('filters the list to what needs a reply, and to the notifications', async () => {
    const needs = (await ask('threads', { show: 'needs-reply' })).threads.map((t: any) => nameOf(t.id)).sort();
    expect(needs).toEqual(['asking', 'known', 'knownOld']);
    const notes = (await ask('threads', { show: 'notifications' })).threads.map((t: any) => nameOf(t.id)).sort();
    expect(notes).toEqual(['alert', 'bulkKnown', 'ci', 'list', 'newsletter', 'store']);
    // All is every conversation, the owner's older ones included.
    const every = (await ask('threads', { show: 'all' })).threads.map((t: any) => t.id);
    expect(Object.values(threads).every((id) => every.includes(id))).toBe(true);
  });

  it('counts the same conversations on the page, the widget, the watcher and select_messages', async () => {
    const page = (await ask('threads', { show: 'needs-reply' })).threads.map((t: any) => t.id).sort();
    const widget = await registry.widget('email.waiting')!.produce(ctx, { size: 'small' });
    expect(widget).toMatchObject({ kind: 'stat', value: String(page.length) });

    // The watcher raises the same rule past the owner's setting (2 days).
    const report = await waitingOnMe.run(hosted({ db: pool, ownerId: 'owner', now: () => NOW, timezone: 'UTC', agentForRole: () => undefined } as CoreSentinelContext));
    const raised = findingsOf(report).map((f) => f.key.split(':')[1]!).sort();
    expect(raised).toEqual([threads.asking, threads.knownOld].sort());
    expect(raised.every((id) => page.includes(id))).toBe(true);

    // What an agent is told is waiting: the same three, each saying why.
    const listed = await registry.invoke('email.list_threads', { needsReply: true }, { ...ctx, agentId: 'mail' });
    expect(listed.ok).toBe(true);
    const told = (listed as any).output.threads;
    expect(told.map((t: any) => t.id).sort()).toEqual(page);
    expect(told.find((t: any) => t.id === threads.asking)).toMatchObject({ needsYou: true, shownAs: 'Waiting on you', why: 'they asked you something' });

    const selected = await selectMessages(pool, [{ id: accountId, address: OWNER }], { needsReply: true }, NOW);
    expect(selected.count).toBe(page.length);
    expect(selected.criteria).toBe('messages in conversations waiting on you in the inbox');
  });

  it('reads no-reply senders the same way in SQL and in TypeScript', async () => {
    const cases: Array<[string, boolean]> = [
      ['no-reply@accounts.google.com', true],
      ['Google <noreply@google.com>', true],
      ['chromewebstore-noreply@google.com', true],
      ['ci_activity@noreply.github.com', true],
      ['notifications@github.com', true],
      ['do-not-reply@bank.test', true],
      ['MAILER-DAEMON@mx.test', true],
      ['support@npmjs.com', false],
      ['noreen@family.test', false],
      ['replyguy@social.test', false],
      ['agent@letting.test', false],
    ];
    for (const [address, expected] of cases) {
      const { rows } = await pool.query('select email.is_notification_address($1) as yes', [address]);
      expect([address, rows[0].yes]).toEqual([address, expected]);
      expect([address, isNotificationAddress(address)]).toEqual([address, expected]);
    }
  });

  // Last: it adds conversations the counts above do not expect.
  it('honours a thread ignore rule, by the conversation\'s id, for the sender recorded with it', async () => {
    const reasonOf = async (id: string): Promise<string | undefined> => {
      const thread = await findThread(pool, id);
      return (await attentionReasons(pool, [thread!], NOW)).get(id);
    };
    // A stranger asking something: needs a reply, until the owner ignores the thread.
    const asking = await write({ from: 'pushy@sales.test', key: '<ignored-thread>', at: daysBefore(2) });
    await verdict(asking.messageId, 'reply-needed', 1, daysBefore(2));
    expect(await reasonOf(asking.threadId)).toBe('asked');
    await pool.query(
      `insert into email.policies (account_id, scope, matcher, action, params, origin, proposed)
       values ($1, 'thread', $2, 'ignore', $3::jsonb, 'owner', false)`,
      [accountId, asking.threadId, JSON.stringify({ sender: 'pushy@sales.test' })],
    );
    expect(await reasonOf(asking.threadId)).toBe('ignored');

    // Somebody else's message threaded into it (References are the sender's to
    // write) is not silenced by that rule — the gate's own corroboration.
    const other = await write({ from: 'someone.else@other.test', key: '<ignored-thread>', at: daysBefore(1) });
    expect(other.threadId).toBe(asking.threadId);
    await verdict(other.messageId, 'reply-needed', 1, daysBefore(1));
    expect(await reasonOf(asking.threadId)).toBe('asked');
  });
});
