/**
 * A file the owner attached, opened on the canvas.
 *
 * An image is shown at the size the panel allows, because that is what you
 * clicked it for. Anything else is named and measured, with the one thing you
 * can do with it — take a copy — as the panel's only button. The agent reads
 * the same file through its tools; this panel is for you.
 */
import { useState } from 'react';
import { FamilyMark } from '../../chat/FileTile';
import {
  FAMILY_LABEL,
  downloadUrl,
  familyOf,
  formatBytes,
  isPreviewable,
  previewUrl,
  type AttachmentBlock,
} from '../../chat/attachments';

export interface ArtifactViewProps {
  attachment: AttachmentBlock;
}

export function ArtifactView({ attachment }: ArtifactViewProps): JSX.Element {
  const family = familyOf(attachment.mime, attachment.filename);
  const name = attachment.filename ?? 'Untitled file';
  const [broken, setBroken] = useState(false);
  const picture = isPreviewable(attachment.mime) && !broken;

  return (
    <div className="wb-artifact" data-family={family} data-testid="artifact-view">
      {picture ? (
        <figure className="wb-artifact-picture">
          <img src={previewUrl(attachment.artifactId)} alt={name} onError={() => setBroken(true)} />
        </figure>
      ) : (
        <div className="wb-artifact-mark" aria-hidden="true">
          <FamilyMark family={family} />
        </div>
      )}
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
