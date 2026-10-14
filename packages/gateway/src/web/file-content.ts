/**
 * A file in Files as the canvas editor and the Files page work on it
 * (docs/files.md): `/api/files/:id` — the file and its versions, its current
 * version's text, the owner's save and Restore (each a new version), delete
 * and undelete, and a new file of his own.
 *
 * Only a file the library holds, named by its id (or any version's). Nothing
 * in a request is a path: bytes are read from a version's own storage path
 * and stored at the one their hash gives, under the data dir. Only text, by
 * the rule the dashboard opens the editor with (`@buddi/core/text-files`),
 * and at most `MAX_EDIT_BYTES`.
 *
 * A save names the version it edited (`base`). A newer one saved since — by
 * buddi, a command, another tab — refuses it with 409 and that version, so
 * the page can offer "theirs or mine" rather than overwrite either. Every
 * refusal has one shape: `{ error, conflict, current?, workspaceText? }`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { commandsRunning, holdWorkspaces, hostWorkspaceDir, workspaceRanConfined } from '@buddi/tool-host';
import type { Pool } from 'pg';
import {
  artifactBytesExist,
  currentVersion,
  deleteFile,
  deleteFileVersion,
  fileVersions,
  getFile,
  libraryVersions,
  readArtifactBytes,
  readArtifactPrefix,
  recordArtifactUse,
  resolveDataDir,
  resolveFileId,
  saveNewFile,
  getLibraryEntry,
  CHANGED_SINCE,
  saveOwnerVersion,
  isTextFile,
  undeleteFile,
  undeleteFileVersion,
  type ArtifactRow,
  type EnvLike,
  type FileRecord,
  type OwnerSaveResult,
  type WorkspaceCopy,
  type WorkspaceFile,
} from '@buddi/core';

/** The largest file the editor edits; a bigger one opens read-only, its start only. */
export const MAX_EDIT_BYTES = 1024 * 1024;

export { CHANGED_SINCE };

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Why the way from `base` down to `file` cannot be trusted, or null: every
 * component is looked at with lstat, and none may be a symbolic link or a
 * junction (Node reports both as links). `missing` when a component is gone.
 */
export async function linkOnTheWay(base: string, file: string): Promise<'outside' | 'missing' | 'link' | null> {
  if (!inside(base, file)) return 'outside';
  let at = base;
  for (const part of path.relative(base, file).split(path.sep)) {
    at = path.join(at, part);
    const info = await lstat(at).catch(() => null);
    if (!info) return 'missing';
    if (info.isSymbolicLink()) return 'link';
  }
  return null;
}

const LINKED = 'its folder in buddi’s workspace is a link, so buddi did not write through it';

/**
 * The workspace copy a command's output was captured from (host.exec's
 * outputs), judged for the owner's save.
 *
 * Only an unconfined workspace is written. A workspace where a sandboxed run
 * (a skill bundle's script) ever ran is marked (host's `workspaceRanConfined`)
 * and gets the owner's save in Files only: a process that run left behind
 * could swap a folder between these path checks and the rename — Node has
 * no openat — and so write outside its sandbox through the save. Where only
 * unconfined commands ran, every process there already runs as the owner's
 * own user and can write anywhere he can, so no escape exists; the checks
 * below guard against accidents, not against an adversary.
 *
 * The write must never reach outside the workspace. The workspace is computed from the data dir — the one
 * trusted base — for the agent and conversation the *file* belongs to, never
 * read from the disk and never from who wrote a version; the recorded path
 * must lie lexically inside it, and every component on the way is lstat'ed
 * and refused if it is a link. The copy is written back only while it still
 * holds what buddi last read or wrote there (or already the owner's text); a
 * copy a command changed since comes back with what it holds now, unless he
 * chose to overwrite it.
 *
 * The new bytes are staged in a new file beside the copy (exclusive create)
 * and renamed over it once the save is committed — a rename replaces a link
 * at the leaf rather than following it — after the folders and the copy's
 * hash are checked once more, and after it the copy must still resolve to
 * the same place. A copy that is gone is left alone, and said so.
 *
 * All of it runs holding host.exec's process-wide lock (`holdWorkspaces`),
 * and only while no command is running anywhere (`commandsRunning`): a
 * command in another conversation may use this workspace as its cwd, and
 * nothing buddi starts can swap a folder between a check and the rename.
 * What remains is a process an unconfined command left running in the
 * background, which is the owner's own; the check after the rename catches a
 * moved folder and reports it, loudly.
 */
async function workspaceCopy(
  env: EnvLike,
  ownerId: string,
  captured: WorkspaceFile,
  save: { bytes: Buffer; overwrite: boolean },
): Promise<WorkspaceCopy> {
  if (!captured.conversationId) return { kind: 'refused', reason: 'it belongs to no conversation' };
  const data = await realpath(resolveDataDir(env)).catch(() => null);
  if (!data) return { kind: 'none' };
  if (await workspaceRanConfined(data, ownerId, captured.createdBy, captured.conversationId)) {
    return { kind: 'refused', reason: 'this agent’s workspace ran sandboxed scripts, so buddi does not write into it; saved in Files only' };
  }
  const root = hostWorkspaceDir(data, ownerId, captured.createdBy, captured.conversationId);
  const file = path.join(data, captured.originPath);
  if (!inside(root, file)) return { kind: 'refused', reason: 'it is not in this agent’s workspace for this conversation' };
  const way = await linkOnTheWay(data, file);
  if (way === 'missing') return { kind: 'refused', reason: 'the workspace copy is gone; saved in Files only' };
  if (way !== null) return { kind: 'refused', reason: LINKED };
  if (!(await lstat(file)).isFile()) return { kind: 'refused', reason: 'it is no longer a file' };
  const next = sha256Hex(save.bytes);
  const holds = async (): Promise<{ ok: boolean; there: Buffer }> => {
    const there = await readFile(file);
    const hash = sha256Hex(there);
    return { ok: save.overwrite || hash === captured.known || hash === next, there };
  };
  const first = await holds();
  if (!first.ok) return { kind: 'changed', text: first.there.toString('utf8') };
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.buddi-${randomUUID()}`);
  await writeFile(temp, save.bytes, { flag: 'wx', mode: 0o644 });
  return {
    kind: 'write',
    commit: async () => {
      if ((await linkOnTheWay(data, path.dirname(file))) !== null) throw new Error(LINKED);
      const leaf = await lstat(file).catch(() => null);
      if (leaf?.isSymbolicLink()) throw new Error(LINKED);
      if (leaf && !(await holds()).ok) throw new Error('a command changed it meanwhile');
      await rename(temp, file);
      // And once more after: the file must still be where it was, by no link.
      const after = await realpath(file).catch(() => null);
      if (after !== file || (await linkOnTheWay(data, file)) !== null) {
        console.error(`file-content: the workspace copy of file ${captured.fileId} no longer resolves inside its workspace after the owner's save (${file} → ${after ?? 'gone'}); refused`);
        throw new Error('the workspace copy no longer resolves inside its workspace');
      }
    },
    abort: () => unlink(temp).catch(() => {}),
  };
}

export interface Answer {
  status: number;
  body: unknown;
}

/** A version as a refusal names it: the one to look at. */
export function versionRef(row: ArtifactRow): { fileId: string; version: number; artifactId: string; sha256: string; createdBy: string } {
  return { fileId: row.fileId, version: row.version, artifactId: row.id, sha256: row.sha256, createdBy: row.createdBy };
}

const NOT_FOUND: Answer = { status: 404, body: { error: 'no such file' } };

/** The live file an id names (its own, or any version's), or why not. */
export async function liveFile(pool: Pool, id: string): Promise<{ file: FileRecord; current: ArtifactRow } | Answer> {
  const fileId = await resolveFileId(pool, id);
  const file = fileId ? await getFile(pool, fileId) : null;
  if (!file) return NOT_FOUND;
  const current = await currentVersion(pool, file.id);
  if (!current) return { status: 404, body: { error: 'this file was deleted from Files', deleted: true } };
  return { file, current };
}

export function isAnswer(value: unknown): value is Answer {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
}

/**
 * `GET /api/files/:id`: the file, its newest version and every live version,
 * newest first — and, for the Files page, the library's entry for the version
 * shown (`version`, else the newest), where the file was used and whether the
 * bytes are there. One read for the canvas and Files alike.
 */
export async function readFileView(pool: Pool, env: EnvLike, id: string, opts: { knownAgentIds?: readonly string[]; version?: number; contextsOffset?: number; nameOf?: (agentId: string) => string | null } = {}): Promise<Answer> {
  const found = await liveFile(pool, id);
  if (isAnswer(found)) return found;
  const { file, current } = found;
  const versions = await libraryVersions(pool, file.id);
  const shown = opts.version === undefined ? null : versions.find((v) => v.version === opts.version) ?? null;
  if (opts.version !== undefined && !shown) return { status: 404, body: { error: `there is no version ${opts.version} of this file` } };
  const library = await getLibraryEntry(pool, shown?.id ?? current.id, opts.knownAgentIds ?? [], opts.contextsOffset ?? 0);
  const row = (await fileVersions(pool, file.id)).find((v) => v.id === (shown?.id ?? current.id));
  return {
    status: 200,
    body: {
      file: { id: file.id, name: file.name, mime: file.mime, conversationId: file.conversationId, origin: file.origin, createdBy: file.createdBy },
      // Who wrote the newest version, as a person reads it: an agent's name, else its id.
      current: { ...versionRef(current), createdByName: current.createdBy === 'owner' ? null : opts.nameOf?.(current.createdBy) ?? current.createdBy },
      versions,
      // Null when the file is not one the library lists (an upload still in a tray).
      entry: library?.entry ?? null,
      contexts: library?.contexts ?? [],
      contextsTotal: library?.contextsTotal ?? 0,
      contextsOffset: library?.contextsOffset ?? 0,
      available: row ? await artifactBytesExist(env, row).catch(() => false) : false,
    },
  };
}

/** `GET /api/files/:id/content`: the current version's text, for the editor. */
export async function readFileContent(pool: Pool, env: EnvLike, id: string): Promise<Answer> {
  const found = await liveFile(pool, id);
  if (isAnswer(found)) return found;
  const { file, current } = found;
  if (!isTextFile(file.mime, file.name)) return { status: 415, body: { error: 'this file is not text' } };
  if (!(await artifactBytesExist(env, current).catch(() => false))) return { status: 410, body: { error: 'the file’s contents are gone from disk' } };
  const prefix = await readArtifactPrefix(env, current, MAX_EDIT_BYTES);
  // Cut on a character boundary: a truncated file never ends in half a letter.
  const text = new StringDecoder('utf8').write(prefix.bytes);
  /*
   * Text that is not UTF-8 (Latin-1, UTF-16) would come back from the editor
   * as different bytes: such a file is shown, never saved over.
   */
  const utf8 = prefix.truncated || Buffer.from(text, 'utf8').equals(prefix.bytes);
  return {
    status: 200,
    body: {
      ...versionRef(current),
      // Where a "Save as new file" of an edit lands, should the file be deleted under it.
      conversationId: file.conversationId,
      text, sizeBytes: current.sizeBytes, editable: !prefix.truncated && utf8, truncated: prefix.truncated,
      ...(utf8 ? {} : { note: 'encoding' }),
    },
  };
}

/** Why a save body is malformed, or null. */
function badSave(body: Record<string, unknown>): string | null {
  if (!Number.isInteger(body.base) || (body.base as number) < 1) return '`base` must be the number of the version opened';
  const restore = body.from !== undefined;
  if (restore && (!Number.isInteger(body.from) || (body.from as number) < 1)) return '`from` must be the number of the version to restore';
  if (!restore && typeof body.text !== 'string') return '`text` must be a string';
  return null;
}

/**
 * `POST /api/files/:id/versions`: the owner's save — his edit (`text`), or a
 * Restore (`from`: that version's bytes, copied here, never a preview) — as
 * a new version over `base`, the one he opened.
 *
 * A command's output is saved holding every workspace (host.exec's lock: no
 * command starts meanwhile) and only while none is running, in any
 * conversation: one could be changing the very file, or have its cwd there.
 */
export async function saveFileVersion(pool: Pool, env: EnvLike, id: string, body: Record<string, unknown>, ownerId: string): Promise<Answer> {
  const bad = badSave(body);
  if (bad) return { status: 400, body: { error: bad } };
  const found = await liveFile(pool, id);
  if (isAnswer(found)) return found;
  const { file } = found;
  const base = body.base as number;
  let bytes: Buffer;
  let restoredFrom: number | undefined;
  if (body.from !== undefined) {
    restoredFrom = body.from as number;
    const source = (await fileVersions(pool, file.id)).find((v) => v.version === restoredFrom);
    if (!source) return { status: 404, body: { error: `there is no version ${restoredFrom} of this file` } };
    bytes = await readArtifactBytes(env, source);
  } else {
    if (!isTextFile(file.mime, file.name)) return { status: 415, body: { error: 'this file is not text' } };
    // Only over what the editor could open for editing: within the size, and UTF-8.
    if (found.current.sizeBytes > MAX_EDIT_BYTES) return { status: 413, body: { error: 'a file edited here can be at most 1 MiB' } };
    const stored = await readArtifactPrefix(env, found.current, MAX_EDIT_BYTES).catch(() => null);
    if (stored && !Buffer.from(stored.bytes.toString('utf8'), 'utf8').equals(stored.bytes)) {
      return { status: 415, body: { error: 'this file is not UTF-8 text, so it cannot be saved from the editor' } };
    }
    bytes = Buffer.from(body.text as string, 'utf8');
    if (bytes.length > MAX_EDIT_BYTES) return { status: 413, body: { error: 'a file edited here can be at most 1 MiB' } };
    if (bytes.length === 0) return { status: 400, body: { error: 'an empty file cannot be saved; delete it instead' } };
  }
  return saveOwnerBytes(pool, env, file, {
    bytes, base, overwriteWorkspace: body.overwriteWorkspace === true,
    ...(restoredFrom === undefined ? {} : { restoredFrom }),
  }, ownerId);
}

/**
 * The one way an owner's bytes become a new version, whatever made them —
 * his edit, a Restore, a save in his own app (Open in app): under the file's
 * lock, over `base`, the version he started from; a command's output also
 * into its workspace (above). Every refusal has the one shape.
 */
export async function saveOwnerBytes(
  pool: Pool,
  env: EnvLike,
  file: FileRecord,
  input: { bytes: Buffer; base: number; restoredFrom?: number; overwriteWorkspace?: boolean },
  ownerId: string,
): Promise<Answer> {
  const { bytes, base, restoredFrom } = input;
  const overwrite = input.overwriteWorkspace === true;
  const save = (): Promise<OwnerSaveResult> => saveOwnerVersion(pool, {
    fileId: file.id, bytes, base,
    ...(restoredFrom === undefined ? {} : { restoredFrom }),
    workspace: (captured) => workspaceCopy(env, ownerId, captured, { bytes, overwrite }),
  }, env);
  const result = file.originPath
    ? await holdWorkspaces(async () => (commandsRunning() > 0 ? 'busy' as const : save()))
    : await save();
  if (result === 'busy') {
    return { status: 409, body: { error: 'buddi is running a command; try again when it finishes', conflict: 'busy' } };
  }
  if (result.ok) {
    const copy = result.workspace;
    return {
      status: 200,
      body: {
        ...versionRef(result.row), sizeBytes: result.row.sizeBytes, created: result.created,
        ...(copy ? { workspace: copy } : {}),
        ...(copy && !copy.updated ? { note: `Saved in Files; the workspace copy couldn’t be updated: ${copy.reason}.` } : {}),
      },
    };
  }
  if (result.reason === 'gone') return { status: 404, body: { error: 'this file was deleted from Files', deleted: true } };
  if (result.reason === 'workspace') {
    return { status: 409, body: { error: `${CHANGED_SINCE}: a command changed its copy in buddi’s workspace.`, conflict: 'workspace', current: versionRef(result.current), workspaceText: result.workspaceText } };
  }
  return { status: 409, body: { error: `${CHANGED_SINCE}: v${result.current.version} is newer.`, conflict: 'newer', current: versionRef(result.current) } };
}

/** `DELETE /api/files/:id[/versions/:n]`: soft, for 30 days (`undeleteFiles` undoes it). */
export async function deleteFromFiles(pool: Pool, id: string, version: number | null, at: Date): Promise<Answer> {
  const fileId = await resolveFileId(pool, id);
  if (!fileId) return NOT_FOUND;
  if (version === null) {
    return (await deleteFile(pool, fileId, at)) ? { status: 200, body: { fileId } } : NOT_FOUND;
  }
  const out = await deleteFileVersion(pool, fileId, version, at);
  return out.deleted ? { status: 200, body: { fileId, version, fileDeleted: out.fileDeleted } } : NOT_FOUND;
}

/** `POST /api/files/:id/undelete`: the file (or one version) back, unless purged. */
export async function undeleteFiles(pool: Pool, id: string, body: Record<string, unknown>): Promise<Answer> {
  const fileId = await resolveFileId(pool, id);
  if (!fileId) return NOT_FOUND;
  if (body.version !== undefined && (!Number.isInteger(body.version) || (body.version as number) < 1)) {
    return { status: 400, body: { error: '`version` must be a version number' } };
  }
  const restored = body.version === undefined ? await undeleteFile(pool, fileId) : await undeleteFileVersion(pool, fileId, body.version as number);
  return restored ? { status: 200, body: { fileId, restored: true } } : NOT_FOUND;
}

/**
 * `POST /api/files`: a text file of the owner's own, in a conversation when
 * one is named — what "Save as new file" makes from an editor whose file was
 * deleted under it. An upload like any other: nothing of the deleted file is
 * brought back, and the conversation records it as his.
 */
export async function createOwnerFile(pool: Pool, env: EnvLike, body: Record<string, unknown>, ownerId: string): Promise<Answer> {
  const { text, name, mime, conversationId } = body;
  if (typeof text !== 'string' || text === '') return { status: 400, body: { error: '`text` must be the file’s text' } };
  if (typeof name !== 'string' || name.trim() === '' || name.length > 260 || /[\\/\u0000]/.test(name)) return { status: 400, body: { error: '`name` must be a file name' } };
  const type = typeof mime === 'string' && mime.trim() !== '' ? mime.trim() : 'text/plain';
  if (!isTextFile(type, name)) return { status: 415, body: { error: 'only a text file can be made here' } };
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_EDIT_BYTES) return { status: 413, body: { error: 'a file edited here can be at most 1 MiB' } };
  let conversation: string | null = null;
  if (conversationId !== undefined && conversationId !== null) {
    if (typeof conversationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(conversationId)) return { status: 400, body: { error: '`conversationId` must be a conversation id' } };
    const { rows } = await pool.query(`select 1 from core.conversations where id = $1`, [conversationId]);
    if (rows.length === 0) return { status: 404, body: { error: 'no such conversation' } };
    conversation = conversationId;
  }
  // Always a new file: bytes another file holds are shared on disk, never that file.
  const saved = await saveNewFile(pool, {
    bytes, mime: type, name: name.trim(), createdBy: ownerId, conversationId: conversation,
    source: { surface: 'files', chatId: conversation, messageId: randomUUID() },
  }, env);
  if (conversation) await recordArtifactUse(pool, { artifactId: saved.row.id, conversationId: conversation, kind: 'uploaded' });
  return { status: 200, body: { ...versionRef(saved.row), filename: saved.row.filename } };
}
