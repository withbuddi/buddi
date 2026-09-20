/**
 * Files: the owner's library over the artifact store (docs/files.md).
 *
 * Everything an agent produced and everything the owner sent, across every
 * conversation, newest first, with a name to search by and two filters that
 * describe origin and family. Selecting one keeps the list in place and
 * opens the file beside it: a preview where one is safe, always a download,
 * and the conversations it was part of, each one a link back.
 *
 * Previews are honest about what they are. An image is the image; a PDF is
 * the browser's own viewer over the preview route; text, code and tables are
 * fetched as plain text and drawn as text — a table is parsed here, quoted
 * fields and all, never evaluated. Anything else says so and offers the
 * download. Nothing here edits, runs an agent, or fetches off this origin.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlaceProps } from '../App';
import { ApiError, api, type LibraryContext, type LibraryEntry } from '../api';
import { FAMILY_LABEL, downloadUrl, formatBytes, previewUrl } from '../chat/attachments';
import { FamilyMark } from '../chat/FileTile';
import { fmtRelative, fmtTime } from '../format';
import { chatRoute, fileRoute, groupChatRoute, parseFileRoute } from '../routes';
import { AgentAvatar, Button, Empty, ErrorBanner, Field, KV, Notice, Pill, Toolbar } from '../ui';

const ORIGINS = [
  { id: '', label: 'All files' },
  { id: 'produced', label: 'Created by agents' },
  { id: 'uploaded', label: 'Uploaded by you' },
] as const;
const FAMILIES: Array<LibraryEntry['family'] | ''> = ['', 'image', 'pdf', 'table', 'text', 'code', 'audio', 'video', 'archive', 'file'];

export function Files({ hash, timezone, navigate, agents }: PlaceProps): JSX.Element {
  // Search and filters live in the address, so Back brings them back and a
  // link carries them. The search box is typed locally and written through
  // after a pause.
  const route = parseFileRoute(hash);
  const selectedId = route?.artifactId ?? null;
  const origin = route?.filters.origin ?? '';
  const family = route?.filters.family ?? '';
  const q = route?.filters.q ?? '';
  const [typed, setTyped] = useState(q);
  useEffect(() => { setTyped(q); }, [q]);
  const setFilters = (next: { q?: string; origin?: string; family?: string }, replace = false): void =>
    navigate(fileRoute(selectedId, { q, origin, family, ...next }), replace);
  useEffect(() => {
    if (typed === q) return undefined;
    const handle = window.setTimeout(() => setFilters({ q: typed }, true), 250);
    return () => window.clearTimeout(handle);
  }, [typed]);
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const nameOf = (id: string | null): string => (id ? agents.find((a) => a.id === id)?.name ?? id : '');

  // A change of search or filters restarts the listing; a page that arrives
  // for an older query is dropped rather than shown under the new one.
  const generation = useRef(0);
  useEffect(() => {
    const mine = ++generation.current;
    setEntries(null);
    setError(null);
    api.library({ ...(q ? { q } : {}), ...(origin ? { origin } : {}), ...(family ? { family } : {}) })
      .then((page) => { if (generation.current !== mine) return; setEntries(page.entries); setNext(page.next); })
      .catch((err: unknown) => { if (generation.current === mine) setError(err instanceof ApiError ? err.message : String(err)); });
    return undefined;
  }, [q, origin, family]);

  const more = (): void => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    const mine = generation.current;
    api.library({ ...(q ? { q } : {}), ...(origin ? { origin } : {}), ...(family ? { family } : {}), cursor: next })
      .then((page) => {
        if (generation.current !== mine) return;
        setEntries((current) => {
          const seen = new Set((current ?? []).map((e) => e.id));
          return [...(current ?? []), ...page.entries.filter((e) => !seen.has(e.id))];
        });
        setNext(page.next);
      })
      .catch((err: unknown) => { if (generation.current === mine) setError(err instanceof ApiError ? err.message : String(err)); })
      .finally(() => { if (generation.current === mine) setLoadingMore(false); });
  };

  return (
    <div className="ui-page files" data-selected={selectedId ? 'true' : undefined}>
      <header className="ui-page-head">
        <h2 className="ui-page-title">Files</h2>
        <p className="ui-page-lede">What your agents made and what you sent them, across every conversation.</p>
      </header>
      <div className="files-body">
        <section className="files-list" aria-label="Files">
          <Toolbar valign="end">
            <Field label="Search" grow>
              <input type="search" value={typed} placeholder="Filename" aria-label="Search files by name" onChange={(e) => setTyped(e.target.value)} />
            </Field>
            <Field label="Origin">
              <select value={origin} aria-label="Origin" onChange={(e) => setFilters({ origin: e.target.value })}>
                {ORIGINS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Kind">
              <select value={family} aria-label="Kind" onChange={(e) => setFilters({ family: e.target.value })}>
                {FAMILIES.map((f) => <option key={f} value={f}>{f === '' ? 'Any kind' : FAMILY_LABEL[f]}</option>)}
              </select>
            </Field>
          </Toolbar>
          <ErrorBanner message={error} />
          {entries === null ? (
            <Empty>Loading…</Empty>
          ) : entries.length === 0 ? (
            <Empty>{q || origin || family ? 'No file matches that.' : 'No files yet. Send an agent a file, or ask one for a report, and it lands here.'}</Empty>
          ) : (
            <ul className="files-rows" role="list">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <a
                    className="files-row"
                    href={fileRoute(entry.id, { q, origin, family })}
                    aria-current={entry.id === selectedId ? 'true' : undefined}
                    onClick={(e) => { e.preventDefault(); navigate(fileRoute(entry.id, { q, origin, family })); }}
                  >
                    <span className="files-row-visual" data-family={entry.family}>
                      {entry.family === 'image' && !entry.deleted ? <img src={previewUrl(entry.id)} alt="" loading="lazy" /> : <FamilyMark family={entry.family} />}
                    </span>
                    <span className="files-row-text">
                      <span className="files-row-name">{entry.filename ?? 'Untitled file'}</span>
                      <span className="files-row-meta">
                        {FAMILY_LABEL[entry.family]} · {formatBytes(entry.sizeBytes)} · {originLabel(entry, nameOf)}
                        {entry.contexts > 1 ? ` · ${entry.contexts} conversations` : ''}
                      </span>
                    </span>
                    <span className="files-row-when" title={fmtTime(entry.createdAt, timezone)}>{fmtRelative(entry.createdAt)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {next ? (
            <Toolbar align="end">
              <Button onClick={more} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Show more'}</Button>
            </Toolbar>
          ) : null}
        </section>
        <section className="files-detail" aria-label="File">
          {selectedId ? (
            <FileDetail key={selectedId} id={selectedId} timezone={timezone} agents={agents} navigate={navigate} onBack={() => navigate(fileRoute(null, { q, origin, family }))} />
          ) : (
            <div className="files-detail-empty"><Empty>Select a file to see it here.</Empty></div>
          )}
        </section>
      </div>
    </div>
  );
}

function originLabel(entry: LibraryEntry, nameOf: (id: string | null) => string): string {
  if (entry.origin === 'uploaded') return 'You sent it';
  if (entry.origin === 'produced') return `Made by ${nameOf(entry.agentId) || 'an agent'}`;
  return entry.agentId ? `Saved by ${nameOf(entry.agentId)}` : 'Origin unknown';
}

/* ------------------------------------------------------------------ *
 * One file
 * ------------------------------------------------------------------ */

function FileDetail({ id, timezone, agents, navigate, onBack }: {
  id: string; timezone: string; agents: PlaceProps['agents']; navigate: (r: string) => void; onBack: () => void;
}): JSX.Element {
  const [data, setData] = useState<{ entry: LibraryEntry; contexts: LibraryContext[]; contextsTotal: number; available: boolean } | null>(null);
  const [moreContexts, setMoreContexts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api.libraryEntry(id)
      .then((found) => { if (!cancelled) setData(found); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof ApiError && err.status === 404 ? 'This file is no longer in the library.' : err instanceof ApiError ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [id]);
  const nameOf = (agentId: string | null): string => (agentId ? agents.find((a) => a.id === agentId)?.name ?? agentId : '');

  if (error) return <div className="files-detail-body"><Button size="sm" onClick={onBack} className="files-back">Back to Files</Button><Notice tone="critical">{error}</Notice></div>;
  if (!data) return <div className="files-detail-body"><Empty>Loading…</Empty></div>;
  const { entry, contexts, contextsTotal, available } = data;
  const name = entry.filename ?? 'Untitled file';
  const loadMoreContexts = (): void => {
    setMoreContexts(true);
    api.libraryEntry(id, contexts.length)
      .then((page) => setData((current) => current ? { ...current, contexts: [...current.contexts, ...page.contexts], contextsTotal: page.contextsTotal } : current))
      .catch(() => undefined)
      .finally(() => setMoreContexts(false));
  };

  return (
    <div className="files-detail-body">
      <Button size="sm" onClick={onBack} className="files-back">Back to Files</Button>
      <header className="files-detail-head">
        <span className="files-detail-mark" data-family={entry.family} aria-hidden="true"><FamilyMark family={entry.family} /></span>
        <div className="files-detail-text">
          <h3 className="files-detail-name">{name}</h3>
          <p className="files-detail-meta">{FAMILY_LABEL[entry.family]} · {formatBytes(entry.sizeBytes)} · {fmtTime(entry.createdAt, timezone)}</p>
        </div>
        {available ? <a className="ui-btn" data-variant="accent" href={downloadUrl(entry.id)} download={name}>Download</a> : null}
      </header>
      {!available ? <Notice tone="warning">The file's bytes are no longer on this machine. What is known about it stays here; the download will not work.</Notice> : null}
      <Preview entry={entry} available={available} />
      <KV items={[
        { label: 'Origin', value: originLabel(entry, nameOf) },
        ...(entry.agentId && entry.origin === 'produced' ? [{ label: 'Made by', value: <span className="files-agent"><AgentAvatar agents={agents} id={entry.agentId} size="sm" />{nameOf(entry.agentId)}</span> }] : []),
        { label: 'Type', value: <span className="mono">{entry.mime}</span> },
        { label: 'Id', value: <span className="mono">{entry.id}</span> },
      ]} />
      <section className="files-conversations">
        <h4 className="ui-section-title">Conversations</h4>
        {contexts.length === 0 ? (
          <p className="muted">No conversation is recorded for this file. It may date from before the library kept track.</p>
        ) : (
          <ul className="files-ctx" role="list">
            {contexts.map((c) => {
              const href = c.groupId ? groupChatRoute(c.groupId, c.conversationId) : chatRoute(c.conversationAgentId, c.conversationId);
              const who = c.groupId ? (c.groupName ?? 'a group') : nameOf(c.conversationAgentId);
              return (
                <li key={`${c.conversationId}:${c.kind}`} className="files-ctx-row">
                  <span className="files-ctx-text">
                    <span>{c.groupId ? `Group: ${who}` : who}</span>
                    <span className="muted"> · {c.kind === 'produced' ? `made by ${nameOf(c.agentId) || 'an agent'}` : c.kind === 'reused' ? 'sent again' : 'sent by you'} · {fmtRelative(c.at)}</span>
                  </span>
                  <a className="ui-btn" data-size="sm" href={href} onClick={(e) => { e.preventDefault(); navigate(href); }}>Open conversation</a>
                </li>
              );
            })}
          </ul>
        )}
        {contexts.length < contextsTotal ? (
          <Toolbar align="end"><Button size="sm" onClick={loadMoreContexts} disabled={moreContexts}>{moreContexts ? 'Loading…' : `Show ${contextsTotal - contexts.length} more`}</Button></Toolbar>
        ) : null}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Previews
 * ------------------------------------------------------------------ */

const TEXT_PREVIEW_CHARS = 100_000;
const TABLE_ROWS = 200;
const TABLE_COLS = 30;

function Preview({ entry, available }: { entry: LibraryEntry; available: boolean }): JSX.Element {
  const family = entry.family;
  const [broken, setBroken] = useState(false);
  if (!available) return <></>;
  if (family === 'image' && !broken) {
    return <figure className="files-preview files-preview-image"><img src={previewUrl(entry.id)} alt={entry.filename ?? 'Image'} onError={() => setBroken(true)} /></figure>;
  }
  if (family === 'pdf') {
    return (
      <div className="files-preview files-preview-pdf">
        <object data={previewUrl(entry.id)} type="application/pdf" aria-label={entry.filename ?? 'PDF'}>
          <Notice>Your browser cannot show this PDF here. Download it to open it.</Notice>
        </object>
      </div>
    );
  }
  if (family === 'text' || family === 'code' || family === 'table') return <TextPreview entry={entry} />;
  return <Notice>Preview not supported for this kind of file. Download it to open it.</Notice>;
}

function TextPreview({ entry }: { entry: LibraryEntry }): JSX.Element {
  const [state, setState] = useState<{ text: string; truncated: boolean } | 'loading' | 'failed'>('loading');
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetch(previewUrl(entry.id), { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const text = await res.text();
        if (cancelled) return;
        setState({ text: text.slice(0, TEXT_PREVIEW_CHARS), truncated: res.headers.get('X-Preview-Truncated') === '1' || text.length > TEXT_PREVIEW_CHARS });
      })
      .catch(() => { if (!cancelled) setState('failed'); });
    return () => { cancelled = true; };
  }, [entry.id]);
  if (state === 'loading') return <div className="files-preview"><Empty>Loading preview…</Empty></div>;
  if (state === 'failed') return <Notice>The preview could not be loaded. Download the file to open it.</Notice>;
  const isTable = entry.family === 'table' && (/csv|tab-separated/.test(entry.mime) || /\.(csv|tsv)$/i.test(entry.filename ?? ''));
  return (
    <div className="files-preview">
      {isTable ? <CsvTable text={state.text} delimiter={/tab|\.tsv$/i.test(entry.mime + (entry.filename ?? '')) ? '\t' : ','} /> : <pre className="files-preview-text">{state.text}</pre>}
      {state.truncated ? <p className="muted">Showing the first {TEXT_PREVIEW_CHARS.toLocaleString()} characters. The download has the whole file.</p> : null}
    </div>
  );
}

/** A CSV parser that respects quotes and embedded newlines. Cells are data, never evaluated. */
export function parseDelimited(text: string, delimiter: string, maxRows: number, maxCols: number): { rows: string[][]; truncatedRows: boolean; truncatedCols: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let truncatedCols = false;
  let truncatedRows = false;
  const endCell = (): void => { if (row.length < maxCols) row.push(cell); else truncatedCols = true; cell = ''; };
  const endRow = (): void => { endCell(); rows.push(row); row = []; };
  let i = 0;
  for (; i < text.length; i += 1) {
    if (rows.length >= maxRows) {
      // Rows are only "truncated" when there is more input than a blank tail.
      truncatedRows = text.slice(i).trim() !== '';
      break;
    }
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { endCell(); continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { endRow(); continue; }
    cell += ch;
  }
  if (rows.length < maxRows && (cell !== '' || row.length > 0)) endRow();
  return { rows, truncatedRows, truncatedCols };
}

function CsvTable({ text, delimiter }: { text: string; delimiter: string }): JSX.Element {
  const parsed = useMemo(() => parseDelimited(text, delimiter, TABLE_ROWS + 1, TABLE_COLS), [text, delimiter]);
  const [head, ...body] = parsed.rows;
  if (!head) return <p className="muted">The file is empty.</p>;
  // As wide as the widest row kept, capped: a ragged file loses no cells.
  const width = Math.min(TABLE_COLS, parsed.rows.reduce((w, r) => Math.max(w, r.length), 0));
  const columns = Array.from({ length: width }, (_, i) => i);
  return (
    <div className="ui-table-wrap files-preview-table">
      <table className="ui-table">
        <thead><tr>{columns.map((i) => <th key={i}>{head[i] ?? ''}</th>)}</tr></thead>
        <tbody>{body.slice(0, TABLE_ROWS).map((r, i) => <tr key={i}>{columns.map((j) => <td key={j}>{r[j] ?? ''}</td>)}</tr>)}</tbody>
      </table>
      {parsed.truncatedRows || parsed.truncatedCols ? (
        <p className="muted">Showing the first {TABLE_ROWS} rows{parsed.truncatedCols ? ` and ${TABLE_COLS} columns` : ''}. The download has the whole file.</p>
      ) : null}
    </div>
  );
}
