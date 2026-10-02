/**
 * "Stop telling me this" — the owner's mute on one subject of a watcher, or on
 * a whole kind of finding.
 *
 * A watcher switch (`switches.ts`) stops a watcher running at all. A mute is
 * narrower and keeps it running: the Checking account's balance reminders go
 * quiet while Savings' still speak; mail from one bank stops being called
 * suspicious while every other sender is still read. A finding a mute covers
 * is still written down (so the fact keeps its history and resolves as
 * usual) but it never wakes anyone, never reaches the recap and is not listed
 * on any surface. Taking the mute back — Settings → Watchers — shows whatever
 * is still true at once, because the watcher never stopped looking.
 */
import type { Pool } from 'pg';
import { appendEvent } from '../events.js';

export interface SentinelMute {
  id: string;
  sentinelId: string;
  /** '' covers every kind of the watcher. */
  kind: string;
  /** '' covers every subject of the kind. */
  subjectId: string;
  /** What the owner read when he chose it: "Checking balance reminders". */
  label: string;
  createdAt: Date;
}

type MuteRow = { id: string; sentinel_id: string; kind: string; subject_id: string; label: string; created_at: Date };

function toMute(row: MuteRow): SentinelMute {
  return {
    id: String(row.id),
    sentinelId: row.sentinel_id,
    kind: row.kind ?? '',
    subjectId: row.subject_id ?? '',
    label: row.label,
    createdAt: row.created_at,
  };
}

/** Every mute, oldest first. */
export async function sentinelMutes(pool: Pool): Promise<SentinelMute[]> {
  const { rows } = await pool.query<MuteRow>(
    `select id, sentinel_id, kind, subject_id, label, created_at from core.sentinel_mutes order by created_at, id`,
  );
  return rows.map(toMute);
}

/** Does a mute cover this finding? */
export function isMuted(
  mutes: readonly Pick<SentinelMute, 'sentinelId' | 'kind' | 'subjectId'>[],
  sentinelId: string,
  kind: string,
  subjectId: string | null,
): boolean {
  return mutes.some(
    (m) =>
      m.sentinelId === sentinelId &&
      (m.kind === '' || m.kind === kind) &&
      (m.subjectId === '' || (subjectId !== null && m.subjectId === subjectId)),
  );
}

/**
 * Of these finding keys, the ones a mute covers now — read off the stored
 * findings' kind and subject. A wake enqueued before the owner said "Stop
 * telling me this" is checked against this when it runs and again before it
 * delivers, so a mute silences what was already on its way.
 */
export async function mutedFindingKeys(pool: Pick<Pool, 'query'>, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const { rows } = await pool.query<{ key: string }>(
    `select f.key from core.sentinel_findings f
      where f.key = any($1::text[])
        and exists (
          select 1 from core.sentinel_mutes m
           where m.sentinel_id = f.sentinel_id
             and (m.kind = '' or m.kind = f.kind)
             and (m.subject_id = '' or m.subject_id = f.subject->>'id')
        )`,
    [[...keys]],
  );
  return new Set(rows.map((r) => String(r.key)));
}

/**
 * Silence a subject, or a whole kind (`subjectId` ''). Idempotent: muting the
 * same thing twice keeps the first row. What it covers that was waiting for
 * the recap is taken out of the queue in the same transaction — the owner
 * asked not to hear it, on Friday included.
 */
export async function muteFindings(
  pool: Pool,
  input: { sentinelId: string; kind: string; subjectId: string; label: string },
  now: Date = new Date(),
): Promise<SentinelMute> {
  const label = input.label.trim().slice(0, 200) || input.sentinelId;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<MuteRow>(
      `insert into core.sentinel_mutes (sentinel_id, kind, subject_id, label, created_at)
       values ($1, $2, $3, $4, $5)
       on conflict (sentinel_id, kind, subject_id) do update set label = core.sentinel_mutes.label
       returning id, sentinel_id, kind, subject_id, label, created_at`,
      [input.sentinelId, input.kind, input.subjectId, label, now.toISOString()],
    );
    await client.query(
      `delete from core.digest_items d
        using core.sentinel_findings f
        where d.finding_key = f.key and d.consumed_at is null
          and f.sentinel_id = $1
          and ($2 = '' or f.kind = $2)
          and ($3 = '' or f.subject->>'id' = $3)`,
      [input.sentinelId, input.kind, input.subjectId],
    );
    await client.query('commit');
    const mute = toMute(rows[0] as MuteRow);
    await appendEvent(pool, 'sentinel.muted', { id: mute.id, sentinelId: mute.sentinelId, kind: mute.kind, subjectId: mute.subjectId });
    return mute;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Take a mute back. True when there was one. */
export async function unmuteFindings(pool: Pool, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const { rows } = await pool.query<{ id: string }>(`delete from core.sentinel_mutes where id = $1 returning id`, [id]);
  if (rows.length === 0) return false;
  await appendEvent(pool, 'sentinel.unmuted', { id });
  return true;
}
