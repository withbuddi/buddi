/**
 * The search query builder, without a database.
 *
 * What is asserted here is the *shape* of the statement — which arms exist,
 * which filters bind which parameters, and when the 90-day window appears —
 * because that is the part two callers have to agree on. Whether the rows come
 * back right, and whether the plan actually reaches the trigram indexes, is
 * `tools/search-attachments.db.test.ts`'s job.
 */
import { describe, expect, it } from 'vitest';
import {
  bounded,
  buildSearch,
  isCalendarDate,
  likeNeedle,
  narrows,
  qualify,
  searchColumns,
  toSearchRow,
  validateFilters,
  windowNote,
  DEFAULT_WINDOW_DAYS,
} from './search.js';

const ACCOUNTS = ['11111111-1111-1111-1111-111111111111'];
const THREAD = '22222222-2222-4222-8222-222222222222';
const OPTS = { now: new Date('2026-09-22T12:00:00Z'), timezone: 'Europe/Paris', limit: 20 };

const build = (filters: Parameters<typeof buildSearch>[1]): ReturnType<typeof buildSearch> =>
  buildSearch(ACCOUNTS, filters, OPTS);

describe('narrows', () => {
  it('is false for free text alone and for nothing at all', () => {
    expect(narrows({})).toBe(false);
    expect(narrows({ query: 'invoice' })).toBe(false);
  });

  it('is true for every filter, including the false and empty-looking ones', () => {
    expect(narrows({ from: 'acme.com' })).toBe(true);
    expect(narrows({ since: '2026-01-01' })).toBe(true);
    expect(narrows({ until: '2026-01-01' })).toBe(true);
    expect(narrows({ thread: THREAD })).toBe(true);
    expect(narrows({ direction: 'out' })).toBe(true);
    // The one that is easy to get wrong: "only messages *without* attachments"
    // is a filter, and `!filters.hasAttachments` would have missed it.
    expect(narrows({ hasAttachments: false })).toBe(true);
  });
});

describe('bounded', () => {
  it('counts only the filters that actually put a floor under the scan', () => {
    expect(bounded({ since: '2026-01-01' })).toBe(true);
    expect(bounded({ thread: THREAD })).toBe(true);
    expect(bounded({ from: 'acme.com' })).toBe(true);
  });

  it('does not count a filter that keeps most of the archive', () => {
    // `direction: in` drops maybe a twentieth of a mailbox, `hasAttachments`
    // rather less, and `until` alone *is* the old half of the archive.
    expect(bounded({ direction: 'in' })).toBe(false);
    expect(bounded({ hasAttachments: true })).toBe(false);
    expect(bounded({ until: '2020-01-01' })).toBe(false);
  });
});

describe('likeNeedle', () => {
  it('escapes the LIKE metacharacters so a query cannot widen itself', () => {
    expect(likeNeedle('100%')).toBe('%100\\%%');
    expect(likeNeedle('a_b')).toBe('%a\\_b%');
    expect(likeNeedle('back\\slash')).toBe('%back\\\\slash%');
  });
});

describe('isCalendarDate', () => {
  it('accepts a day and rejects a well-formed non-day', () => {
    expect(isCalendarDate('2026-03-01')).toBe(true);
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-31')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('last march')).toBe(false);
  });
});

describe('validateFilters', () => {
  it('passes the filters a caller is allowed to send', () => {
    expect(validateFilters({ query: 'invoice', from: 'acme.com', since: '2026-03-01' })).toBeNull();
    expect(validateFilters({})).toBeNull();
  });

  it('refuses a date that is not a day, rather than letting it reach the pool', () => {
    expect(validateFilters({ since: '2026-02-31' })).toMatch(/`since` is a real day/);
    expect(validateFilters({ until: 'yesterday' })).toMatch(/`until` is a real day/);
  });

  it('refuses a thread that is not an id', () => {
    expect(validateFilters({ thread: 'x' })).toMatch(/conversation id/);
    expect(validateFilters({ thread: THREAD })).toBeNull();
  });

  it('refuses a one-character query, which is a body scan for one letter', () => {
    expect(validateFilters({ query: 'a' })).toMatch(/at least 2 characters/);
    expect(validateFilters({ query: 'ab' })).toBeNull();
  });

  it('refuses a range that cannot contain anything', () => {
    expect(validateFilters({ since: '2026-03-02', until: '2026-03-01' })).toMatch(/before `since`/);
  });
});

describe('buildSearch', () => {
  it('always scopes to the accounts it was given, first parameter', () => {
    const built = build({ query: 'invoice' });
    expect(built.text).toContain('m.account_id = any($1::uuid[])');
    expect(built.params[0]).toBe(ACCOUNTS);
  });

  it('splits the text search into an indexed arm and a body arm', () => {
    const built = build({ query: 'invoice' });
    // The whole point of the UNION: an OR across an indexed and an unindexed
    // column can never use the indexed ones.
    expect(built.text).toContain('union');
    expect(built.text).toMatch(/m\.subject ilike \$\d+ or m\.from_addr ilike \$\d+/);
    expect(built.text).toContain('m.body_text ilike');
    expect(built.text).not.toMatch(/m\.subject ilike \$\d+ or m\.from_addr ilike \$\d+ or m\.body_text/);
    expect(built.params).toContain('%invoice%');
  });

  it('windows the body arm only, and says so', () => {
    const built = build({ query: 'invoice' });
    expect(built.windowed).toBe(true);
    // 90 days before 2026-09-22.
    expect(built.windowFrom).toBe('2026-06-24');
    expect(windowNote(built.windowFrom as string)).toContain(String(DEFAULT_WINDOW_DAYS));
    // The indexed arm (before `union`) carries no window; the body arm does.
    const [indexed, body] = built.text.split('union') as [string, string];
    expect(indexed).not.toContain('2026-06-24');
    expect(body).toContain(`$${built.params.indexOf('2026-06-24') + 1}`);
  });

  it('keeps the window for filters that narrow without bounding', () => {
    // These used to turn it off, which left an unindexed body scan running
    // over the whole archive one cheap argument away.
    expect(build({ query: 'invoice', direction: 'in' }).windowed).toBe(true);
    expect(build({ query: 'invoice', hasAttachments: true }).windowed).toBe(true);
  });

  it('drops the window only for a filter that bounds the scan', () => {
    expect(build({ query: 'invoice', since: '2020-01-01' }).windowed).toBe(false);
    expect(build({ query: 'invoice', from: 'acme.com' }).windowed).toBe(false);
    expect(build({ query: 'invoice', thread: THREAD }).windowed).toBe(false);
  });

  it('measures the window back from `until` when that is the only date given', () => {
    // `{ until: 2020-01-01 }` asks for the *old* half of the archive; windowing
    // it at "the last 90 days" would return nothing while claiming to look.
    const built = build({ query: 'invoice', until: '2020-01-01' });
    expect(built.windowed).toBe(true);
    expect(built.windowFrom).toBe('2019-10-03');
  });

  it('never windows a search with no text at all, and builds one arm', () => {
    const built = build({ from: 'acme.com' });
    expect(built.windowed).toBe(false);
    expect(built.text).not.toContain('union');
    expect(built.text).not.toContain('body_text');
  });

  it('reads every day boundary in the owner’s timezone', () => {
    const built = build({ since: '2026-03-01', until: '2026-03-31' });
    expect(built.params).toContain('Europe/Paris');
    expect(built.text).toMatch(/at time zone \$\d+/);
    expect(built.text).toContain("interval '1 day'");
  });

  it('binds the timezone only when a day is actually read', () => {
    // A parameter that is sent and never mentioned in the SQL is a "could not
    // determine data type of parameter" from the server, so a search with no
    // date filter must not carry one.
    const built = build({ query: 'invoice', from: 'acme.com' });
    expect(built.params).not.toContain('Europe/Paris');
    expect(built.text).not.toContain('at time zone');
  });

  it('treats a `from` with an @ as one exact address', () => {
    const built = build({ from: 'Billing@Acme.com' });
    expect(built.text).toMatch(/m\.from_addr = \$\d+/);
    expect(built.params).toContain('billing@acme.com');
    expect(built.text).not.toContain('like');
  });

  it('treats a bare `from` as a domain, subdomains included and nothing else', () => {
    const built = build({ from: 'acme.com' });
    expect(built.params.slice(1, 4)).toEqual(['acme.com', '%@acme.com', '%.acme.com']);
  });

  it('orders and filters on the ingest clock, never on the sender’s date header', () => {
    const built = build({ since: '2026-03-01' });
    expect(built.text).toContain('coalesce(m.internal_date, m.fetched_at) >=');
    expect(built.text).toContain('order by at desc nulls last');
  });

  it('selects a hit’s columns and not the whole message row', () => {
    // A hundred hits used to mean a hundred full bodies read out of the table
    // to build a hundred snippets. `body_text` appears in the body arm's
    // predicate and must not appear in what is selected.
    const columns = searchColumns();
    for (const heavy of ['body_text', 'm.attachments', 'flags', 'to_addrs', 'm.cc']) {
      expect(columns).not.toContain(heavy);
    }
    expect(columns).toContain('substring(');
    expect(build({ query: 'invoice' }).text).toContain(columns);
  });

  it('binds the limit last', () => {
    const built = build({ query: 'invoice' });
    expect(built.params[built.params.length - 1]).toBe(OPTS.limit);
  });
});

describe('toSearchRow', () => {
  it('reports the ordering clock as the hit’s date, not the sender’s header', () => {
    const at = new Date('2026-09-18T08:00:00Z');
    const row = toSearchRow({
      id: 'x',
      account_id: 'a',
      thread_id: 't',
      direction: 'out',
      from_addr: 'a@b.test',
      subject: 'S',
      snippet: 'hello',
      has_attachments: true,
      at,
    });
    expect(row.date).toBe(at.toISOString());
    expect(row.direction).toBe('out');
    expect(row.hasAttachments).toBe(true);
  });
});

describe('qualify', () => {
  it('puts the alias on every column', () => {
    expect(qualify('id, account_id, uid', 'm')).toBe('m.id, m.account_id, m.uid');
  });
});
