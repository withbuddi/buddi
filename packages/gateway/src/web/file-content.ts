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
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { hostWorkspaceDir } from '@buddi/tool-host';
import type { Pool } from 'pg';
import {
  artifactBytesExist,
  getArtifact,
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
 * The workspace copy a command's output was captured from (host.exec's
 * outputs), judged for the owner's save. Written back only inside the
 * workspace of the agent and conversation that made it, and only while it
 * still holds what the owner opened (or already his text); a copy changed
 * since comes back with what it holds now, unless he chose to overwrite it.
 * A copy that is gone, or anywhere else, is left alone: Files is saved.
 */
async function workspaceCopy(
  env: EnvLike,
  ownerId: string,
  captured: WorkspaceRow,
  save: { base: string; next: string; bytes: Buffer; overwrite: boolean },
): Promise<WorkspaceCopy> {
  if (!captured.conversationId) return { kind: 'none' };
  const data = await realpath(resolveDataDir(env)).catch(() => null);
  if (!data) return { kind: 'none' };
  const root = await realpath(hostWorkspaceDir(data, ownerId, captured.createdBy, captured.conversationId)).catch(() => null);
  const file = await realpath(path.join(data, captured.originPath)).catch(() => null);
  if (!root || !file || !inside(root, file)) return { kind: 'none' };
  if (!(await stat(file)).isFile()) return { kind: 'none' };
  const there = await readFile(file);
  const hash = sha256Hex(there);
  if (hash !== save.base && hash !== save.next && !save.overwrite) return { kind: 'changed', text: there.toString('utf8') };
  return { kind: 'write', write: () => writeFile(file, save.bytes) };
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
  const result = await replaceArtifactContent(pool, {
    id, bytes, expectedSha256: base,
    workspace: (captured) => workspaceCopy(env, ownerId, captured, { base, next: sha256Hex(bytes), bytes, overwrite }),
  }, env);
  if (result.ok) return { status: 200, body: { sha256: result.row.sha256, sizeBytes: result.row.sizeBytes } };
  if (result.reason === 'gone') return { status: 404, body: { error: 'no such file' } };
  if (result.reason === 'workspace') {
    return { status: 409, body: { error: 'buddi changed this file in its workspace since you opened it', current: current(result.current), workspaceText: result.workspaceText } };
  }
  if (result.reason === 'duplicate') return { status: 409, body: { error: 'these exact contents are already another file here' } };
  return { status: 409, body: { error: 'the file changed since you opened it', current: current(result.current) } };
}
