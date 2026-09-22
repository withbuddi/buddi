/**
 * The mail search query, built once (docs/specs/email.md §9).
 *
 * `email.search` and `GET /api/email/search` ask the same question of the same
 * table. One builder writes the whole statement for both — not just the WHERE
 * clause — because the filters are where the meaning lives: "from this domain,
 * since March, with an attachment" has to mean the same thing to an agent and
 * to the owner reading the page, and two hand-written queries drift apart the
 * first time one of them learns a filter.
 *
 * ## Why the text search is a UNION and not an OR
 *
 * Migration 012 puts trigram GIN indexes on `subject` and `from_addr`. The
 * first version of this module then wrote the obvious predicate:
 *
 *     subject ilike $q or from_addr ilike $q or body_text ilike $q
 *
 * and it never used either index. Postgres can only serve an `OR` from indexes
 * by building a `BitmapOr` over **every** arm, and `body_text` has no index —
 * by design — so the whole disjunction collapsed into a filter on a sequential
 * scan. Two GIN indexes were paid for on every ingest and read by nothing.
 *
 * So the text search is two queries unioned:
 *
 *  - the **indexed arm**, `subject ilike $q or from_addr ilike $q`, which is a
 *    BitmapOr the planner can actually build, over the whole archive;
 *  - the **body arm**, `body_text ilike $q`, which is the scan — and which is
 *    therefore the only arm the 90-day window is applied to.
 *
 * `union` (not `union all`) dedupes, and `id` is in the column list, so a
 * message whose subject *and* body both match comes back once. Ordering and
 * the limit go outside, over the union, so the newest hit wins whichever arm
 * found it.
 *
 * That asymmetry is a feature and the result says so: a subject or a sender is
 * searched over everything the mailbox holds, and only the *bodies* are
 * windowed. `ilike` is kept rather than pg_trgm's `%` similarity operator —
 * the trigram index accelerates `ilike` directly, and `%` would silently turn
 * the documented case-insensitive substring into a fuzzy word match that finds
 * `invoice` for `invoicing` and misses `@acme.` in an address. A search whose
 * meaning changes under the agent is worse than a slow one. Full-text search
 * over archives is §11's later work, on purpose.
 */
import { normalizeAddress } from './mail.js';

/** The clock every date filter and every ordering here is written against. */
export const WHEN = 'coalesce(m.internal_date, m.fetched_at)';

/** How far back an unbounded **body** scan reaches. Days. */
export const DEFAULT_WINDOW_DAYS = 90;

export type Direction = 'in' | 'out';

/** A YYYY-MM-DD day, which is what both callers accept. */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The shortest phrase worth scanning bodies for. */
export const MIN_QUERY_CHARS = 2;

/** How much of a snippet a hit carries. Matches `SNIPPET_CHARS` in mail.ts. */
export const SNIPPET_CHARS = 220;

/**
 * What a hit is made of.
 *
 * Deliberately **not** `MESSAGE_COLUMNS`: that list carries `body_text`,
 * `attachments`, `flags`, `to_addrs` and `cc`, none of which a search result
 * shows. A hundred hits used to mean a hundred full message bodies read out of
 * the table (a TOAST fetch each) to build a hundred snippets nobody asked for.
 *
 * `snippet` is bounded here as well as at ingest: the column is written short,
 * but a row inserted by hand is not a reason to ship a megabyte to a page.
 */
export function searchColumns(): string {
  return (
    'm.id, m.account_id, m.thread_id, m.direction, m.from_addr, m.subject, ' +
    'm.has_attachments, m.uid, ' +
    `substring(coalesce(m.snippet, '') for ${SNIPPET_CHARS}) as snippet, ` +
    `${WHEN} as at`
  );
}

/** One hit, as both callers read it back. */
export interface SearchRow {
  id: string;
  accountId: string;
  threadId: string | null;
  direction: Direction;
  from: string;
  subject: string;
  /** The ordering clock — `coalesce(internal_date, fetched_at)`, as an ISO string. */
  date: string | null;
  snippet: string;
  hasAttachments: boolean;
}

export function toSearchRow(row: Record<string, any>): SearchRow {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    threadId: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
    direction: row.direction === 'out' ? 'out' : 'in',
    from: row.from_addr ?? '',
    subject: row.subject ?? '',
    // The value the list is *ordered* by is the value the list *shows*. It
    // used to return `m.date`, the header the sender wrote, while ordering on
    // the server's clock — so a hit list could look misordered to the owner
    // and to a model reading it. See §9.
    date: row.at instanceof Date ? row.at.toISOString() : (row.at ?? null),
    snippet: row.snippet ?? '',
    hasAttachments: Boolean(row.has_attachments),
  };
}

export interface SearchFilters {
  /** Free text, matched against subject, sender and body. */
  query?: string | undefined;
  /** An address (`a@b.com`) or a bare domain (`b.com`, matching subdomains). */
  from?: string | undefined;
  /** Inclusive, on the ordering clock, in the owner's timezone. */
  since?: string | undefined;
  /** Inclusive of the whole day named, in the owner's timezone. */
  until?: string | undefined;
  /** One conversation, by the id a result gave. */
  thread?: string | undefined;
  direction?: Direction | undefined;
  hasAttachments?: boolean | undefined;
}

export interface BuiltSearch {
  /** The whole statement, ready to run. Parameters are 1-based. */
  text: string;
  params: unknown[];
  /** True when the body arm was windowed. */
  windowed: boolean;
  /** The cutoff the window used, when it was applied. */
  windowFrom: string | null;
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

/**
 * Whether these filters actually **bound** the body scan.
 *
 * Not the same question as `narrows`, and conflating the two is how the window
 * went missing. `direction: 'in'` excludes perhaps a twentieth of a mailbox
 * and `hasAttachments` rather less; either one used to turn the window off and
 * leave an unindexed `body_text ilike '%…%'` running over the whole archive,
 * which is one cheap argument away from the thing the window exists to stop.
 *
 * Only three filters bound it: `since` (a lower edge on the clock the scan is
 * ordered by), `thread` (a handful of rows, by an index), and `from` (one
 * sender or one company). `until` on its own has **no lower edge** at all — it
 * is the older half of the archive — so it does not count, and the window is
 * measured back from `until` rather than from today.
 */
export function bounded(filters: SearchFilters): boolean {
  return (
    (filters.since ?? '') !== '' ||
    (filters.thread ?? '') !== '' ||
    (filters.from ?? '') !== ''
  );
}

/** A LIKE needle with the metacharacters escaped: `%` is a percent sign. */
export function likeNeedle(text: string): string {
  return `%${text.replace(/([\\%_])/g, '\\$1')}%`;
}

/** A YYYY-MM-DD that is also a day that exists. `2026-02-31` is not one. */
export function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Everything wrong with these filters, in one sentence, or null.
 *
 * Shared by the tool and the route on purpose. Zod catches the *shape* of a
 * tool argument, but nothing catches `2026-02-31` (a well-formed date that is
 * not a day) and the route has no zod at all — so `?thread=x` used to reach
 * `m.thread_id = $n::uuid`, raise `22P02` inside the pool, and come back to
 * the owner as a blank 500 for a typo.
 */
export function validateFilters(filters: SearchFilters): string | null {
  const query = filters.query?.trim() ?? '';
  if (query !== '' && query.length < MIN_QUERY_CHARS) {
    return `Type at least ${MIN_QUERY_CHARS} characters to search for.`;
  }
  for (const [name, value] of [
    ['since', filters.since],
    ['until', filters.until],
  ] as const) {
    const day = value?.trim() ?? '';
    if (day !== '' && !isCalendarDate(day)) {
      return `\`${name}\` is a real day, written as 2026-03-01.`;
    }
  }
  const since = filters.since?.trim() ?? '';
  const until = filters.until?.trim() ?? '';
  if (since !== '' && until !== '' && until < since) {
    return '`until` is before `since`, so nothing could be in that range.';
  }
  const thread = filters.thread?.trim() ?? '';
  if (thread !== '' && !UUID_PATTERN.test(thread)) {
    return '`thread` is a conversation id, as email.list_threads gives it.';
  }
  if (filters.direction !== undefined && filters.direction !== 'in' && filters.direction !== 'out') {
    return '`direction` is `in` or `out`.';
  }
  return null;
}

/**
 * A `from` filter, as SQL.
 *
 * With an `@` in it the value is one address and the match is exact: an agent
 * that types a whole address means that mailbox and not everything ending in
 * it. Without one it is a domain, and the match is the domain itself or any
 * subdomain of it — `acme.com` finds `billing@mail.acme.com` — which is what
 * makes "everything from this company" one filter rather than a guess at their
 * sending hosts. Both patterns are anchored on a separator, so `acme.com` can
 * never match `notacme.com`. Both sides are lowercased, because `from_addr` is
 * stored normalized.
 */
function fromClause(raw: string, params: unknown[]): string {
  const value = normalizeAddress(raw);
  if (value.includes('@')) {
    params.push(value);
    return `m.from_addr = $${params.length}`;
  }
  const escaped = value.replace(/([\\%_])/g, '\\$1');
  params.push(value);
  const at = params.length;
  params.push(`%@${escaped}`);
  const exact = params.length;
  params.push(`%.${escaped}`);
  const sub = params.length;
  return `(m.from_addr = $${at} or m.from_addr like $${exact} or m.from_addr like $${sub})`;
}

export interface SearchOptions {
  /** Now, for the default window. */
  now: Date;
  /** The owner's IANA zone. Day boundaries are read in it, not in UTC. */
  timezone: string;
  limit: number;
}

/** `YYYY-MM-DD`, `days` before the given day. Pure string arithmetic on UTC. */
function dayBefore(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}

/**
 * The whole search statement.
 *
 * `accountIds` is not a filter and is never optional: it is the scope the
 * owner configured, and a search cannot widen it. Validation is the caller's
 * (`validateFilters`); this function assumes it passed.
 */
export function buildSearch(
  accountIds: readonly string[],
  filters: SearchFilters,
  opts: SearchOptions,
): BuiltSearch {
  const params: unknown[] = [accountIds];
  const base: string[] = ['m.account_id = any($1::uuid[])'];

  /*
   * The owner's zone, bound **on first use**. Every day boundary below is read
   * in it: a `since` of 2026-03-01 is midnight where the owner lives, which in
   * Los Angeles is eight hours after midnight UTC and in Auckland thirteen
   * hours before it. The server's TimeZone (UTC on the bundled Postgres) is
   * not anybody's day.
   *
   * Lazily, because a parameter that is sent and never mentioned in the SQL is
   * a "could not determine data type of parameter $2" from the server — a
   * search with no date filter at all would have been that error.
   */
  let tzParam = 0;
  const tz = (): number => {
    if (tzParam === 0) {
      params.push(opts.timezone);
      tzParam = params.length;
    }
    return tzParam;
  };

  const from = filters.from?.trim() ?? '';
  if (from !== '') base.push(fromClause(from, params));

  const thread = filters.thread?.trim() ?? '';
  if (thread !== '') {
    params.push(thread);
    base.push(`m.thread_id = $${params.length}::uuid`);
  }

  if (filters.direction) {
    params.push(filters.direction);
    base.push(`m.direction = $${params.length}`);
  }

  if (filters.hasAttachments !== undefined) {
    params.push(filters.hasAttachments);
    base.push(`m.has_attachments = $${params.length}`);
  }

  const since = filters.since?.trim() ?? '';
  if (since !== '') {
    params.push(since);
    base.push(`${WHEN} >= ($${params.length}::date::timestamp at time zone $${tz()})`);
  }

  const until = filters.until?.trim() ?? '';
  if (until !== '') {
    params.push(until);
    // The whole of the day named, not the instant it began.
    base.push(
      `${WHEN} < (($${params.length}::date + interval '1 day') at time zone $${tz()})`,
    );
  }

  const columns = searchColumns();
  const query = filters.query?.trim() ?? '';

  // Filters only: one arm, no text predicate, no window — the filters are the
  // bound, and there is no body to scan.
  if (query === '') {
    params.push(opts.limit);
    return {
      text:
        `select ${columns} from email.messages m\n` +
        ` where ${base.join(' and ')}\n` +
        ` order by at desc nulls last, uid desc\n` +
        ` limit $${params.length}`,
      params,
      windowed: false,
      windowFrom: null,
    };
  }

  params.push(likeNeedle(query));
  const needle = params.length;

  /*
   * The window, on the body arm alone.
   *
   * Measured back from `until` when there is one and from today when there is
   * not, because `{ until: '2020-01-01' }` is a request for the *old* half of
   * the archive and windowing it at "the last 90 days" would return nothing at
   * all while claiming to have looked.
   */
  const bodyWhere = [...base];
  let windowFrom: string | null = null;
  if (!bounded(filters)) {
    const anchor = until !== '' ? until : new Date(opts.now).toISOString().slice(0, 10);
    windowFrom = dayBefore(anchor, DEFAULT_WINDOW_DAYS);
    params.push(windowFrom);
    bodyWhere.push(`${WHEN} >= ($${params.length}::date::timestamp at time zone $${tz()})`);
  }

  params.push(opts.limit);
  const limit = params.length;

  return {
    text:
      `select * from (\n` +
      // The indexed arm: a BitmapOr the planner can build over
      // messages_subject_trgm_idx and messages_from_trgm_idx. Not windowed —
      // a subject from three years ago is cheap to find and worth finding.
      `  select ${columns} from email.messages m\n` +
      `   where ${base.join(' and ')}\n` +
      `     and (m.subject ilike $${needle} or m.from_addr ilike $${needle})\n` +
      `  union\n` +
      // The body arm: the scan, and so the arm the window bounds.
      `  select ${columns} from email.messages m\n` +
      `   where ${bodyWhere.join(' and ')}\n` +
      `     and m.body_text ilike $${needle}\n` +
      `) hits\n` +
      ` order by at desc nulls last, uid desc\n` +
      ` limit $${limit}`,
    params,
    windowed: windowFrom !== null,
    windowFrom,
  };
}

/** The sentence a result carries when the body scan was windowed. */
export function windowNote(windowFrom: string): string {
  return (
    `Subjects and senders were searched in full; only the last ` +
    `${DEFAULT_WINDOW_DAYS} days of message bodies were read (since ${windowFrom}), ` +
    'because no filter bounded the search. Give `since`, `from` or `thread` to read further back.'
  );
}

/**
 * A column list, qualified with a table alias.
 *
 * Kept for callers that select whole message rows next to a join; the search
 * itself has `SEARCH_COLUMNS`, which is already qualified.
 */
export function qualify(columns: string, alias: string): string {
  return columns
    .split(',')
    .map((c) => `${alias}.${c.trim()}`)
    .join(', ');
}
