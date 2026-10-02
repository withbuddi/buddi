/**
 * Sources: the pages an agent read and the searches it ran in one turn.
 *
 * A platform panel, not a renderer a descriptor can ask for: the page decides
 * which calls are gathered here (`chat/sources.ts`), and this file reads only
 * their shapes — a URL with its title and text, a query with its results.
 *
 * Nothing here loads anything from another host. A page's mark is a letter
 * tile from its domain, never its favicon: the dashboard makes no request the
 * owner did not click (`bundle.test.ts`). Links out open a new tab with no
 * opener, and only http and https are ever made links.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon, Pill } from '../../ui';
import { fmtClock } from '../../format';
import type { SourceEntry, SourcesPanelProps } from '../renderables';

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : {});
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** The reader's reasons (`packages/tools/web` `problem`), in the owner's words. */
export const READ_PROBLEMS: Record<string, string> = {
  blocked: 'Blocked — that address is on this computer or a private network, which the reader never opens.',
  forbidden: 'The site turned the reader away. It may need a sign-in or refuse automated readers.',
  unauthorised: 'The page needs a sign-in, which the reader doesn’t have.',
  'not-found': 'Page not found — the link may be old or mistyped.',
  timeout: 'Timed out — the site didn’t answer in time.',
  'too-large': 'Too large to read — the page is bigger than the reader takes.',
  'unsupported-content': 'Not a web page — a PDF, an image or a file the reader doesn’t open.',
  'rate-limited': 'The site is limiting how often it can be read. Try again later.',
  'server-error': 'The site had a problem of its own.',
  'too-many-redirects': 'The link kept redirecting, so the reader gave up.',
  network: 'Couldn’t reach the site.',
};

/** The host a citation names, without `www.`; the input itself when it is no URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Only http and https become links. */
function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** One URL however it was written: no hash, no trailing slash, no `www.`. */
function sameUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch {
    return url;
  }
}

/** A tile's letter: the first letter or digit of the domain. */
function letterOf(host: string): string {
  return host.match(/[\p{L}\p{N}]/u)?.[0] ?? '?';
}

export interface PageSource {
  kind: 'page';
  id: string;
  url: string;
  host: string;
  state: 'pending' | 'ok' | 'failed';
  title: string | null;
  text: string | null;
  truncated: boolean;
  retrievedAt: string | null;
  /** Present on a failure: one sentence, plain. */
  why: string | null;
  raw: unknown;
}

export interface SearchSource {
  kind: 'search';
  id: string;
  query: string;
  state: 'pending' | 'ok' | 'failed';
  provider: string | null;
  results: Array<{ title: string; url: string; host: string; snippet: string | null }>;
  why: string | null;
  raw: unknown;
}

export type Source = PageSource | SearchSource;

/** What a gathered call is, from its shape alone. */
export function sourceOf(entry: SourceEntry): Source {
  const input = rec(entry.input);
  const output = rec(entry.output);
  const raw = { input: entry.input, ...(entry.ok === null ? { status: 'Awaiting result' } : { output: entry.output }), ...(entry.error === undefined ? {} : { error: entry.error }) };
  const failedCall = entry.ok === false;
  const errorText = str(entry.error) ?? str(rec(entry.error)['message']);

  if (Array.isArray(output['results']) || (str(input['query']) && !str(input['url']))) {
    const results = (Array.isArray(output['results']) ? output['results'] : [])
      .map((item) => rec(item))
      .flatMap((item) => {
        const url = str(item['url']);
        if (!url) return [];
        return [{ title: str(item['title']) ?? hostOf(url), url, host: str(item['source']) ?? hostOf(url), snippet: str(item['snippet']) }];
      });
    const unavailable = output['available'] === false;
    return {
      kind: 'search', id: entry.id, raw,
      query: str(output['query']) ?? str(input['query']) ?? '',
      state: entry.ok === null ? 'pending' : failedCall || unavailable ? 'failed' : 'ok',
      provider: str(output['provider']),
      results,
      why: failedCall
        ? `The search failed${errorText ? `: ${errorText}` : '.'}`
        : unavailable
          ? str(output['provider']) ? 'The search couldn’t be run this time.' : 'Web search isn’t set up on this buddi yet — `buddi doctor` says how.'
          : null,
    };
  }

  const url = str(output['url']) ?? str(input['url']) ?? '';
  const failed = failedCall || output['ok'] === false;
  const problem = str(output['problem']);
  const message = str(output['message']);
  return {
    kind: 'page', id: entry.id, url, raw,
    host: str(output['source']) ?? hostOf(url),
    state: entry.ok === null ? 'pending' : failed ? 'failed' : 'ok',
    title: str(output['title']),
    text: str(output['text']),
    truncated: output['truncated'] === true,
    retrievedAt: str(output['retrievedAt']) ?? entry.at,
    why: !failed ? null
      : (problem && READ_PROBLEMS[problem])
        ?? (message ? message.charAt(0).toUpperCase() + message.slice(1) + (/[.!?]$/.test(message) ? '' : '.') : null)
        ?? `The read failed${errorText ? `: ${errorText}` : '.'}`,
  };
}

/** "1 search · 6 pages": the panel's quiet line. */
export function sourcesSummary(props: SourcesPanelProps): string {
  const sources = props.entries.map(sourceOf);
  const searches = sources.filter((item) => item.kind === 'search').length;
  const pages = sources.length - searches;
  return [
    searches ? `${searches} ${searches === 1 ? 'search' : 'searches'}` : null,
    pages ? `${pages} ${pages === 1 ? 'page' : 'pages'}` : null,
  ].filter(Boolean).join(' · ');
}

function wordsOf(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function fmtWords(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k words` : `${count} ${count === 1 ? 'word' : 'words'}`;
}

function fmtAt(iso: string | null, timezone?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return fmtClock(date, timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function Out({ url, className, children }: { url: string; className: string; children: React.ReactNode }): JSX.Element {
  const href = safeHref(url);
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a className={`wb-src-link ${className}`} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="wb-src-out" aria-hidden="true">↗</span>
    </a>
  );
}

function Raw({ value }: { value: unknown }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="wb-src-quiet" data-raw="" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide JSON' : 'Raw JSON'}
      </button>
      {open ? <pre className="wb-src-raw">{JSON.stringify(value, null, 2)}</pre> : null}
    </>
  );
}

function Page({ page, focused, timezone }: { page: PageSource; focused: boolean; timezone?: string }): JSX.Element {
  const [open, setOpen] = useState(focused);
  const [more, setMore] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused]);

  if (page.state === 'pending') {
    return (
      <li className="wb-src-page" data-state="pending" ref={ref}>
        <div className="wb-src-row">
          <span className="wb-src-tile" data-state="pending" aria-hidden="true">{letterOf(page.host)}</span>
          <span className="wb-src-head">
            <span className="wb-src-title">Reading {page.host}…</span>
            <span className="wb-src-meta">{page.url}</span>
          </span>
          <span />
        </div>
      </li>
    );
  }
  const failed = page.state === 'failed';
  const words = page.text ? wordsOf(page.text) : 0;
  const at = fmtAt(page.retrievedAt, timezone);
  const meta = [page.host, at ? `read ${at}` : null, words ? fmtWords(words) : null, words ? `${Math.max(1, Math.round(words / 230))} min read` : null]
    .filter(Boolean).join(' · ');
  return (
    <li className="wb-src-page" data-open={open ? 'true' : undefined} data-state={page.state} ref={ref}>
      <div className="wb-src-row">
        <span className="wb-src-tile" data-tone={failed ? 'critical' : undefined} aria-hidden="true">{failed ? '!' : letterOf(page.host)}</span>
        <span className="wb-src-head">
          {failed
            ? <span className="wb-src-title">Couldn’t read {page.host}</span>
            : <Out url={page.url} className="wb-src-title">{page.title ?? page.host}</Out>}
          {failed ? <span className="wb-src-why">{page.why}</span> : <span className="wb-src-meta">{meta}</span>}
        </span>
        <button
          type="button"
          className="wb-src-toggle"
          aria-expanded={open}
          aria-label={open ? `Hide what was read from ${page.host}` : `Show what was read from ${page.host}`}
          onClick={() => setOpen(!open)}
        >
          <Icon name="chevron" />
        </button>
      </div>
      {open ? (
        <div className="wb-src-body">
          {failed ? <p className="wb-src-note">{page.url}</p> : (
            <>
              {page.text ? <p className="wb-src-text" data-clamped={more ? undefined : 'true'}>{page.text}</p> : <p className="wb-src-note">The page had no text to read.</p>}
              {page.truncated ? <p className="wb-src-note">Only the beginning of the page was read; it was longer than the limit.</p> : null}
            </>
          )}
          <div className="wb-src-foot">
            {!failed && page.text ? (
              <button type="button" className="wb-src-quiet" onClick={() => setMore(!more)}>{more ? 'Show less' : 'Show more'}</button>
            ) : null}
            <Raw value={page.raw} />
          </div>
        </div>
      ) : null}
    </li>
  );
}

const FIRST_RESULTS = 3;

function Search({ search, read, focused }: { search: SearchSource; read: ReadonlySet<string>; focused: boolean }): JSX.Element {
  const [all, setAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused]);
  const shown = all ? search.results : search.results.slice(0, FIRST_RESULTS);
  const meta = search.state === 'pending' ? 'Searching…'
    : [search.provider, search.state === 'ok' ? `${search.results.length} ${search.results.length === 1 ? 'result' : 'results'}` : null].filter(Boolean).join(' · ');
  return (
    <div className="wb-src-list" data-state={search.state} ref={ref}>
      <div className="wb-src-query">
        <span className="wb-src-query-text">“{search.query}”</span>
        {meta ? <span className="wb-src-query-meta">{meta}</span> : null}
        <span className="wb-src-query-raw"><Raw value={search.raw} /></span>
      </div>
      {search.state === 'failed' ? <p className="wb-src-empty wb-src-why">{search.why}</p> : null}
      {search.state === 'ok' && search.results.length === 0 ? <p className="wb-src-empty">No results.</p> : null}
      {shown.length > 0 ? (
        <ol className="wb-src-results">
          {shown.map((result) => (
            <li key={result.url} className="wb-src-result">
              <Out url={result.url} className="wb-src-result-title">{result.title}</Out>
              <span className="wb-src-result-site">{result.host}</span>
              {result.snippet ? <p className="wb-src-result-snippet">{result.snippet}</p> : null}
              {read.has(sameUrl(result.url)) ? <span className="wb-src-result-side"><Pill tone="good">Read</Pill></span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {search.results.length > FIRST_RESULTS ? (
        <div className="wb-src-more">
          <button type="button" className="wb-src-quiet" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${search.results.length}`}</button>
        </div>
      ) : null}
    </div>
  );
}

export function SourcesView({ entries, focus, timezone }: SourcesPanelProps & { timezone?: string }): JSX.Element {
  const sources = entries.map(sourceOf);
  const pages = sources.filter((item): item is PageSource => item.kind === 'page');
  const searches = sources.filter((item): item is SearchSource => item.kind === 'search');
  // A result counts as read when this turn read it, under either URL.
  const read = new Set(pages.filter((page) => page.state === 'ok').flatMap((page) => {
    const entry = entries.find((item) => item.id === page.id);
    const asked = str(rec(entry?.input)['url']);
    return [sameUrl(page.url), ...(asked ? [sameUrl(asked)] : [])];
  }));
  return (
    <div className="wb-src">
      {pages.length > 0 ? (
        <div className="wb-src-group">
          <p className="wb-src-kicker">Read</p>
          <ul className="wb-src-list">
            {pages.map((page) => <Page key={page.id} page={page} focused={focus === page.id} timezone={timezone} />)}
          </ul>
        </div>
      ) : null}
      {searches.length > 0 ? (
        <div className="wb-src-group">
          <p className="wb-src-kicker">Searched</p>
          {searches.map((search) => <Search key={search.id} search={search} read={read} focused={focus === search.id} />)}
        </div>
      ) : null}
    </div>
  );
}
