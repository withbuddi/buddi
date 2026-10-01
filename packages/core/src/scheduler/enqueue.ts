/**
 * Enqueueing an event-driven occurrence of a mission, coalesced when asked.
 *
 * A cron occurrence is one instant and one run. An occurrence enqueued by the
 * world changing — a watcher's finding — is not: a burst of five findings in
 * one tick used to be five runs of the same agent, each re-reading the same
 * numbers and each a notification. A mission (or the caller, for a mission
 * shared by many producers like `sentinel-wake`) can ask for coalescing
 * instead: `{ windowSeconds, maxWaitSeconds }`.
 *
 *  - The first occurrence for a group (the same mission, the same agent) is
 *    scheduled `windowSeconds` out, to wait for company.
 *  - Each one that arrives while it is still pending joins it — its payload is
 *    folded in by `merge` — and pushes the run back by the window again.
 *  - Never past `maxWaitSeconds` after the first: a steady trickle cannot keep
 *    the run waiting forever.
 *
 * Joining takes the waiting row's lock (`for update`), and the scheduler's
 * claim skips locked rows, so an occurrence is either joined or claimed,
 * never both. Once claimed, a newcomer starts a new group.
 */
import type { Pool, PoolClient } from 'pg';

export interface CoalesceOptions {
  /** How long the first occurrence waits for company, and each arrival pushes it back. */
  windowSeconds: number;
  /** The longest the first occurrence of a group may wait, whatever keeps arriving. */
  maxWaitSeconds: number;
}

/** The bookkeeping a coalesced occurrence carries in its payload. */
export interface CoalesceMark {
  group: string;
  /** When the group's first occurrence was enqueued. */
  firstAt: string;
  /** How many occurrences it carries. */
  count: number;
}

export type Payload = Record<string, unknown>;

export interface EnqueueOccurrenceInput {
  missionId: string;
  payload: Payload;
  now: Date;
  /**
   * Coalescing for this enqueue. Undefined takes the mission's own
   * (`core.missions.coalesce_*`); null asks for none even if the mission has it.
   */
  coalesce?: CoalesceOptions | null;
  /** Which occurrences may share a run, within the mission. Default: all of them. */
  group?: string;
  /** Fold a joining payload into the waiting one. Default: a `batch` array of payloads. */
  merge?: (waiting: Payload, joining: Payload) => Payload;
}

export type EnqueueOccurrenceResult =
  | { ok: true; occurrenceId: string; coalesced: boolean; scheduledAt: Date }
  | { ok: false; reason: string };

/** Valid coalescing, or null: both bounds positive, the wait no shorter than the window. */
export function coalesceOptions(value: unknown): CoalesceOptions | null {
  if (value === null || typeof value !== 'object') return null;
  const { windowSeconds, maxWaitSeconds } = value as Record<string, unknown>;
  if (typeof windowSeconds !== 'number' || typeof maxWaitSeconds !== 'number') return null;
  if (!Number.isInteger(windowSeconds) || !Number.isInteger(maxWaitSeconds)) return null;
  if (windowSeconds < 1 || windowSeconds > 3600 || maxWaitSeconds < windowSeconds || maxWaitSeconds > 86_400) return null;
  return { windowSeconds, maxWaitSeconds };
}

function defaultMerge(waiting: Payload, joining: Payload): Payload {
  const { coalesce: _mark, ...first } = waiting;
  const batch = Array.isArray(waiting.batch) ? waiting.batch as Payload[] : [first];
  return { ...waiting, batch: [...batch, joining] };
}

/** Where a coalesced payload keeps its bookkeeping. */
export function coalesceMarkOf(payload: unknown): CoalesceMark | null {
  const mark = payload && typeof payload === 'object' ? (payload as { coalesce?: unknown }).coalesce : null;
  if (!mark || typeof mark !== 'object') return null;
  const m = mark as Record<string, unknown>;
  return typeof m.group === 'string' && typeof m.firstAt === 'string' && typeof m.count === 'number'
    ? { group: m.group, firstAt: m.firstAt, count: m.count } : null;
}

/**
 * Insert at `at`, or the first free millisecond after it: the occurrence key is
 * (mission, revision, instant), and two facts in the same millisecond are two
 * runs. Savepoints keep a collision from aborting the caller's transaction.
 */
async function insertAt(client: Pick<PoolClient, 'query'>, missionId: string, at: Date, payload: Payload): Promise<{ id: string; at: Date } | null> {
  for (let offset = 0; offset < 60; offset++) {
    const instant = new Date(at.getTime() + offset);
    const { rows } = await client.query<{ id: string }>(
      `insert into core.occurrences (mission_id, schedule_revision, scheduled_at, state, payload)
       values ($1, 0, $2, 'pending', $3::jsonb)
       on conflict (mission_id, schedule_revision, scheduled_at) do nothing
       returning id`,
      [missionId, instant.toISOString(), JSON.stringify(payload)],
    );
    if (rows[0]) return { id: String(rows[0].id), at: instant };
  }
  return null;
}

/** A pending occurrence, enqueued now — or folded into the one already waiting for its group. */
export async function enqueueOccurrence(pool: Pool, input: EnqueueOccurrenceInput): Promise<EnqueueOccurrenceResult> {
  const mission = await pool.query<{ win: number | null; max_wait: number | null }>(
    `select coalesce_window_seconds as win, coalesce_max_wait_seconds as max_wait from core.missions where id = $1`,
    [input.missionId],
  );
  const row = mission.rows[0];
  if (!row) return { ok: false, reason: `mission "${input.missionId}" is not registered` };
  const options = input.coalesce === undefined
    ? coalesceOptions({ windowSeconds: row.win, maxWaitSeconds: row.max_wait })
    : input.coalesce === null ? null : coalesceOptions(input.coalesce);

  if (options === null) {
    const inserted = await insertAt(pool, input.missionId, input.now, input.payload);
    return inserted ? { ok: true, occurrenceId: inserted.id, coalesced: false, scheduledAt: inserted.at }
      : { ok: false, reason: 'could not allocate an occurrence instant' };
  }

  const group = input.group ?? '';
  const merge = input.merge ?? defaultMerge;
  const client = await pool.connect();
  try {
    await client.query('begin');
    // One enqueuer per group at a time, so two arrivals cannot both start a group.
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`occurrence-coalesce:${input.missionId}:${group}`]);
    const waiting = await client.query<{ id: string; payload: Payload }>(
      `select id, payload from core.occurrences
       where mission_id = $1 and state = 'pending' and payload->'coalesce'->>'group' = $2
       order by scheduled_at, id limit 1
       for update`,
      [input.missionId, group],
    );
    const found = waiting.rows[0];
    const mark = found ? coalesceMarkOf(found.payload) : null;
    let result: EnqueueOccurrenceResult;
    if (found && mark) {
      const firstAt = Date.parse(mark.firstAt);
      const at = new Date(Math.min(input.now.getTime() + options.windowSeconds * 1000, firstAt + options.maxWaitSeconds * 1000));
      const payload: Payload = { ...merge(found.payload, input.payload), coalesce: { ...mark, count: mark.count + 1 } };
      // Moving the instant can collide with another occurrence's: step a millisecond.
      let moved: Date | null = null;
      for (let offset = 0; offset < 60 && moved === null; offset++) {
        const instant = new Date(at.getTime() + offset);
        await client.query('savepoint move');
        try {
          await client.query(`update core.occurrences set payload = $2::jsonb, scheduled_at = $3 where id = $1`, [found.id, JSON.stringify(payload), instant.toISOString()]);
          await client.query('release savepoint move');
          moved = instant;
        } catch (err) {
          await client.query('rollback to savepoint move');
          if ((err as { code?: string }).code !== '23505') throw err;
        }
      }
      result = moved
        ? { ok: true, occurrenceId: String(found.id), coalesced: true, scheduledAt: moved }
        : { ok: false, reason: 'could not move the waiting occurrence' };
    } else {
      const payload: Payload = { ...input.payload, coalesce: { group, firstAt: input.now.toISOString(), count: 1 } satisfies CoalesceMark };
      const inserted = await insertAt(client, input.missionId, new Date(input.now.getTime() + options.windowSeconds * 1000), payload);
      result = inserted ? { ok: true, occurrenceId: inserted.id, coalesced: false, scheduledAt: inserted.at }
        : { ok: false, reason: 'could not allocate an occurrence instant' };
    }
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
