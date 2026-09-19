/**
 * One file, drawn the same way everywhere it appears.
 *
 * An image is its own thumbnail. Anything else is a mark for its family, the
 * name, and the size — enough to tell a statement from a screenshot without
 * opening either. The tile is a button when there is somewhere to go (the
 * canvas), and a plain figure when there is not (a file still uploading).
 */
import { FAMILY_LABEL, familyOf, formatBytes, type FileFamily } from './attachments';

export function FileTile({
  name,
  mime,
  sizeBytes,
  thumbnail,
  state,
  error,
  onOpen,
  onRemove,
  size = 'md',
}: {
  name: string;
  mime: string;
  sizeBytes?: number | null;
  /** A URL to draw instead of a family mark. Only for images. */
  thumbnail?: string | null;
  state?: 'uploading' | 'ready' | 'failed';
  error?: string | undefined;
  onOpen?: () => void;
  onRemove?: () => void;
  size?: 'sm' | 'md';
}): JSX.Element {
  const family = familyOf(mime, name);
  const meta = [FAMILY_LABEL[family], formatBytes(sizeBytes)].filter(Boolean).join(' · ');
  const body = (
    <>
      <span className="wb-file-visual" data-family={family}>
        {thumbnail ? <img src={thumbnail} alt="" /> : <FamilyMark family={family} />}
      </span>
      <span className="wb-file-text">
        <span className="wb-file-name" title={name}>{name}</span>
        <span className="wb-file-meta">
          {state === 'uploading' ? 'Uploading…' : state === 'failed' ? (error ?? 'Upload failed') : meta}
        </span>
      </span>
    </>
  );

  return (
    <span
      className="wb-file"
      data-size={size}
      data-state={state}
      data-thumb={thumbnail ? 'true' : undefined}
      title={state === 'failed' ? error : undefined}
    >
      {onOpen ? (
        <button type="button" className="wb-file-open" onClick={onOpen} aria-label={`Open ${name}`}>
          {body}
        </button>
      ) : (
        <span className="wb-file-open">{body}</span>
      )}
      {onRemove ? (
        <button type="button" className="wb-file-x" aria-label={`Remove ${name}`} onClick={onRemove}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
          </svg>
        </button>
      ) : null}
    </span>
  );
}

/** Each family as the mark it makes: a frame, a page, a grid, a wave. */
export function FamilyMark({ family }: { family: FileFamily }): JSX.Element {
  const common = { width: 20, height: 20, viewBox: '0 0 20 20', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (family) {
    case 'image':
      return <svg {...common}><rect x="3" y="4" width="14" height="12" rx="2" /><circle cx="7.5" cy="8.5" r="1.4" /><path d="M17 13l-3.6-3.6a1 1 0 0 0-1.4 0L6 15.5" /></svg>;
    case 'pdf':
      return <svg {...common}><path d="M6 2.5h5.5L16 7v9.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z" /><path d="M11.5 2.5V7H16" /><path d="M7.5 13.5h5M7.5 11h5" /></svg>;
    case 'table':
      return <svg {...common}><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M3 8.5h14M3 12.5h14M8 4v12M13 4v12" /></svg>;
    case 'text':
      return <svg {...common}><path d="M6 2.5h5.5L16 7v9.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z" /><path d="M11.5 2.5V7H16" /><path d="M7.5 10.5h5M7.5 13.5h3.5" /></svg>;
    case 'code':
      return <svg {...common}><path d="M7 6l-4 4 4 4M13 6l4 4-4 4M11.5 4l-3 12" /></svg>;
    case 'audio':
      return <svg {...common}><path d="M4 8v4M7.5 5.5v9M11 3.5v13M14.5 6.5v7M18 8.5v3" /></svg>;
    case 'video':
      return <svg {...common}><rect x="3" y="5" width="10" height="10" rx="1.5" /><path d="M13 9l4-2.5v7L13 11" /></svg>;
    case 'archive':
      return <svg {...common}><rect x="4" y="3" width="12" height="14" rx="1.5" /><path d="M10 3v3M10 8v2M10 12v2M8.5 14h3" /></svg>;
    default:
      return <svg {...common}><path d="M6 2.5h5.5L16 7v9.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z" /><path d="M11.5 2.5V7H16" /></svg>;
  }
}
