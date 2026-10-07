import type { Pool } from 'pg';

/** Only explicit playback requests for one saved edition attach its existing recording. */
export async function savedEditionAudio(pool: Pool, output: unknown): Promise<string[]> {
  if (!output || typeof output !== 'object') return [];
  const value = output as { attachAudio?: unknown; editions?: unknown };
  if (value.attachAudio !== true || !Array.isArray(value.editions) || value.editions.length !== 1) return [];
  const id: unknown = value.editions[0]?.id;
  if (typeof id !== 'string' || !/^e_[a-zA-Z0-9_-]+$/.test(id)) return [];
  const { rows } = await pool.query<{ audio: string }>(
    `select n.audio from core.owner_notifications n join core.artifacts a on a.id = n.audio
     where n.link = $1 and a.mime like 'audio/%' order by n.created_at desc limit 1`,
    [`#/p/news/stories?edition=${encodeURIComponent(id)}`],
  );
  return rows.map(row => row.audio);
}
