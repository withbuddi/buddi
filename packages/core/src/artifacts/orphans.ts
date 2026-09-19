/**
 * Uploads nobody sent.
 *
 * A file dropped on the dashboard is stored the moment it lands, so the send
 * is instant and a failure shows while the owner is still typing. The price is
 * a file that was removed from the tray, or left in a tab that was closed:
 * stored, and pointed at by nothing. Two things settle that account:
 *
 *  - the page discards a file it removed (`discardUnreferencedUpload`), and
 *  - a sweep tombstones uploads older than a day that no message ever carried.
 *
 * Both refuse to touch anything a message references — the same bytes dropped
 * twice are one artifact, and the first send owns it — and both are confined
 * to what a surface handed in. A file an agent made is never an orphan.
 */
import type { Pool } from 'pg';
import { deleteArtifact } from './store.js';

/** Whether any transcript turn or surface record still points at this artifact. */
export async function isArtifactReferenced(pool: Pool, id: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select exists (
       select 1 from core.messages
        where content @> jsonb_build_array(jsonb_build_object('type', 'artifact_ref', 'artifactId', $1::text))
     ) or exists (
       select 1 from core.surface_attachments where artifact_id = $1::text
     ) as referenced`,
    [id],
  );
  return rows[0]?.referenced === true;
}

export type DiscardOutcome = 'discarded' | 'referenced' | 'not-an-upload' | 'missing';

/**
 * Tombstone one upload the owner took back, if nothing carries it. `surface`
 * names who may be discarded through this path: a web upload from the web
 * page, never a Telegram photo, never something an agent produced.
 */
export async function discardUnreferencedUpload(
  pool: Pool,
  id: string,
  surface: string,
  at: Date = new Date(),
): Promise<DiscardOutcome> {
  const { rows } = await pool.query(
    `select source_surface from core.artifacts where id = $1::uuid and deleted_at is null`,
    [id],
  );
  if (!rows[0]) return 'missing';
  if (rows[0].source_surface !== surface) return 'not-an-upload';
  if (await isArtifactReferenced(pool, id)) return 'referenced';
  return (await deleteArtifact(pool, id, at)) ? 'discarded' : 'missing';
}

/**
 * Tombstone every upload from `surface` older than `olderThan` that no message
 * or surface record references. Returns how many went.
 */
export async function sweepOrphanUploads(
  pool: Pool,
  input: { surface: string; olderThan: Date; at?: Date },
): Promise<number> {
  const { rows } = await pool.query(
    `update core.artifacts a
        set deleted_at = $3
      where a.source_surface = $1
        and a.deleted_at is null
        and a.created_at < $2
        and not exists (
          select 1 from core.messages m
           where m.content @> jsonb_build_array(jsonb_build_object('type', 'artifact_ref', 'artifactId', a.id::text))
        )
        and not exists (
          select 1 from core.surface_attachments s where s.artifact_id = a.id::text
        )
      returning a.id`,
    [input.surface, input.olderThan, input.at ?? new Date()],
  );
  return rows.length;
}
