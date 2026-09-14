/**
 * The artifact store: metadata in `core.artifacts`, bytes on disk.
 *
 * Two rules shape this module.
 *
 * 1. **Bytes never live in the database.** A Telegram photo or a bank statement
 *    would otherwise sit base64-encoded inside `core.messages` forever, bloating
 *    every history replay. The row holds a relative `storage_path`; the file
 *    lives under `BUDDI_DATA_DIR` (gitignored).
 * 2. **Content addressing, so re-sending is free.** The same file dropped twice
 *    into the same chat is the same artifact: dedup is `(sha256, source)`, and
 *    `saveArtifact` returns the existing row instead of writing a duplicate.
 *
 * Deletion is soft — an artifact can be referenced by a transcript, an approval
 * or a run, and those references must stay explicable after the owner forgets
 * the file. The bytes are left in place in v1; only the row is tombstoned.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/** The four kinds `core.artifacts.kind` allows. */
export type ArtifactKind = 'document' | 'image' | 'audio' | 'other';

/**
 * One artifact, as every caller sees it. This is the exact shape the gateway
 * reads back from `saveArtifact` after a surface attachment ingest.
 */
export interface ArtifactRow {
  id: string;
  kind: ArtifactKind;
  mime: string;
  filename: string | null;
  sizeBytes: number;
  sha256: string;
  /** Relative to the data dir; join with `resolveDataDir` to read it. */
  storagePath: string;
  caption: string | null;
  createdAt: string | null;
}

/** Where an attachment came from, when a surface handed it in. */
export interface ArtifactSource {
  surface: string;
  chatId?: string | null;
  messageId?: string | null;
}

export interface SaveArtifactInput {
  bytes: Buffer;
  mime: string;
  filename?: string | null;
  source?: ArtifactSource | null;
  caption?: string | null;
  /** `'owner'` or an agent id — provenance, same as a derived memory carries. */
  createdBy: string;
  conversationId?: string | null;
}

export interface ListArtifactsOptions {
  limit?: number;
  conversationId?: string | null;
  kind?: ArtifactKind;
}

/** Environment shape this module reads. `process.env` satisfies it. */
export type EnvLike = Record<string, string | undefined>;

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

/**
 * Repo root as seen from this file, whether it runs from `src/artifacts` (tests)
 * or `dist/artifacts` (build) — both are exactly two levels under the package.
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/**
 * Absolute path of the data dir: `BUDDI_DATA_DIR` if set, else `<repo>/data`
 * (gitignored). Never read ambiently by callers — it is passed an env on
 * purpose, so a test can point it somewhere disposable.
 */
export function resolveDataDir(env: EnvLike = process.env): string {
  const configured = env.BUDDI_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(REPO_ROOT, 'data');
}

/** Kind is derived from the mime type — never taken from the sender. */
export function kindForMime(mime: string): ArtifactKind {
  const m = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'other';
  if (m.startsWith('text/')) return 'document';
  if (DOCUMENT_MIMES.has(m)) return 'document';
  return 'other';
}

const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/json',
  'application/xml',
  'application/rtf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]);

const MIME_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
};

const SAFE_EXT = /^[a-z0-9]{1,8}$/;

/** File extension for the stored copy: mime first, filename as a fallback. */
export function extensionFor(mime: string, filename?: string | null): string {
  const m = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  const known = MIME_EXTENSIONS[m];
  if (known) return known;
  const fromName = path.extname(filename ?? '').replace(/^\./, '').toLowerCase();
  if (SAFE_EXT.test(fromName)) return fromName;
  const subtype = m.split('/')[1]?.replace(/\+.*$/, '') ?? '';
  return SAFE_EXT.test(subtype) ? subtype : 'bin';
}

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `artifacts/<yyyy>/<mm>/<sha256>.<ext>` — relative, always POSIX-separated. */
export function storagePathFor(
  sha256: string,
  mime: string,
  filename: string | null | undefined,
  at: Date,
): string {
  const yyyy = String(at.getUTCFullYear());
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `artifacts/${yyyy}/${mm}/${sha256}.${extensionFor(mime, filename)}`;
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toRow(row: Record<string, any>): ArtifactRow {
  return {
    id: String(row.id),
    kind: row.kind as ArtifactKind,
    mime: row.mime,
    filename: row.filename ?? null,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    storagePath: row.storage_path,
    caption: row.caption ?? null,
    createdAt: toIso(row.created_at),
  };
}

const SELECT_COLUMNS = `id, kind, mime, filename, size_bytes, sha256, storage_path,
       caption, created_at`;

/**
 * Store bytes and record the artifact.
 *
 * Dedup is by `(sha256, source_surface, source_chat_id)`: the same statement
 * forwarded twice in the same chat returns the row that already exists. Postgres
 * counts NULLs as distinct, so source-less artifacts (what an agent produced)
 * are matched here with `is not distinct from` rather than left to the
 * constraint — the constraint still guards the surface case, which is the one
 * a retrying poller can actually hit.
 *
 * The file is written before the row is inserted: an orphan file wastes disk, an
 * orphan row would be a broken reference.
 */
export async function saveArtifact(
  pool: Pool,
  input: SaveArtifactInput,
  env: EnvLike = process.env,
): Promise<ArtifactRow> {
  if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) {
    throw new Error('saveArtifact: bytes must be a non-empty Buffer');
  }
  if (!input.mime || input.mime.trim() === '') {
    throw new Error('saveArtifact: mime is required');
  }
  if (!input.createdBy || input.createdBy.trim() === '') {
    throw new Error('saveArtifact: createdBy is required (owner id or agent id)');
  }

  const mime = input.mime.trim();
  const filename = input.filename?.trim() || null;
  const sha256 = sha256Of(input.bytes);
  const surface = input.source?.surface ?? null;
  const chatId = input.source?.chatId ?? null;

  const existing = await pool.query(
    `select ${SELECT_COLUMNS} from core.artifacts
      where sha256 = $1
        and source_surface is not distinct from $2
        and source_chat_id is not distinct from $3
        and deleted_at is null
      order by created_at asc
      limit 1`,
    [sha256, surface, chatId],
  );
  if (existing.rows[0]) return toRow(existing.rows[0]);

  const now = new Date();
  const relative = storagePathFor(sha256, mime, filename, now);
  const absolute = path.join(resolveDataDir(env), relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  // Content-addressed: if the file is already there it is byte-identical.
  await writeFile(absolute, input.bytes);

  const { rows } = await pool.query(
    `insert into core.artifacts
       (kind, mime, filename, size_bytes, sha256, storage_path,
        source_surface, source_chat_id, source_message_id, caption,
        created_by, conversation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict on constraint artifacts_source_sha_key do update
       set caption = coalesce(core.artifacts.caption, excluded.caption)
     returning ${SELECT_COLUMNS}`,
    [
      kindForMime(mime),
      mime,
      filename,
      input.bytes.length,
      sha256,
      relative,
      surface,
      chatId,
      input.source?.messageId ?? null,
      input.caption?.trim() || null,
      input.createdBy,
      input.conversationId ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('saveArtifact: insert returned no row');
  return toRow(row);
}

/** One artifact by id. `null` when it does not exist or was deleted. */
export async function getArtifact(pool: Pool, id: string): Promise<ArtifactRow | null> {
  const { rows } = await pool.query(
    `select ${SELECT_COLUMNS} from core.artifacts
      where id = $1 and deleted_at is null`,
    [id],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** Newest first. Bounded by `MAX_LIST_LIMIT` — a tool argument cannot widen it. */
export async function listArtifacts(
  pool: Pool,
  opts: ListArtifactsOptions = {},
): Promise<ArtifactRow[]> {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIST_LIMIT)), MAX_LIST_LIMIT);
  const params: unknown[] = [];
  const where = ['deleted_at is null'];
  if (opts.conversationId) {
    params.push(opts.conversationId);
    where.push(`conversation_id = $${params.length}`);
  }
  if (opts.kind) {
    params.push(opts.kind);
    where.push(`kind = $${params.length}`);
  }
  params.push(limit);
  const { rows } = await pool.query(
    `select ${SELECT_COLUMNS} from core.artifacts
      where ${where.join(' and ')}
      order by created_at desc, id desc
      limit $${params.length}`,
    params,
  );
  return rows.map(toRow);
}

/** Read the bytes back. Throws with the artifact id when the file is gone. */
export async function readArtifactBytes(
  env: EnvLike,
  row: Pick<ArtifactRow, 'id' | 'storagePath'>,
): Promise<Buffer> {
  const absolute = path.join(resolveDataDir(env), row.storagePath);
  try {
    return await readFile(absolute);
  } catch (err) {
    throw new Error(
      `artifact ${row.id}: bytes missing at ${row.storagePath} (${
        err instanceof Error ? err.message : String(err)
      })`,
      { cause: err },
    );
  }
}

/** True when the bytes are still on disk — cheap enough for a describe tool. */
export async function artifactBytesExist(
  env: EnvLike,
  row: Pick<ArtifactRow, 'storagePath'>,
): Promise<boolean> {
  try {
    await stat(path.join(resolveDataDir(env), row.storagePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Soft delete. The row is tombstoned so references stay explicable; the bytes
 * stay on disk in v1 (another artifact may be content-addressed to the same
 * file). Returns false when there was nothing live to delete.
 */
export async function deleteArtifact(
  pool: Pool,
  id: string,
  at: Date = new Date(),
): Promise<boolean> {
  const { rows } = await pool.query(
    `update core.artifacts set deleted_at = $2
      where id = $1 and deleted_at is null
      returning id`,
    [id, at],
  );
  return rows.length > 0;
}
