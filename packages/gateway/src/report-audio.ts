/**
 * The recording filed with a saved report: the audio of the newest owner
 * notification sent under exactly this page link. What the dashboard's
 * `GET /api/reports/audio` answers and what a messenger sends for an
 * `{ kind: 'audio', report }` attachment (host API 1.33).
 */
import { getArtifact, type ArtifactRow } from '@buddi/core';
import type { Pool } from 'pg';

export async function reportRecording(pool: Pool, link: string): Promise<ArtifactRow | null> {
  const { rows } = await pool.query<{ audio: string }>(
    `select audio from core.owner_notifications where link = $1 and audio is not null order by created_at desc limit 1`,
    [link],
  );
  const file = rows[0] ? await getArtifact(pool, rows[0].audio) : null;
  return file && file.mime.startsWith('audio/') ? file : null;
}
