/**
 * IMAP IDLE beside the poll (`idle.ts`), against the fake server and a
 * throwaway database. Real timers, with the debounce and backoff shrunk to
 * tens of milliseconds; no socket is opened to any mailbox.
 */
import type { BuddiHost, CoreSourceContext } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPluginHost, createPool, hostBindingOf, runMigrations, testDatabaseUrl } from '@buddi/core/testing';
import { secretNameFor, writeGmailAccount } from '../config.js';
import { FakeImapServer, fakeMessage } from '../imap/fake.js';
import { manifest } from '../index.js';
import { clearLoginFailure } from '../logins.js';
import { accountsQuery } from '../pages/queries.js';
import type { ImapClientFactory } from '../ports.js';
import type { SourceWatch } from '@buddi/core/plugin';
import type { Source } from '../types.js';
import { accountChanged, idleLive } from './idle.js';
import { createInboxPollSource } from './inbox-poll.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_email_idle_test_${process.pid}`;
const OWNER = 'owner@example.test';
const ENV = { [secretNameFor(OWNER)]: 'app-password' };
const DEBOUNCE = 60;
const BACKOFF = 40;

function hosted<C>(facts: C): C & { buddi: BuddiHost } {
  const ctx = { ...facts } as C & { buddi: BuddiHost };
  ctx.buddi = createPluginHost(hostBindingOf(manifest), ctx as never);
  return ctx;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('waitFor: timed out');
    await sleep(10);
  }
}

suite('email IDLE watcher (postgres + fake imap)', () => {
  let admin: Pool;
  let pool: Pool;
  let accountId: string;
  let server: FakeImapServer;
  let logs: string[];
  /** Reader connections open right now, and the most ever open at once. */
  let open: number;
  let maxOpen: number;
  let connects: number;
  let connectDelayMs: number;
  /** Connections from this one on fail like a dropped network. */
  let failFromConnect: number;
  let watch: SourceWatch | null;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [manifest]);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate email.messages, email.folders, email.accounts cascade');
    accountId = (await writeGmailAccount(pool, OWNER)).id;
    server = new FakeImapServer({ INBOX: { uidValidity: 1, messages: [] } });
    server.capabilities = [...server.capabilities, 'IDLE'];
    logs = [];
    open = 0;
    maxOpen = 0;
    connects = 0;
    connectDelayMs = 0;
    failFromConnect = Infinity;
    watch = null;
  });

  afterEach(async () => {
    await watch?.stop();
  });

  /** The reader, counted: a poll is one connection, so two at once is two polls at once. */
  const connect: ImapClientFactory = async () => {
    connects += 1;
    if (connects >= failFromConnect) throw new Error('connect ECONNRESET');
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    if (connectDelayMs > 0) await sleep(connectDelayMs);
    const client = server.client();
    const close = client.close.bind(client);
    client.close = async () => {
      open -= 1;
      await close();
    };
    return client;
  };

  function contextFor(): CoreSourceContext {
    return hosted({
      db: pool,
      now: () => new Date(),
      timezone: 'UTC',
      log: (line: string) => logs.push(line),
      async enqueueRun() {},
    });
  }

  function sourceWith(over: { slowPollSeconds?: number } = {}): Source {
    return createInboxPollSource({
      connect,
      idle: server.idleFactory(),
      env: ENV,
      backfill: 10_000,
      idleTuning: { debounceMs: DEBOUNCE, backoffFirstMs: BACKOFF, backoffMaxMs: 10_000, stableMs: 60_000 },
      ...over,
    });
  }

  async function startWatch(source: Source): Promise<CoreSourceContext> {
    const ctx = contextFor();
    // First contact plants the cursor; after that, new mail is new.
    await source.poll(ctx);
    watch = source.watch!(ctx);
    return ctx;
  }

  async function rows(): Promise<number> {
    const { rows: r } = await pool.query(`select count(*)::int as n from email.messages`);
    return r[0].n;
  }

  it('polls within the debounce when the server says new mail arrived', async () => {
    const source = sourceWith();
    await startWatch(source);
    await waitFor(() => idleLive(accountId));
    const before = connects;
    const started = Date.now();
    server.add('INBOX', fakeMessage({ messageId: '<a@x>' }));
    server.add('INBOX', fakeMessage({ messageId: '<b@x>' }));
    await waitFor(async () => (await rows()) === 2);
    // One poll for the burst, and soon: the debounce plus a poll, not a period.
    expect(connects - before).toBe(1);
    expect(Date.now() - started).toBeLessThan(DEBOUNCE + 1_500);
  });

  it('never runs two polls of one account at once', async () => {
    const source = sourceWith();
    const ctx = await startWatch(source);
    await waitFor(() => idleLive(accountId));
    connectDelayMs = 150;
    server.add('INBOX', fakeMessage({ messageId: '<a@x>' }));
    await sleep(DEBOUNCE + 20);
    // IDLE's poll is running; the scheduled pass skips the account rather than racing it.
    await source.poll(ctx);
    // A change during that poll earns exactly one more after it.
    server.add('INBOX', fakeMessage({ messageId: '<b@x>' }));
    await sleep(DEBOUNCE + 20);
    server.add('INBOX', fakeMessage({ messageId: '<c@x>' }));
    await waitFor(async () => (await rows()) === 3);
    await waitFor(() => open === 0);
    expect(maxOpen).toBe(1);
    expect(logs.some((l) => /being polled already/.test(l))).toBe(true);
  });

  it('a failing follow-up poll (a change during a poll) is logged, never an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const source = sourceWith();
      await startWatch(source);
      await waitFor(() => idleLive(accountId));
      connectDelayMs = 150;
      server.add('INBOX', fakeMessage({ messageId: '<a@x>' }));
      await sleep(DEBOUNCE + 20);
      // IDLE's poll is connecting; this change earns one more poll, which fails.
      failFromConnect = connects + 1;
      server.add('INBOX', fakeMessage({ messageId: '<b@x>' }));
      await waitFor(() => logs.some((l) => /follow-up poll failed: .*ECONNRESET/.test(l)));
      await sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('slows the scheduled poll while IDLE is live, and keeps it while it is not', async () => {
    const source = sourceWith({ slowPollSeconds: 900 });
    const ctx = await startWatch(source);
    await waitFor(() => idleLive(accountId));
    const before = connects;
    await source.poll(ctx);
    expect(connects).toBe(before);
    server.idleUnreachable = true;
    server.dropIdle();
    await waitFor(() => !idleLive(accountId));
    await source.poll(ctx);
    expect(connects).toBe(before + 1);
  });

  it('falls back to polling, quietly, when the server has no IDLE', async () => {
    server.capabilities = server.capabilities.filter((c) => c !== 'IDLE');
    const source = sourceWith();
    const ctx = await startWatch(source);
    await waitFor(() => logs.some((l) => /has no IDLE/.test(l)));
    await sleep(BACKOFF * 4);
    expect(server.idleConnects).toBe(1);
    expect(idleLive(accountId)).toBe(false);
    const before = connects;
    await source.poll(ctx);
    expect(connects).toBe(before + 1);
    const answer = (await accountsQuery().produce({}, ctx as never)) as { accounts: Array<{ arrival: string }> };
    expect(answer.accounts[0]!.arrival).toBe('Checking every 5 min');
  });

  it('reconnects with backoff after a drop, and polls for what came meanwhile', async () => {
    const source = sourceWith();
    await startWatch(source);
    await waitFor(() => idleLive(accountId));
    server.idleUnreachable = true;
    const t0 = Date.now();
    server.dropIdle();
    // While it is down, mail arrives that nobody hears about.
    server.add('INBOX', fakeMessage({ messageId: '<while-down@x>' }));
    await waitFor(() => server.idleConnects >= 3); // first retry after BACKOFF, second after 2x
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(BACKOFF * 3 - 5);
    server.idleUnreachable = false;
    await waitFor(() => idleLive(accountId), 5_000);
    // Back up: the poll runs once and finds it.
    await waitFor(async () => (await rows()) === 1);
    expect(logs.some((l) => /trying again in/.test(l))).toBe(true);
    expect(server.idlers.size).toBe(1);
  });

  it('a refused login records Password needed and stops retrying until the password changes', async () => {
    server.refuseIdleLogin = true;
    const source = sourceWith();
    const ctx = await startWatch(source);
    await waitFor(async () => {
      const { rows: r } = await pool.query(`select login_failed_at from email.accounts where id = $1`, [accountId]);
      return r[0].login_failed_at !== null;
    });
    await sleep(BACKOFF * 5);
    expect(server.idleConnects).toBe(1);
    const answer = (await accountsQuery().produce({}, ctx as never)) as { accounts: Array<{ password: string }> };
    expect(answer.accounts[0]!.password).toBe('Password needed');
    // Set password: the row is cleared and the plugin says so.
    server.refuseIdleLogin = false;
    await clearLoginFailure(pool, accountId);
    accountChanged({ accountId, password: true });
    await waitFor(() => idleLive(accountId));
    expect(server.idleConnects).toBe(2);
  });

  it('stops cleanly: no socket, no timer, no poll after stop', async () => {
    const source = sourceWith();
    await startWatch(source);
    await waitFor(() => idleLive(accountId));
    // A change is waiting on its debounce when stop comes.
    server.add('INBOX', fakeMessage({ messageId: '<late@x>' }));
    const before = connects;
    await watch!.stop();
    watch = null;
    expect(server.idlers.size).toBe(0);
    expect(idleLive(accountId)).toBe(false);
    await sleep(DEBOUNCE * 3);
    expect(connects).toBe(before);
    expect(open).toBe(0);

    // Stopped while waiting to reconnect: the retry never fires.
    const again = sourceWith();
    await startWatch(again);
    await waitFor(() => idleLive(accountId));
    server.idleUnreachable = true;
    server.dropIdle();
    await waitFor(() => logs.some((l) => /trying again in/.test(l)));
    const attempts = server.idleConnects;
    await watch!.stop();
    watch = null;
    await sleep(BACKOFF * 4);
    expect(server.idleConnects).toBe(attempts);
  });

  it('closes the connection when the mailbox is removed, and a mailbox action leaves IDLE alone', async () => {
    server.mailbox('Archive');
    const source = sourceWith();
    const ctx = await startWatch(source);
    await waitFor(() => idleLive(accountId));
    server.add('INBOX', fakeMessage({ messageId: '<a@x>' }));
    await waitFor(async () => (await rows()) === 1);
    // A MOVE over the write port's own connection: IDLE hears the EXPUNGE and stays up.
    const writer = server.client();
    await writer.move('INBOX', [1], 'Archive');
    await writer.close();
    expect(server.idlers.size).toBe(1);
    expect(idleLive(accountId)).toBe(true);
    const answer = (await accountsQuery().produce({}, ctx as never)) as { accounts: Array<{ arrival: string }> };
    expect(answer.accounts[0]!.arrival).toBe('Instant');
    // Let the poll the EXPUNGE asked for finish before the row goes.
    await sleep(DEBOUNCE + 50);
    await waitFor(() => open === 0);

    await pool.query(`delete from email.accounts where id = $1`, [accountId]);
    accountChanged();
    await waitFor(() => server.idlers.size === 0);
    expect(idleLive(accountId)).toBe(false);
  });
  it('notices mail the owner sent from another app while IDLE is live, without a second connection', async () => {
    server.mailboxes.set('Sent', { uidValidity: 2, messages: [], specialUse: '\\Sent' });
    const source = createInboxPollSource({
      connect,
      idle: server.idleFactory(),
      env: ENV,
      backfill: 10_000,
      idleTuning: { debounceMs: DEBOUNCE, backoffFirstMs: BACKOFF, backoffMaxMs: 10_000, stableMs: 60_000, sentCheckMs: 40 },
    });
    await startWatch(source);
    await waitFor(() => idleLive(accountId));
    server.add('INBOX', fakeMessage({ messageId: '<lunch@friend.test>', from: 'friend@friend.test', to: [OWNER], subject: 'Lunch?' }));
    const threadState = async (): Promise<string | null> =>
      ((await pool.query(`select state from email.threads where subject ilike '%lunch%'`)).rows[0]?.state as string | undefined) ?? null;
    await waitFor(async () => (await threadState()) === 'waiting-on-me');
    const idleConnects = server.idleConnects;

    // Answered from the phone: it lands in Sent; INBOX hears nothing.
    server.add('Sent', fakeMessage({
      messageId: '<reply@owner>', from: OWNER, to: ['friend@friend.test'], subject: 'Re: Lunch?',
      inReplyTo: '<lunch@friend.test>', references: ['<lunch@friend.test>'],
      date: new Date('2026-09-13T10:00:00Z'),
    }));
    await waitFor(async () => (await threadState()) === 'waiting-on-them');
    expect(server.sentChecks).toBeGreaterThan(0);
    expect(server.idleConnects).toBe(idleConnects);
    // Once seen, the same Sent message asks for no further polls (one already
    // asked for may still be finishing; after that, quiet).
    await sleep(200);
    const fetches = server.fetches.length;
    await sleep(200);
    expect(server.fetches.length).toBe(fetches);
  });
});
