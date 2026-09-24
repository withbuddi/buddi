/**
 * `email.waiting_on_me`, without a database.
 *
 * A fake `db` that answers a regex with rows, the way the tools' own unit
 * tests fake one. What is worth pinning here is not the SQL — the DB suite
 * runs the real statements — but the answers around it: that the number is
 * stamped with the *stalest* completed poll rather than with now or with the
 * freshest, and the silences that must be `null` instead of a confident zero.
 */
import { describe, expect, it } from 'vitest';
import { emailMetrics, inboxUnread, stalestSync, waitingOnMe } from './metrics.js';
import { createEmailManifest } from './index.js';
import { createPluginHost, hostBindingOf } from '@buddi/core/testing';
import { manifest as emailManifestForHost } from './index.js';

/** The context core hands the email plugin: these facts, with its `ctx.buddi` built over them. */
function hosted<C>(facts: C): C {
  // Built over the context it returns, so a test that changes a field on it
  // afterwards changes what the host reads, as core's per-call host would.
  const ctx = { ...facts } as C & { buddi?: unknown };
  ctx.buddi = createPluginHost(hostBindingOf(emailManifestForHost), ctx as never);
  return ctx;
}

const NOW = new Date('2026-09-22T09:00:00Z');
const FRESH = new Date('2026-09-22T08:55:00Z');
const STALE = new Date('2026-09-20T10:00:00Z');

const account = (id: string, address: string) => ({
  id,
  address,
  imap_host: 'imap.test',
  imap_port: 993,
  smtp_host: 'smtp.test',
  smtp_port: 465,
  auth_mode: 'password',
  secret_name: 'EMAIL_X',
  aliases: [],
  display_name: null,
  enabled: true,
  added_via: 'page',
  folders_discovered_at: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
});

/** One fake context: the first pattern that matches the statement answers it. */
function ctx(rows: Array<[string, unknown[]]>): never {
  const query = async (sql: string) => {
    for (const [pattern, result] of rows) {
      if (new RegExp(pattern).test(sql)) return { rows: result };
    }
    return { rows: [] };
  };
  return hosted({ db: { query }, ownerId: 'owner', now: () => NOW, timezone: 'UTC' } as never);
}

const ACCOUNTS = [account('a1', 'owner@example.test'), account('a2', 'owner@work.test')];

function mailbox(
  opts: {
    accounts?: unknown[];
    synced?: Array<[string, Date | null]>;
    waiting?: number;
    unread?: number;
  } = {},
): never {
  const synced = opts.synced ?? [
    ['a1', FRESH],
    ['a2', STALE],
  ];
  return ctx([
    ['last_synced_at from email\\.accounts', synced.map(([id, at]) => ({ id, last_synced_at: at }))],
    ['from waiting', [{ n: opts.waiting ?? 0 }]],
    ['from email\\.folders', [{ n: opts.unread ?? 0 }]],
    ['from email\\.settings', []],
    ['from email\\.accounts', opts.accounts ?? ACCOUNTS],
  ]);
}

describe('the metrics this plugin contributes', () => {
  it('is two counts that should come down: what waits on you, and what is unread', () => {
    expect(createEmailManifest().metrics).toEqual(emailMetrics);
    expect(emailMetrics.map((m) => m.id)).toEqual(['email.waiting_on_me', 'email.inbox_unread']);
    expect(emailMetrics.every((m) => m.unit === 'count' && m.direction === 'down')).toBe(true);
  });
});

describe('how current the answer is', () => {
  it('is the stalest completed poll, not the newest', async () => {
    expect((await stalestSync(mailbox({}), ['a1', 'a2']))?.toISOString()).toBe(STALE.toISOString());
    expect((await stalestSync(mailbox({}), ['a1']))?.toISOString()).toBe(FRESH.toISOString());
  });

  it('is nothing at all when one of the mailboxes has never finished a poll', async () => {
    expect(await stalestSync(mailbox({ synced: [['a1', FRESH], ['a2', null]] }), ['a1', 'a2'])).toBeNull();
    expect(await stalestSync(mailbox({}), [])).toBeNull();
  });
});

describe('email.waiting_on_me', () => {
  it('is the watcher\'s own count, as of the stalest sync', async () => {
    const reading = await waitingOnMe.measure({}, mailbox({ waiting: 6 }));
    expect(reading?.value).toBe(6);
    expect(reading?.asOf.toISOString()).toBe(STALE.toISOString());
    expect(reading?.note).toContain('2 mailboxes');
  });

  it('answers zero — a mailbox that synced and found nothing waiting is an answer', async () => {
    const reading = await waitingOnMe.measure({}, mailbox({ waiting: 0 }));
    expect(reading?.value).toBe(0);
    expect(reading?.asOf.toISOString()).toBe(STALE.toISOString());
  });

  it('is null with no mailbox, and while one in scope has never synced', async () => {
    expect(await waitingOnMe.measure({}, mailbox({ accounts: [] }))).toBeNull();
    expect(
      await waitingOnMe.measure({}, mailbox({ synced: [['a1', FRESH], ['a2', null]], waiting: 2 })),
    ).toBeNull();
  });

  it('takes no narrowing', () => {
    expect(waitingOnMe.params?.safeParse({}).success).toBe(true);
    expect(waitingOnMe.params?.strict().safeParse({ account: 'owner@work.test' }).success).toBe(false);
  });
});

describe('email.inbox_unread', () => {
  it('is the unread count over every enabled inbox, as of the stalest sync', async () => {
    const reading = await inboxUnread.measure({}, mailbox({ unread: 14 }));
    expect(reading?.value).toBe(14);
    expect(reading?.asOf.toISOString()).toBe(STALE.toISOString());
    expect(reading?.note).toBe('unread across 2 inboxes');
  });

  it('narrows to one mailbox by address, dated by that mailbox\'s own sync', async () => {
    const reading = await inboxUnread.measure(
      { account: 'owner@example.test' },
      mailbox({ accounts: [ACCOUNTS[0]], unread: 3 }),
    );
    expect(reading?.value).toBe(3);
    expect(reading?.asOf.toISOString()).toBe(FRESH.toISOString());
    expect(reading?.note).toBe('unread in owner@example.test');
  });

  it('is null with no mailbox, an unknown one, or one that never synced', async () => {
    expect(await inboxUnread.measure({}, mailbox({ accounts: [] }))).toBeNull();
    expect(await inboxUnread.measure({ account: 'nobody@x.test' }, mailbox({ accounts: [] }))).toBeNull();
    expect(
      await inboxUnread.measure({}, mailbox({ synced: [['a1', FRESH], ['a2', null]], unread: 2 })),
    ).toBeNull();
  });

  it('takes an account and nothing else, and says what it counts for the goal editor', () => {
    expect(inboxUnread.params?.strict().safeParse({ account: 'owner@work.test' }).success).toBe(true);
    expect(inboxUnread.params?.strict().safeParse({}).success).toBe(true);
    expect(inboxUnread.params?.strict().safeParse({ folder: 'INBOX' }).success).toBe(false);
    expect(inboxUnread.description).toMatch(/unread/);
    expect(inboxUnread.description).toContain('2,000');
  });
});
