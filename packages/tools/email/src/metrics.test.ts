/**
 * `email.inbox_unread` and `email.waiting_on_me`, without a database.
 *
 * A fake `db` that answers a regex with rows, the way the tools' own unit
 * tests fake one. What is worth pinning here is not the SQL — the DB suite
 * runs the real statements — but the *answers around* it: which mailboxes are
 * counted, that the number is stamped with the last sync rather than with now,
 * and the three silences that must be `null` instead of a confident zero.
 */
import { describe, expect, it } from 'vitest';
import { emailMetrics, inboxUnread, waitingOnMe } from './metrics.js';
import { createEmailManifest } from './index.js';

const NOW = new Date('2026-09-22T09:00:00Z');
const SYNCED = '2026-09-22T06:30:00.000Z';

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

/**
 * One fake context. Later patterns win nothing: the first that matches the
 * statement answers it, so the more specific ones are listed first.
 */
function ctx(rows: Array<[string, unknown[] | ((params: unknown[]) => unknown[])]>): never {
  const query = async (sql: string, params: unknown[] = []) => {
    for (const [pattern, result] of rows) {
      if (new RegExp(pattern).test(sql)) {
        return { rows: typeof result === 'function' ? result(params) : result };
      }
    }
    return { rows: [] };
  };
  return { db: { query }, ownerId: 'owner', now: () => NOW, timezone: 'UTC' } as never;
}

const ACCOUNTS = [account('a1', 'owner@example.test'), account('a2', 'owner@work.test')];

function mailbox(
  opts: { accounts?: unknown[]; synced?: Array<[string, string]>; unread?: number; waiting?: number } = {},
): never {
  const synced = opts.synced ?? [
    ['a1', SYNCED],
    ['a2', '2026-09-20T10:00:00.000Z'],
  ];
  return ctx([
    ['max\\(fetched_at\\)', synced.map(([id, at]) => ({ account_id: id, last_sync: new Date(at) }))],
    ['count\\(\\*\\)::int as n from email\\.messages', [{ n: opts.unread ?? 0 }]],
    ['from waiting', [{ n: opts.waiting ?? 0 }]],
    ['from email\\.settings', []],
    // Naming one mailbox is a lookup by address, alias or id, and the fake
    // has to answer it the way the table does — or "the account you named"
    // would silently be "the first account there is".
    [
      'or id::text = \\$1',
      (params: unknown[]) =>
        (opts.accounts ?? ACCOUNTS).filter(
          (a) => (a as { address: string; id: string }).address === params[0] || (a as { id: string }).id === params[0],
        ),
    ],
    ['from email\\.accounts', opts.accounts ?? ACCOUNTS],
  ]);
}

describe('the metrics this plugin contributes', () => {
  it('are on the manifest, as counts that should come down', () => {
    expect(createEmailManifest().metrics).toEqual(emailMetrics);
    expect(emailMetrics.map((m) => m.id)).toEqual(['email.inbox_unread', 'email.waiting_on_me']);
    expect(emailMetrics.every((m) => m.unit === 'count' && m.direction === 'down')).toBe(true);
  });
});

describe('email.inbox_unread', () => {
  it('counts every mailbox by default, as of the newest sync', async () => {
    const reading = await inboxUnread.measure({}, mailbox({ unread: 17 }));
    expect(reading?.value).toBe(17);
    expect(reading?.asOf.toISOString()).toBe(SYNCED);
    expect(reading?.note).toBe('across 2 mailboxes');
  });

  it('counts one mailbox when it is named, and says which', async () => {
    const reading = await inboxUnread.measure({ account: 'owner@work.test' }, mailbox({ unread: 4 }));
    expect(reading?.value).toBe(4);
    expect(reading?.note).toBe('owner@work.test');
  });

  it('refuses a mailbox this installation does not have, in the tools\' own words', async () => {
    await expect(inboxUnread.measure({ account: 'someone@else.test' }, mailbox({}))).rejects.toThrow(
      /no mail account here is someone@else\.test/,
    );
  });

  it('is null with no mailbox configured, and null before the first sync', async () => {
    expect(await inboxUnread.measure({}, mailbox({ accounts: [] }))).toBeNull();
    expect(await inboxUnread.measure({}, mailbox({ synced: [], unread: 3 }))).toBeNull();
  });

  it('takes a mailbox and nothing else', () => {
    expect(inboxUnread.params?.safeParse({}).success).toBe(true);
    expect(inboxUnread.params?.safeParse({ account: 'owner@example.test' }).success).toBe(true);
    expect(inboxUnread.params?.strict().safeParse({ unreadOnly: true }).success).toBe(false);
  });
});

describe('email.waiting_on_me', () => {
  it('is the watcher\'s own count, as of the last sync', async () => {
    const reading = await waitingOnMe.measure({}, mailbox({ waiting: 6 }));
    expect(reading?.value).toBe(6);
    expect(reading?.asOf.toISOString()).toBe(SYNCED);
  });

  it('is null with no mailbox, and before the first sync', async () => {
    expect(await waitingOnMe.measure({}, mailbox({ accounts: [] }))).toBeNull();
    expect(await waitingOnMe.measure({}, mailbox({ synced: [], waiting: 2 }))).toBeNull();
  });
});
