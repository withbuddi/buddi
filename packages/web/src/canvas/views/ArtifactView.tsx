/**
 * A file the owner attached, opened on the canvas.
 *
 * The preview is the same one the Files library draws (chat/ArtifactPreview):
 * an image at the size the panel allows, a PDF in the browser's own viewer,
 * text and tables as text. Anything else is named and measured, with the one
 * thing you can do with it — take a copy — as the panel's only button. The
 * agent reads the same file through its tools; this panel is for you.
 */
import { ArtifactPreview } from '../../chat/ArtifactPreview';
import {
  FAMILY_LABEL,
  downloadUrl,
  familyOf,
  formatBytes,
  type AttachmentBlock,
} from '../../chat/attachments';

export interface ArtifactViewProps {
  attachment: AttachmentBlock;
}

export function ArtifactView({ attachment }: ArtifactViewProps): JSX.Element {
  const family = familyOf(attachment.mime, attachment.filename);
  const name = attachment.filename ?? 'Untitled file';

  return (
    <div className="wb-artifact" data-family={family} data-testid="artifact-view">
      <ArtifactPreview artifactId={attachment.artifactId} filename={attachment.filename ?? null} mime={attachment.mime} family={family} />
      <dl className="ui-kv">
        <dt>Type</dt><dd>{FAMILY_LABEL[family]}<span className="wb-artifact-mime mono">{attachment.mime}</span></dd>
        {attachment.sizeBytes ? <><dt>Size</dt><dd>{formatBytes(attachment.sizeBytes)}</dd></> : null}
        <dt>Id</dt><dd className="mono">{attachment.artifactId}</dd>
      </dl>
      <div className="ui-toolbar" data-align="end">
        <a className="ui-btn" href={downloadUrl(attachment.artifactId)} download={name}>Download</a>
      </div>
    </div>
  );
}
