/**
 * The artifact store: files in `core.files`, their versions in
 * `core.artifacts`, bytes on disk (docs/files.md).
 *
 * Four rules shape this module.
 *
 * 1. **Bytes never live in the database.** A Telegram photo or a bank statement
 *    would otherwise sit base64-encoded inside `core.messages` forever, bloating
 *    every history replay. A version holds a relative `storage_path`; the bytes
 *    live under `BUDDI_DATA_DIR` (gitignored), content-addressed.
 * 2. **A file is a row; its versions are appended, never rewritten.** Each
 *    version has a number and an author (`created_by`: the owner for his
 *    saves and restores). What a file *is* — its name, its conversation, the
 *    workspace path a command's output came from and whose workspace that is —
 *    lives on the file, so writing a version never changes it. The current
 *    version is the highest-numbered live one.
 * 3. **Re-sending is free.** The same attachment dropped twice into the same
 *    chat is the same file: `saveArtifact` returns the version that holds it.
 *    That is about what was handed in, not about versions: two versions of
 *    one file may hold the same bytes (a Restore does).
 * 4. **One lock per file.** Every change to a file — a version, a delete, an
 *    undelete — runs in one transaction holding that file's lock; creating a
 *    file holds the lock on what names it (its title in the conversation, its
 *    workspace path, or its bytes and source), so two writers never make two
 *    files of one. A blob is written and unlinked under a lock on its path,
 *    held until the row that names it is committed.
 *
 * Deletion is soft — a version can be referenced by a transcript, an approval
 * or a run, and those references must stay explicable after the owner forgets
 * the file. A month later `purgeDeletedArtifacts` removes the rows, and the
 * bytes no remaining version stores.
 */
import { OFFICE_FORMATS, type NewestVersionFacts } from '../office-files.js';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { sha256Of } from '../plugin/hash.js';

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
  /** The file this is a version of (`core.files`). */
  fileId: string;
  /** Its number among the file's versions, from 1. */
  version: number;
  /** Who wrote this version: `'owner'` or an agent id. */
  createdBy: string;
}

/** Where an attachment came from, when a surface handed it in. */
export interface ArtifactSource {
  surface: string;
  chatId?: string | null;
  messageId?: string | null;
}

/**
 * The program a composed version was made from (`core.compose_sources`):
 * what `artifacts.compose` stores beside the version it produced, and what
 * a Restore of that version copies.
 */
export interface ComposeSource {
  kind: 'docx' | 'pptx' | 'xlsx';
  /** The library the program was written against (`docx`, `pptxgenjs`), and its version. */
  library: string;
  libraryVersion: string;
  /** The Node it ran under. */
  nodeVersion: string;
  program: string;
}

/** A composed version's program, with the version it belongs to. */
export interface StoredComposeSource extends ComposeSource {
  artifactId: string;
  fileId: string;
  version: number;
  createdAt: string | null;
}

/** The largest program stored beside a version (the table's own check says the same). */
export const MAX_COMPOSE_PROGRAM_BYTES = 200 * 1024;

export interface SaveArtifactInput {
  bytes: Buffer;
  mime: string;
  filename?: string | null;
  source?: ArtifactSource | null;
  caption?: string | null;
  /** `'owner'` or an agent id — provenance, same as a derived memory carries. */
  createdBy: string;
  conversationId?: string | null;
  /**
   * Where the bytes were read from, relative to the data dir, when that is a
   * workspace the file may be edited in again (a command's output): the
   * file is the one captured from that path in this conversation, and the
   * owner's save writes back there.
   */
  originPath?: string | null;
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
  // Every Office format (`office-files.ts`).
  ...Object.values(OFFICE_FORMATS).map((f) => f.mime),
]);

const MIME_EXTENSIONS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(OFFICE_FORMATS).map(([ext, f]) => [f.mime, ext])),
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/zip': 'zip',
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

// Pure, so it lives in the plugin entry point (`@buddi/core/plugin`).
export { sha256Of };

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
    fileId: String(row.file_id),
    version: Number(row.version),
    createdBy: String(row.created_by),
  };
}

const SELECT_COLUMNS = `id, kind, mime, filename, size_bytes, sha256, storage_path,
       caption, created_at, file_id, version, created_by`;
/** The same columns of the version alias `a`. */
const A_COLUMNS = SELECT_COLUMNS.split(',').map((column) => `a.${column.trim()}`).join(', ');

/** How a file came to be: written by title, captured from a workspace, or handed in. */
export type StoredFileOrigin = 'document' | 'capture' | 'upload';

/** One file, across its versions. */
export interface FileRecord {
  id: string;
  conversationId: string | null;
  /** Its name, never with a version mark (a download adds one). */
  name: string | null;
  mime: string;
  /** Who made it: `'owner'` or an agent id. A capture belongs to that agent's workspace. */
  createdBy: string;
  origin: StoredFileOrigin;
  /** A command's output: the path it was read from, relative to the data dir. */
  originPath: string | null;
  /** That copy's hash as buddi last read or wrote it. */
  originSha256: string | null;
  createdAt: string | null;
  deletedAt: string | null;
}

const FILE_COLUMNS = `f.id, f.conversation_id, f.name, f.mime, f.created_by, f.origin, f.origin_path, f.origin_sha256, f.created_at, f.deleted_at`;

function toFile(row: Record<string, any>): FileRecord {
  return {
    id: String(row.id),
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    name: row.name ?? null,
    mime: String(row.mime),
    createdBy: String(row.created_by),
    origin: row.origin as StoredFileOrigin,
    originPath: row.origin_path ?? null,
    originSha256: row.origin_sha256 ?? null,
    createdAt: toIso(row.created_at),
    deletedAt: toIso(row.deleted_at),
  };
}

type Queryable = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };

/** One transaction on one connection: every lock below is held until it ends. */
async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function lock(client: Queryable, key: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

/** The one lock every change to a file takes: versions, deletes and undeletes are serialised by it. */
function lockFile(client: Queryable, fileId: string): Promise<void> {
  return lock(client, `buddi.file:${fileId}`);
}

/**
 * Put bytes on disk at the path their hash gives, under that path's lock —
 * held until the caller's transaction ends, so a purge that would unlink the
 * blob either ran before (and the bytes are written again here) or sees the
 * row this transaction commits.
 */
async function storeBlob(client: Queryable, env: EnvLike, bytes: Buffer, mime: string, filename: string | null): Promise<{ sha256: string; relative: string }> {
  const sha256 = sha256Of(bytes);
  const relative = storagePathFor(sha256, mime, filename, new Date());
  await lock(client, `buddi.blob:${relative}`);
  const absolute = path.join(resolveDataDir(env), relative);
  // Content-addressed, so bytes already there are these bytes — once checked:
  // a write cut short (a full disk, a crash) leaves a blob that is not.
  if (!(await blobHolds(absolute, bytes.length, sha256))) {
    await mkdir(path.dirname(absolute), { recursive: true });
    // Written beside and renamed over: the path only ever names whole bytes.
    const temp = `${absolute}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(temp, bytes, { flag: 'wx' });
      await rename(temp, absolute);
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    }
  }
  return { sha256, relative };
}

/** Is the blob at `absolute` exactly these bytes (their size, then their hash)? */
async function blobHolds(absolute: string, size: number, sha256: string): Promise<boolean> {
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile() || info.size !== size) return false;
  return sha256Of(await readFile(absolute)) === sha256;
}

async function loadFile(client: Queryable, fileId: string): Promise<FileRecord | null> {
  const { rows } = await client.query(`select ${FILE_COLUMNS} from core.files f where f.id = $1`, [fileId]);
  return rows[0] ? toFile(rows[0]) : null;
}

async function newestOf(client: Queryable, fileId: string): Promise<ArtifactRow | null> {
  const { rows } = await client.query(
    `select ${A_COLUMNS} from core.artifacts a where a.file_id = $1 and a.deleted_at is null order by a.version desc limit 1`,
    [fileId],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

async function createFile(
  client: Queryable,
  input: { conversationId: string | null; name: string | null; mime: string; createdBy: string; origin: StoredFileOrigin; originPath?: string | null; originSha256?: string | null },
): Promise<FileRecord> {
  const { rows } = await client.query(
    `insert into core.files (conversation_id, name, mime, created_by, origin, origin_path, origin_sha256)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${FILE_COLUMNS.replace(/f\./g, '')}`,
    [input.conversationId, input.name, input.mime, input.createdBy, input.origin, input.originPath ?? null, input.originSha256 ?? null],
  );
  return toFile(rows[0]);
}

/** The next version of `file`, numbered past every one it ever had (deleted ones keep theirs). */
async function insertVersion(
  client: Queryable,
  env: EnvLike,
  file: FileRecord,
  input: { bytes: Buffer; mime?: string; createdBy: string; caption?: string | null; source?: ArtifactSource | null; restoredFrom?: number },
): Promise<ArtifactRow> {
  const mime = input.mime ?? file.mime;
  const blob = await storeBlob(client, env, input.bytes, mime, file.name);
  const { rows } = await client.query(
    `insert into core.artifacts
       (kind, mime, filename, size_bytes, sha256, storage_path, source_surface, source_chat_id, source_message_id,
        caption, created_by, conversation_id, file_id, version, restored_from)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             (select f.next_version from core.files f where f.id = $13), $14)
     returning ${SELECT_COLUMNS}`,
    [
      kindForMime(mime), mime, file.name, input.bytes.length, blob.sha256, blob.relative,
      input.source?.surface ?? null, input.source?.chatId ?? null, input.source?.messageId ?? null,
      input.caption?.trim() || null, input.createdBy, file.conversationId, file.id, input.restoredFrom ?? null,
    ],
  );
  return toRow(rows[0]);
}

function checkInput(input: { bytes: Buffer; createdBy: string }, mime?: string): void {
  if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) {
    throw new Error('saveArtifact: bytes must be a non-empty Buffer');
  }
  if (mime !== undefined && (!mime || mime.trim() === '')) {
    throw new Error('saveArtifact: mime is required');
  }
  if (!input.createdBy || input.createdBy.trim() === '') {
    throw new Error('saveArtifact: createdBy is required (owner id or agent id)');
  }
}

/**
 * Store bytes as a file: an attachment handed in, a file a plugin saved, or
 * — with `originPath` — a command's output.
 *
 * An output is a version of the file captured from that path in this
 * conversation (a new one when it changed, the current one when it did not);
 * the copy's hash is recorded on the file, as what buddi last read there.
 *
 * Anything else is a file of its own, unless these bytes already came in
 * from the same place — `(sha256, source_surface, source_chat_id)`, the
 * first version of a file handed in: then that version comes back (brought
 * back if it was discarded) and `existed` says so. Checked under a lock on
 * that key, so a retrying poller never makes two.
 */
export async function saveArtifact(
  pool: Pool,
  input: SaveArtifactInput,
  env: EnvLike = process.env,
): Promise<ArtifactRow> {
  return (await saveArtifactReporting(pool, input, env)).row;
}

/** `saveArtifact`, saying whether the bytes were already there (`existed`): then nothing new was written. */
export async function saveArtifactReporting(
  pool: Pool,
  input: SaveArtifactInput,
  env: EnvLike = process.env,
): Promise<{ row: ArtifactRow; existed: boolean }> {
  checkInput(input, input.mime);
  const mime = input.mime.trim();
  const filename = input.filename?.trim() || null;
  const conversationId = input.conversationId ?? null;
  const sha256 = sha256Of(input.bytes);
  const source = input.source ?? null;
  const version = { bytes: input.bytes, mime, createdBy: input.createdBy, caption: input.caption ?? null, source };

  if (input.originPath) {
    const originPath = input.originPath;
    return transaction(pool, async (client) => {
      await lock(client, `buddi.files.origin:${conversationId ?? ''}:${originPath}`);
      const { rows } = await client.query(
        `select ${FILE_COLUMNS} from core.files f
          where f.conversation_id is not distinct from $1 and f.origin_path = $2 and f.deleted_at is null
          order by f.created_at desc limit 1`,
        [conversationId, originPath],
      );
      // Under the file's lock, read again: a delete may have committed while this waited.
      const file = rows[0] ? await lockFile(client, String(rows[0].id)).then(() => loadFile(client, String(rows[0].id))) : null;
      if (!file || file.deletedAt !== null) {
        const made = await createFile(client, { conversationId, name: filename, mime, createdBy: input.createdBy, origin: 'capture', originPath, originSha256: sha256 });
        return { row: await insertVersion(client, env, made, version), existed: false };
      }
      // The copy holds these bytes: what buddi last read there.
      await client.query(`update core.files set origin_sha256 = $2 where id = $1`, [file.id, sha256]);
      const newest = await newestOf(client, file.id);
      if (newest && newest.sha256 === sha256) return { row: newest, existed: true };
      return { row: await insertVersion(client, env, file, version), existed: false };
    });
  }

  return transaction(pool, async (client) => {
    await lock(client, `buddi.files.received:${sha256}:${source?.surface ?? ''}:${source?.chatId ?? ''}`);
    const { rows } = await client.query(
      `select ${A_COLUMNS}, a.deleted_at from core.artifacts a join core.files f on f.id = a.file_id
        where a.sha256 = $1 and a.source_surface is not distinct from $2 and a.source_chat_id is not distinct from $3
          and a.version = 1 and f.origin = 'upload' and f.deleted_at is null
        order by a.created_at asc, a.id asc limit 1`,
      [sha256, source?.surface ?? null, source?.chatId ?? null],
    );
    const found = rows[0];
    if (found) {
      /*
       * Under the file's lock, as a delete or the purge takes it: the version
       * is still there and its file not deleted, or it is a new file after all.
       * The same bytes handed in again after a discard: the version comes back.
       */
      await lockFile(client, String(found.file_id));
      const { rows: kept } = await client.query(
        `update core.artifacts a set deleted_at = null, caption = coalesce(a.caption, $2)
           from core.files f
          where a.id = $1 and f.id = a.file_id and f.deleted_at is null
          returning ${A_COLUMNS}`,
        [found.id, input.caption?.trim() || null],
      );
      if (kept[0]) return { row: toRow(kept[0]), existed: true };
    }
    const file = await createFile(client, { conversationId, name: filename, mime, createdBy: input.createdBy, origin: 'upload' });
    return { row: await insertVersion(client, env, file, version), existed: false };
  });
}

/**
 * A new file, always: the owner's "Save as new file" (`POST /api/files`).
 * Never the file that already holds these bytes — the bytes on disk are
 * shared, the file is not.
 */
export async function saveNewFile(
  pool: Pool,
  input: { bytes: Buffer; mime: string; name: string; createdBy: string; conversationId: string | null; source?: ArtifactSource | null },
  env: EnvLike = process.env,
): Promise<{ row: ArtifactRow; file: FileRecord }> {
  checkInput(input, input.mime);
  return transaction(pool, async (client) => {
    const file = await createFile(client, { conversationId: input.conversationId, name: input.name, mime: input.mime.trim(), createdBy: input.createdBy, origin: 'upload' });
    return { row: await insertVersion(client, env, file, { bytes: input.bytes, createdBy: input.createdBy, source: input.source ?? null }), file };
  });
}

/**
 * Someone else's version is the newest: the writer did not say it read it
 * (`readVersion`), or read another one (an older one, or one since deleted). Writing would drop that version's
 * changes, so it is refused, with what to read.
 */
export class FileChangedError extends Error {
  override readonly name = 'FileChangedError';
  constructor(readonly file: FileRecord, readonly newest: ArtifactRow, readonly readVersion?: number) {
    const name = file.name ?? 'the file';
    const by = newest.createdBy === 'owner' ? 'the owner' : newest.createdBy;
    const read = `Read it with artifacts.text { id: "${newest.id}" }, keep its changes, and write again with fileId "${file.id}" and readVersion ${newest.version}.`;
    super(readVersion === undefined
      ? `The newest version of ${name} (v${newest.version}) is by ${by}, not you. ${read}`
      : newest.version < readVersion
        ? `The v${readVersion} of ${name} you read was deleted; the newest is now v${newest.version}, by ${by}. ${read}`
        : `${name} has a newer version (v${newest.version}, by ${by}) than the v${readVersion} you read. ${read}`);
  }
}

/** The file was deleted from Files: nothing more is written to it. */
export class FileGoneError extends Error {
  override readonly name = 'FileGoneError';
  constructor(readonly fileId: string) {
    super(`File ${fileId} was deleted from Files by the owner. Do not write or recreate it unless they ask.`);
  }
}

/** A title names more than one file in the conversation: the writer picks one by id. */
export class AmbiguousFileError extends Error {
  override readonly name = 'AmbiguousFileError';
  constructor(readonly title: string, readonly fileIds: readonly string[]) {
    super(`More than one file in this conversation is called "${title}" (${fileIds.join(', ')}). Write the one you mean with its fileId.`);
  }
}

/**
 * A writer's next version of `file`, under its lock: refused when someone
 * else wrote the newest and the writer did not read it (`FileChangedError`),
 * and nothing new when the bytes are the newest's.
 */
async function appendWriterVersion(
  client: PoolClient,
  env: EnvLike,
  fileId: string,
  input: WriterInput,
): Promise<{ row: ArtifactRow; existed: boolean; file: FileRecord }> {
  await lockFile(client, fileId);
  const file = await loadFile(client, fileId);
  if (!file || file.deletedAt !== null) throw new FileGoneError(fileId);
  const newest = await newestOf(client, file.id);
  // Asked under the lock, of the file and its newest version: the rebuild rule.
  input.guard?.(file, newest ? { id: newest.id, version: newest.version, createdBy: newest.createdBy, composed: await isComposed(client, newest.id) } : null);
  if (newest) {
    // Exactly the version read: an older one is newest again only because a later one was deleted, and its changes were never read.
    const stale = input.readVersion !== undefined ? newest.version !== input.readVersion : newest.createdBy !== input.createdBy;
    if (stale) throw new FileChangedError(file, newest, input.readVersion);
    if (newest.sha256 === sha256Of(input.bytes)) return { row: newest, existed: true, file };
  }
  const row = await insertVersion(client, env, file, input);
  if (input.composed) await insertComposeSource(client, row.id, input.composed);
  return { row, existed: false, file };
}

/** What a writer's version carries: its bytes, who wrote it, what it read, and what may refuse it. */
interface WriterInput {
  bytes: Buffer;
  createdBy: string;
  caption?: string | null;
  readVersion?: number;
  /** Asked, under the file's lock, before the next version of an existing file is written: throws to refuse it. */
  guard?: (file: FileRecord, newest: NewestVersionFacts | null) => void;
  /** The program that made these bytes, stored beside the version (`artifacts.compose`). */
  composed?: ComposeSource;
}

async function isComposed(client: Queryable, artifactId: string): Promise<boolean> {
  const { rows } = await client.query(`select 1 from core.compose_sources where artifact_id = $1`, [artifactId]);
  return rows.length > 0;
}

async function insertComposeSource(client: Queryable, artifactId: string, source: ComposeSource): Promise<void> {
  if (Buffer.byteLength(source.program, 'utf8') > MAX_COMPOSE_PROGRAM_BYTES) {
    throw new Error(`a program can be at most ${MAX_COMPOSE_PROGRAM_BYTES / 1024} KB`);
  }
  await client.query(
    `insert into core.compose_sources (artifact_id, kind, library, library_version, node_version, program)
     values ($1, $2, $3, $4, $5, $6)`,
    [artifactId, source.kind, source.library, source.libraryVersion, source.nodeVersion, source.program],
  );
}

/** The program `from` was composed from, kept beside `to` too (a Restore of it). Nothing when `from` was not composed. */
async function copyComposeSource(client: Queryable, from: string, to: string): Promise<void> {
  await client.query(
    `insert into core.compose_sources (artifact_id, kind, library, library_version, node_version, program)
     select $2, kind, library, library_version, node_version, program from core.compose_sources where artifact_id = $1`,
    [from, to],
  );
}

/**
 * The program a version was composed from, by the version's id — or, by a
 * file's id, its newest version's. Null when that version was not composed.
 */
export async function composeSourceOf(pool: Queryable, id: string): Promise<StoredComposeSource | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const { rows } = await pool.query(
    `select s.artifact_id, s.kind, s.library, s.library_version, s.node_version, s.program, s.created_at, a.file_id, a.version
       from core.compose_sources s join core.artifacts a on a.id = s.artifact_id
      where a.deleted_at is null and s.artifact_id = coalesce(
        (select v.id from core.artifacts v where v.id = $1::uuid),
        (select v.id from core.artifacts v where v.file_id = $1::uuid and v.deleted_at is null order by v.version desc limit 1))`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    artifactId: String(row.artifact_id), fileId: String(row.file_id), version: Number(row.version),
    kind: row.kind, library: String(row.library), libraryVersion: String(row.library_version),
    nodeVersion: String(row.node_version), program: String(row.program), createdAt: toIso(row.created_at),
  };
}

/**
 * The next version of a file named by id: what `artifacts.write { fileId }`
 * and a plugin's `version.of` do. The file keeps its name and, for a
 * command's output, its workspace path (the copy there is not written; it
 * still holds what it held). `id` may be the file's or any version's.
 */
export async function saveVersion(
  pool: Pool,
  input: WriterInput & { id: string },
  env: EnvLike = process.env,
): Promise<{ row: ArtifactRow; existed: boolean; file: FileRecord }> {
  checkInput(input);
  const fileId = await resolveFileId(pool, input.id);
  if (!fileId) throw new Error(`there is no file ${input.id} in Files; find it with artifacts.list`);
  return transaction(pool, (client) => appendWriterVersion(client, env, fileId, input));
}

/**
 * A document written by title (`artifacts.write { title }`): the next
 * version of the live file of that name in the conversation (names compared
 * ignoring case), else a new file. Resolved and written under one lock on
 * the conversation and the name, then the file's own: two writes at once
 * never make two files, and a write never slips past an owner's save.
 * Outside a conversation it is always a new file.
 */
export async function saveDocument(
  pool: Pool,
  input: {
    conversationId: string | null; name: string; mime: string;
  } & WriterInput,
  env: EnvLike = process.env,
): Promise<{ row: ArtifactRow; existed: boolean; file: FileRecord }> {
  checkInput(input, input.mime);
  return transaction(pool, async (client) => {
    if (input.conversationId) {
      await lock(client, `buddi.files.name:${input.conversationId}:${input.name.toLowerCase()}`);
      const { rows } = await client.query<{ id: string }>(
        `select f.id from core.files f
          where f.conversation_id = $1 and lower(f.name) = lower($2) and f.deleted_at is null
            and exists (select 1 from core.artifacts a where a.file_id = f.id and a.deleted_at is null)
          order by f.created_at asc, f.id asc`,
        [input.conversationId, input.name],
      );
      if (rows.length > 1) throw new AmbiguousFileError(input.name, rows.map((row) => String(row.id)));
      if (rows[0]) return appendWriterVersion(client, env, String(rows[0].id), input);
    }
    const file = await createFile(client, { conversationId: input.conversationId, name: input.name, mime: input.mime.trim(), createdBy: input.createdBy, origin: 'document' });
    const row = await insertVersion(client, env, file, input);
    if (input.composed) await insertComposeSource(client, row.id, input.composed);
    return { row, existed: false, file };
  });
}

/** One version by id. `null` when it does not exist or was deleted. */
export async function getArtifact(pool: Queryable, id: string): Promise<ArtifactRow | null> {
  const { rows } = await pool.query(
    `select ${SELECT_COLUMNS} from core.artifacts
      where id = $1 and deleted_at is null`,
    [id],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** The file an id names: a file's own id, or any of its versions'. Null when neither. */
export async function resolveFileId(pool: Queryable, id: string): Promise<string | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const { rows } = await pool.query(
    `select coalesce((select f.id from core.files f where f.id = $1::uuid), (select a.file_id from core.artifacts a where a.id = $1::uuid)) as id`,
    [id],
  );
  return rows[0]?.id ? String(rows[0].id) : null;
}

/** One file, deleted or not. */
export async function getFile(pool: Queryable, fileId: string): Promise<FileRecord | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) return null;
  return loadFile(pool, fileId);
}

/** A file's current version: its highest-numbered live one. Null when the file is deleted or has none. */
export async function currentVersion(pool: Queryable, fileId: string): Promise<ArtifactRow | null> {
  const file = await getFile(pool, fileId);
  if (!file || file.deletedAt !== null) return null;
  return newestOf(pool, fileId);
}

/** A file's live versions, newest first, each saying which version it restored, if any. */
export async function fileVersions(pool: Queryable, fileId: string): Promise<Array<ArtifactRow & { restoredFrom: number | null; composed: boolean }>> {
  const { rows } = await pool.query(
    `select ${A_COLUMNS}, a.restored_from,
            exists (select 1 from core.compose_sources s where s.artifact_id = a.id) as composed
       from core.artifacts a
      where a.file_id = $1 and a.deleted_at is null
      order by a.version desc`,
    [fileId],
  );
  return rows.map((row) => ({ ...toRow(row), restoredFrom: row.restored_from === null || row.restored_from === undefined ? null : Number(row.restored_from), composed: row.composed === true }));
}

/** What `saveOwnerVersion` found. */
export type OwnerSaveResult =
  /**
   * Saved: the new version (or, when the bytes were already the newest's,
   * that one: `created` false). `workspace` says what became of the
   * workspace copy, for a command's output: written, or not and why.
   */
  | { ok: true; row: ArtifactRow; file: FileRecord; created: boolean; workspace?: { updated: true } | { updated: false; reason: string } }
  /** A version newer than the one he opened was saved meanwhile; `current` is it. */
  | { ok: false; reason: 'newer'; current: ArtifactRow }
  /** The workspace copy it was captured from changed since; `workspaceText` is what is there now. */
  | { ok: false; reason: 'workspace'; current: ArtifactRow; workspaceText: string }
  | { ok: false; reason: 'gone' };

/**
 * The workspace a command's output came from, as the caller judges it:
 * nothing to write back to, changed since (with what it holds now), or a
 * write to make once the save is in.
 */
export type WorkspaceCopy =
  | { kind: 'none' }
  | { kind: 'changed'; text: string }
  /** Not written back, and why: Files is saved and says so. */
  | { kind: 'refused'; reason: string }
  /**
   * The new bytes are staged beside the copy. `commit` puts them in place
   * once the save is in (checking again first); `abort` removes them when
   * it is not.
   */
  | { kind: 'write'; commit: () => Promise<void>; abort: () => Promise<void> };

/** What `saveOwnerVersion` tells a workspace check: the file, and the hash its copy should still hold. */
export interface WorkspaceFile {
  fileId: string;
  originPath: string;
  /** The copy's hash as buddi last read or wrote it. */
  known: string;
  conversationId: string | null;
  /** The agent whose workspace it is. */
  createdBy: string;
}

/**
 * The owner's save of a file — his edit on the Canvas, or a Restore of an
 * older version (`restoredFrom`, its bytes copied by the caller from that
 * version, never from a preview) — appended as a new version by `owner`.
 *
 * One transaction under the file's lock: `base` is the version he opened,
 * and a newer one saved meanwhile (by an agent, a command, another tab)
 * refuses the save with it. For a command's output, `workspace` checks the
 * copy and stages the write; the copy is put in place only once the save is
 * committed, and a copy that cannot be is reported, not undone — the save is
 * in Files, and saving again retries it.
 */
export async function saveOwnerVersion(
  pool: Pool,
  input: {
    fileId: string;
    bytes: Buffer;
    base: number;
    restoredFrom?: number;
    workspace?: (file: WorkspaceFile) => Promise<WorkspaceCopy>;
  },
  env: EnvLike = process.env,
): Promise<OwnerSaveResult> {
  checkInput({ bytes: input.bytes, createdBy: 'owner' });
  const client = await pool.connect();
  let staged: Extract<WorkspaceCopy, { kind: 'write' }> | null = null;
  try {
    await client.query('begin');
    await lockFile(client, input.fileId);
    const file = await loadFile(client, input.fileId);
    const newest = file && file.deletedAt === null ? await newestOf(client, file.id) : null;
    if (!file || !newest) { await client.query('rollback'); return { ok: false, reason: 'gone' }; }
    if (newest.version !== input.base) { await client.query('rollback'); return { ok: false, reason: 'newer', current: newest }; }

    let notWritten: string | null = null;
    if (file.originPath && input.workspace) {
      const copy = await input.workspace({
        fileId: file.id, originPath: file.originPath, known: file.originSha256 ?? newest.sha256,
        conversationId: file.conversationId, createdBy: file.createdBy,
      });
      if (copy.kind === 'changed') { await client.query('rollback'); return { ok: false, reason: 'workspace', current: newest, workspaceText: copy.text }; }
      if (copy.kind === 'refused') notWritten = copy.reason;
      if (copy.kind === 'write') staged = copy;
    }
    const same = newest.sha256 === sha256Of(input.bytes);
    const row = same ? newest : await insertVersion(client, env, file, {
      bytes: input.bytes, createdBy: 'owner',
      ...(input.restoredFrom === undefined ? {} : { restoredFrom: input.restoredFrom }),
    });
    // A Restore of a composed version brings its program with the bytes.
    if (!same && input.restoredFrom !== undefined) {
      const { rows: from } = await client.query(`select id from core.artifacts where file_id = $1 and version = $2`, [file.id, input.restoredFrom]);
      if (from[0]) await copyComposeSource(client, String(from[0].id), row.id);
    }
    await client.query('commit');

    const done = { ok: true as const, row, file, created: !same };
    if (notWritten !== null) return { ...done, workspace: { updated: false, reason: notWritten } };
    if (!staged) return done;
    const write = staged;
    staged = null;
    try {
      await write.commit();
    } catch (err) {
      await write.abort().catch(() => {});
      return { ...done, workspace: { updated: false, reason: err instanceof Error ? err.message : String(err) } };
    }
    // On the connection already held: a second one from the pool could wait on this one forever.
    await client.query(`update core.files set origin_sha256 = $2 where id = $1`, [file.id, row.sha256]).catch(() => {});
    return { ...done, file: { ...file, originSha256: row.sha256 }, workspace: { updated: true } };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    await staged?.abort().catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** An agent read a version of a file (its text, its description, its bytes): the newest it read is kept. */
export async function recordFileRead(pool: Queryable, input: { fileId: string; agentId: string; version: number }): Promise<void> {
  await pool.query(
    `insert into core.file_reads (file_id, agent_id, version) values ($1, $2, $3)
     on conflict (file_id, agent_id) do update set version = greatest(core.file_reads.version, excluded.version), read_at = now()`,
    [input.fileId, input.agentId, input.version],
  );
}

/** A file in a conversation whose newest version is the owner's, as the next turn's context tells it. */
export interface OwnerNewestFile {
  fileId: string;
  name: string | null;
  /** The owner's version: the newest. */
  version: number;
  artifactId: string;
  savedAt: string;
  /** The newest version this agent wrote, if it wrote one. */
  yours: number | null;
  /**
   * A command's output whose workspace copy holds the owner's version (his
   * save was written back there): its path in the workspace.
   */
  workspacePath?: string;
}

/**
 * The files of a conversation an agent made or wrote whose newest version
 * is the owner's and the agent has not read (`recordFileRead`): derived from
 * the versions, so it stays true until the agent reads or writes the file
 * again (newest first, at most `limit`).
 */
export async function filesNewestByOwner(pool: Queryable, conversationId: string, agentId: string, limit = 5): Promise<OwnerNewestFile[]> {
  const { rows } = await pool.query(
    `select f.id, f.name, f.origin_path, f.origin_sha256, n.id as artifact_id, n.version, n.created_at, n.sha256,
            (select max(v.version) from core.artifacts v where v.file_id = f.id and v.created_by = $2 and v.deleted_at is null) as yours
       from core.files f
       cross join lateral (
         select a.id, a.version, a.created_at, a.sha256, a.created_by from core.artifacts a
          where a.file_id = f.id and a.deleted_at is null order by a.version desc limit 1
       ) n
      where f.conversation_id = $1 and f.deleted_at is null and n.created_by = 'owner'
        and (f.created_by = $2 or exists (select 1 from core.artifacts v where v.file_id = f.id and v.created_by = $2))
        -- Once the agent has read his version, it knows.
        and not exists (select 1 from core.file_reads r where r.file_id = f.id and r.agent_id = $2 and r.version >= n.version)
      order by n.created_at desc
      limit $3`,
    [conversationId, agentId, limit],
  );
  return rows.map((row) => ({
    fileId: String(row.id),
    name: row.name ?? null,
    version: Number(row.version),
    artifactId: String(row.artifact_id),
    savedAt: toIso(row.created_at) ?? '',
    yours: row.yours === null || row.yours === undefined ? null : Number(row.yours),
    // host/workspaces/<key>/<path>: the path inside the workspace.
    ...(row.origin_path && row.origin_sha256 === row.sha256 ? { workspacePath: String(row.origin_path).split('/').slice(3).join('/') } : {}),
  }));
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
/**
 * The first `maxBytes` of an artifact, read from disk without loading the
 * rest: what a preview shows. `truncated` says whether the file went on.
 */
export async function readArtifactPrefix(
  env: EnvLike,
  row: Pick<ArtifactRow, 'id' | 'storagePath' | 'sizeBytes'>,
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const absolute = path.join(resolveDataDir(env), row.storagePath);
  const handle = await open(absolute, 'r').catch((err: unknown) => {
    throw new Error(`artifact ${row.id}: bytes missing at ${row.storagePath} (${err instanceof Error ? err.message : String(err)})`, { cause: err });
  });
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, maxBytes);
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(bytes, read, length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { bytes: bytes.subarray(0, read), truncated: size > maxBytes };
  } finally {
    await handle.close();
  }
}

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
 * The owner deleting a file from Files, with every version it has. Soft, like
 * `deleteArtifact`: the file and its live versions are tombstoned at one
 * moment (so `undeleteFile` brings back exactly those), a conversation that
 * carried one shows it as deleted, and nothing on disk or in a workspace
 * changes. Under the file's lock: a version being written waits, then finds
 * the file gone. False when there was nothing live to delete.
 */
export async function deleteFile(pool: Pool, fileId: string, at: Date = new Date()): Promise<boolean> {
  return transaction(pool, async (client) => {
    await lockFile(client, fileId);
    const { rows } = await client.query(`update core.files set deleted_at = $2 where id = $1 and deleted_at is null returning id`, [fileId, at]);
    if (rows.length === 0) return false;
    await client.query(`update core.artifacts set deleted_at = $2 where file_id = $1 and deleted_at is null`, [fileId, at]);
    return true;
  });
}

/**
 * One version deleted: the one before it is the newest again. The last live
 * version takes its file with it. Under the file's lock.
 */
export async function deleteFileVersion(pool: Pool, fileId: string, version: number, at: Date = new Date()): Promise<{ deleted: boolean; fileDeleted: boolean }> {
  return transaction(pool, async (client) => {
    await lockFile(client, fileId);
    const { rows } = await client.query(
      `update core.artifacts set deleted_at = $3 where file_id = $1 and version = $2 and deleted_at is null returning id`,
      [fileId, version, at],
    );
    if (rows.length === 0) return { deleted: false, fileDeleted: false };
    const { rows: gone } = await client.query(
      `update core.files set deleted_at = $2 where id = $1 and deleted_at is null
         and not exists (select 1 from core.artifacts a where a.file_id = $1 and a.deleted_at is null)
       returning id`,
      [fileId, at],
    );
    return { deleted: true, fileDeleted: gone.length > 0 };
  });
}

/** Undo a file's delete: it comes back with the versions deleted with it, unless purged. */
export async function undeleteFile(pool: Pool, fileId: string): Promise<boolean> {
  return transaction(pool, async (client) => {
    await lockFile(client, fileId);
    const { rows } = await client.query(`select deleted_at from core.files where id = $1 and deleted_at is not null`, [fileId]);
    if (!rows[0]) return false;
    await client.query(`update core.artifacts set deleted_at = null where file_id = $1 and deleted_at = $2`, [fileId, rows[0].deleted_at]);
    await client.query(`update core.files set deleted_at = null where id = $1`, [fileId]);
    return true;
  });
}

/** Undo a version's delete (and its file's, when it was the last one). */
export async function undeleteFileVersion(pool: Pool, fileId: string, version: number): Promise<boolean> {
  return transaction(pool, async (client) => {
    await lockFile(client, fileId);
    const { rows } = await client.query(
      `update core.artifacts set deleted_at = null where file_id = $1 and version = $2 and deleted_at is not null returning id`,
      [fileId, version],
    );
    if (rows.length === 0) return false;
    await client.query(`update core.files set deleted_at = null where id = $1`, [fileId]);
    return true;
  });
}

/** How long a deleted file can still be brought back before its rows go for good. */
export const DELETED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Versions tombstoned before `olderThan` go for good — once the upgrade that
 * brought the purge is itself older than that (`core.artifact_purge_epoch`):
 * what was tombstoned before it gets its month from then. Files left with none
 * go with them, and so do the bytes no remaining version stores: blobs are
 * content-addressed, so the same bytes may be another version's too. Each
 * blob is checked and unlinked under its lock, the one a writer holds until
 * its row is in, so a save that adopts the blob meanwhile keeps it. Run from
 * the hourly artifact sweep. Returns the rows and blobs removed.
 */
export async function purgeDeletedArtifacts(
  pool: Pool,
  olderThan: Date,
  env: EnvLike = process.env,
): Promise<{ rows: number; blobs: number }> {
  // A row deleted before the purge existed (086) has its month from the upgrade: until a month after it, nothing goes.
  const { rows: epoch } = await pool.query<{ counted_from: Date }>(`select counted_from from core.artifact_purge_epoch limit 1`);
  if (epoch[0] && new Date(epoch[0].counted_from).getTime() >= olderThan.getTime()) return { rows: 0, blobs: 0 };
  const { rows: due } = await pool.query<{ file_id: string }>(
    `select distinct file_id from core.artifacts where deleted_at is not null and deleted_at < $1`,
    [olderThan],
  );
  const paths = new Set<string>();
  let removed = 0;
  // File by file, under the file's lock: a save, a dedup or an undelete of it waits, then sees what is left.
  for (const { file_id: fileId } of due) {
    await transaction(pool, async (client) => {
      await lockFile(client, String(fileId));
      const { rows } = await client.query<{ storage_path: string }>(
        `delete from core.artifacts where file_id = $1 and deleted_at is not null and deleted_at < $2 returning storage_path`,
        [fileId, olderThan],
      );
      removed += rows.length;
      for (const row of rows) paths.add(row.storage_path);
      await client.query(`delete from core.files f where f.id = $1 and not exists (select 1 from core.artifacts a where a.file_id = f.id)`, [fileId]);
    });
  }
  let blobs = 0;
  for (const relative of paths) {
    // Only ever a path under the data dir's artifacts folder, as the store wrote it.
    if (!/^artifacts\/\d{4}\/\d{2}\/[0-9a-f]{64}\.[a-z0-9]{1,8}$/.test(relative)) continue;
    const gone = await transaction(pool, async (client) => {
      await lock(client, `buddi.blob:${relative}`);
      const { rows: still } = await client.query(`select 1 from core.artifacts where storage_path = $1 limit 1`, [relative]);
      if (still.length > 0) return false;
      return unlink(path.join(resolveDataDir(env), relative)).then(() => true, () => false);
    });
    if (gone) blobs += 1;
  }
  return { rows: removed, blobs };
}

/**
 * Soft delete of one version by id (a discarded upload): tombstoned so
 * references stay explicable; the last live version takes its file with it.
 * The bytes stay on disk until the purge. False when there was nothing live
 * to delete.
 */
export async function deleteArtifact(
  pool: Pool,
  id: string,
  at: Date = new Date(),
): Promise<boolean> {
  const { rows } = await pool.query(`select file_id, version from core.artifacts where id = $1 and deleted_at is null`, [id]);
  if (!rows[0]) return false;
  return (await deleteFileVersion(pool, String(rows[0].file_id), Number(rows[0].version), at)).deleted;
}
