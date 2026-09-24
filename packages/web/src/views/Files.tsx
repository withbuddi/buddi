/**
 * Files: the owner's library over the artifact store (docs/files.md).
 *
 * Everything an agent produced and everything the owner sent, across every
 * conversation, newest first, with a name to search by and two filters that
 * describe origin and family. Selecting one keeps the list in place and
 * opens the file beside it: a preview where one is safe, always a download,
 * and the conversations it was part of, each one a link back.
 *
 * The preview is the one the canvas uses (chat/ArtifactPreview), so a file
 * looks the same wherever it is opened. Nothing here edits, runs an agent,
 * or fetches off this origin.
 */
export { parseDelimited } from '../chat/ArtifactPreview';
import { useEffect, useRef, useState } from 'react';
import type { PlaceProps } from '../App';
import { ApiError, api, type LibraryContext, type LibraryEntry } from '../api';
import { ArtifactPreview } from '../chat/ArtifactPreview';
import { FAMILY_LABEL, downloadUrl, formatBytes, previewUrl } from '../chat/attachments';
import { FamilyMark } from '../chat/FileTile';
import { fmtRelative, fmtTime } from '../format';
import { chatRoute, fileRoute, groupChatRoute, parseFileRoute } from '../routes';
import { AgentAvatar, Button, Chip, Empty, ErrorBanner, Field, FormGrid, KV, List, Notice, PickRow, SearchBar, Split, Toolbar } from '../ui';

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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const nameOf = (id: string | null): string => (id ? agents.find((a) => a.id === id)?.name ?? id : '');

  // A change of search or filters restarts the listing; a page that arrives
  // for an older query is dropped rather than shown under the new one.
  const generation = useRef(0);
  useEffect(() => {
    const mine = ++generation.current;
    setEntries(null);
    setNext(null);
    setLoadingMore(false);
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

  const on = (origin ? 1 : 0) + (family ? 1 : 0);
  const originName = ORIGINS.find((o) => o.id === origin)?.label ?? origin;
  const list = (
    <>
      {entries === null ? (
        <Empty>Loading…</Empty>
      ) : entries.length === 0 ? (
        <Empty>No file matches that.</Empty>
      ) : (
        <List>
          {entries.map((entry) => (
            <PickRow
              key={entry.id}
              href={fileRoute(entry.id, { q, origin, family })}
              current={entry.id === selectedId}
              onClick={() => navigate(fileRoute(entry.id, { q, origin, family }))}
              lead={
                <span className="files-row-visual" data-family={entry.family}>
                  {entry.family === 'image' && !entry.deleted ? <img src={previewUrl(entry.id)} alt="" loading="lazy" /> : <FamilyMark family={entry.family} />}
                </span>
              }
              title={entry.filename ?? 'Untitled file'}
              meta={<span title={fmtTime(entry.createdAt, timezone)}>{fmtRelative(entry.createdAt)}</span>}
              sub={`${FAMILY_LABEL[entry.family]} · ${formatBytes(entry.sizeBytes)} · ${originLabel(entry, nameOf)}${contextLabel(entry, nameOf)}`}
            />
          ))}
        </List>
      )}
      {next ? (
        <div className="files-more">
          <Button size="sm" onClick={more} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Show more'}</Button>
        </div>
      ) : null}
    </>
  );

  // Nothing in the library at all, and nothing asked: the kit's warm empty
  // state, on its own, rather than an empty list beside an empty pane.
  const bare = entries !== null && entries.length === 0 && !q && !origin && !family && !typed;

  return (
    <div className="ui-page files" data-selected={selectedId ? 'true' : undefined}>
      <header className="ui-page-head">
        <h2 className="ui-page-title">Files</h2>
        <p className="ui-page-lede">What your agents made or were given.</p>
      </header>
      {bare ? (
        <Empty warm title="Nothing here yet">Drop a file into any conversation and it shows up here too.</Empty>
      ) : (
        <>
          <SearchBar
            label="Files"
            onSubmit={() => setFilters({ q: typed }, true)}
            main={<input type="search" value={typed} placeholder="Search by filename" aria-label="Search files by name" onChange={(e) => setTyped(e.target.value)} />}
            filters={
              <FormGrid dense>
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
              </FormGrid>
            }
            filtersOpen={filtersOpen}
            onToggleFilters={() => setFiltersOpen((v) => !v)}
            active={on}
            chips={
              on > 0 ? (
                <>
                  {origin ? <Chip label="Origin" onRemove={() => setFilters({ origin: '' })}>{originName}</Chip> : null}
                  {family ? <Chip label="Kind" onRemove={() => setFilters({ family: '' })}>{FAMILY_LABEL[family as LibraryEntry['family']]}</Chip> : null}
                </>
              ) : undefined
            }
          />
          <ErrorBanner message={error} />
          <Split
            className="files-split"
            label="Files"
            list={list}
            detail={
              selectedId ? (
                <FileDetail key={selectedId} id={selectedId} timezone={timezone} agents={agents} navigate={navigate} onBack={() => navigate(fileRoute(null, { q, origin, family }))} />
              ) : undefined
            }
            empty="Choose a file to see it here."
          />
        </>
      )}
    </div>
  );
}

/** Where it was: the group, or the agent, of its first conversation; and how many more. */
function contextLabel(entry: LibraryEntry, nameOf: (id: string | null) => string): string {
  // The agent it was with is left out when that is the agent that made it: one name, not two.
  const where = entry.context?.groupName ? `in ${entry.context.groupName}`
    : entry.context?.agentId && entry.context.agentId !== entry.agentId ? `with ${nameOf(entry.context.agentId)}` : '';
  const more = entry.contexts > 1 ? `${entry.contexts} conversations` : '';
  return [where, more].filter(Boolean).map((part) => ` · ${part}`).join('');
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
      <ArtifactPreview artifactId={entry.id} filename={entry.filename} mime={entry.mime} family={entry.family} available={available} />
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

