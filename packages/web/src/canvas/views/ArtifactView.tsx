/**
 * A file the owner attached, opened on the canvas.
 *
 * The preview is the same one the Files library draws (chat/ArtifactPreview):
 * an image at the size the panel allows, a PDF in the browser's own viewer,
 * text and tables as text. Anything else is named and measured, with the one
 * thing you can do with it — take a copy — as the panel's only button: a menu
 * for a document buddi converts (PDF and Word, Excel), one button otherwise. The
 * agent reads the same file through its tools; this panel is for you.
 *
 * A text file — Markdown, a table as CSV, JSON, code, a log — opens in the
 * editor instead (`TextFileView`): read it, change it, save it back.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api';
import { ArtifactPreview } from '../../chat/ArtifactPreview';
import { Notice } from '../../ui';
import { DownloadMenu } from '../../chat/DownloadMenu';
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
  // A file deleted from Files says so, rather than a preview that fails to load.
  const [deleted, setDeleted] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setDeleted(false);
    api.file(attachment.fileId ?? attachment.artifactId)
      .catch((err: unknown) => { if (!cancelled && err instanceof ApiError && err.status === 404) setDeleted(true); });
    return () => { cancelled = true; };
  }, [attachment.artifactId, attachment.fileId]);
  if (deleted) {
    return <div className="wb-artifact" data-testid="artifact-view"><Notice role="status">This file was deleted from Files.</Notice></div>;
  }

  return (
    <div className="wb-artifact" data-family={family} data-testid="artifact-view">
      <ArtifactPreview artifactId={attachment.artifactId} filename={attachment.filename ?? null} mime={attachment.mime} family={family} />
      <dl className="ui-kv">
        <dt>Type</dt><dd>{FAMILY_LABEL[family]}<span className="wb-artifact-mime mono">{attachment.mime}</span></dd>
        {attachment.sizeBytes ? <><dt>Size</dt><dd>{formatBytes(attachment.sizeBytes)}</dd></> : null}
        <dt>Id</dt><dd className="mono">{attachment.artifactId}</dd>
      </dl>
      <div className="ui-toolbar" data-align="end">
        <FileVersionsLink fileId={attachment.fileId ?? attachment.artifactId} />
        <DownloadMenu artifactId={attachment.artifactId} filename={attachment.filename} mime={attachment.mime} />
      </div>
    </div>
  );
}
