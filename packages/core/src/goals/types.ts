/**
 * A goal, and the checks under it.
 *
 * The row shapes and the refusals; the arithmetic is `math.ts` and the SQL is
 * `store.ts`. Everything here is core's: an agent reaches it only through the
 * `goal.*` tools, and a goal set from a Telegram conversation and one set by
 * the weekly recap are the same object.
 */

/** At most this many open goals in one installation. */
export const MAX_OPEN_GOALS = 12;

/**
 * The sentence the owner reads when the thirteenth is proposed.
 *
 * A constant because the refusal is part of the contract (docs/specs/goals.md
 * §10.5): the tool repeats it verbatim, and the test asserts it verbatim.
 */
export const TOO_MANY_GOALS =
  `This installation already holds ${MAX_OPEN_GOALS} open goals; close one first.`;

/** The longest title a goal carries. It is a name, not a plan. */
export const MAX_GOAL_TITLE = 120;

/** At most this many milestones. Each one is a wake. */
export const MAX_MILESTONES = 8;

export const GOAL_STATES = ['open', 'met', 'missed', 'closed'] as const;
export type GoalState = (typeof GOAL_STATES)[number];

export const GOAL_CADENCES = ['daily', 'weekly'] as const;
export type GoalCadence = (typeof GOAL_CADENCES)[number];

/** Either a number to land on, or a move from the baseline. */
export type GoalTarget = { kind: 'absolute'; value: number } | { kind: 'delta'; value: number };

export interface Goal {
  id: string;
  title: string;
  /** The holder. A different agent may read it, never hold it. */
  agentId: string;
  metric: string;
  params: Record<string, unknown>;
  target: GoalTarget;
  /** Measured when the goal was set: what the owner saw on the card. */
  baseline: { value: number; asOf: Date };
  deadline: Date;
  cadence: GoalCadence;
  /** On the target's own scale. Each fires once when crossed. */
  milestones: number[];
  createdAt: Date;
  updatedAt: Date;
  state: GoalState;
  closedAt: Date | null;
  closedNote: string | null;
}

/** One measurement, with the arithmetic of that moment beside it. */
export interface GoalCheck {
  id: string;
  goalId: string;
  at: Date;
  /** Null when the metric could not answer; `note` says why. */
  value: number | null;
  currency: string | null;
  note: string | null;
  onTrack: boolean | null;
  paceNeeded: number | null;
  projected: number | null;
}

export type GoalRow = {
  id: string;
  title: string;
  agent_id: string;
  metric: string;
  params: unknown;
  target_kind: 'absolute' | 'delta';
  target_value: string | number;
  baseline_value: string | number;
  baseline_as_of: Date;
  deadline: Date;
  cadence: GoalCadence;
  milestones: unknown;
  state: GoalState;
  closed_at: Date | null;
  closed_note: string | null;
  created_at: Date;
  updated_at: Date;
};

export type GoalCheckRow = {
  id: string;
  goal_id: string;
  at: Date;
  value: string | number | null;
  currency: string | null;
  note: string | null;
  on_track: boolean | null;
  pace_needed: string | number | null;
  projected: string | number | null;
};

export const GOAL_COLUMNS =
  'id, title, agent_id, metric, params, target_kind, target_value, baseline_value, baseline_as_of, ' +
  'deadline, cadence, milestones, state, closed_at, closed_note, created_at, updated_at';

export const GOAL_CHECK_COLUMNS =
  'id, goal_id, at, value, currency, note, on_track, pace_needed, projected';

/**
 * `numeric` comes back from `pg` as a string — it is arbitrary precision, and
 * turning it into a float is a decision, not a parse. Every number a goal
 * holds is money or a count in the tens of thousands, so the decision is safe
 * and it is made here, once, rather than at each call site.
 */
function num(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toGoal(row: GoalRow): Goal {
  return {
    id: String(row.id),
    title: row.title,
    agentId: row.agent_id,
    metric: row.metric,
    params: (row.params ?? {}) as Record<string, unknown>,
    target: { kind: row.target_kind, value: num(row.target_value) ?? 0 },
    baseline: { value: num(row.baseline_value) ?? 0, asOf: row.baseline_as_of },
    deadline: row.deadline,
    cadence: row.cadence,
    milestones: Array.isArray(row.milestones) ? (row.milestones as number[]) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    state: row.state,
    closedAt: row.closed_at,
    closedNote: row.closed_note,
  };
}

export function toGoalCheck(row: GoalCheckRow): GoalCheck {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    at: row.at,
    value: num(row.value),
    currency: row.currency,
    note: row.note,
    onTrack: row.on_track,
    paceNeeded: num(row.pace_needed),
    projected: num(row.projected),
  };
}

/**
 * Why a goal was not created.
 *
 * Every one is an expected outcome the model can act on and repeat to the
 * owner, never a defect: nothing in `createGoal` throws for one of these.
 */
export type GoalRefusal = 'no-agent' | 'empty-title' | 'too-many';

export type CreateGoalResult =
  | { ok: true; goal: Goal }
  | { ok: false; reason: GoalRefusal; message: string };
