/**
 * A file the owner attached, opened on the canvas.
 *
 * The preview is the same one the Files library draws (chat/ArtifactPreview):
 * an image at the size the panel allows, a PDF in the browser's own viewer,
 * text and tables as text, a Word, Excel or PowerPoint file drawn by buddi —
 * always the file's newest version, with who wrote it. An Office document
 * also opens in the owner's own app (chat/OpenInApp), and what he saves
 * there comes back as his next version. Anything else is named and measured, with the one
 * thing you can do with it — take a copy — as the panel's only button: a menu
 * for a document buddi converts (PDF and Word, Excel), one button otherwise. The
 * agent reads the same file through its tools; this panel is for you.
 *
 * A text file — Markdown, a table as CSV, JSON, code, a log — opens in the
 * editor instead (`TextFileView`): read it, change it, save it back.
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type FileView } from '../../api';
import { ArtifactPreview } from '../../chat/ArtifactPreview';
import { Notice } from '../../ui';
import { DownloadMenu } from '../../chat/DownloadMenu';
import { OpenInAppBar, OpenInAppButton, opensInApp, useOpenInApp } from '../../chat/OpenInApp';
import {
  artifactTabId,
  FAMILY_LABEL,
  familyOf,
  formatBytes,
  type AttachmentBlock,
} from '../../chat/attachments';
import { isTextFile } from '../text-files';
import { TextFileView } from './TextFileView';
import { FileVersionsLink } from './FileVersionsLink';

export interface ArtifactViewProps {
  attachment: AttachmentBlock;
  /** The tab it is open in, when that is not the file's own (a file a run produced). */
  tabId?: string;
}

export function ArtifactView({ attachment, tabId }: ArtifactViewProps): JSX.Element {
  if (isTextFile(attachment.mime, attachment.filename)) {
    return <TextFileView attachment={attachment} tabId={tabId ?? artifactTabId(attachment.artifactId)} />;
  }
  return <FileCard attachment={attachment} />;
}

function FileCard({ attachment }: { attachment: AttachmentBlock }): JSX.Element {
  const family = familyOf(attachment.mime, attachment.filename);
  const fileKey = attachment.fileId ?? attachment.artifactId;
  // The file's newest version: what the card previews, and who wrote it.
  const [view, setView] = useState<FileView | null>(null);
  // A file deleted from Files says so, rather than a preview that fails to load.
  const [deleted, setDeleted] = useState(false);
  /** Bumped when a save in the owner's app brought a new version back. */
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setDeleted(false);
    api.file(fileKey)
      .then((found) => { if (!cancelled) setView(found); })
      .catch((err: unknown) => { if (!cancelled && err instanceof ApiError && err.status === 404) setDeleted(true); });
    return () => { cancelled = true; };
  }, [fileKey, attachment.artifactId, revision]);
  const inApp = opensInApp(attachment.mime, attachment.filename);
  const app = useOpenInApp(fileKey, () => setRevision((n) => n + 1));
  if (deleted) {
    return <div className="wb-artifact" data-testid="artifact-view"><Notice role="status">This file was deleted from Files.</Notice></div>;
  }
  // Until Files answers, the version the conversation named.
  const shown = view?.current.artifactId ?? attachment.artifactId;
  const by = view ? (view.current.createdBy === 'owner' ? 'you' : view.current.createdBy) : null;

  return (
    <div className="wb-artifact" data-family={family} data-testid="artifact-view">
      {inApp ? <OpenInAppBar app={app} /> : null}
      <ArtifactPreview key={shown} artifactId={shown} filename={attachment.filename ?? null} mime={attachment.mime} family={family} />
      <dl className="ui-kv">
        <dt>Type</dt><dd>{FAMILY_LABEL[family]}<span className="wb-artifact-mime mono">{attachment.mime}</span></dd>
        {attachment.sizeBytes ? <><dt>Size</dt><dd>{formatBytes(attachment.sizeBytes)}</dd></> : null}
        {view && by ? <><dt>Newest</dt><dd>v{view.current.version}, by {by}</dd></> : null}
        <dt>Id</dt><dd className="mono">{shown}</dd>
      </dl>
      <div className="ui-toolbar" data-align="end">
        <FileVersionsLink fileId={fileKey} revision={view?.current.version ?? 0} />
        {inApp ? <OpenInAppButton app={app} /> : null}
        <DownloadMenu artifactId={shown} filename={attachment.filename} mime={attachment.mime} />
      </div>
    </div>
  );
}
