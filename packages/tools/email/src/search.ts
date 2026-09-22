/**
 * The mail search query, built once (docs/specs/email.md §9).
 *
 * `email.search` and `GET /api/email/search` ask the same question of the same
 * table, and they used to be one substring scan and nothing at all
 * respectively. One builder now writes the SQL for both, because the filters
 * are where the meaning lives: "from this domain, since March, with an
 * attachment" has to mean the same thing to an agent and to the owner reading
 * the page, and two hand-written WHERE clauses drift apart the first time one
 * of them learns a filter.
 *
 * ## What the index can and cannot do
 *
 * Migration 012 puts trigram GIN indexes on `subject` and `from_addr` and a
 * b-tree on `(account_id, coalesce(internal_date, fetched_at))`. The text
 * match is deliberately still `ilike '%needle%'` rather than pg_trgm's `%`
 * similarity operator: the trigram index accelerates `ilike` directly, so the
 * index is used either way, and `ilike` keeps the promise the tool has always
 * made — a case-insensitive **substring** — where `%` would silently become a
 * fuzzy word match that finds `invoice` for `invoicing` and misses `@acme.` in
 * an address. A search whose meaning changes under the agent is worse than a
 * slow one.
 *
 * `body_text` has no index and will not get one: it is the bulky half of the
 * table, it is purged on a schedule, and a GIN over it would be most of a
 * full-text search without being one (§11 names that as later work). So the
 * body scan is **bounded** instead — by the other filters when there are any,
 * and by a 90-day window on the ordering clock when there are none. That
 * window is the one piece of behaviour a caller has to know about, so both the
 * tool result and the route say when it was applied.
 */
import { normalizeAddress } from './mail.js';

/** The clock every date filter and every ordering here is written against. */
export const WHEN = 'coalesce(m.internal_date, m.fetched_at)';

/** How far back an unnarrowed body search reaches. Days. */
export const DEFAULT_WINDOW_DAYS = 90;

export type Direction = 'in' | 'out';

/** A YYYY-MM-DD day, which is what both callers accept. */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface SearchFilters {
  /** Free text, matched against subject, sender and body. */
  query?: string | undefined;
  /** An address (`a@b.com`) or a bare domain (`b.com`, matching subdomains). */
  from?: string | undefined;
  /** Inclusive, on the ordering clock. */
  since?: string | undefined;
  /** Inclusive of the whole day named. */
  until?: string | undefined;
  /** One conversation, by the id a result gave. */
  thread?: string | undefined;
  direction?: Direction | undefined;
  hasAttachments?: boolean | undefined;
}

export interface BuiltSearch {
  /** The WHERE body, without the keyword. Parameters are 1-based. */
  where: string;
  params: unknown[];
  /** True when nothing narrowed the search and the 90-day window was applied. */
  windowed: boolean;
  /** The cutoff the window used, when it was applied. */
  windowFrom: Date | null;
}

/** Whether these filters narrow the table by anything but free text. */
export function narrows(filters: SearchFilters): boolean {
  return (
    (filters.from ?? '') !== '' ||
    (filters.since ?? '') !== '' ||
    (filters.until ?? '') !== '' ||
    (filters.thread ?? '') !== '' ||
    filters.direction !== undefined ||
    filters.hasAttachments !== undefined
  );
}

/** A LIKE needle with the metacharacters escaped: `%` is a percent sign. */
export function likeNeedle(text: string): string {
  return `%${text.replace(/([\\%_])/g, '\\$1')}%`;
}

/**
 * A `from` filter, as SQL.
 *
 * With an `@` in it the value is one address and the match is exact: an agent
 * that types a whole address means that mailbox and not everything ending in
 * it. Without one it is a domain, and the match is the domain itself or any
 * subdomain of it — `acme.com` finds `billing@mail.acme.com` — which is what
 * makes "everything from this company" one filter rather than a guess at their
 * sending hosts. Both sides are lowercased, because `from_addr` is stored
 * normalized.
 */
function fromClause(raw: string, params: unknown[]): string {
  const value = normalizeAddress(raw);
  if (value.includes('@')) {
    params.push(value);
    return `m.from_addr = $${params.length}`;
  }
  params.push(value);
  const at = params.length;
  params.push(`%@${value.replace(/([\\%_])/g, '\\$1')}`);
  const exact = params.length;
  params.push(`%.${value.replace(/([\\%_])/g, '\\$1')}`);
  const sub = params.length;
  return `(m.from_addr = $${at} or m.from_addr like $${exact} escape '\\' or m.from_addr like $${sub} escape '\\')`;
}

/**
 * The WHERE clause for one search, over `email.messages m`.
 *
 * `accountIds` is not a filter and is never optional: it is the scope the
 * owner configured, and a search cannot widen it.
 */
export function buildSearch(
  accountIds: readonly string[],
  filters: SearchFilters,
  now: Date,
): BuiltSearch {
  const params: unknown[] = [accountIds];
  const where: string[] = ['m.account_id = any($1::uuid[])'];

  const query = filters.query?.trim() ?? '';
  if (query !== '') {
    params.push(likeNeedle(query));
    const needle = params.length;
    // Subject and sender ride the trigram indexes; the body is the scan the
    // filters and the window are here to bound.
    where.push(
      `(m.subject ilike $${needle} escape '\\'` +
        ` or m.from_addr ilike $${needle} escape '\\'` +
        ` or m.body_text ilike $${needle} escape '\\')`,
    );
  }

  const from = filters.from?.trim() ?? '';
  if (from !== '') where.push(fromClause(from, params));

  const thread = filters.thread?.trim() ?? '';
  if (thread !== '') {
    params.push(thread);
    where.push(`m.thread_id = $${params.length}::uuid`);
  }

  if (filters.direction) {
    params.push(filters.direction);
    where.push(`m.direction = $${params.length}`);
  }

  if (filters.hasAttachments !== undefined) {
    params.push(filters.hasAttachments);
    where.push(`m.has_attachments = $${params.length}`);
  }

  const since = filters.since?.trim() ?? '';
  if (since !== '') {
    params.push(since);
    where.push(`${WHEN} >= $${params.length}::date`);
  }

  const until = filters.until?.trim() ?? '';
  if (until !== '') {
    params.push(until);
    // The whole of the day named, not the instant it began.
    where.push(`${WHEN} < ($${params.length}::date + interval '1 day')`);
  }

  // Nothing narrowed it: the body scan gets a window rather than the archive.
  let windowed = false;
  let windowFrom: Date | null = null;
  if (query !== '' && !narrows(filters)) {
    windowFrom = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
    params.push(windowFrom);
    where.push(`${WHEN} >= $${params.length}`);
    windowed = true;
  }

  return { where: where.join(' and '), params, windowed, windowFrom };
}

/** The sentence a result carries when the default window was applied. */
export function windowNote(windowFrom: Date): string {
  return (
    `Only the last ${DEFAULT_WINDOW_DAYS} days were searched (since ` +
    `${windowFrom.toISOString().slice(0, 10)}), because no filter narrowed the ` +
    'search. Give `since`, `from`, `thread`, `direction` or `hasAttachments` to reach further back.'
  );
}

/**
 * A column list, qualified with a table alias.
 *
 * `MESSAGE_COLUMNS` is written bare because every other read selects from one
 * table; a search joins `threads` for nothing yet but reads `m.` everywhere in
 * its WHERE, and an unqualified `id` beside a join is how a query starts
 * returning the wrong row the day a second table joins in.
 */
export function qualify(columns: string, alias: string): string {
  return columns
    .split(',')
    .map((c) => `${alias}.${c.trim()}`)
    .join(', ');
}
