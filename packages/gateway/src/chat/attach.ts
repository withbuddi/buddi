/**
 * Files, from the filesystem into the artifact store.
 *
 * Telegram hands the surface bytes and a mime type; a terminal hands it a path
 * and nothing else. So the one thing this module adds over the shared store is
 * a mime guess from the extension — conservative, and never taken from the
 * file's own content, because `application/octet-stream` is a fine answer and a
 * wrong `image/png` is not.
 *
 * Everything else is the same path a Telegram document takes: `saveArtifact`
 * through the shared `ArtifactStore` port, content-addressed, with the source
 * recorded as `{ surface: 'cli' }`.
 */
import path from 'node:path';
import { classifyMime, isViewable, type ArtifactRow, type ArtifactStore } from '../telegram/attachments.js';

/** The surface name recorded on an artifact saved from the terminal. */
export const SURFACE = 'cli';

/** Extension → mime. Only types the owner plausibly attaches to an agent. */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.ofx': 'text/plain',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.qfx': 'text/plain',
  '.rtf': 'application/rtf',
  '.svg': 'image/svg+xml',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.zip': 'application/zip',
};

/** The mime this path claims by its extension, or the honest fallback. */
export function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/** One file staged for the next message. */
export interface PendingAttachment {
  artifactId: string;
  filename: string;
  mime: string;
  kind: string;
  sizeBytes: number;
  /** True when the model can actually look at it (image, PDF). */
  viewable: boolean;
}

export interface SaveFileDeps {
  store: ArtifactStore;
  readFile(filePath: string): Promise<Buffer>;
  createdBy: string;
}

/** Read a path, store it, and describe what was stored. */
export async function attachFile(
  filePath: string,
  deps: SaveFileDeps,
): Promise<PendingAttachment> {
  const bytes = await deps.readFile(filePath);
  const filename = path.basename(filePath);
  const mime = mimeForPath(filePath);
  const row: ArtifactRow = await deps.store.save({
    bytes,
    mime,
    filename,
    source: { surface: SURFACE },
    createdBy: deps.createdBy,
  });
  return {
    artifactId: row.id,
    filename: row.filename ?? filename,
    mime: row.mime,
    kind: row.kind,
    sizeBytes: row.sizeBytes,
    viewable: isViewable(classifyMime(row.mime), row.mime),
  };
}
