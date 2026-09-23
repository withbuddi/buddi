/**
 * The Files tab: the conversation's agent's workspace, read by the owner.
 *
 * A folder list with a breadcrumb rather than a tree, because the canvas is
 * often a third of the window and a tree four levels deep is mostly
 * indentation there. Clicking a folder walks into it; clicking a file opens it
 * in the same tab — text as text, an image as itself, a PDF in the browser's
 * own viewer, anything else as its size and a download.
 *
 * Every read is a plugin page query, named by what `GET /api/pages` served
 * under `files` — this file knows no plugin and no query by name. The plugin
 * holds the reads to the workspace (no `..`, no link, no deny-listed path) and
 * the gateway decides what may be shown inline; this page only links to them.
 *
 * Read-only on purpose: no edit, no delete, no upload. A file for the agent
 * goes through the Files library, which the empty state points at.
 *
 * `revision` is how many file changes the conversation has seen (a result
 * carrying a `diff` and a `path`); when it grows, what is on screen is read
 * again, and a file's URL carries its size and mtime, so an overwritten file
 * is fetched afresh rather than served from the browser's cache.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { formatBytes } from '../../chat/attachments';
import type { PluginWorkspaceFiles } from '../../pages/types';
import { FILES_ROUTE } from '../../routes';
import { Button, ButtonLink, Empty, KV, List, ListRow, Notice, Spacer, Toolbar } from '../../ui';

export interface FilesViewProps {
  files: PluginWorkspaceFiles;
  agentId: string;
  /** The workspace directory's own name, the breadcrumb's first step. */
  root: string;
  revision: number;
}

interface FolderEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  bytes: number | null;
  mtimeMs: number | null;
}

interface Folder {
  path: string;
  entries: FolderEntry[];
  skipped: number;
  truncated: boolean;
}

interface FileStat {
  path: string;
  name: string;
  bytes: number;
  mtimeMs: number;
  type: 'text' | 'image' | 'pdf' | 'other';
  mime: string;
}

/** Past this, a text file is a download: a megabyte of text is not read on a canvas. */
export const TEXT_VIEW_MAX_BYTES = 1024 * 1024;

type Place = { kind: 'dir' | 'file'; path: string };

export function FilesView({ files, agentId, root, revision }: FilesViewProps): JSX.Element {
  const [place, setPlace] = useState<Place>({ kind: 'dir', path: '' });
  // Another agent's workspace is another tab's: start again at its root.
  useEffect(() => setPlace({ kind: 'dir', path: '' }), [files.plugin, agentId]);

  return (
    <div className="wb-files" data-testid="files-view">
      {place.kind === 'dir' ? (
        <FolderPanel files={files} agentId={agentId} root={root} path={place.path} revision={revision} go={setPlace} />
      ) : (
        <FilePanel files={files} agentId={agentId} root={root} path={place.path} revision={revision} go={setPlace} />
      )}
    </div>
  );
}

/** `root / src / app.ts`, each step but the last a way back. */
function Crumbs({ root, path, go }: { root: string; path: string; go: (place: Place) => void }): JSX.Element {
  const parts = path === '' ? [] : path.split('/');
  const steps = [{ label: root, path: '' }, ...parts.map((part, index) => ({ label: part, path: parts.slice(0, index + 1).join('/') }))];
  return (
    <nav className="wb-files-crumbs" aria-label="Where you are in the workspace">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <span key={step.path} className="wb-files-crumb">
            {index > 0 ? <span className="wb-files-sep" aria-hidden="true">/</span> : null}
            {last ? (
              <span className="wb-files-here mono" aria-current="location">{step.label}</span>
            ) : (
              <button type="button" className="wb-files-step mono" onClick={() => go({ kind: 'dir', path: step.path })}>
                {step.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function FolderPanel({
  files,
  agentId,
  root,
  path,
  revision,
  go,
}: {
  files: PluginWorkspaceFiles;
  agentId: string;
  root: string;
  path: string;
  revision: number;
  go: (place: Place) => void;
}): JSX.Element {
  const [folder, setFolder] = useState<Folder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [packing, setPacking] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .pageQuery<Folder>(files.plugin, files.list, { agent: agentId, ...(path ? { path } : {}) })
      .then((body) => { if (!cancelled) setFolder(body.data); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [files.plugin, files.list, agentId, path, revision]);
  useEffect(() => setArchiveError(null), [path]);

  /*
   * Fetched rather than followed: a folder over the cap answers with a
   * sentence naming it, and that sentence belongs on this panel, not in a
   * browser tab showing raw JSON.
   */
  const archive = async (): Promise<void> => {
    setPacking(true);
    setArchiveError(null);
    try {
      const res = await fetch(api.pageFileUrl(files.plugin, files.archive, { agent: agentId, ...(path ? { path } : {}) }), { credentials: 'same-origin' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setArchiveError(body?.error ?? 'The archive could not be made.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${path === '' ? root : path.split('/').at(-1)}.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setArchiveError('The archive could not be made.');
    } finally {
      setPacking(false);
    }
  };

  const entries = folder && folder.path === path ? folder.entries : null;

  return (
    <>
      <Toolbar>
        <Crumbs root={root} path={path} go={go} />
        <Spacer />
        <Button size="sm" onClick={() => void archive()} disabled={packing || entries === null || entries.length === 0}>
          {packing ? 'Packing…' : 'Download as archive'}
        </Button>
      </Toolbar>
      {archiveError ? <Notice tone="warning" role="alert">{archiveError}</Notice> : null}
      {error ? <Notice tone="critical" role="alert">{error}</Notice> : null}
      {entries === null ? (
        error ? null : <Empty>Reading the folder…</Empty>
      ) : entries.length === 0 ? (
        <Empty>
          {path === ''
            ? <>Nothing in this workspace yet. To hand the agent a file, add it to the <a href={FILES_ROUTE}>Files library</a> and mention it here.</>
            : 'This folder is empty.'}
        </Empty>
      ) : (
        <List>
          {entries.map((entry) => (
            <ListRow
              key={entry.path}
              href="#"
              onClick={() => go({ kind: entry.kind, path: entry.path })}
              lead={<EntryIcon kind={entry.kind} />}
              title={<span className="mono">{entry.name}{entry.kind === 'dir' ? '/' : ''}</span>}
              side={entry.kind === 'file' ? formatBytes(entry.bytes) : undefined}
            />
          ))}
        </List>
      )}
      {folder && folder.path === path && (folder.skipped > 0 || folder.truncated) ? (
        <p className="wb-files-note">
          {folder.truncated ? `Only the first ${folder.entries.length} entries are shown. ` : ''}
          {folder.skipped > 0 ? `${folder.skipped} ${folder.skipped === 1 ? 'entry is' : 'entries are'} not shown: symbolic links and protected paths are never read.` : ''}
        </p>
      ) : null}
    </>
  );
}

function FilePanel({
  files,
  agentId,
  root,
  path,
  revision,
  go,
}: {
  files: PluginWorkspaceFiles;
  agentId: string;
  root: string;
  path: string;
  revision: number;
  go: (place: Place) => void;
}): JSX.Element {
  const [stat, setStat] = useState<FileStat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .pageQuery<FileStat>(files.plugin, files.stat, { agent: agentId, path })
      .then((body) => { if (!cancelled) setStat(body.data); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [files.plugin, files.stat, agentId, path, revision]);

  const current = stat && stat.path === path ? stat : null;
  // Size and mtime in the URL: a file written since is a different URL.
  const version = current ? `${current.bytes}-${Math.round(current.mtimeMs)}` : '';
  const src = current ? api.pageFileUrl(files.plugin, files.read, { agent: agentId, path, v: version }) : '';
  const download = api.pageFileUrl(files.plugin, files.read, { agent: agentId, path, download: '1' });
  const showsText = current?.type === 'text' && current.bytes <= TEXT_VIEW_MAX_BYTES;

  return (
    <>
      <Toolbar>
        <Crumbs root={root} path={path} go={go} />
        <Spacer />
        {showsText ? (
          <Button size="sm" aria-pressed={wrap} onClick={() => setWrap((on) => !on)}>Wrap</Button>
        ) : null}
        <ButtonLink size="sm" href={download} download={current?.name ?? path.split('/').at(-1)}>Download</ButtonLink>
      </Toolbar>
      {error ? <Notice tone="critical" role="alert">{error}</Notice> : null}
      {current === null ? (
        error ? null : <Empty>Reading the file…</Empty>
      ) : current.type === 'image' ? (
        <figure className="wb-files-picture"><img src={src} alt={current.name} /></figure>
      ) : current.type === 'pdf' ? (
        <div className="file-preview file-preview-pdf">
          <object data={src} type="application/pdf" aria-label={current.name}>
            <Notice>Your browser cannot show this PDF here. Download it to open it.</Notice>
          </object>
        </div>
      ) : showsText ? (
        <TextBody src={src} wrap={wrap} />
      ) : (
        <>
          <Notice>
            {current.type === 'text'
              ? `This file is over ${formatBytes(TEXT_VIEW_MAX_BYTES)}, too long to read here. Download it to open it.`
              : 'This kind of file is not shown here. Download it to open it.'}
          </Notice>
          <KV items={[{ label: 'Size', value: formatBytes(current.bytes) }, { label: 'Type', value: <span className="mono">{current.mime}</span> }]} />
        </>
      )}
    </>
  );
}

/** The text itself, as text nodes: nothing in it is ever markup here. */
function TextBody({ src, wrap }: { src: string; wrap: boolean }): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetch(src, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.text();
        if (!cancelled) setText(body);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [src]);
  if (failed) return <Notice tone="critical">The file could not be read.</Notice>;
  if (text === null) return <Empty>Reading the file…</Empty>;
  if (text === '') return <Empty>This file is empty.</Empty>;
  return <pre className="wb-files-text" data-wrap={wrap ? 'true' : undefined} data-testid="files-text">{text}</pre>;
}

function EntryIcon({ kind }: { kind: 'file' | 'dir' }): JSX.Element {
  return (
    <span className="wb-files-icon" data-kind={kind} aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
        {kind === 'dir' ? <path d="M2 4.2h4.2l1.4 1.6H14v7H2z" /> : <path d="M4 2.4h5l3 3v8.2H4zM9 2.4v3h3" />}
      </svg>
    </span>
  );
}
