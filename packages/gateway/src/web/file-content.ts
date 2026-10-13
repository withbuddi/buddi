/**
 * A text file in Files, read whole and written back by the owner: the canvas
 * editor's two routes (`GET` and `PUT /api/artifacts/:id/content`).
 *
 * Only a file the library holds, named by its id. Nothing in a request is a
 * path: the bytes are read from the row's own storage path and written to the
 * one their hash gives, under the data dir (`replaceArtifactContent`). Only
 * text, by the same rule the preview route uses, and at most `MAX_EDIT_BYTES`.
 *
 * A save names the hash of the version it edited. If the file changed since —
 * its bytes, or a newer version written under the same name in the same
 * conversation — the save is refused with 409 and the version that won, so
 * the page can offer "yours or buddi's" rather than overwrite either.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { holdWorkspaces, hostWorkspaceDir, hostWorkspaceKey, workspaceBusy } from '@buddi/tool-host';
import type { Pool } from 'pg';
import {
  artifactBytesExist,
  getArtifact,
  recordArtifactUse,
  saveArtifactReporting,
  readArtifactPrefix,
  replaceArtifactContent,
  resolveDataDir,
  textPreviewable,
  type ArtifactRow,
  type EnvLike,
  type WorkspaceCopy,
  type WorkspaceRow,
} from '@buddi/core';

/** The largest file the editor edits; a bigger one opens read-only, its start only. */
export const MAX_EDIT_BYTES = 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/;

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Why the way from `base` down to `file` cannot be trusted, or null: every
 * component is looked at with lstat, and none may be a symbolic link or a
 * junction (Node reports both as links). `missing` when a component is gone.
 */
async function linkOnTheWay(base: string, file: string): Promise<'outside' | 'missing' | 'link' | null> {
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
 * A sandboxed command is confined to its workspace, so this write must never
 * reach outside one. The workspace is computed from the data dir — the one
 * trusted base — for the agent and conversation the file belongs to, never
 * read from the disk; the recorded path must lie lexically inside it, and
 * every component on the way is lstat'ed and refused if it is a link. The
 * copy is written back only while it still holds what buddi last read or
 * wrote there (or already the owner's text); a copy a command changed since
 * comes back with what it holds now, unless he chose to overwrite it.
 *
 * The new bytes are staged in a new file beside the copy (exclusive create)
 * and renamed over it once the save is committed — a rename replaces a link
 * at the leaf rather than following it — after the folders and the copy's
 * hash are checked once more, and after it the copy must still resolve to
 * the same place. A copy that is gone is left alone, and said so.
 *
 * All of it runs holding host.exec's process-wide lock (`holdWorkspaces`),
 * so no command buddi starts can swap a folder between a check and the
 * rename. What remains is a process an earlier command left running in the
 * background (host.exec ends its process tree, but a detached daemon can
 * escape that), or a command already running in another conversation with
 * its cwd here: it could still race the rename. The check after the rename
 * catches the result and reports it, loudly, rather than preventing it.
 */
async function workspaceCopy(
  env: EnvLike,
  ownerId: string,
  captured: WorkspaceRow,
  save: { base: string; next: string; bytes: Buffer; overwrite: boolean },
): Promise<WorkspaceCopy> {
  if (!captured.conversationId) return { kind: 'refused', reason: 'it belongs to no conversation' };
  const data = await realpath(resolveDataDir(env)).catch(() => null);
  if (!data) return { kind: 'none' };
  const root = hostWorkspaceDir(data, ownerId, captured.createdBy, captured.conversationId);
  const file = path.join(data, captured.originPath);
  if (!inside(root, file)) return { kind: 'refused', reason: 'it is not in this agent’s workspace for this conversation' };
  const way = await linkOnTheWay(data, file);
  if (way === 'missing') return { kind: 'refused', reason: 'the workspace copy is gone; saved in Files only' };
  if (way !== null) return { kind: 'refused', reason: LINKED };
  if (!(await lstat(file)).isFile()) return { kind: 'refused', reason: 'it is no longer a file' };
  const known = captured.originSha256 ?? save.base;
  const holds = async (): Promise<{ ok: boolean; there: Buffer }> => {
    const there = await readFile(file);
    const hash = sha256Hex(there);
    return { ok: save.overwrite || hash === known || hash === save.next, there };
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
        console.error(`file-content: the workspace copy of ${captured.id} no longer resolves inside its workspace after the owner's save (${file} → ${after ?? 'gone'}); refused`);
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

function current(row: ArtifactRow): { artifactId: string; sha256: string; filename: string | null } {
  return { artifactId: row.id, sha256: row.sha256, filename: row.filename };
}

export async function readFileContent(pool: Pool, env: EnvLike, id: string): Promise<Answer> {
  const row = await getArtifact(pool, id);
  if (!row) return { status: 404, body: { error: 'no such file' } };
  if (!textPreviewable(row.mime, row.filename)) return { status: 415, body: { error: 'this file is not text' } };
  if (!(await artifactBytesExist(env, row).catch(() => false))) return { status: 410, body: { error: 'the file’s contents are gone from disk' } };
  const prefix = await readArtifactPrefix(env, row, MAX_EDIT_BYTES);
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
      text, sha256: row.sha256, sizeBytes: row.sizeBytes, editable: !prefix.truncated && utf8, truncated: prefix.truncated,
      ...(utf8 ? {} : { note: 'encoding' }),
    },
  };
}

export async function saveFileContent(pool: Pool, env: EnvLike, id: string, body: Record<string, unknown>, ownerId: string): Promise<Answer> {
  const { text, base } = body;
  if (typeof text !== 'string') return { status: 400, body: { error: '`text` must be a string' } };
  if (typeof base !== 'string' || !SHA256.test(base)) return { status: 400, body: { error: '`base` must be the sha256 of the version edited' } };
  const row = await getArtifact(pool, id);
  if (!row) return { status: 404, body: { error: 'no such file' } };
  if (!textPreviewable(row.mime, row.filename)) return { status: 415, body: { error: 'this file is not text' } };
  // Only a file the editor could open for editing: within the size, and UTF-8.
  if (row.sizeBytes > MAX_EDIT_BYTES) return { status: 413, body: { error: 'a file edited here can be at most 1 MiB' } };
  const stored = await readArtifactPrefix(env, row, MAX_EDIT_BYTES).catch(() => null);
  if (stored && !Buffer.from(stored.bytes.toString('utf8'), 'utf8').equals(stored.bytes)) {
    return { status: 415, body: { error: 'this file is not UTF-8 text, so it cannot be saved from the editor' } };
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_EDIT_BYTES) return { status: 413, body: { error: 'a file edited here can be at most 1 MiB' } };
  const overwrite = body.overwriteWorkspace === true;
  const replace = (): ReturnType<typeof replaceArtifactContent> => replaceArtifactContent(pool, {
    id, bytes, expectedSha256: base,
    workspace: (captured) => workspaceCopy(env, ownerId, captured, { base, next: sha256Hex(bytes), bytes, overwrite }),
  }, env);
  /*
   * A command's output is saved holding its workspace (host.exec's lock): no
   * command starts meanwhile, and none may be running — it could be changing
   * the very file.
   */
  const origin = await pool.query(`select origin_path, created_by, conversation_id from core.artifacts where id = $1`, [id]);
  const captured = origin.rows[0]?.origin_path && origin.rows[0]?.conversation_id
    ? hostWorkspaceKey(ownerId, String(origin.rows[0].created_by), String(origin.rows[0].conversation_id)) : null;
  const result = captured
    ? await holdWorkspaces(async () => (workspaceBusy(captured) ? 'busy' as const : replace()))
    : await replace();
  if (result === 'busy') return { status: 409, body: { error: 'buddi is running a command in this conversation; try again when it finishes', busy: true } };
  if (result.ok) {
    const copy = result.workspace;
    return {
      status: 200,
      body: {
        sha256: result.row.sha256, sizeBytes: result.row.sizeBytes,
        ...(copy ? { workspace: copy } : {}),
        ...(copy && !copy.updated ? { note: `Saved in Files; the workspace copy couldn’t be updated: ${copy.reason}.` } : {}),
      },
    };
  }
  if (result.reason === 'gone') return { status: 404, body: { error: 'no such file' } };
  if (result.reason === 'workspace') {
    return { status: 409, body: { error: 'buddi changed this file in its workspace since you opened it', current: current(result.current), workspaceText: result.workspaceText } };
  }
  if (result.reason === 'duplicate') return { status: 409, body: { error: 'these exact contents are already another file here' } };
  return { status: 409, body: { error: 'the file changed since you opened it', current: current(result.current) } };
}

/**
 * "Save as new file": the owner's text, from an editor whose file was
 * deleted under it, kept as a file of his own — the deleted file's name and
 * type, in its conversation (so Files lists it), never the deleted row back.
 */
export async function saveAsNewFile(pool: Pool, env: EnvLike, id: string, body: Record<string, unknown>): Promise<Answer> {
  const { text } = body;
  if (typeof text !== 'string' || text === '') return { status: 400, body: { error: '`text` must be the text to keep' } };
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_EDIT_BYTES) return { status: 413, body: { error: 'a file edited here can be at most 1 MiB' } };
  const { rows } = await pool.query(`select filename, mime, conversation_id from core.artifacts where id = $1`, [id]);
  const from = rows[0];
  if (!from) return { status: 404, body: { error: 'no such file' } };
  if (!textPreviewable(String(from.mime), from.filename ?? null)) return { status: 415, body: { error: 'this file is not text' } };
  const conversationId = from.conversation_id ? String(from.conversation_id) : null;
  const saved = await saveArtifactReporting(pool, {
    bytes, mime: String(from.mime), filename: from.filename ?? 'Untitled.txt', createdBy: 'owner', conversationId,
  }, env);
  if (conversationId) await recordArtifactUse(pool, { artifactId: saved.row.id, conversationId, kind: 'uploaded' });
  return { status: 200, body: { artifactId: saved.row.id, filename: saved.row.filename, sha256: saved.row.sha256 } };
}
