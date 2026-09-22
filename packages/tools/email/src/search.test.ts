/**
 * The search query builder, without a database.
 *
 * What is asserted here is the *shape* of the clause — which filters narrow,
 * which parameters they bind, and when the 90-day window appears — because
 * that is the part two callers have to agree on. Whether the rows come back
 * right is `search.db.test.ts`'s job.
 */
import { describe, expect, it } from 'vitest';
import { buildSearch, likeNeedle, narrows, qualify, windowNote, DEFAULT_WINDOW_DAYS } from './search.js';

const ACCOUNTS = ['11111111-1111-1111-1111-111111111111'];
const NOW = new Date('2026-09-22T12:00:00Z');

describe('narrows', () => {
  it('is false for free text alone and for nothing at all', () => {
    expect(narrows({})).toBe(false);
    expect(narrows({ query: 'invoice' })).toBe(false);
  });

  it('is true for every filter, including the false and empty-looking ones', () => {
    expect(narrows({ from: 'acme.com' })).toBe(true);
    expect(narrows({ since: '2026-01-01' })).toBe(true);
    expect(narrows({ until: '2026-01-01' })).toBe(true);
    expect(narrows({ thread: 'abc' })).toBe(true);
    expect(narrows({ direction: 'out' })).toBe(true);
    // The one that is easy to get wrong: "only messages *without* attachments"
    // is a filter, and `!filters.hasAttachments` would have missed it.
    expect(narrows({ hasAttachments: false })).toBe(true);
  });
});

describe('likeNeedle', () => {
  it('escapes the LIKE metacharacters so a query cannot widen itself', () => {
    expect(likeNeedle('100%')).toBe('%100\\%%');
    expect(likeNeedle('a_b')).toBe('%a\\_b%');
    expect(likeNeedle('back\\slash')).toBe('%back\\\\slash%');
  });
});

describe('buildSearch', () => {
  it('always scopes to the accounts it was given, first parameter', () => {
    const built = buildSearch(ACCOUNTS, { query: 'invoice' }, NOW);
    expect(built.where).toContain('m.account_id = any($1::uuid[])');
    expect(built.params[0]).toBe(ACCOUNTS);
  });

  it('matches subject, sender and body on one needle', () => {
    const built = buildSearch(ACCOUNTS, { query: 'invoice' }, NOW);
    expect(built.where).toContain('m.subject ilike $2');
    expect(built.where).toContain('m.from_addr ilike $2');
    expect(built.where).toContain('m.body_text ilike $2');
    expect(built.params[1]).toBe('%invoice%');
  });

  it('windows an unnarrowed text search to the last 90 days, and says so', () => {
    const built = buildSearch(ACCOUNTS, { query: 'invoice' }, NOW);
    expect(built.windowed).toBe(true);
    expect(built.windowFrom?.toISOString().slice(0, 10)).toBe('2026-06-24');
    expect(windowNote(built.windowFrom as Date)).toContain(String(DEFAULT_WINDOW_DAYS));
  });

  it('drops the window as soon as anything else narrows the search', () => {
    for (const filters of [
      { query: 'invoice', from: 'acme.com' },
      { query: 'invoice', since: '2020-01-01' },
      { query: 'invoice', hasAttachments: true },
      { query: 'invoice', direction: 'out' as const },
    ]) {
      expect(buildSearch(ACCOUNTS, filters, NOW).windowed).toBe(false);
    }
  });

  it('never windows a search with no text at all', () => {
    const built = buildSearch(ACCOUNTS, { from: 'acme.com' }, NOW);
    expect(built.windowed).toBe(false);
  });

  it('treats a `from` with an @ as one exact address', () => {
    const built = buildSearch(ACCOUNTS, { from: 'Billing@Acme.com' }, NOW);
    expect(built.where).toContain('m.from_addr = $2');
    expect(built.params[1]).toBe('billing@acme.com');
    expect(built.where).not.toContain('like');
  });

  it('treats a bare `from` as a domain, subdomains included', () => {
    const built = buildSearch(ACCOUNTS, { from: 'acme.com' }, NOW);
    expect(built.params.slice(1)).toEqual(['acme.com', '%@acme.com', '%.acme.com']);
  });

  it('takes `until` as the whole of the day named', () => {
    const built = buildSearch(ACCOUNTS, { until: '2026-03-01' }, NOW);
    expect(built.where).toContain("interval '1 day'");
  });

  it('orders and filters on the ingest clock, never on the sender\'s date header', () => {
    const built = buildSearch(ACCOUNTS, { since: '2026-03-01' }, NOW);
    expect(built.where).toContain('coalesce(m.internal_date, m.fetched_at) >= $2::date');
  });
});

describe('qualify', () => {
  it('puts the alias on every column', () => {
    expect(qualify('id, account_id, uid', 'm')).toBe('m.id, m.account_id, m.uid');
  });
});
