import type { Pool, PoolClient } from 'pg';
import { instantsBetween, parseCron } from './cron.js';
import {
  OCCURRENCE_COLUMNS,
  toOccurrence,
  type MisfirePolicy,
  type Occurrence,
  type OccurrenceRow,
  type OccurrenceState,
  type ScheduleSpecRow,
} from './types.js';

export type MaterializeOptions = {
  /** Hard cap on instants produced per mission per pass. */
  maxPerMission?: number;
};

type Due = { at: Date; state: Extract<OccurrenceState, 'pending' | 'skipped'> };

type MissionSpecRow = ScheduleSpecRow & { through: Date | null };

/**
 * Materialize occurrences up to `now` for every enabled mission with an active
 * schedule.
 *
 * Two properties matter here:
 *
 *  1. **Idempotency.** Inserts are `on conflict do nothing` against the unique
 *     `(mission_id, schedule_revision, scheduled_at)` key, so running this
 *     twice over the same window produces the same rows — the watermark is an
 *     optimization, not the correctness mechanism.
 *  2. **Misfire policy is applied here**, at materialization, not at claim
 *     time. A week asleep still produces the full audit trail of instants; the
 *     policy decides which of them are `pending` (will run) and which are
 *     recorded `skipped` (happened, deliberately not run).
 *
 * The watermark advance and the inserts share one transaction per mission.
 */
export async function materializeOccurrences(
  pool: Pool,
  now: Date,
  opts: MaterializeOptions = {},
): Promise<Occurrence[]> {
  const maxPerMission = opts.maxPerMission ?? 10_000;

  const { rows: specs } = await pool.query<MissionSpecRow>(
    `select s.id, s.mission_id, s.revision, s.cron, s.timezone, s.misfire_policy,
            s.deadline_minutes, s.active, s.created_at, lm.through
     from core.schedule_specs s
     join core.missions m on m.id = s.mission_id
     left join core.last_materialized lm on lm.mission_id = s.mission_id
     where s.active and m.enabled
     order by s.mission_id`,
  );

  const created: Occurrence[] = [];
  for (const spec of specs) {
    created.push(...(await materializeOne(pool, spec, now, maxPerMission)));
  }
  return created;
}

async function materializeOne(
  pool: Pool,
  spec: MissionSpecRow,
  now: Date,
  maxPerMission: number,
): Promise<Occurrence[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    // Re-read the watermark inside the transaction and lock the mission row, so
    // two schedulers materializing the same mission serialize rather than race.
    await client.query(`select id from core.missions where id = $1 for update`, [spec.mission_id]);
    const wm = await client.query<{ through: Date }>(
      `select through from core.last_materialized where mission_id = $1`,
      [spec.mission_id],
    );
    const watermark = wm.rows[0]?.through ?? null;

    // Start from the later of the watermark and this revision's creation: a new
    // revision never backfills instants from before it existed.
    const startMs = Math.max(watermark?.getTime() ?? 0, spec.created_at.getTime());
    const from = new Date(startMs);

    if (from.getTime() >= now.getTime()) {
      await client.query('rollback');
      return [];
    }

    const cron = parseCron(spec.cron);
    const instants = instantsBetween(cron, from, now, spec.timezone, maxPerMission);
    const due = await applyMisfirePolicy(client, spec, instants, now);

    const rows: OccurrenceRow[] = [];
    for (const item of due) {
      const inserted = await client.query<OccurrenceRow>(
        `insert into core.occurrences (mission_id, schedule_revision, scheduled_at, state)
         values ($1, $2, $3, $4)
         on conflict (mission_id, schedule_revision, scheduled_at) do nothing
         returning ${OCCURRENCE_COLUMNS}`,
        [spec.mission_id, spec.revision, item.at.toISOString(), item.state],
      );
      if (inserted.rows[0]) rows.push(inserted.rows[0]);
    }

    await client.query(
      `insert into core.last_materialized (mission_id, through)
       values ($1, $2)
       on conflict (mission_id) do update set through = excluded.through
       where last_materialized.through < excluded.through`,
      [spec.mission_id, now.toISOString()],
    );

    await client.query('commit');
    return rows.map(toOccurrence);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Decide, for one catch-up window, which instants run and which are recorded as
 * deliberately skipped.
 *
 * - `replay-all`            every instant runs.
 * - `coalesce`              only the newest instant runs; older ones are skipped.
 * - `latest-only`           coalesce, and additionally skip everything if work
 *                           for this mission is already queued (a still-pending
 *                           occurrence means the previous instant never ran).
 * - `skip-after-deadline`   an instant older than `deadline_minutes` is skipped;
 *                           anything still inside its deadline runs.
 */
async function applyMisfirePolicy(
  client: PoolClient,
  spec: MissionSpecRow,
  instants: Date[],
  now: Date,
): Promise<Due[]> {
  if (instants.length === 0) return [];
  const policy: MisfirePolicy = spec.misfire_policy;

  if (policy === 'replay-all') {
    return instants.map((at) => ({ at, state: 'pending' as const }));
  }

  if (policy === 'skip-after-deadline') {
    const deadlineMs = (spec.deadline_minutes ?? 0) * 60_000;
    return instants.map((at) => ({
      at,
      state:
        deadlineMs > 0 && now.getTime() - at.getTime() > deadlineMs
          ? ('skipped' as const)
          : ('pending' as const),
    }));
  }

  // coalesce / latest-only
  let latestRuns = true;
  if (policy === 'latest-only') {
    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from core.occurrences
       where mission_id = $1 and state in ('pending', 'claimed')`,
      [spec.mission_id],
    );
    latestRuns = Number(rows[0]?.n ?? '0') === 0;
  }

  const lastIndex = instants.length - 1;
  return instants.map((at, i) => ({
    at,
    state: i === lastIndex && latestRuns ? ('pending' as const) : ('skipped' as const),
  }));
}
