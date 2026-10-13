/**
 * A text file on the canvas, open to read and to edit.
 *
 * The file is fetched whole (`GET /api/artifacts/:id/content`, at most 1 MiB;
 * a bigger one opens read-only, its start only) and drawn in the editor —
 * CodeMirror, loaded on first use — or, for Markdown, as the page draws
 * Markdown, with Edit beside it. A table can be seen as its table.
 *
 * Live: the tab is handed the newest version the conversation has. When buddi
 * writes the file again it is read again, in place, and the lines that
 * changed are marked for a moment. An edit the owner has not saved is never
 * replaced under him: a bar says buddi changed the file and offers theirs or
 * his. A save names the version it started from; a file that moved on since
 * comes back 409 with the version that won, and the same bar.
 *
 * Unsaved edits live in `file-drafts`, not here: a tab in the back is not
 * mounted, and the strip draws a dot for one.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError, type FileContent } from '../../api';
import { CsvTable } from '../../chat/ArtifactPreview';
import { DownloadMenu } from '../../chat/DownloadMenu';
import type { AttachmentBlock } from '../../chat/attachments';
import { Markdown } from '../../chat/markdown';
import { Button, Empty, Notice, Segment } from '../../ui';
import { getDraft, getPin, setDraft, setPin, useDirtyTabs } from '../file-drafts';
import { changedLines, isMarkdown, languageOf } from '../text-files';

const CodeEditor = lazy(() => import('./CodeEditor'));

/** How long buddi's changed lines stay marked. */
export const MARK_MS = 2_500;

export interface TextFileViewProps {
  attachment: AttachmentBlock;
  /** The tab this file is open in: what its unsaved edit is kept under. */
  tabId: string;
}

/** One version of the file as the server gave it, its line endings as the editor keeps them (LF). */
interface Version {
  artifactId: string;
  sha256: string;
  text: string;
  editable: boolean;
  /** Stored with CRLF line endings: a save writes them back. */
  crlf: boolean;
  /** Why it is read-only, when it is. */
  note?: 'encoding' | 'size';
}

/** buddi's version, waiting on the owner's choice. `retry` when his save of the same file was refused. */
interface Theirs extends Version {
  retry: boolean;
}

function versionOf(artifactId: string, content: FileContent): Version {
  const crlf = content.text.includes('\r\n');
  return {
    artifactId,
    sha256: content.sha256,
    text: crlf ? content.text.replace(/\r\n/g, '\n') : content.text,
    editable: content.editable,
    crlf,
    ...(content.editable ? {} : { note: content.note === 'encoding' ? 'encoding' as const : 'size' as const }),
  };
}

/** The text as it goes back to the server: the file's own line endings. */
function onDisk(text: string, crlf: boolean | undefined): string {
  return crlf ? text.replace(/\r?\n/g, '\r\n') : text;
}

export function TextFileView({ attachment, tabId }: TextFileViewProps): JSX.Element {
  const target = attachment.artifactId;
  const filename = attachment.filename ?? null;
  const markdown = isMarkdown(filename, attachment.mime);
  const table = /\.(csv|tsv)$/i.test(filename ?? '') || /csv|tab-separated/.test(attachment.mime);
  const previewable = markdown || table;
  // Markdown and tables open as they read; everything else opens to edit.
  const [mode, setMode] = useState<'preview' | 'edit'>(previewable ? 'preview' : 'edit');
  /** The version the editor's text is based on. */
  const [file, setFile] = useState<Version | null>(null);
  const [text, setText] = useState('');
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [theirs, setTheirs] = useState<Theirs | null>(null);
  const [changed, setChanged] = useState<readonly number[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = useDirtyTabs().has(tabId);
  const markTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The text last read from the server and shown as it was: what a new version is compared with. */
  const shown = useRef<string | null>(null);
  /** False once the panel is gone: a save coming back then only settles the store. */
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const mark = useCallback((lines: readonly number[]): void => {
    if (markTimer.current) clearTimeout(markTimer.current);
    setChanged(lines);
    markTimer.current = lines.length === 0 ? null : setTimeout(() => setChanged([]), MARK_MS);
  }, []);
  useEffect(() => () => { if (markTimer.current) clearTimeout(markTimer.current); }, []);

  // The newest version, whenever the conversation has a newer one — or the
  // one the owner settled on, while the conversation names nothing newer.
  useEffect(() => {
    let cancelled = false;
    setLoadFailed(null);
    const pin = getPin(tabId);
    if (pin && pin.target !== target) setPin(tabId, null);
    const open = pin && pin.target === target ? pin.artifactId : target;
    api.fileContent(open)
      .then((content) => {
        if (cancelled) return;
        const arrived = versionOf(open, content);
        const draft = getDraft(tabId);
        if (draft) {
          // His edit stays. If it started from another version, he chooses.
          setText(draft.text);
          setFile((current) => current ?? (draft.base === arrived.sha256 ? arrived
            : { artifactId: draft.artifactId, sha256: draft.base, text: draft.baseText, editable: true, crlf: draft.crlf === true }));
          if (draft.base !== arrived.sha256) setTheirs({ ...arrived, retry: false });
          return;
        }
        const before = shown.current;
        shown.current = arrived.text;
        setFile(arrived);
        setText(arrived.text);
        setTheirs(null);
        if (before !== null && before !== arrived.text) mark(changedLines(before, arrived.text));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadFailed(err instanceof ApiError && err.status === 410 ? 'The file’s contents are gone from disk.' : 'The file could not be loaded.');
      });
    return () => { cancelled = true; };
  }, [target, tabId, mark]);

  const edit = (next: string): void => {
    setText(next);
    if (!file) return;
    setDraft(tabId, { artifactId: file.artifactId, base: file.sha256, baseText: file.text, text: next, crlf: file.crlf });
  };

  const save = useCallback(async (): Promise<void> => {
    const sent = getDraft(tabId);
    if (!sent || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveFileContent(sent.artifactId, { text: onDisk(sent.text, sent.crlf), base: sent.base });
      const version: Version = { artifactId: sent.artifactId, sha256: saved.sha256, text: sent.text, editable: true, crlf: sent.crlf === true };
      setPin(tabId, { target, artifactId: sent.artifactId });
      /*
       * What he typed while the save was out stays, now over the version just
       * saved. A draft that moved to another base meanwhile (he chose theirs,
       * or kept his over theirs) is not this save's to touch.
       */
      const now = getDraft(tabId);
      if (now && now.base === sent.base && now.artifactId === sent.artifactId) {
        setDraft(tabId, { ...now, base: saved.sha256, baseText: sent.text });
      }
      if (mounted.current && (!now || (now.base === sent.base && now.artifactId === sent.artifactId))) {
        shown.current = version.text;
        setFile(version);
        setTheirs(null);
      }
    } catch (err) {
      if (!mounted.current) return;
      const current = err instanceof ApiError && err.status === 409
        ? (err.detail as { current?: { artifactId?: unknown } } | null)?.current
        : undefined;
      if (current && typeof current.artifactId === 'string') {
        const id = current.artifactId;
        const content = await api.fileContent(id).catch(() => null);
        // Saved again at once only onto the same file; another file is his to look at first.
        if (content) setTheirs({ ...versionOf(id, content), retry: id === sent.artifactId });
        else setError('buddi changed this file, and its version could not be loaded. Try again.');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [tabId, saving, target]);

  /** Drop the edit and take buddi's version, its changes marked against his. */
  const showTheirs = (): void => {
    if (!theirs) return;
    const mine = text;
    const { retry: _retry, ...version } = theirs;
    setDraft(tabId, null);
    setPin(tabId, { target, artifactId: version.artifactId });
    shown.current = version.text;
    setFile(version);
    setText(version.text);
    setTheirs(null);
    mark(changedLines(mine, version.text));
  };

  /** Keep the edit, now over buddi's version; saved at once only when his save of that file was refused. */
  const keepMine = (): void => {
    if (!theirs) return;
    const { retry, ...version } = theirs;
    setFile(version);
    setPin(tabId, { target, artifactId: version.artifactId });
    setDraft(tabId, { artifactId: version.artifactId, base: version.sha256, baseText: version.text, text, crlf: version.crlf });
    setTheirs(null);
    if (retry) void save();
  };

  // Cmd/Ctrl+S saves from anywhere in the panel, the preview included; the editor handles its own.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  };

  const readOnly = file !== null && !file.editable;
  const label = filename ?? 'File';
  return (
    <div className="wb-textfile" data-testid="text-file" onKeyDown={onKeyDown}>
      {theirs ? (
        <Notice tone="warning" role="status" action={
          <span className="ui-toolbar">
            <Button size="sm" onClick={showTheirs}>Show theirs</Button>
            <Button size="sm" variant="accent" onClick={keepMine}>Keep mine</Button>
          </span>
        }>
          buddi changed this file
        </Notice>
      ) : null}
      {readOnly ? <Notice>{file?.note === 'encoding'
        ? 'This file is not UTF-8 text, so it opens read-only: saving it from here would change its characters.'
        : 'This file is over 1 MB, so it opens read-only and shows its start. Download it for the whole file.'}</Notice> : null}
      {error ? <Notice tone="critical" role="alert">{error}</Notice> : null}
      {loadFailed ? <Notice>{loadFailed} Download it to open it.</Notice>
        : file === null ? <div className="file-preview"><Empty>Loading…</Empty></div>
        : previewable && mode === 'preview' ? (
          <div className="wb-textfile-preview" data-testid="text-file-preview">
            {markdown ? <div className="wb-doc"><Markdown text={text} /></div> : <CsvTable text={text} delimiter={/\.tsv$/i.test(filename ?? '') || /tab-separated/.test(attachment.mime) ? '\t' : ','} />}
          </div>
        ) : (
          <Suspense fallback={<div className="file-preview"><Empty>Loading the editor…</Empty></div>}>
            <CodeEditor value={text} onChange={edit} readOnly={readOnly} language={languageOf(filename, attachment.mime)} changed={changed} onSave={() => { void save(); }} label={`Edit ${label}`} />
          </Suspense>
        )}
      <div className="ui-toolbar wb-textfile-bar">
        {previewable ? (
          <Segment label="Show" value={mode} onChange={setMode} options={[{ value: 'preview', label: markdown ? 'Preview' : 'Table' }, { value: 'edit', label: 'Edit' }]} />
        ) : null}
        {changed.length > 0 && mode === 'preview' ? <span className="muted">buddi changed {changed.length === 1 ? 'a line' : `${changed.length} lines`}</span> : null}
        <span className="ui-toolbar-spacer" />
        <DownloadMenu artifactId={file?.artifactId ?? target} filename={filename} mime={attachment.mime} />
        <Button variant="accent" disabled={!dirty || saving || readOnly} onClick={() => { void save(); }} title="Save (⌘S)">
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
