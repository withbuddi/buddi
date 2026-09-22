/**
 * The goal store. The budget lives here, in SQL, never in an agent's judgement.
 *
 * `createGoal` counts the open goals inside the INSERT's own WHERE clause, the
 * way `createReminder` does — and, unlike it, takes a transaction-scoped
 * advisory lock first. The count alone is not a limit: under READ COMMITTED
 * two concurrent statements both see eleven open goals and both commit, and
 * the thirteenth goal is then one the sentinel never even walks (it reads
 * `limit: MAX_OPEN_GOALS`). The lock is what makes "one goal and one refusal"
 * true; the count is what decides which. When nothing is inserted, the answer
 * is a typed refusal carrying the sentence the owner reads, not an error.
 *
 * The two ways a goal changes are both guarded by what the *caller last saw*
 * rather than by the row alone: `updateGoal` takes the `updated_at` the
 * approval card was drawn from, and writes nothing if the goal moved since —
 * an approval names the goal as it was, and a goal that changed underneath is
 * not the one the owner agreed about. `closeGoal` and `settleGoal` are
 * guarded on `state`, so the SQL says what the module claims.
 */
import type { Pool, PoolClient } from 'pg';
import type { Queryable } from '../owner.js';
import {
  GOALS_LOCK_KEY,
  GOAL_CHECK_COLUMNS,
  GOAL_COLUMNS,
  MAX_OPEN_GOALS,
  TOO_MANY_GOALS,
  toGoal,
  toGoalCheck,
  type CreateGoalResult,
  type Goal,
  type GoalCadence,
  type GoalCheck,
  type GoalCheckRow,
  type GoalRow,
  type GoalState,
  type GoalTarget,
  type GoalUpdateRefusal,
} from './types.js';

export interface CreateGoalInput {
  title: string;
  /** The holder. A goal with no agent is nobody's, so this is refused empty. */
  agentId: string;
  metric: string;
  params?: Record<string, unknown>;
  target: GoalTarget;
  /** What the owner saw on the card. Never re-measured afterwards. */
  baseline: { value: number; asOf: Date };
  deadline: Date;
  cadence: GoalCadence;
  /** The currency of that first reading, when the metric answered one. */
  currency?: string | null;
  milestones?: number[];
}

/**
 * Put a goal on the clock, or say why not. Never throws for a known limit.
 *
 * Takes a `Pool` rather than a `Queryable` because the budget needs a
 * transaction: `pg_advisory_xact_lock` is held until commit, and that is the
 * whole point — it serialises the count and the insert against every other
 * writer, and it is released by the commit or the rollback whatever happens to
 * this process afterwards. The count stays in the WHERE clause: the lock says
 * "one at a time", the count says "and only if there is room".
 */
export async function createGoal(
  pool: Pool,
  input: CreateGoalInput,
): Promise<CreateGoalResult> {
  const agentId = (input.agentId ?? '').trim();
  if (agentId === '') {
    return {
      ok: false,
      reason: 'no-agent',
      message: 'a goal belongs to the agent that holds it, and this run has no agent id',
    };
  }
  const title = (input.title ?? '').trim();
  if (title === '') {
    return { ok: false, reason: 'empty-title', message: 'a goal needs a title the owner recognises' };
  }

  const rows = await inTransaction(pool, async (client) => {
    await client.query('select pg_advisory_xact_lock($1)', [GOALS_LOCK_KEY]);
    const inserted = await client.query(
      `insert into core.goals
         (title, agent_id, metric, params, target_kind, target_value,
          baseline_value, baseline_as_of, deadline, cadence, currency, milestones)
       select $1::text, $2::text, $3::text, $4::jsonb, $5::text, $6::numeric,
              $7::numeric, $8::timestamptz, $9::timestamptz, $10::text, $11::text, $12::jsonb
       where (select count(*) from core.goals where state = 'open') < $13
       returning ${GOAL_COLUMNS}`,
      [
        title,
        agentId,
        input.metric,
        JSON.stringify(input.params ?? {}),
        input.target.kind,
        input.target.value,
        input.baseline.value,
        input.baseline.asOf.toISOString(),
        input.deadline.toISOString(),
        input.cadence,
        input.currency ?? null,
        JSON.stringify(input.milestones ?? []),
        MAX_OPEN_GOALS,
      ],
    );
    return inserted.rows;
  });

  if (rows.length > 0) return { ok: true, goal: toGoal(rows[0] as GoalRow) };
  // Nothing inserted: the only WHERE clause is the budget.
  return { ok: false, reason: 'too-many', message: TOO_MANY_GOALS };
}

/** One transaction, committed on return and rolled back on any throw. */
async function inTransaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await body(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** One goal by id, or null. */
export async function getGoal(pool: Queryable, id: string): Promise<Goal | null> {
  const { rows } = await pool.query(
    `select ${GOAL_COLUMNS} from core.goals where id = $1::uuid`,
    [id],
  );
  return rows.length > 0 ? toGoal(rows[0] as GoalRow) : null;
}

export interface ListGoalsInput {
  agentId?: string;
  state?: GoalState;
  /** Every state but `closed`/`met`/`missed`, which is what the sentinel walks. */
  openOnly?: boolean;
  limit?: number;
}

/** Goals, oldest first — the order the owner set them in. */
export async function listGoals(pool: Queryable, input: ListGoalsInput = {}): Promise<Goal[]> {
  const { rows } = await pool.query(
    `select ${GOAL_COLUMNS} from core.goals
      where ($1::text is null or agent_id = $1)
        and ($2::text is null or state = $2)
        and ($3::boolean is not true or state = 'open')
      order by created_at, id
      limit $4`,
    [input.agentId ?? null, input.state ?? null, input.openOnly ?? false, input.limit ?? 100],
  );
  return (rows as GoalRow[]).map(toGoal);
}

export interface UpdateGoalInput {
  target?: GoalTarget;
  deadline?: Date;
  cadence?: GoalCadence;
  milestones?: number[];
  /**
   * The `updated_at` the caller last saw — the one the approval card was drawn
   * from. The UPDATE is predicated on it, so a goal that moved since the card
   * (another approval landed, the sentinel settled it) is not written to.
   *
   * It is the version, not a timestamp anybody reads: an approval names the
   * goal *as it was*, and re-describing cannot close the window between the
   * executor's check and this statement. Only the statement can.
   */
  expectedUpdatedAt: Date;
}

export type UpdateGoalResult =
  | { ok: true; goal: Goal }
  | { ok: false; reason: GoalUpdateRefusal; message: string };

/**
 * Change what an approved goal is aiming at. Only the four fields §5 names:
 * the metric, the baseline and the holder are what the goal *is*, and
 * changing one of those is a new goal, not an update.
 *
 * Open goals only, and only at the version the caller saw.
 */
export async function updateGoal(
  pool: Queryable,
  id: string,
  input: UpdateGoalInput,
  now: Date,
): Promise<UpdateGoalResult> {
  const { rows } = await pool.query(
    `update core.goals set
       target_kind = coalesce($2::text, target_kind),
       target_value = coalesce($3::numeric, target_value),
       deadline = coalesce($4::timestamptz, deadline),
       cadence = coalesce($5::text, cadence),
       milestones = coalesce($6::jsonb, milestones),
       updated_at = $7::timestamptz
     where id = $1::uuid and state = 'open' and updated_at = $8::timestamptz
     returning ${GOAL_COLUMNS}`,
    [
      id,
      input.target?.kind ?? null,
      input.target?.value ?? null,
      input.deadline?.toISOString() ?? null,
      input.cadence ?? null,
      input.milestones === undefined ? null : JSON.stringify(input.milestones),
      now.toISOString(),
      input.expectedUpdatedAt.toISOString(),
    ],
  );
  if (rows.length > 0) return { ok: true, goal: toGoal(rows[0] as GoalRow) };
  const still = await getGoal(pool, id);
  if (still === null) return { ok: false, reason: 'not-found', message: `no goal ${id}` };
  return {
    ok: false,
    reason: 'changed',
    message:
      `goal ${id} has changed since the owner saw the card` +
      `${still.state === 'open' ? '' : ` and is now ${still.state}`}` +
      '. Read it again with goal.status and propose the change afresh.',
  };
}

/**
 * Close a goal with a note.
 *
 * An `open` goal becomes `closed` — the owner stopped. A goal the sentinel
 * already settled as `met` or `missed` keeps that word and only gains the
 * closing note: "we hit it" and "we hit it and then agreed we were done" are
 * the same history, and overwriting `met` with `closed` would lose the one
 * fact anybody will want to read back.
 */
export async function closeGoal(
  pool: Queryable,
  id: string,
  note: string,
  now: Date,
): Promise<Goal | null> {
  const { rows } = await pool.query(
    `update core.goals set
       state = case when state = 'open' then 'closed' else state end,
       closed_at = $3::timestamptz,
       closed_note = $2::text,
       updated_at = $3::timestamptz
     where id = $1::uuid and state in ('open', 'met', 'missed')
     returning ${GOAL_COLUMNS}`,
    [id, note, now.toISOString()],
  );
  return rows.length > 0 ? toGoal(rows[0] as GoalRow) : null;
}

/**
 * The sentinel's two verdicts.
 *
 * They settle the *state* and nothing else. `closed_at` stays null on purpose:
 * a goal buddi decided was met is not a goal the owner has finished with, and
 * §5 says "met and missed become final when the owner agrees" — that agreement
 * is `goal.close`, which adds the note and the date and leaves the word alone.
 * The note here is buddi's own reason, kept so the row explains itself.
 */
export async function settleGoal(
  pool: Queryable,
  id: string,
  state: 'met' | 'missed',
  note: string,
  now: Date,
): Promise<Goal | null> {
  const { rows } = await pool.query(
    `update core.goals set state = $2::text, closed_note = $3::text,
       updated_at = $4::timestamptz
     where id = $1::uuid and state = 'open'
     returning ${GOAL_COLUMNS}`,
    [id, state, note, now.toISOString()],
  );
  return rows.length > 0 ? toGoal(rows[0] as GoalRow) : null;
}

export interface RecordCheckInput {
  goalId: string;
  /** When buddi looked. */
  at: Date;
  /** When the world was that way, as the reading said. Null when it did not. */
  asOf?: Date | null;
  value?: number | null;
  currency?: string | null;
  note?: string | null;
  onTrack?: boolean | null;
  paceNeeded?: number | null;
  projected?: number | null;
}

/** One measurement, with the arithmetic of that moment beside it. */
export async function recordCheck(
  pool: Queryable,
  input: RecordCheckInput,
): Promise<GoalCheck> {
  const { rows } = await pool.query(
    `insert into core.goal_checks (goal_id, at, as_of, value, currency, note, on_track, pace_needed, projected)
     values ($1::uuid, $2::timestamptz, $9::timestamptz, $3::numeric, $4::text, $5::text, $6::boolean, $7::numeric, $8::numeric)
     returning ${GOAL_CHECK_COLUMNS}`,
    [
      input.goalId,
      input.at.toISOString(),
      input.value ?? null,
      input.currency ?? null,
      input.note ?? null,
      input.onTrack ?? null,
      input.paceNeeded ?? null,
      input.projected ?? null,
      input.asOf?.toISOString() ?? null,
    ],
  );
  return toGoalCheck(rows[0] as GoalCheckRow);
}

/**
 * The most recent checks, newest first. Four is the number that matters — it
 * is what the projection is drawn over and what a wake prompt carries.
 */
export async function recentChecks(
  pool: Queryable,
  goalId: string,
  limit = 4,
): Promise<GoalCheck[]> {
  const { rows } = await pool.query(
    `select ${GOAL_CHECK_COLUMNS} from core.goal_checks
      where goal_id = $1::uuid order by at desc, id desc limit $2`,
    [goalId, limit],
  );
  return (rows as GoalCheckRow[]).map(toGoalCheck);
}

/** The most recent check of all, or null for a goal never checked. */
export async function lastCheck(pool: Queryable, goalId: string): Promise<GoalCheck | null> {
  const [first] = await recentChecks(pool, goalId, 1);
  return first ?? null;
}

/**
 * The most recent checks that actually carried a number, newest first.
 *
 * What a *verdict* is read off — see `standing.ts`. It is a separate statement
 * from `recentChecks` rather than a filter applied afterwards, because "the
 * last four measured checks" and "the measured ones among the last four rows"
 * are different sets the moment a look fails, and every surface has to be
 * asking the first question.
 */
export async function measuredChecks(
  pool: Queryable,
  goalId: string,
  limit = 4,
): Promise<GoalCheck[]> {
  const { rows } = await pool.query(
    `select ${GOAL_CHECK_COLUMNS} from core.goal_checks
      where goal_id = $1::uuid and value is not null
      order by at desc, id desc limit $2`,
    [goalId, limit],
  );
  return (rows as GoalCheckRow[]).map(toGoalCheck);
}

/** The most recent check that actually carried a number, or null. */
export async function lastMeasuredCheck(
  pool: Queryable,
  goalId: string,
): Promise<GoalCheck | null> {
  const [first] = await measuredChecks(pool, goalId, 1);
  return first ?? null;
}

/** What one goal's row needs to draw a standing: its checks, and its last look. */
export interface StandingChecks {
  /** The newest measured checks, newest first. */
  measured: GoalCheck[];
  /**
   * The newest check of all carried no number.
   *
   * Not the same as having no measurement: it is the difference between "this
   * goal has never answered" and "this morning's look failed and the number
   * you can see is Thursday's", which is the sentence the owner wants.
   */
  lastLookFailed: boolean;
}

/**
 * The same, for many goals, in **one** statement.
 *
 * Home draws every open goal and the Goals page draws every goal there is; a
 * pair of queries per goal is up to four hundred round trips to paint one
 * screen. Two lateral joins answer it once: the newest measured checks per
 * goal, and whether the newest row of all carried a number.
 *
 * Goals with no checks are still in the map, with an empty list — a caller
 * asking about a goal must never have to tell "no rows" from "not asked".
 */
export async function standingChecks(
  pool: Queryable,
  goalIds: readonly string[],
  limit = 4,
): Promise<Map<string, StandingChecks>> {
  const out = new Map<string, StandingChecks>();
  for (const id of goalIds) out.set(id, { measured: [], lastLookFailed: false });
  if (goalIds.length === 0) return out;
  const { rows } = await pool.query(
    `select g.id::text as goal_id, l.failed as last_look_failed,
            m.id, m.goal_id as check_goal_id, m.at, m.as_of, m.value, m.currency,
            m.note, m.on_track, m.pace_needed, m.projected
       from unnest($1::uuid[]) as g(id)
       left join lateral (
         select c.* from core.goal_checks c
          where c.goal_id = g.id and c.value is not null
          order by c.at desc, c.id desc limit $2
       ) m on true
       left join lateral (
         select c.value is null as failed from core.goal_checks c
          where c.goal_id = g.id
          order by c.at desc, c.id desc limit 1
       ) l on true
      order by g.id, m.at desc, m.id desc`,
    [goalIds, limit],
  );
  for (const raw of rows as Array<Record<string, unknown>>) {
    const entry = out.get(String(raw.goal_id));
    if (entry === undefined) continue;
    entry.lastLookFailed = raw.last_look_failed === true;
    // The measured lateral yields no row for a goal never measured; the
    // `left join` still gives the goal its line, with every check column null.
    if (raw.id === null || raw.id === undefined) continue;
    entry.measured.push(
      toGoalCheck({ ...(raw as unknown as GoalCheckRow), goal_id: String(raw.check_goal_id) }),
    );
  }
  return out;
}
