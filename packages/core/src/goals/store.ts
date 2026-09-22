/**
 * The goal store. The budget lives here, in SQL, never in an agent's judgement.
 *
 * `createGoal` is one INSERT whose WHERE clause *is* the 12-goal limit — the
 * count is a subquery in the same statement, exactly as `createReminder` does
 * it — so two runs racing for the last slot produce one goal and one refusal
 * rather than thirteen rows. When it inserts nothing, the answer is a typed
 * refusal carrying the sentence the owner reads, not an error.
 */
import type { Queryable } from '../owner.js';
import {
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
  milestones?: number[];
}

/** Put a goal on the clock, or say why not. Never throws for a known limit. */
export async function createGoal(
  pool: Queryable,
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

  const { rows } = await pool.query(
    `insert into core.goals
       (title, agent_id, metric, params, target_kind, target_value,
        baseline_value, baseline_as_of, deadline, cadence, milestones)
     select $1::text, $2::text, $3::text, $4::jsonb, $5::text, $6::numeric,
            $7::numeric, $8::timestamptz, $9::timestamptz, $10::text, $11::jsonb
     where (select count(*) from core.goals where state = 'open') < $12
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
      JSON.stringify(input.milestones ?? []),
      MAX_OPEN_GOALS,
    ],
  );

  if (rows.length > 0) return { ok: true, goal: toGoal(rows[0] as GoalRow) };
  // Nothing inserted: the only WHERE clause is the budget.
  return { ok: false, reason: 'too-many', message: TOO_MANY_GOALS };
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
}

/**
 * Change what an approved goal is aiming at. Only the four fields §5 names:
 * the metric, the baseline and the holder are what the goal *is*, and
 * changing one of those is a new goal, not an update.
 */
export async function updateGoal(
  pool: Queryable,
  id: string,
  input: UpdateGoalInput,
  now: Date,
): Promise<Goal | null> {
  const { rows } = await pool.query(
    `update core.goals set
       target_kind = coalesce($2::text, target_kind),
       target_value = coalesce($3::numeric, target_value),
       deadline = coalesce($4::timestamptz, deadline),
       cadence = coalesce($5::text, cadence),
       milestones = coalesce($6::jsonb, milestones),
       updated_at = $7::timestamptz
     where id = $1::uuid
     returning ${GOAL_COLUMNS}`,
    [
      id,
      input.target?.kind ?? null,
      input.target?.value ?? null,
      input.deadline?.toISOString() ?? null,
      input.cadence ?? null,
      input.milestones === undefined ? null : JSON.stringify(input.milestones),
      now.toISOString(),
    ],
  );
  return rows.length > 0 ? toGoal(rows[0] as GoalRow) : null;
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
     where id = $1::uuid and closed_at is null
     returning ${GOAL_COLUMNS}`,
    [id, note, now.toISOString()],
  );
  return rows.length > 0 ? toGoal(rows[0] as GoalRow) : null;
}

/** The sentinel's two verdicts. Both are final and both set `closed_at`. */
export async function settleGoal(
  pool: Queryable,
  id: string,
  state: 'met' | 'missed',
  note: string,
  now: Date,
): Promise<Goal | null> {
  const { rows } = await pool.query(
    `update core.goals set state = $2::text, closed_at = $4::timestamptz,
       closed_note = $3::text, updated_at = $4::timestamptz
     where id = $1::uuid and state = 'open'
     returning ${GOAL_COLUMNS}`,
    [id, state, note, now.toISOString()],
  );
  return rows.length > 0 ? toGoal(rows[0] as GoalRow) : null;
}

export interface RecordCheckInput {
  goalId: string;
  at: Date;
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
    `insert into core.goal_checks (goal_id, at, value, currency, note, on_track, pace_needed, projected)
     values ($1::uuid, $2::timestamptz, $3::numeric, $4::text, $5::text, $6::boolean, $7::numeric, $8::numeric)
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

/** The most recent check that actually carried a number, or null. */
export async function lastMeasuredCheck(
  pool: Queryable,
  goalId: string,
): Promise<GoalCheck | null> {
  const { rows } = await pool.query(
    `select ${GOAL_CHECK_COLUMNS} from core.goal_checks
      where goal_id = $1::uuid and value is not null order by at desc, id desc limit 1`,
    [goalId],
  );
  return rows.length > 0 ? toGoalCheck(rows[0] as GoalCheckRow) : null;
}
