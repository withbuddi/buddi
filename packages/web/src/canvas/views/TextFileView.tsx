/**
 * A text file on the canvas, open to read and to edit.
 *
 * The file's current version is fetched whole (`GET /api/files/:id/content`,
 * at most 1 MiB; a bigger one opens read-only, its start only) and drawn in
 * the editor — CodeMirror, loaded on first use — or, for Markdown, as the
 * page draws Markdown, with Edit beside it. A table can be seen as its table.
 *
 * Live: when the conversation names a newer version (buddi wrote the file
 * again), it is read again, in place, and the lines that changed are marked
 * for a moment. An edit the owner has not saved is never replaced under him:
 * a bar says the file changed and offers theirs or his. A save is a new
 * version over the one he started from; one saved meanwhile comes back 409
 * with that version, and the same bar.
 *
 * Unsaved edits live in `file-drafts`, not here: a tab in the back is not
 * mounted, and the strip draws a dot for one.
 */
import { CHANGED_SINCE } from '@buddi/core/text-files';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError, type FileConflict, type FileContent } from '../../api';
import { CsvTable } from '../../chat/ArtifactPreview';
import { DownloadMenu } from '../../chat/DownloadMenu';
import { FileVersionsLink } from './FileVersionsLink';
import type { AttachmentBlock } from '../../chat/attachments';
import { Markdown } from '../../chat/markdown';
import { Button, Empty, Notice, Segment } from '../../ui';
import { LoadBoundary } from '../../shell/LoadBoundary';
import { getDraft, getEdit, setDraft, useDirtyTabs } from '../file-drafts';
import { changedLines, isMarkdown, languageOf } from '../text-files';

/** Where the editor's chunk comes from; tests swap it. */
export const editorDeps = { load: () => import('./CodeEditor') };
const editor = () => lazy(() => editorDeps.load());
const CodeEditor = editor();

/** How long buddi's changed lines stay marked. */
export const MARK_MS = 2_500;

/** What the bar says whenever the file moved on under an edit: the server's own phrase. */
export { CHANGED_SINCE };

export interface TextFileViewProps {
  attachment: AttachmentBlock;
  /** The tab this file is open in: what its unsaved edit is kept under. */
  tabId: string;
}

/** One version of the file as the server gave it, its line endings as the editor keeps them (LF). */
interface Version {
  fileId: string;
  version: number;
  /** That version's id: what a download names. */
  artifactId: string;
  conversationId: string | null;
  text: string;
  editable: boolean;
  /** Stored with CRLF line endings: a save writes them back. */
  crlf: boolean;
  /** Why it is read-only, when it is. */
  note?: 'encoding' | 'size';
}

/** Their version, waiting on the owner's choice. `retry` when his save of it was refused. */
interface Theirs extends Version {
  retry: boolean;
  /**
   * The copy in buddi's workspace changed, not the file in Files: a command
   * edited it there. Its text is shown; Keep mine writes over that copy.
   */
  workspace?: boolean;
}

function versionOf(content: FileContent): Version {
  const crlf = content.text.includes('\r\n');
  return {
    fileId: content.fileId,
    version: content.version,
    artifactId: content.artifactId,
    conversationId: content.conversationId ?? null,
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

/** The version an edit started from, as the editor holds it. */
function baseOf(draft: { fileId: string; base: number; baseText: string; crlf?: boolean; conversationId?: string | null }, artifactId: string): Version {
  return { fileId: draft.fileId, version: draft.base, artifactId, conversationId: draft.conversationId ?? null, text: draft.baseText, editable: true, crlf: draft.crlf === true };
}

export function TextFileView({ attachment, tabId }: TextFileViewProps): JSX.Element {
  // The file this tab is; a transcript that names no file names a version, which the server resolves.
  const fileKey = attachment.fileId ?? attachment.artifactId;
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
  /** The file was deleted from Files: shown as such, and an unsaved edit can still be kept. */
  const [deleted, setDeleted] = useState(false);
  /** The new file his text was kept as. */
  const [keptAs, setKeptAs] = useState<string | null>(null);
  const [theirs, setTheirs] = useState<Theirs | null>(null);
  const [changed, setChanged] = useState<readonly number[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Saved, with something to say: the workspace copy could not be updated. */
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const dirty = useDirtyTabs().has(tabId);
  /** The editor's lazy component: a fresh import after Retry, since React keeps one that rejected. */
  const [Editor, setEditor] = useState(() => CodeEditor);
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

  /** Take a version as what the editor shows and holds, its changes since the last one marked. */
  const settle = useCallback((arrived: Version): void => {
    const before = shown.current;
    shown.current = arrived.text;
    setFile(arrived);
    setText(arrived.text);
    setTheirs(null);
    setDraft(tabId, { fileId: arrived.fileId, conversationId: arrived.conversationId, base: arrived.version, baseText: arrived.text, text: arrived.text, crlf: arrived.crlf });
    if (before !== null && before !== arrived.text) mark(changedLines(before, arrived.text));
  }, [tabId, mark]);

  // The current version, whenever the conversation names a newer one.
  useEffect(() => {
    let cancelled = false;
    setLoadFailed(null);
    setDeleted(false);
    api.fileContent(fileKey)
      .then((content) => {
        if (cancelled) return;
        const arrived = versionOf(content);
        const draft = getDraft(tabId);
        if (!draft) { settle(arrived); return; }
        // His edit stays. If it started from another version, he chooses.
        setText(draft.text);
        setFile((current) => current ?? (draft.base === arrived.version ? arrived : baseOf(draft, arrived.artifactId)));
        if (draft.base !== arrived.version) setTheirs({ ...arrived, retry: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          // Deleted from Files. His unsaved edit, if any, stays on screen.
          setDeleted(true);
          const draft = getDraft(tabId);
          if (draft) {
            setText(draft.text);
            setFile((current) => current ?? baseOf(draft, attachment.artifactId));
          }
          return;
        }
        setLoadFailed(err instanceof ApiError && err.status === 410 ? 'The file’s contents are gone from disk.' : 'The file could not be loaded.');
      });
    return () => { cancelled = true; };
  }, [fileKey, attachment.artifactId, tabId, settle]);

  const edit = (next: string): void => {
    setText(next);
    if (!file) return;
    const held = getEdit(tabId);
    setDraft(tabId, {
      fileId: file.fileId, conversationId: file.conversationId, base: file.version, baseText: file.text, text: next, crlf: file.crlf,
      ...(held?.overwriteWorkspace && held.base === file.version ? { overwriteWorkspace: true } : {}),
    });
  };

  const save = useCallback(async (): Promise<void> => {
    const sent = getDraft(tabId);
    if (!sent || saving) return;
    setSaving(true);
    setError(null);
    setSavedNote(null);
    try {
      const saved = await api.saveFileVersion(sent.fileId, {
        base: sent.base, text: onDisk(sent.text, sent.crlf), ...(sent.overwriteWorkspace ? { overwriteWorkspace: true as const } : {}),
      });
      if (saved.note && mounted.current) setSavedNote(saved.note);
      /*
       * What the editor holds now becomes an edit over the version just
       * saved — what he typed while the save was out, or even an edit he
       * undid back to the old text, which is now a change. An edit that
       * moved to another version meanwhile (he chose theirs, or kept his
       * over theirs) is not this save's to touch.
       */
      const now = getEdit(tabId);
      const ours = now !== null && now.base === sent.base && now.fileId === sent.fileId;
      if (ours) {
        const { overwriteWorkspace: _done, ...rest } = now;
        setDraft(tabId, { ...rest, base: saved.version, baseText: sent.text });
      }
      if (mounted.current && (now === null || ours)) {
        shown.current = sent.text;
        setFile({ fileId: saved.fileId, version: saved.version, artifactId: saved.artifactId, conversationId: sent.conversationId ?? null, text: sent.text, editable: true, crlf: sent.crlf === true });
        setTheirs(null);
      }
    } catch (err) {
      if (!mounted.current) return;
      const conflict = err instanceof ApiError && err.status === 409 ? err.detail as FileConflict | null : null;
      if (conflict?.conflict === 'workspace' && typeof conflict.workspaceText === 'string') {
        // A command changed buddi's own copy, not Files: that copy is theirs.
        const there = conflict.workspaceText;
        const crlf = there.includes('\r\n');
        setTheirs({ ...baseOf(sent, file?.artifactId ?? attachment.artifactId), text: crlf ? there.replace(/\r\n/g, '\n') : there, crlf, retry: true, workspace: true });
      } else if (conflict?.conflict === 'newer') {
        const content = await api.fileContent(sent.fileId).catch(() => null);
        if (content) setTheirs({ ...versionOf(content), retry: true });
        else setError(`${CHANGED_SINCE}, and its newest version could not be loaded. Try again.`);
      } else if (conflict) {
        setError(conflict.error);
      } else if (err instanceof ApiError && err.status === 404) {
        setDeleted(true);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [tabId, saving, file, attachment.artifactId]);

  /** His text, from a deleted file's editor, kept as a new file of his own: an upload like any other. */
  const saveAsNew = async (): Promise<void> => {
    const draft = getDraft(tabId);
    if (!draft) return;
    try {
      const made = await api.createFile({
        name: filename ?? 'Untitled.txt', mime: attachment.mime, text: onDisk(draft.text, draft.crlf),
        ...(draft.conversationId ? { conversationId: draft.conversationId } : {}),
      });
      // Only the text that was kept: what he typed while it was out is still his edit.
      const now = getEdit(tabId);
      if (now && now.text === draft.text) setDraft(tabId, null);
      else if (now) setDraft(tabId, { ...now, baseText: draft.text });
      if (mounted.current) setKeptAs(made.filename ?? 'a new file');
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** The save is in Files; write the workspace copy again (the same text over the same version). */
  const retryCopy = async (): Promise<void> => {
    if (!file) return;
    try {
      const again = await api.saveFileVersion(file.fileId, { base: file.version, text: onDisk(file.text, file.crlf) });
      if (mounted.current) setSavedNote(again.note ?? null);
    } catch (err) {
      if (mounted.current) setSavedNote(err instanceof Error ? err.message : String(err));
    }
  };

  /** Drop the edit and take their version, its changes marked against his. */
  const showTheirs = (): void => {
    if (!theirs) return;
    const mine = text;
    if (theirs.workspace) {
      // Not in Files yet: his view becomes buddi's copy, to save over Files as it is.
      setText(theirs.text);
      if (file) setDraft(tabId, { fileId: file.fileId, conversationId: file.conversationId, base: file.version, baseText: file.text, text: theirs.text, crlf: theirs.crlf });
      setTheirs(null);
      mark(changedLines(mine, theirs.text));
      return;
    }
    const { retry: _retry, workspace: _workspace, ...version } = theirs;
    shown.current = mine;
    settle(version);
  };

  /** Keep the edit, now over their version; saved at once when his save was the one refused. */
  const keepMine = (): void => {
    if (!theirs) return;
    if (theirs.workspace) {
      // His version over buddi's copy too, as he was saving.
      const draft = getDraft(tabId);
      if (draft) setDraft(tabId, { ...draft, overwriteWorkspace: true });
      setTheirs(null);
      void save();
      return;
    }
    const { retry, workspace: _workspace, ...version } = theirs;
    setFile(version);
    setDraft(tabId, { fileId: version.fileId, conversationId: version.conversationId, base: version.version, baseText: version.text, text, crlf: version.crlf });
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
          {CHANGED_SINCE}{theirs.workspace ? ': a command changed its copy in buddi’s workspace.' : ` (v${theirs.version} is newer).`}
        </Notice>
      ) : null}
      {readOnly ? <Notice>{file?.note === 'encoding'
        ? 'This file is not UTF-8 text, so it opens read-only: saving it from here would change its characters.'
        : 'This file is over 1 MB, so it opens read-only and shows its start. Download it for the whole file.'}</Notice> : null}
      {error ? <Notice tone="critical" role="alert">{error}</Notice> : null}
      {savedNote ? <Notice tone="warning" role="status" action={<Button size="sm" onClick={() => { void retryCopy(); }}>Try again</Button>}>{savedNote}</Notice> : null}
      {deleted ? (
        dirty ? (
          <Notice tone="warning" role="status" action={<Button size="sm" variant="accent" onClick={() => { void saveAsNew(); }}>Save as new file</Button>}>
            This file was deleted from Files. Your changes are still here.
          </Notice>
        ) : <Notice role="status">{keptAs ? `Saved as a new file, ${keptAs}, in Files.` : 'This file was deleted from Files.'}</Notice>
      ) : null}
      {loadFailed ? <Notice>{loadFailed} Download it to open it.</Notice>
        : deleted && !dirty ? null
        : file === null ? <div className="file-preview"><Empty>Loading…</Empty></div>
        : previewable && mode === 'preview' ? (
          <div className="wb-textfile-preview" data-testid="text-file-preview">
            {markdown ? <div className="wb-doc"><Markdown text={text} /></div> : <CsvTable text={text} delimiter={/\.tsv$/i.test(filename ?? '') || /tab-separated/.test(attachment.mime) ? '\t' : ','} />}
          </div>
        ) : (
          <LoadBoundary what="the editor" onRetry={() => setEditor(() => editor())} note={dirty ? 'Your changes are kept: save them before you reload.' : undefined}>
            <Suspense fallback={<div className="file-preview"><Empty>Loading the editor…</Empty></div>}>
              <Editor value={text} onChange={edit} readOnly={readOnly} language={languageOf(filename, attachment.mime)} changed={changed} onSave={() => { void save(); }} label={`Edit ${label}`} />
            </Suspense>
          </LoadBoundary>
        )}
      <div className="ui-toolbar wb-textfile-bar">
        {previewable ? (
          <Segment label="Show" value={mode} onChange={setMode} options={[{ value: 'preview', label: markdown ? 'Preview' : 'Table' }, { value: 'edit', label: 'Edit' }]} />
        ) : null}
        {deleted ? null : <FileVersionsLink fileId={file?.fileId ?? fileKey} revision={file?.version ?? 0} />}
        {changed.length > 0 && mode === 'preview' ? <span className="muted">buddi changed {changed.length === 1 ? 'a line' : `${changed.length} lines`}</span> : null}
        <span className="ui-toolbar-spacer" />
        {deleted ? null : <DownloadMenu artifactId={file?.artifactId ?? attachment.artifactId} filename={filename} mime={attachment.mime} />}
        <Button variant="accent" disabled={!dirty || saving || readOnly || deleted} onClick={() => { void save(); }} title="Save (⌘S)">
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
