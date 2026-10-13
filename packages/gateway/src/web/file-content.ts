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
import { StringDecoder } from 'node:string_decoder';
import type { Pool } from 'pg';
import {
  artifactBytesExist,
  getArtifact,
  readArtifactPrefix,
  replaceArtifactContent,
  textPreviewable,
  type ArtifactRow,
  type EnvLike,
} from '@buddi/core';

/** The largest file the editor edits; a bigger one opens read-only, its start only. */
export const MAX_EDIT_BYTES = 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/;

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
  return {
    status: 200,
    body: { text, sha256: row.sha256, sizeBytes: row.sizeBytes, editable: !prefix.truncated, truncated: prefix.truncated },
  };
}

export async function saveFileContent(pool: Pool, env: EnvLike, id: string, body: Record<string, unknown>): Promise<Answer> {
  const { text, base } = body;
  if (typeof text !== 'string') return { status: 400, body: { error: '`text` must be a string' } };
  if (typeof base !== 'string' || !SHA256.test(base)) return { status: 400, body: { error: '`base` must be the sha256 of the version edited' } };
  const row = await getArtifact(pool, id);
  if (!row) return { status: 404, body: { error: 'no such file' } };
  if (!textPreviewable(row.mime, row.filename)) return { status: 415, body: { error: 'this file is not text' } };
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_EDIT_BYTES) return { status: 413, body: { error: 'a file edited here can be at most 1 MiB' } };
  const result = await replaceArtifactContent(pool, { id, bytes, expectedSha256: base }, env);
  if (result.ok) return { status: 200, body: { sha256: result.row.sha256, sizeBytes: result.row.sizeBytes } };
  if (result.reason === 'gone') return { status: 404, body: { error: 'no such file' } };
  if (result.reason === 'duplicate') return { status: 409, body: { error: 'these exact contents are already another file here' } };
  return { status: 409, body: { error: 'the file changed since you opened it', current: current(result.current) } };
}
