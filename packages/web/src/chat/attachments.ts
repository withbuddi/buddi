/**
 * Files in a conversation: what the page knows about one, and how it draws it.
 *
 * A file is shown as itself where it can be — an image is a picture, before
 * it is a filename — and as a tile naming its type and size where it cannot.
 * The same tile serves the composer (a file about to be sent, thumbnail from
 * the browser's own copy) and the transcript (a file that was sent, thumbnail
 * from the artifact store), so the thing you attached looks the same after
 * you pressed Enter as it did before.
 *
 * Only passive raster formats are drawn inline — the same list the gateway's
 * preview route will serve. Anything else is a tile, however tempting a PDF's
 * first page might be.
 */
import type { ChatBlock } from './types';
import type { Renderable } from '../canvas/types';

export type AttachmentBlock = Extract<ChatBlock, { type: 'attachment' }>;

const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isPreviewable(mime: string): boolean {
  return PREVIEWABLE.has(mime.toLowerCase());
}

export function previewUrl(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/preview`;
}

export function downloadUrl(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/download`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The family a file belongs to, for the icon and the word under it. Coarse on
 * purpose: the owner needs to tell a spreadsheet from a photo at a glance, not
 * to learn the difference between two zip flavours.
 */
export type FileFamily = 'image' | 'pdf' | 'table' | 'text' | 'code' | 'audio' | 'video' | 'archive' | 'file';

export function familyOf(mime: string, filename?: string | null): FileFamily {
  const value = mime.toLowerCase();
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? '';
  if (value.startsWith('image/')) return 'image';
  if (value === 'application/pdf') return 'pdf';
  if (value.startsWith('audio/')) return 'audio';
  if (value.startsWith('video/')) return 'video';
  if (value === 'text/csv' || value === 'text/tab-separated-values' || value.includes('spreadsheet') || value.includes('excel') || ['csv', 'tsv', 'xls', 'xlsx', 'numbers'].includes(ext)) return 'table';
  if (value.includes('zip') || value.includes('tar') || value.includes('compressed') || ['zip', 'gz', 'tgz', 'rar', '7z'].includes(ext)) return 'archive';
  if (value === 'application/json' || value.includes('javascript') || value.includes('xml') || ['ts', 'tsx', 'js', 'py', 'rb', 'go', 'rs', 'swift', 'json', 'yaml', 'yml', 'toml', 'sh', 'sql', 'html', 'css'].includes(ext)) return 'code';
  if (value.startsWith('text/') || ['md', 'txt', 'rtf', 'doc', 'docx'].includes(ext)) return 'text';
  return 'file';
}

export const FAMILY_LABEL: Record<FileFamily, string> = {
  image: 'Image',
  pdf: 'PDF',
  table: 'Spreadsheet',
  text: 'Document',
  code: 'Code',
  audio: 'Audio',
  video: 'Video',
  archive: 'Archive',
  file: 'File',
};

/** The tab id for one artifact on the canvas. Its own namespace, stable across refreshes. */
export function artifactTabId(artifactId: string): string {
  return `artifact:${artifactId}`;
}

/**
 * The canvas entry for a file the owner clicked. Marked unsubstantial: it was
 * opened on purpose, and it must never take the screen away from a result
 * that lands while the owner is looking at it.
 */
export function artifactRenderable(block: AttachmentBlock): Renderable {
  const family = familyOf(block.mime, block.filename);
  return {
    id: artifactTabId(block.artifactId),
    tool: FAMILY_LABEL[family],
    title: block.filename ?? 'Untitled file',
    renderer: 'artifact',
    props: { attachment: block },
    at: null,
    source: 'artifact',
    substantial: false,
  };
}
