/**
 * Goals: a target with a clock, that buddi keeps (docs/goals.md).
 *
 * A reminder is one instant an agent promised to look at; a schedule is a
 * standing run the owner approved. A goal is the object neither of them is: a
 * number, a date, a holder, and a rhythm of checks that happens whether or not
 * anybody is talking to buddi. The rows are core's (migration 037); this
 * module is the six tools an agent reaches them through and the watcher that
 * runs between conversations.
 *
 * It lives in the gateway, beside the reminder and schedule manifests, for the
 * same reason they do: nothing here owns a schema, and everything here is a
 * *surface* onto core. It takes the registry because that is where metrics
 * are — `goal.metrics` reflects it, and every measurement goes through
 * `measureMetric` against it.
 *
 * Two rules shape the whole file:
 *
 *  - **Setting a goal is an approval.** `goal.set` and `goal.update` are gated
 *    and the card shows the whole shape. A gated tool is gated on every call —
 *    the registry refuses a `tierFor` that narrows it — so a call that
 *    *cannot* happen (a delegate proposing one, a deadline in the past, a
 *    metric nobody installed) is refused out of `describe`, which runs before
 *    any action exists: nothing is recorded, the owner is never shown a card,
 *    and the model is handed the sentence. The write path then re-checks and
 *    calls `assertApprovedEffect`, so nothing reaches a row unapproved.
 *  - **Read is open, write is the holder's.** Any agent may `goal.list` and
 *    `goal.status`; only the holder may update or close, and a non-holder is
 *    told `not-yours` in as many words, the way `reminder.cancel` does it.
 */
import {
  GOAL_CADENCES,
  MAX_GOAL_TITLE,
  MAX_MILESTONES,
  MAX_OPEN_GOALS,
  assertApprovedEffect,
  closeGoal,
  createGoal,
  getGoal,
  checkMetricParams,
  STANDING_CHECKS,
  lastCheck,
  lastMeasuredCheck,
  listGoals,
  localDateString,
  measureMetricResult,
  measuredChecks,
  metricParamsSchema,
  milestoneValue,
  milestonesCrossed,
  paceNeeded,
  parseReminderWhen,
  reached,
  recentChecks,
  recordCheck,
  settleGoal,
  standingOf,
  targetValue,
  updateGoal,
  FREQUENCY_PERS,
  MAX_FREQUENCY_COUNT,
  frequencySettles,
  frequencyWords,
  type FrequencyStanding,
  METRIC_DIRECTIONS,
  METRIC_UNITS,
  MAX_OWNER_LABEL,
  MAX_OWNER_UNIT_LABEL,
  OWNER_SOURCE,
  createOwnerMetric,
  cadenceMs,
  getOwnerMetric,
  isOwnerMetric,
  latestOwnerValue,
  ownerMetricId,
  ownerSlugOf,
  recordOwnerValue,
  refuseOutsideBand,
  refuseOwnerSlug,
  type OwnerMetric,
  type OwnerMetricSource,
  type OwnerValueSource,
  type OwnerMetricValue,
  type Finding,
  type GoalStanding,
  type GoalVerdict,
  type Goal,
  type GoalCadence,
  type GoalCheck,
  type GoalTarget,
  type MetricDirection,
  type MetricSource,
  type MetricUnit,
  type PluginManifest,
  type Sentinel,
  type CoreSentinelContext,
  type CoreToolContext,
  type ToolDefinition,
} from '@buddi/core';
import { z } from 'zod';
import {
  GOALS_SENTINEL_ID,
  asOwnerSource,
  frequencyNow,
  baseUnit,
  checkLines,
  formatPace,
  formatValue,
  goalKey,
  goalLine,
  unitLabelOf,
  valueUnitOf,
  type ValueUnit,
} from './goals-format.js';
import {
  CHART_CHECKS,
  chartOf,
  createGoalHome,
  createGoalOwnerClose,
  createGoalQueries,
  frequencyOf,
  goalOwnerValues,
  goalViews,
  goalsPage,
  type GoalChart,
} from './goals-page.js';

/** Plugin family name for the goal tools. The rows live in core's schema. */
export const GOAL_PLUGIN = 'goal';

/**
 * The watcher's id and its finding keys, re-exported from `goals-format.ts`.
 *
 * They live there because the page reads findings back by the very same id and
 * prefix the watcher writes them under, and two copies of that string is one
 * rename away from a page quietly showing another plugin's findings.
 */
export { GOALS_SENTINEL_ID, goalKey } from './goals-format.js';

/** How often the watcher looks. Hourly; what is *due* is decided per goal. */
export const GOALS_SENTINEL_EVERY_S = 3600;

/**
 * When a cadence is due again, with a margin.
 *
 * A daily goal checked at 09:04 must be checked again on tomorrow's 09:00
 * tick. A strict 24 h says no — 23 h 56 m have passed — so the check slips to
 * 10:00, then 11:00, and within a fortnight the morning goal is a midnight
 * one. Four hours of margin holds it to the same part of the day forever.
 *
 * Note what it costs: 20 h is 20 h, so a goal *can* be checked twice in one
 * calendar day (00:00 and 20:00). The spec's "one check per goal per day at
 * most" (§2) is therefore a near-miss rather than an invariant; the margin is
 * what makes the cadence stable, and a second check is one extra row, never a
 * second wake — findings dedup by key.
 */
export const DAILY_DUE_MS = 20 * 60 * 60_000;
export const WEEKLY_DUE_MS = (6 * 24 + 20) * 60 * 60_000;

/** A deadline within this is news whether or not the goal is on track. */
export const DEADLINE_NEAR_MS = 7 * 24 * 60 * 60_000;

/** No number for this long is itself a fact the holder is woken about. */
export const NOT_MEASURABLE_MS = 7 * 24 * 60 * 60_000;

/** And a goal cannot be set further out than this. A year and a half is a lot. */
export const MAX_GOAL_HORIZON_DAYS = 1095;

/** The sentence in every goal wake. The agent verifies; it never edits silently. */
export const GOAL_WAKE_INSTRUCTION =
  'Verify with your own tools, then report; to change the goal propose `goal.update`, never change it silently.';

/* ------------------------------------------------------------------ *
 * Rendering
 *
 * The words for a goal's numbers live in `goals-format.ts` and are re-exported
 * here, where every caller and every test has always found them: the Goals
 * page and the Home block need the same sentences, and a third module both
 * they and this one import is what keeps those two out of a cycle.
 * ------------------------------------------------------------------ */

export { checkLines, formatPace, formatValue, goalLine } from './goals-format.js';

export { asOwnerSource } from './goals-format.js';

/** Where a value was said, from the surface the run answers on. */
export function valueSourceOf(ctx: CoreToolContext): OwnerValueSource {
  const surface = ctx.surface?.id;
  if (surface === 'telegram') return 'telegram';
  if (surface === 'web' || surface === 'cli') return 'chat';
  return 'api';
}

/** What an owner metric is, as `goal.set` names one it has never seen. */
export interface OwnerMetricDefinition {
  slug: string;
  label: string;
  unit: MetricUnit;
  direction: MetricDirection;
  unitLabel: string | null;
}

/** What a goal envelope says will happen. Hashed before the owner sees it. */
export interface GoalSetEnvelope {
  tool: 'goal.set';
  agentId: string;
  title: string;
  metric: string;
  params: Record<string, unknown>;
  target: GoalTarget;
  /**
   * The number the owner saw, and the two instants behind it.
   *
   * `asOf` is the *description clock* — when the goal was set. `readingAsOf`
   * is what the metric said its number was true of, which for a bank reading
   * last Friday's statement is not the same day, and is kept because the card
   * says so out loud and the first check row stores it.
   *
   * The whole baseline is measured **once**, at the first description. The
   * executor re-describes before it dispatches and refuses anything that
   * changed since the preview (`effect-changed`); a `describe` that measured
   * again would put a live number into a hashed envelope, and
   * `email.inbox_unread` moving by one between the card and the tap would void
   * an approval that was perfectly good. So `describe` reuses the approved
   * baseline when `ctx.approvedEffect` is there — the owner's number is what
   * executes, and everything else in the envelope still re-derives and still
   * voids the approval if the model changed it.
   */
  baseline: { value: number; currency: string | null; asOf: string; readingAsOf: string | null };
  deadline: string;
  cadence: GoalCadence;
  milestones: number[];
  /**
   * For a metric the owner reports: its definition (created on execute when it
   * is new) and whether the baseline is a number the owner just said, which
   * execute then records as the metric's first value.
   */
  owner?: { metric: OwnerMetricDefinition; isNew: boolean; baselineTold: boolean };
}

/**
 * The sentence the owner approves.
 *
 * §5: "From X today to Y by <date>: Z per week, checked weekly, held by
 * @ledger". Everything in it is a number this process measured or computed —
 * nothing the model wrote — which is the whole point of rendering from the
 * envelope rather than from the arguments.
 */
export function renderGoalSet(
  envelope: GoalSetEnvelope,
  unit: ValueUnit,
  direction: MetricDirection,
  timezone: string,
): string {
  const asGoal = {
    target: envelope.target,
    baseline: { value: envelope.baseline.value, asOf: new Date(envelope.baseline.asOf) },
    deadline: new Date(envelope.deadline),
    milestones: envelope.milestones,
  };
  const currency = envelope.baseline.currency;
  const setAt = new Date(envelope.baseline.asOf);
  const pace = paceNeeded(asGoal, envelope.baseline.value, setAt);
  /*
   * "Today" is a claim about the number, and it is not always true: a metric
   * may be reading a statement that closed on Friday. When the reading is more
   * than a day behind the card, the card says so — the owner is approving six
   * months of behaviour off this number and deserves to know how old it is.
   */
  const readingAsOf = envelope.baseline.readingAsOf === null ? null : new Date(envelope.baseline.readingAsOf);
  const stale =
    readingAsOf !== null && setAt.getTime() - readingAsOf.getTime() > 24 * 60 * 60_000
      ? ` (reading as of ${localDateString(readingAsOf, timezone)})`
      : '';
  const measuredBy =
    envelope.owner !== undefined
      ? `Measured by you, when you tell buddi${
          envelope.owner.isNew ? ` (a new metric, ${envelope.metric})` : ''
        }, until ${localDateString(asGoal.deadline, timezone)}.`
      : `Measured by ${envelope.metric}${
          Object.keys(envelope.params).length === 0 ? '' : ` ${JSON.stringify(envelope.params)}`
        }, every ${envelope.cadence === 'daily' ? 'day' : 'week'}, until ${localDateString(asGoal.deadline, timezone)}.`;
  if (envelope.target.kind === 'frequency') {
    /*
     * "3 times a week until 2026-12-31": a count per window has no "from"
     * and no pace per week — the window is the pace. Milestones are streaks.
     */
    const per = envelope.target.per;
    const lines = [
      `${envelope.title}`,
      '',
      `${frequencyWords(envelope.target)} until ${localDateString(asGoal.deadline, timezone)}, ` +
        `checked ${envelope.cadence}, held by @${envelope.agentId}`,
      '',
      measuredBy,
    ];
    if (envelope.milestones.length > 0) {
      lines.push(
        `Milestones you will hear about, once each: ${envelope.milestones
          .map((m) => `${m} ${per}s in a row`)
          .join(', ')}.`,
      );
    }
    return lines.join('\n');
  }
  const lines = [
    `${envelope.title}`,
    '',
    `From ${formatValue(envelope.baseline.value, unit, currency)} today${stale} to ` +
      `${formatValue(targetValue(asGoal), unit, currency)} by ${localDateString(asGoal.deadline, timezone)}: ` +
      `${formatPace(pace, unit, direction, currency)}, checked ${envelope.cadence}, held by @${envelope.agentId}`,
    '',
    measuredBy,
  ];
  if (envelope.milestones.length > 0) {
    lines.push(
      `Milestones you will hear about, once each: ${envelope.milestones
        .map((m) => formatValue(envelope.target.kind === 'delta' ? envelope.baseline.value + m : m, unit, currency))
        .join(', ')}.`,
    );
  }
  return lines.join('\n');
}

/** What an approved change to a goal is. Before and after, per changed field. */
export interface GoalUpdateEnvelope {
  tool: 'goal.update';
  id: string;
  agentId: string;
  title: string;
  /**
   * The version of the goal this card was drawn from.
   *
   * It is in the envelope because it is part of what the owner approved: "this
   * goal, as it stands now, becomes that". The store predicates its UPDATE on
   * it, so an approval that sat in Telegram while the sentinel settled the
   * goal — or while another approval landed — writes nothing instead of
   * quietly restoring values nobody agreed to.
   */
  updatedAt: string;
  before: { target: GoalTarget; deadline: string; cadence: GoalCadence; milestones: number[] };
  after: { target: GoalTarget; deadline: string; cadence: GoalCadence; milestones: number[] };
}

/** The card: one line per field that actually changes, before → after. */
export function renderGoalUpdate(
  envelope: GoalUpdateEnvelope,
  unit: ValueUnit,
  timezone: string,
  baseline: number,
  currency: string | null = null,
): string {
  const value = (target: GoalTarget): string =>
    target.kind === 'frequency'
      ? frequencyWords(target)
      : formatValue(targetValue({ target, baseline: { value: baseline, asOf: new Date(0) } }), unit, currency);
  const { before, after } = envelope;
  const rows: string[] = [];
  if (JSON.stringify(before.target) !== JSON.stringify(after.target)) {
    rows.push(`Target:    ${value(before.target)} → ${value(after.target)}`);
  }
  if (before.deadline !== after.deadline) {
    rows.push(
      `Deadline:  ${localDateString(new Date(before.deadline), timezone)} → ${localDateString(
        new Date(after.deadline),
        timezone,
      )}`,
    );
  }
  if (before.cadence !== after.cadence) rows.push(`Cadence:   ${before.cadence} → ${after.cadence}`);
  if (JSON.stringify(before.milestones) !== JSON.stringify(after.milestones)) {
    rows.push(
      `Milestones: ${before.milestones.join(', ') || '(none)'} → ${after.milestones.join(', ') || '(none)'}`,
    );
  }
  return [
    `Change the goal "${envelope.title}", held by @${envelope.agentId}:`,
    '',
    ...(rows.length === 0 ? ['  (nothing changes)'] : rows.map((row) => `  ${row}`)),
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

const levelTargetInput = z
  .object({
    kind: z
      .enum(['absolute', 'delta'])
      .describe(
        '"absolute" is a number to land on (inbox at 0); "delta" is a move from the baseline measured ' +
          'when the goal is set (down by 40000 is kind "delta", value -40000). Delta is how an owner says it.',
      ),
    value: z
      .number()
      .finite()
      .describe('The number. For a delta it carries its own sign: -40000 to come down by 40,000.'),
  })
  .strict();

const frequencyTargetInput = z
  .object({
    kind: z
      .literal('frequency')
      .describe('"run three times a week": how many values the owner reports in every week or month.'),
    count: z.number().int().min(1).max(MAX_FREQUENCY_COUNT).describe('How many times in each window: 3.'),
    per: z.enum(FREQUENCY_PERS).describe('The window: a week (Monday to Sunday) or a calendar month.'),
  })
  .strict();

/**
 * A level target, or a frequency. A frequency goal counts the values of a
 * metric the owner reports; "finish X by Friday" is neither — that is a
 * reminder or a mission.
 */
const targetInput = z.union([levelTargetInput, frequencyTargetInput]);

/** A metric the owner will report, named the first time a goal needs it. */
const ownerMetricInput = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(40)
      .describe('A short kebab name, unique here: "weight", "resting-heart-rate". The metric becomes owner.<slug>.'),
    label: z.string().min(1).max(MAX_OWNER_LABEL).describe('What it is, in the owner\'s words: "Weight".'),
    unit: z
      .enum(METRIC_UNITS)
      .describe('How the number is formatted. Weight is "number" with a unitLabel; a count of runs is "count".'),
    direction: z.enum(METRIC_DIRECTIONS).describe('Which way is better: "down" for weight to lose, "up" for runs.'),
    unitLabel: z
      .string()
      .min(1)
      .max(MAX_OWNER_UNIT_LABEL)
      .optional()
      .describe('The word after the number, when there is one: "lb", "kg", "km".'),
  })
  .strict();

const setInput = z
  .object({
    title: z
      .string()
      .min(1)
      .max(MAX_GOAL_TITLE)
      .describe('A short name the owner will recognise on a card months from now: "Debt down by 40k".'),
    metric: z
      .union([z.string().min(1), z.object({ owner: ownerMetricInput }).strict()])
      .describe(
        'The metric to watch: an id exactly as goal.metrics lists it ("finance.total_debt", "owner.weight"), ' +
          'or, when no metric measures what the owner named, {"owner": {slug, label, unit, direction, unitLabel?}} ' +
          'to create one the owner reports. Never create an owner metric for something a plugin already measures.',
      ),
    baseline: z
      .object({ value: z.number().finite().describe('The number the owner said: "I\'m 288" is 288.') })
      .strict()
      .optional()
      .describe(
        'Only for a metric the owner reports: where they are today, from the sentence that set the goal, so ' +
          'the goal starts measured. A plugin metric is measured instead.',
      ),
    params: z
      .record(z.unknown())
      .optional()
      .describe(
        'The narrowing that metric declares, if any — {"account": "..."} — validated against its own schema. ' +
          'Leave it out when the metric takes none.',
      ),
    target: targetInput.describe('Where the number has to get to.'),
    deadline: z
      .string()
      .min(1)
      .describe(
        "When, in the owner's timezone: an ISO date (2027-03-22, which means 09:00 local that day) or an " +
          'ISO datetime. Work it out yourself from today; never pass a phrase like "in six months".',
      ),
    cadence: z
      .enum(GOAL_CADENCES)
      .describe('How often buddi measures. Daily is the floor; weekly is right for anything that moves slowly.'),
    milestones: z
      .array(z.number().finite())
      .max(MAX_MILESTONES)
      .optional()
      .describe(
        'Numbers on the same scale as the target — deltas when the target is a delta — that you want to say ' +
          'something about when they are crossed. For a frequency goal they are streaks: [4, 8] is four and ' +
          'eight windows met in a row. Each fires once, ever.',
      ),
  })
  .strict();

const updateInput = z
  .object({
    id: z.string().min(1).describe('The goal id, as goal.status or goal.list reports it.'),
    target: targetInput.optional().describe('A new target. Leave it out to keep the one you have.'),
    deadline: z.string().min(1).optional().describe('A new deadline, in the same spelling as goal.set takes.'),
    cadence: z.enum(GOAL_CADENCES).optional().describe('A new cadence.'),
    milestones: z
      .array(z.number().finite())
      .max(MAX_MILESTONES)
      .optional()
      .describe('The whole milestone list, replacing the old one.'),
  })
  .strict();

const closeInput = z
  .object({
    id: z.string().min(1).describe('The goal id.'),
    note: z
      .string()
      .min(1)
      .max(500)
      .describe('One or two sentences for the record: why it is ending, and where it got to.'),
  })
  .strict();

const statusInput = z
  .object({
    id: z
      .string()
      .min(1)
      .optional()
      .describe('One goal, by id — any goal, whoever holds it. Leave it out for all of your own.'),
  })
  .strict();

const recordInput = z
  .object({
    goal: z
      .string()
      .min(1)
      .optional()
      .describe('The goal the number is for, by id. Name this or metric, not both.'),
    metric: z
      .string()
      .min(1)
      .optional()
      .describe('Or the metric the owner reports: "owner.weight", or just "weight".'),
    value: z.number().finite().describe('The number the owner said. An occurrence ("ran today") is 1.'),
    asOf: z
      .string()
      .min(1)
      .optional()
      .describe(
        "When it was true, in the owner's timezone: 2026-09-26 or 2026-09-26T07:30. Leave it out for now.",
      ),
    note: z.string().max(280).optional().describe('A few words the owner added: "after the holidays".'),
    confirmed: z
      .boolean()
      .optional()
      .describe('Set only after the owner confirmed a value this tool refused as far from the last one.'),
  })
  .strict();

/** A conversation id is a uuid; anything else is not provenance worth keeping. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A refusal a goal tool hands back instead of asking the owner anything. */
type Refusal = { ok: false; reason: string; message: string };

const refusal = (reason: string, message: string): Refusal => ({ ok: false, reason, message });

/**
 * A frequency goal's milestones are streaks — windows met in a row — so they
 * are whole numbers from 1 up, listed in the order they will be reached.
 */
function refuseStreaks(milestones: readonly number[]): Refusal | null {
  let previous = 0;
  for (const milestone of milestones) {
    if (!Number.isInteger(milestone) || milestone <= previous) {
      return refusal(
        'wrong-direction',
        `the milestone ${milestone} is not a streak: a frequency goal's milestones are windows met in a row, ` +
          'whole numbers from 1 up, listed from the smallest ([4, 8]).',
      );
    }
    previous = milestone;
  }
  return null;
}

/** One check, as `goal.status` prints it. */
export interface GoalStatusCheck {
  at: string;
  asOf: string | null;
  value: number | null;
  valueFormatted: string;
  note: string | null;
  onTrack: boolean | null;
  paceNeeded: number | null;
  projected: number | null;
}

/**
 * One goal, as `goal.status` answers it.
 *
 * Written out rather than left as `Record<string, unknown>` because the
 * timeseries descriptor maps paths into this shape: a field renamed here and
 * not in `goalViews` is a chart that silently draws nothing, and the compiler
 * is the only reader that will notice before the owner does.
 */
export interface GoalStatusGoal {
  id: string;
  title: string;
  agentId: string;
  metric: string;
  params: Record<string, unknown>;
  unit: MetricUnit;
  /** The owner's word after the number ("lb"), for a metric they report. */
  unitLabel: string | null;
  target: GoalTarget;
  targetValue: number;
  baseline: { value: number; asOf: string };
  deadline: string;
  deadlineLocal: string;
  cadence: GoalCadence;
  currency: string | null;
  milestones: number[];
  state: Goal['state'];
  closedAt: string | null;
  closedNote: string | null;
  value: number | null;
  valueFormatted: string;
  progress: number | null;
  paceNeeded: number | null;
  paceNeededInWords: string | null;
  projected: number | null;
  onTrack: boolean | null;
  verdict: GoalVerdict;
  line: string;
  checks: GoalStatusCheck[];
  /** For an owner metric: the newest values the owner told buddi, newest first. */
  values?: Array<{ asOf: string; value: number; valueFormatted: string; note: string | null; source: string }>;
  /** For a frequency goal: windows met in a row, and the newest windows, oldest first. */
  streak?: number;
  windows?: Array<{ start: string; end: string; count: number; state: 'met' | 'short' | 'partial' | 'open' }>;
}

/** How many owner values and frequency windows `goal.status` prints. */
export const STATUS_VALUES = 10;
export const STATUS_WINDOWS = 12;

/** What `goal.status` returns: the goals, and the chart when there is one. */
export interface GoalStatusResult {
  goals: GoalStatusGoal[];
  /** Only when the answer holds exactly one goal. See `goalViews`. */
  chart?: GoalChart;
}

/* ------------------------------------------------------------------ *
 * The manifest
 * ------------------------------------------------------------------ */

/**
 * The goal tools and the `core.goals` watcher, over one registry's metrics.
 *
 * `source` is the registry in every real process. It is typed as
 * `MetricSource` so a suite can hand it one in-memory metric and exercise the
 * whole surface without building a plugin.
 */
export function createGoalManifest(base: MetricSource): PluginManifest {
  /*
   * The plugin metrics and the owner's, behind one `metric(id)`. Every tool
   * refreshes its owner half first — one small `select` — so a metric another
   * conversation created a minute ago is known here.
   */
  const source = asOwnerSource(base);
  /** The unit a goal's numbers are rendered in, or a safe default. */
  const unitOf = (metric: string): ValueUnit => valueUnitOf(source, metric);
  /** Which way is better, for a goal whose plugin may have been uninstalled. */
  const directionOf = (metric: string): MetricDirection => source.metric(metric)?.direction ?? 'down';

  /**
   * Is this target — and are these milestones — on the improving side of the
   * baseline?
   *
   * The one check that makes a goal mean what it says. `reached()` is a pure
   * inequality, so a `down` goal whose target is *above* its baseline is
   * already met by the baseline: the first tick settles it `met` and
   * congratulates the owner on a debt that grew. A sign slip in one field of a
   * model's JSON is all it takes, and the card reads almost identically —
   * which is why this is refused before anybody is asked, rather than relied
   * on being spotted.
   *
   * Milestones get the same treatment: on a `down` delta goal, positive
   * milestones are all "crossed" at the baseline, so the first tick would
   * raise three wakes at once. They must lie strictly between the baseline and
   * the target, and be ordered toward it.
   */
  function refuseDirection(
    goal: { target: GoalTarget; baseline: { value: number; asOf: Date } },
    milestones: readonly number[],
    direction: MetricDirection,
    unit: ValueUnit,
    currency: string | null,
  ): Refusal | null {
    const target = targetValue(goal);
    const baseline = goal.baseline.value;
    const money = (n: number): string => formatValue(n, unit, currency);
    if (reached(goal, direction, baseline)) {
      return refusal(
        'wrong-direction',
        `this metric should go ${direction}, and ${money(target)} is not ${
          direction === 'down' ? 'below' : 'above'
        } today's ${money(baseline)} — the goal would be met the moment it was set. ` +
          (goal.target.kind === 'delta'
            ? `A delta carries its own sign: to go ${direction} from here, use a ${
                direction === 'down' ? 'negative' : 'positive'
              } value.`
            : 'Name a target on the other side of where the number is now.'),
      );
    }
    let previous = baseline;
    for (const milestone of milestones) {
      const at = milestoneValue(goal, milestone);
      const beyondBaseline = direction === 'down' ? at < baseline : at > baseline;
      const beforeTarget = direction === 'down' ? at > target : at < target;
      const forward = direction === 'down' ? at < previous : at > previous;
      if (!beyondBaseline || !beforeTarget || !forward) {
        return refusal(
          'wrong-direction',
          `the milestone ${money(at)} is not on the way from ${money(baseline)} to ${money(target)}. ` +
            'Milestones lie strictly between the two and are listed in the order they will be crossed.',
        );
      }
      previous = at;
    }
    return null;
  }

  /** The metric a `goal.set` names, resolved: an installed one, or an owner definition. */
  interface ResolvedMetric {
    id: string;
    unit: ValueUnit;
    direction: MetricDirection;
    /** Set when the metric is the owner's, new or not. */
    owner: { metric: OwnerMetricDefinition; isNew: boolean } | null;
  }

  function definitionOf(metric: OwnerMetric): OwnerMetricDefinition {
    return {
      slug: metric.slug,
      label: metric.label,
      unit: metric.unit,
      direction: metric.direction,
      unitLabel: metric.unitLabel,
    };
  }

  /**
   * Which metric this is, or why there is none.
   *
   * A string names an installed metric (a plugin's, or an owner metric that
   * already exists). An `{ owner }` definition names one to create — or one
   * that exists already, in which case it has to agree about the unit and the
   * direction: two goals reading one series in opposite directions is a
   * contradiction, not a second opinion.
   */
  async function resolveMetric(
    input: z.infer<typeof setInput>,
    ctx: CoreToolContext,
  ): Promise<{ ok: true; metric: ResolvedMetric } | Refusal> {
    if (typeof input.metric === 'string') {
      const found = source.metric(input.metric);
      if (found === undefined) {
        return refusal(
          'unknown-metric',
          `no metric "${input.metric}" is installed here. Call goal.metrics and name one of those, or pass ` +
            '{"owner": {...}} for a number the owner will report; a goal without a metric is a reminder.',
        );
      }
      if (isOwnerMetric(found)) {
        const slug = ownerSlugOf(found.id) as string;
        return {
          ok: true,
          metric: {
            id: found.id,
            unit: valueUnitOf(source, found.id),
            direction: found.direction,
            owner: {
              metric: { slug, label: found.label, unit: found.unit, direction: found.direction, unitLabel: found.unitLabel },
              isNew: false,
            },
          },
        };
      }
      return { ok: true, metric: { id: found.id, unit: found.unit, direction: found.direction, owner: null } };
    }
    const def = input.metric.owner;
    const badSlug = refuseOwnerSlug(def.slug);
    if (badSlug !== null) return refusal('invalid-metric', badSlug);
    const wanted: OwnerMetricDefinition = {
      slug: def.slug,
      label: def.label.trim(),
      unit: def.unit,
      direction: def.direction,
      unitLabel: def.unitLabel?.trim() || null,
    };
    const existing = await getOwnerMetric(ctx.db, def.slug);
    if (existing !== null) {
      if (
        existing.unit !== wanted.unit ||
        existing.direction !== wanted.direction ||
        (existing.unitLabel ?? null) !== wanted.unitLabel
      ) {
        return refusal(
          'metric-differs',
          `owner.${def.slug} already exists as ${existing.unit}${
            existing.unitLabel ? ` (${existing.unitLabel})` : ''
          }, better ${existing.direction}. Name it as "owner.${def.slug}" to use it, or choose another slug.`,
        );
      }
      return {
        ok: true,
        metric: {
          id: existing.id,
          unit: existing.unitLabel ? { unit: existing.unit, label: existing.unitLabel } : existing.unit,
          direction: existing.direction,
          owner: { metric: definitionOf(existing), isNew: false },
        },
      };
    }
    return {
      ok: true,
      metric: {
        id: ownerMetricId(def.slug),
        unit: wanted.unitLabel ? { unit: wanted.unit, label: wanted.unitLabel } : wanted.unit,
        direction: wanted.direction,
        owner: { metric: wanted, isNew: true },
      },
    };
  }

  /**
   * Everything `goal.set` refuses before an approval exists, in one place.
   *
   * Read twice on purpose: by `describe`, so the call never becomes a card,
   * and again by `execute`, because the approval was recorded minutes or hours
   * ago and "a delegate may not" is a fact about the run that is executing. It
   * only reads the arguments, the context and the metric definitions, so both
   * readings agree.
   */
  async function refuseSet(
    input: z.infer<typeof setInput>,
    ctx: CoreToolContext,
  ): Promise<{ ok: true; metric: ResolvedMetric; params: Record<string, unknown> } | Refusal> {
    if (!ctx.agentId) {
      return refusal(
        'no-agent',
        'a goal belongs to the agent that holds it, and this run has no agent id, so there is nobody to hold it',
      );
    }
    if ((ctx.delegationDepth ?? 0) >= 1) {
      return refusal(
        'delegate',
        'a delegate cannot set a goal: a goal outlives this run by months and belongs to the agent that will ' +
          'be woken about it. Report back instead, and let the agent that asked you propose it.',
      );
    }
    const resolved = await resolveMetric(input, ctx);
    if (!resolved.ok) return resolved;
    const metric = resolved.metric;
    let params: Record<string, unknown> = {};
    if (metric.owner !== null) {
      if (input.params !== undefined && Object.keys(input.params).length > 0) {
        return refusal('invalid-params', `${metric.id} is a number the owner reports; it takes no parameters.`);
      }
    } else {
      if (input.baseline !== undefined) {
        return refusal(
          'baseline-measured',
          `${metric.id} is measured by its plugin, so the baseline is measured too; leave baseline out.`,
        );
      }
      const checked = checkMetricParams(source.metric(metric.id) as NonNullable<ReturnType<typeof source.metric>>, input.params);
      if (!checked.ok) return refusal('invalid-params', checked.message);
      params = checked.params;
    }
    if (input.target.kind === 'frequency') {
      /*
       * A frequency goal counts values, and only the owner's metrics have
       * values to count: a plugin's number is a level, read when buddi looks.
       */
      if (metric.owner === null) {
        return refusal(
          'frequency-needs-owner',
          `a frequency goal counts the times the owner tells buddi, and ${metric.id} is measured by a plugin. ` +
            'Use an owner metric ({"owner": {...}}) for something the owner does, or a level target for this one.',
        );
      }
      if (input.baseline !== undefined) {
        return refusal('baseline-frequency', 'a frequency goal starts with nothing counted; leave baseline out.');
      }
      const streaks = refuseStreaks(input.milestones ?? []);
      if (streaks !== null) return streaks;
    }
    const when = parseReminderWhen(input.deadline, ctx.timezone);
    if (!when.ok) return refusal('invalid-deadline', when.message);
    const aheadMs = when.at.getTime() - ctx.now().getTime();
    if (aheadMs <= 0) {
      return refusal(
        'deadline-past',
        `${localDateString(when.at, ctx.timezone)} is not in the future; a goal is a target with a clock ` +
          'and the clock has to have time left on it.',
      );
    }
    if (aheadMs > MAX_GOAL_HORIZON_DAYS * 24 * 60 * 60_000) {
      return refusal(
        'deadline-too-far',
        `a goal can run at most ${MAX_GOAL_HORIZON_DAYS} days; that deadline is further out than anyone can ` +
          'hold a plan to.',
      );
    }
    return { ok: true, metric, params };
  }

  /** The envelope, from the arguments, the resolved metric and one measurement. */
  function envelopeOf(
    input: z.infer<typeof setInput>,
    ctx: CoreToolContext,
    metric: ResolvedMetric,
    params: Record<string, unknown>,
    baseline: GoalSetEnvelope['baseline'],
  ): GoalSetEnvelope {
    const when = parseReminderWhen(input.deadline, ctx.timezone);
    return {
      tool: 'goal.set',
      agentId: ctx.agentId ?? '',
      title: input.title.trim(),
      metric: metric.id,
      // What the schema *made of* the input — defaults applied, unknown keys
      // already refused — so the goal row and every later measurement agree.
      params,
      target:
        input.target.kind === 'frequency'
          ? { kind: 'frequency', count: input.target.count, per: input.target.per }
          : { kind: input.target.kind, value: input.target.value },
      baseline,
      deadline: (when.ok ? when.at : new Date(0)).toISOString(),
      cadence: input.cadence,
      milestones: input.milestones ?? [],
      ...(metric.owner === null
        ? {}
        : {
            owner: {
              metric: metric.owner.metric,
              isNew: metric.owner.isNew,
              baselineTold: input.baseline !== undefined,
            },
          }),
    };
  }

  /** The baseline an approval already carries, when it carries one. */
  function approvedBaseline(ctx: CoreToolContext): GoalSetEnvelope['baseline'] | null {
    const envelope = (ctx.approvedEffect?.envelope ?? null) as GoalSetEnvelope | null;
    const baseline = envelope?.baseline;
    if (!baseline || typeof baseline.value !== 'number' || typeof baseline.asOf !== 'string') return null;
    return {
      value: baseline.value,
      currency: baseline.currency ?? null,
      asOf: baseline.asOf,
      readingAsOf: baseline.readingAsOf ?? null,
    };
  }

  /**
   * The approved envelope's word on whether the owner metric was new.
   *
   * "New" is a fact about the moment the card was drawn: by the time the
   * executor re-describes, another approval may have created the slug, and a
   * card that said "a new metric" must not be voided for that — the definition
   * already had to agree for the second goal to get this far.
   */
  function approvedIsNew(ctx: CoreToolContext, metric: ResolvedMetric): ResolvedMetric {
    const envelope = (ctx.approvedEffect?.envelope ?? null) as GoalSetEnvelope | null;
    if (metric.owner === null || envelope?.owner === undefined) return metric;
    return { ...metric, owner: { ...metric.owner, isNew: envelope.owner.isNew === true } };
  }

  const metrics: ToolDefinition<Record<string, never>, unknown> = {
    name: 'goal.metrics',
    description:
      'Every number this installation can actually measure, with what it means, which way is better and the ' +
      'narrowing it takes. A goal watches one of these — name one from here when you propose a goal. Source ' +
      '"plugin" is measured by a plugin; source "owner" is a number the owner reports with goal.record. When ' +
      'nothing here measures what the owner named, goal.set can create an owner metric.',
    tier: 'auto',
    input: z.object({}).strict(),
    async execute(_input, ctx: CoreToolContext) {
      await source.refresh(ctx.db);
      return {
        metrics: source.metrics().map((metric) =>
          isOwnerMetric(metric)
            ? {
                id: metric.id,
                source: OWNER_SOURCE,
                description: metric.description,
                label: metric.label,
                unit: metric.unit,
                ...(metric.unitLabel === null ? {} : { unitLabel: metric.unitLabel }),
                direction: metric.direction,
              }
            : {
                id: metric.id,
                source: 'plugin',
                plugin: metric.plugin,
                description: metric.description,
                unit: metric.unit,
                direction: metric.direction,
                ...(metricParamsSchema(metric) === undefined ? {} : { params: metricParamsSchema(metric) }),
              },
        ),
      };
    },
  };

  const set: ToolDefinition<z.infer<typeof setInput>, unknown> = {
    name: 'goal.set',
    description:
      'Propose a goal for the owner to approve: a number from goal.metrics, a target, a deadline and how often ' +
      'buddi should check. You hold it — an agent cannot give another agent a goal — and from then on buddi ' +
      'measures on that cadence and wakes you when the owner drifts, when a milestone is crossed, or when the ' +
      'deadline gets close. The owner sees the whole shape before they say yes: where the number is today, ' +
      'where it has to get to, by when, what that is per week, and that it is you who will be speaking about ' +
      `it. At most ${MAX_OPEN_GOALS} open goals in an installation. Use it for something measurable that ` +
      'runs for weeks; for one future nudge use reminder.set. When no plugin measures the number (a weight, ' +
      'a time), create an owner metric with {"owner": {...}} and pass the baseline the owner said.',
    tier: 'gated',
    input: setInput,
    /*
     * `describe` is the only hook that runs before an action exists, and a
     * gated tool is gated on every call — the registry refuses a `tierFor`
     * that narrows it, and rightly: a rule written over model-chosen
     * arguments must not be able to skip the owner. So a refusal here is a
     * throw, and the message stands on its own, because the registry wraps it
     * in one line and hands it straight to the model. Nothing is recorded and
     * the owner is never shown a card for a goal that could not exist.
     */
    async describe(input, ctx: CoreToolContext) {
      await source.refresh(ctx.db);
      const checked = await refuseSet(input, ctx);
      if (!checked.ok) throw new Error(checked.message);
      const metric = approvedIsNew(ctx, checked.metric);
      /*
       * Measure **once**, on the first description. The executor re-describes
       * before it dispatches and compares envelope hashes, so a second
       * measurement here would mean the approval survives only if the metric
       * answers the identical number at approval time — fine for a debt,
       * hopeless for an unread count, and `email.inbox_unread` is one of the
       * metrics this exists for. At re-description the approved envelope is on
       * the context, so the number the owner saw is the number that executes.
       *
       * A number the owner just said is the baseline as it is: there is
       * nothing to measure, and it is the one sentence the goal came from.
       */
      const baseline =
        approvedBaseline(ctx) ??
        // A frequency goal starts with nothing counted: there is no level to measure.
        (input.target.kind === 'frequency'
          ? { value: 0, currency: null, asOf: ctx.now().toISOString(), readingAsOf: null }
          : input.baseline !== undefined && metric.owner !== null
          ? { value: input.baseline.value, currency: null, asOf: ctx.now().toISOString(), readingAsOf: null }
          : await (async (): Promise<GoalSetEnvelope['baseline']> => {
              const measured =
                metric.owner !== null && metric.owner.isNew
                  ? { ok: false as const, note: 'the owner has told buddi no value yet' }
                  : await measureMetricResult(
                      source,
                      metric.id,
                      metric.owner !== null ? { cadence: input.cadence } : checked.params,
                      ctx,
                    );
              if (!measured.ok) {
                /*
                 * The card is never shown for a metric nobody can read.
                 * Approving "from ? today to 47,400" is approving nothing, and
                 * the baseline is the one number the whole goal is relative to.
                 */
                throw new Error(
                  metric.owner !== null
                    ? `${metric.id} has no recent value, so there is no baseline to set a goal against. Ask the ` +
                        'owner where they are today and pass it as baseline: {"value": ...}.'
                    : `${metric.id} cannot be measured right now, so there is no baseline to set a goal against: ` +
                        `${measured.note ?? 'no reason given'}. Fix that first — a goal needs a number to start from.`,
                );
              }
              return {
                value: measured.reading.value,
                currency: measured.reading.currency ?? null,
                asOf: ctx.now().toISOString(),
                readingAsOf: measured.reading.asOf?.toISOString() ?? null,
              };
            })());

      const envelope = envelopeOf(input, ctx, metric, checked.params, baseline);
      const wrongWay = envelope.target.kind === 'frequency' ? null : refuseDirection(
        { target: envelope.target, baseline: { value: baseline.value, asOf: new Date(baseline.asOf) } },
        envelope.milestones,
        metric.direction,
        metric.unit,
        baseline.currency,
      );
      if (wrongWay !== null) throw new Error(wrongWay.message);
      return {
        envelope,
        preview: renderGoalSet(envelope, metric.unit, metric.direction, ctx.timezone),
      };
    },
    async execute(input, ctx: CoreToolContext) {
      // Only `executeApproved` reaches this. The checks run again anyway: the
      // approval was recorded minutes or hours ago, and "a delegate may not"
      // is a fact about the run that is executing, not about the one that asked.
      await source.refresh(ctx.db);
      const checked = await refuseSet(input, ctx);
      if (!checked.ok) throw new Error(checked.message);
      const metric = approvedIsNew(ctx, checked.metric);
      /*
       * The baseline is the approval's: it is the number the owner saw, and a
       * goal measured against a different one is a different goal. Everything
       * else is rebuilt from the arguments, so `assertApprovedEffect` still
       * catches a model that changed the target or the deadline between the
       * card and the yes.
       */
      const baseline = approvedBaseline(ctx);
      if (baseline === null) {
        throw new Error('the effect no longer matches the approved preview; propose it again');
      }
      const envelope = envelopeOf(input, ctx, metric, checked.params, baseline);
      assertApprovedEffect(ctx, envelope);

      const created = await createGoal(ctx.db, {
        title: envelope.title,
        agentId: envelope.agentId,
        metric: envelope.metric,
        params: envelope.params,
        target: envelope.target,
        baseline: { value: envelope.baseline.value, asOf: new Date(envelope.baseline.asOf) },
        deadline: new Date(envelope.deadline),
        cadence: envelope.cadence,
        currency: envelope.baseline.currency,
        milestones: envelope.milestones,
      });
      if (!created.ok) return { ok: false, reason: created.reason, message: created.message };

      /*
       * The owner metric is created only now that the goal exists — a goal the
       * budget refused leaves no definition behind — and a baseline the owner
       * said is the metric's first value, so the next thing they tell buddi is
       * measured against it.
       */
      if (envelope.owner !== undefined) {
        const owned = await createOwnerMetric(ctx.db, envelope.owner.metric);
        source.remember(owned);
        if (envelope.owner.baselineTold) {
          await recordOwnerValue(ctx.db, {
            slug: owned.slug,
            value: envelope.baseline.value,
            at: new Date(envelope.baseline.asOf),
            note: 'baseline, said when the goal was set',
            source: valueSourceOf(ctx),
            conversationId: ctx.conversationId ?? null,
          });
        }
      }

      // The baseline is also the first check: a goal's history starts where
      // the owner was told it starts, not at the first sentinel tick.
      await recordCheck(ctx.db, {
        goalId: created.goal.id,
        at: new Date(envelope.baseline.asOf),
        asOf: envelope.baseline.readingAsOf === null ? null : new Date(envelope.baseline.readingAsOf),
        value: envelope.baseline.value,
        currency: envelope.baseline.currency,
        note:
          envelope.target.kind === 'frequency'
            ? 'set; nothing counted yet'
            : envelope.owner?.baselineTold === true
              ? 'baseline, said when the goal was set'
              : 'baseline, measured when the goal was set',
        paceNeeded:
          envelope.target.kind === 'frequency' ? null : paceNeeded(created.goal, envelope.baseline.value, ctx.now()),
      });
      return {
        ok: true,
        goal: renderGoal(created.goal, metric.unit, ctx.timezone, unchecked(created.goal, ctx.now()), [], ctx.now()),
      };
    },
  };

  /** Everything `goal.update` and `goal.close` refuse: the goal, or the holder. */
  async function holderOf(
    id: string,
    ctx: CoreToolContext,
  ): Promise<{ ok: true; goal: Goal } | Refusal> {
    const goal = await getGoal(ctx.db, id).catch(() => null);
    if (goal === null) return refusal('not-found', `no goal ${id}`);
    if (goal.agentId !== (ctx.agentId ?? '')) {
      // Read is open and write is not (§5). Saying whose it is beats
      // pretending the row does not exist — the agent can go and ask.
      return refusal('not-yours', `goal ${id} belongs to ${goal.agentId}; only its holder can change it`);
    }
    return { ok: true, goal };
  }

  function afterOf(
    input: z.infer<typeof updateInput>,
    goal: Goal,
    ctx: CoreToolContext,
  ): GoalUpdateEnvelope['after'] {
    const when = input.deadline === undefined ? null : parseReminderWhen(input.deadline, ctx.timezone);
    return {
      target: input.target ?? goal.target,
      deadline: (when?.ok ? when.at : goal.deadline).toISOString(),
      cadence: input.cadence ?? goal.cadence,
      milestones: input.milestones ?? goal.milestones,
    };
  }

  /**
   * The whole update envelope, built the same way by `describe` and `execute`
   * so the hashes agree — and carrying the goal's version, which is what the
   * store's UPDATE is predicated on.
   */
  function updateEnvelopeOf(
    input: z.infer<typeof updateInput>,
    goal: Goal,
    ctx: CoreToolContext,
  ): GoalUpdateEnvelope {
    return {
      tool: 'goal.update',
      id: goal.id,
      agentId: goal.agentId,
      title: goal.title,
      updatedAt: goal.updatedAt.toISOString(),
      before: {
        target: goal.target,
        deadline: goal.deadline.toISOString(),
        cadence: goal.cadence,
        milestones: goal.milestones,
      },
      after: afterOf(input, goal, ctx),
    };
  }

  /** What `goal.update` refuses before a card exists, read twice like the rest. */
  function refuseUpdate(
    input: z.infer<typeof updateInput>,
    goal: Goal,
    ctx: CoreToolContext,
  ): Refusal | null {
    if (goal.state !== 'open') {
      return refusal('not-open', `goal ${goal.id} is ${goal.state}; only an open goal can be changed`);
    }
    if (input.deadline !== undefined) {
      const when = parseReminderWhen(input.deadline, ctx.timezone);
      if (!when.ok) return refusal('invalid-deadline', when.message);
      if (when.at.getTime() <= ctx.now().getTime()) {
        return refusal(
          'deadline-past',
          `${localDateString(when.at, ctx.timezone)} is not in the future; a goal needs time left on its clock`,
        );
      }
    }
    const after = afterOf(input, goal, ctx);
    /*
     * A goal keeps its shape. A level goal's baseline is a number and a
     * frequency goal's is nothing counted; turning one into the other would
     * judge months of history against a baseline that never meant that.
     */
    if ((goal.target.kind === 'frequency') !== (after.target.kind === 'frequency')) {
      return refusal(
        'shape',
        goal.target.kind === 'frequency'
          ? 'this is a frequency goal and stays one; a level target is a new goal.'
          : 'this goal aims at a level and stays one; a frequency is a new goal on an owner metric.',
      );
    }
    if (after.target.kind === 'frequency') return refuseStreaks(after.milestones);
    // Same rule as `goal.set`: an update that puts the target on the wrong
    // side of the baseline would settle the goal `met` on the next tick.
    return refuseDirection(
      { target: after.target, baseline: goal.baseline },
      after.milestones,
      directionOf(goal.metric),
      unitOf(goal.metric),
      goal.currency,
    );
  }

  const update: ToolDefinition<z.infer<typeof updateInput>, unknown> = {
    name: 'goal.update',
    description:
      'Ask the owner to change one of your own goals: its target, its deadline, its cadence or its milestones. ' +
      'This is the only way a goal changes — when a check says the pace is not going to work, you propose this ' +
      'and say why; you never quietly move the line. The card shows the owner each field before and after. ' +
      'The metric, the baseline and the holder are what the goal IS and cannot be changed; that would be a new goal.',
    tier: 'gated',
    input: updateInput,
    // Same rule as `goal.set`: a refusal is a throw out of `describe`, before
    // any action exists, and the owner is never asked about a change nobody
    // is allowed to make.
    async describe(input, ctx: CoreToolContext) {
      await source.refresh(ctx.db);
      const mine = await holderOf(input.id, ctx);
      if (!mine.ok) throw new Error(mine.message);
      const goal = mine.goal;
      const no = refuseUpdate(input, goal, ctx);
      if (no !== null) throw new Error(no.message);
      const envelope = updateEnvelopeOf(input, goal, ctx);
      return {
        envelope,
        preview: renderGoalUpdate(
          envelope,
          unitOf(goal.metric),
          ctx.timezone,
          goal.baseline.value,
          goal.currency,
        ),
      };
    },
    async execute(input, ctx: CoreToolContext) {
      await source.refresh(ctx.db);
      const mine = await holderOf(input.id, ctx);
      if (!mine.ok) throw new Error(mine.message);
      const goal = mine.goal;
      const no = refuseUpdate(input, goal, ctx);
      if (no !== null) throw new Error(no.message);
      const envelope = updateEnvelopeOf(input, goal, ctx);
      assertApprovedEffect(ctx, envelope);
      /*
       * The version the card was drawn from travels into the WHERE clause.
       * Re-reading the row above cannot close the window between that read and
       * this statement — only the statement can — and what is on the other
       * side of that window is an approval silently restoring a target, a
       * deadline and a milestone list that nobody agreed to.
       */
      const updated = await updateGoal(
        ctx.db,
        goal.id,
        {
          target: envelope.after.target,
          deadline: new Date(envelope.after.deadline),
          cadence: envelope.after.cadence,
          milestones: envelope.after.milestones,
          expectedUpdatedAt: new Date(envelope.updatedAt),
        },
        ctx.now(),
      );
      if (!updated.ok) return refusal(updated.reason, updated.message);
      return {
        ok: true,
        goal: renderGoal(updated.goal, unitOf(updated.goal.metric), ctx.timezone, unchecked(updated.goal, ctx.now()), [], ctx.now()),
      };
    },
  };

  const close: ToolDefinition<z.infer<typeof closeInput>, unknown> = {
    name: 'goal.close',
    description:
      'Close one of your own goals with a note, because it is done, or because the owner has decided it no ' +
      'longer matters. Closing is always allowed and needs no approval — you may always stop something of ' +
      'your own. A goal buddi already settled as met or missed keeps that word and gains your note: that is ' +
      'how "met" becomes final.',
    tier: 'auto',
    input: closeInput,
    async execute(input, ctx: CoreToolContext) {
      await source.refresh(ctx.db);
      const mine = await holderOf(input.id, ctx);
      if (!mine.ok) return mine;
      /*
       * `open`, `met` and `missed` can all be closed; only an already-closed
       * goal cannot. This is §5's "met and missed become final when the owner
       * agrees": buddi decides the word, the holder writes the note and the
       * date, and the word is kept.
       */
      const closed = await closeGoal(ctx.db, mine.goal.id, input.note.trim(), ctx.now());
      if (closed === null) {
        return refusal(
          'already-closed',
          `goal ${mine.goal.id} was already closed on ${mine.goal.closedAt?.toISOString()}`,
        );
      }
      return {
        ok: true,
        goal: renderGoal(closed, unitOf(closed.metric), ctx.timezone, unchecked(closed, ctx.now()), [], ctx.now()),
      };
    },
  };

  /**
   * The standing of a goal nobody has looked at in this call.
   *
   * `goal.set`, `goal.update` and `goal.close` answer with the goal they just
   * wrote, not with its history: there is nothing to project over and no
   * verdict to give, and saying "not measured" is the honest form of that.
   */
  const unchecked = (goal: Goal, now: Date): GoalStanding =>
    standingOf(goal, directionOf(goal.metric), [], now);

  /**
   * A goal and its arithmetic, as a tool result. Numbers, and the words for them.
   *
   * The arithmetic is `standing`, decided by `standingOf` over the same four
   * measured checks Home and the Goals page read, so this tool and those
   * screens cannot answer the same question two ways. `checks` is only what
   * gets *printed* — the last four rows, failed looks included, because "the
   * bank did not answer on Monday" is something the holder should say.
   */
  function renderGoal(
    goal: Goal,
    unit: ValueUnit,
    timezone: string,
    standing: GoalStanding,
    checks: GoalCheck[],
    /** The run's clock. Never `new Date()`: `goal.status` is read under one. */
    now: Date,
    /** For a goal on an owner metric: its newest values, and a frequency goal's windows. */
    owner: { values: OwnerMetricValue[]; frequency: FrequencyStanding | null } | null = null,
  ): GoalStatusGoal {
    const currency = goal.currency;
    const latest = standing.latest;
    const value = latest?.value ?? null;
    const projected = standing.projected;
    void now;
    const ownerFields =
      owner === null
        ? {}
        : {
            values: owner.values.slice(0, STATUS_VALUES).map((v) => ({
              asOf: v.asOf.toISOString(),
              value: v.value,
              valueFormatted: formatValue(v.value, unit, null),
              note: v.note,
              source: v.source,
            })),
          };
    const frequency = owner?.frequency ?? null;
    if (goal.target.kind === 'frequency' && frequency !== null) {
      /*
       * A frequency goal's numbers are windows, not a level: the value is the
       * count so far in this window, the pace is what is left to do in it,
       * and the verdict is the last window that closed.
       */
      const last = frequency.lastClosed;
      const onTrackNow = last === null || last.state === 'partial' ? null : last.state === 'met';
      return {
        ...renderGoal({ ...goal }, unit, timezone, standing, checks, now),
        ...ownerFields,
        value: frequency.current?.count ?? null,
        valueFormatted: frequencyNow(goal, frequency),
        progress: null,
        paceNeeded: frequency.toGo,
        paceNeededInWords:
          frequency.toGo === null ? null : frequency.toGo === 0 ? 'done this ' + goal.target.per : `${frequency.toGo} more this ${goal.target.per}`,
        projected: null,
        onTrack: onTrackNow,
        verdict: onTrackNow === null ? 'no-projection' : onTrackNow ? 'on-track' : 'off-track',
        streak: frequency.streak,
        windows: frequency.windows.slice(-STATUS_WINDOWS).map((w) => ({
          start: w.start,
          end: w.end,
          count: w.count,
          state: w.state,
        })),
      };
    }
    return {
      ...ownerFields,
      id: goal.id,
      title: goal.title,
      agentId: goal.agentId,
      metric: goal.metric,
      params: goal.params,
      unit: baseUnit(unit),
      unitLabel: unitLabelOf(unit),
      target: goal.target,
      targetValue: targetValue(goal),
      baseline: { value: goal.baseline.value, asOf: goal.baseline.asOf.toISOString() },
      deadline: goal.deadline.toISOString(),
      deadlineLocal: localDateString(goal.deadline, timezone),
      cadence: goal.cadence,
      currency,
      milestones: goal.milestones,
      state: goal.state,
      closedAt: goal.closedAt?.toISOString() ?? null,
      closedNote: goal.closedNote,
      value,
      valueFormatted: formatValue(value, unit, currency),
      progress: standing.progress,
      paceNeeded: standing.paceNeeded,
      paceNeededInWords:
        value === null ? null : formatPace(standing.paceNeeded, unit, directionOf(goal.metric), currency),
      projected,
      onTrack: standing.onTrack,
      verdict: standing.verdict,
      line: goalLine(goal, unit, latest, timezone),
      checks: checks.map((check) => ({
        at: check.at.toISOString(),
        asOf: check.asOf?.toISOString() ?? null,
        value: check.value,
        // The goal's own currency, never the row's: a check taken while the
        // metric answered no code must not print a different unit two lines
        // under the stats that used the goal's.
        valueFormatted: formatValue(check.value, unit, currency),
        note: check.note,
        onTrack: check.onTrack,
        paceNeeded: check.paceNeeded,
        projected: check.projected,
      })),
    };
  }

  const status: ToolDefinition<z.infer<typeof statusInput>, GoalStatusResult | Refusal> = {
    name: 'goal.status',
    description:
      'Where a goal stands: the last four checks, how far along it is, what is needed per week from here, ' +
      'where the current pace lands at the deadline, and whether that meets the target. With an id it reads ' +
      'any goal, whoever holds it; with no id it reads all of your own. Read this before you say anything ' +
      'about a goal — the numbers here are measured, not remembered.',
    tier: 'auto',
    input: statusInput,
    async execute(input, ctx: CoreToolContext) {
      await source.refresh(ctx.db);
      const goals =
        input.id === undefined
          ? await listGoals(ctx.db, { agentId: ctx.agentId ?? '', limit: 50 })
          : await (async () => {
              const one = await getGoal(ctx.db, input.id as string).catch(() => null);
              return one === null ? [] : [one];
            })();
      if (input.id !== undefined && goals.length === 0) {
        return refusal('not-found', `no goal ${input.id}`);
      }
      const out: GoalStatusGoal[] = [];
      /*
       * The chart the canvas draws, and the reason it is out here rather than
       * on each goal: a descriptor is one mapping per tool, so `chart` is
       * present **only when this answer holds exactly one goal** — with an id,
       * or when the agent happens to hold one. With several, the points
       * resolve to none and there is nothing to draw the first goal's history
       * under the title of all of them.
       */
      let chart: GoalChart | null = null;
      for (const goal of goals) {
        /*
         * Two reads, and they answer different questions. The four rows are
         * what gets *printed* — failed looks included, because "the bank did
         * not answer on Monday" is something the holder should say. The four
         * *measured* checks are what the arithmetic is done over, which is the
         * same window Home and the Goals page use, so this tool cannot
         * contradict them after a look fails.
         */
        const printed = await recentChecks(ctx.db, goal.id, 4);
        const standing = standingOf(
          goal,
          directionOf(goal.metric),
          await measuredChecks(ctx.db, goal.id, STANDING_CHECKS),
          ctx.now(),
        );
        const ownerInfo =
          ownerSlugOf(goal.metric) !== null
            ? {
                values: await goalOwnerValues(ctx.db, goal),
                frequency: await frequencyOf(ctx.db, goal, ctx.now(), ctx.timezone),
              }
            : null;
        out.push(renderGoal(goal, unitOf(goal.metric), ctx.timezone, standing, printed, ctx.now(), ownerInfo));
        if (goals.length === 1) {
          /*
           * The chart is the goal's *history*, not its last four looks: a
           * six-month goal drawn from four points is four dots, and a
           * milestone crossed in week two would have no event on it. Its own
           * read, so the printed rows stay four.
           */
          chart = chartOf(
            goal,
            unitOf(goal.metric),
            directionOf(goal.metric),
            await recentChecks(ctx.db, goal.id, CHART_CHECKS),
            ctx.timezone,
            ownerInfo,
          );
        }
      }
      return chart === null ? { goals: out } : { goals: out, chart };
    },
  };

  /**
   * Where a goal stands, in one sentence: what `goal.record` answers with.
   *
   * Read off `standingOf` like every other surface, with the value just said
   * stood in front of the measured checks — it is not a check yet, and the
   * owner wants to know what it means now, not after the next tick.
   */
  function paceSentence(goal: Goal, standing: GoalStanding, timezone: string): string {
    const unit = unitOf(goal.metric);
    const direction = directionOf(goal.metric);
    const value = standing.latest?.value ?? null;
    const target = formatValue(targetValue(goal), unit, goal.currency);
    const by = localDateString(goal.deadline, timezone);
    const pct = standing.progress === null ? '' : `, ${Math.round(standing.progress * 100)}% of the way`;
    const pace =
      standing.paceNeeded === null
        ? 'the deadline has passed'
        : `${formatPace(standing.paceNeeded, unit, direction, goal.currency)} from here reaches ${target} by ${by}`;
    return `${goal.title}: ${formatValue(value, unit, goal.currency)} now${pct}; ${pace}.`;
  }

  const record: ToolDefinition<z.infer<typeof recordInput>, unknown> = {
    name: 'goal.record',
    description:
      'Write down a number the owner just told you for a metric they report ("285 this morning", "ran today" ' +
      'is 1). Name the goal or the metric, not whose goal it is — any agent may record, so the owner can say it ' +
      'to whoever is listening. Answers with where the goal stands now, in one sentence you can repeat. A value ' +
      'far from the last one is refused with a sentence: ask the owner, then record again with confirmed: true.',
    tier: 'auto',
    input: recordInput,
    async execute(input, ctx: CoreToolContext) {
      await source.refresh(ctx.db);
      if ((input.goal === undefined) === (input.metric === undefined)) {
        return refusal('name-one', 'name the goal or the metric, exactly one of them');
      }
      /*
       * Which series. A goal names its metric; a metric may be named as
       * `owner.weight` or just `weight`. Either way it has to be one the owner
       * reports: a plugin's number is measured, and typing over it would be a
       * second, disagreeing history.
       */
      let goals: Goal[] = [];
      let metricId: string;
      if (input.goal !== undefined) {
        const goal = await getGoal(ctx.db, input.goal).catch(() => null);
        if (goal === null) return refusal('not-found', `no goal ${input.goal}`);
        metricId = goal.metric;
        goals = [goal];
      } else {
        const raw = (input.metric as string).trim();
        metricId = raw.includes('.') ? raw : ownerMetricId(raw);
      }
      const metric = source.metric(metricId);
      if (!isOwnerMetric(metric)) {
        return refusal(
          'not-owner-metric',
          metric === undefined
            ? `no metric "${metricId}" is kept here. goal.metrics lists the ones the owner reports (source "owner").`
            : `${metricId} is measured by ${metric.plugin}; there is nothing to record by hand.`,
        );
      }
      const slug = ownerSlugOf(metric.id) as string;
      if (input.goal === undefined) {
        goals = (await listGoals(ctx.db, { openOnly: true, limit: MAX_OPEN_GOALS })).filter(
          (goal) => goal.metric === metric.id,
        );
      }

      const now = ctx.now();
      let asOf = now;
      if (input.asOf !== undefined) {
        const when = parseReminderWhen(input.asOf, ctx.timezone);
        if (!when.ok) return refusal('invalid-as-of', when.message);
        asOf = when.at;
        // "This morning" written as today's date lands at 09:00; before nine
        // that is a few hours ahead of the clock, and it still means today.
        if (asOf.getTime() > now.getTime()) {
          if (localDateString(asOf, ctx.timezone) !== localDateString(now, ctx.timezone)) {
            return refusal('as-of-future', `${input.asOf} has not happened yet; a value is true of now or of the past`);
          }
          asOf = now;
        }
      }

      const unit = unitOf(metric.id);
      if (input.confirmed !== true) {
        const last = await latestOwnerValue(ctx.db, slug);
        const outside = refuseOutsideBand(last?.value ?? null, input.value, (n) => formatValue(n, unit, null));
        if (outside !== null) return refusal('confirm', outside);
      }

      const conversationId =
        ctx.conversationId !== undefined && UUID.test(ctx.conversationId) ? ctx.conversationId : null;
      const saved = await recordOwnerValue(ctx.db, {
        slug,
        value: input.value,
        at: now,
        asOf,
        note: input.note ?? null,
        source: valueSourceOf(ctx),
        conversationId,
      });

      const lines: string[] = [];
      for (const goal of goals) {
        if (goal.state !== 'open') continue;
        const frequency = await frequencyOf(ctx.db, goal, now, ctx.timezone);
        if (frequency !== null) {
          // The value is saved, so the windows already count it.
          lines.push(`${goal.title}: ${frequencyNow(goal, frequency)}.`);
          continue;
        }
        const pending: GoalCheck = {
          id: '',
          goalId: goal.id,
          at: now,
          asOf,
          value: input.value,
          currency: null,
          note: null,
          onTrack: null,
          paceNeeded: null,
          projected: null,
        };
        const standing = standingOf(
          goal,
          directionOf(goal.metric),
          [pending, ...(await measuredChecks(ctx.db, goal.id, STANDING_CHECKS))],
          now,
        );
        lines.push(paceSentence(goal, standing, ctx.timezone));
      }
      return {
        ok: true,
        recorded: {
          metric: metric.id,
          value: saved.value,
          valueFormatted: formatValue(saved.value, unit, null),
          asOf: saved.asOf.toISOString(),
          source: saved.source,
        },
        // One sentence per open goal on this metric; usually exactly one.
        pace:
          lines.length === 0
            ? `Recorded ${formatValue(saved.value, unit, null)}; no open goal watches ${metric.id}.`
            : lines.join(' '),
      };
    },
  };

  const list: ToolDefinition<Record<string, never>, unknown> = {
    name: 'goal.list',
    description:
      'Every open goal in this installation, whoever holds it, one line each. Reading is open to any agent — ' +
      'check here before proposing one so two agents do not watch the same number, and to know whose chat a ' +
      'goal belongs in. Use goal.status for the numbers behind a line.',
    tier: 'auto',
    input: z.object({}).strict(),
    async execute(_input, ctx: CoreToolContext) {
      await source.refresh(ctx.db);
      const goals = await listGoals(ctx.db, { openOnly: true, limit: MAX_OPEN_GOALS });
      const out = [];
      for (const goal of goals) {
        // The newest row that carried a number, not merely the newest row: a
        // line that says "not measured" because this morning's look failed is
        // a line that has forgotten yesterday.
        const last = (await lastMeasuredCheck(ctx.db, goal.id)) ?? (await lastCheck(ctx.db, goal.id));
        out.push({
          id: goal.id,
          agentId: goal.agentId,
          line: goalLine(goal, unitOf(goal.metric), last, ctx.timezone),
        });
      }
      return { goals: out, limit: MAX_OPEN_GOALS };
    },
  };

  return {
    name: GOAL_PLUGIN,
    version: '0.1.0',
    // The rows are core's (migration 037), like the reminders': a goal is a
    // core concept and this manifest only exposes it to a model.
    schema: 'core',
    migrationsDir: '',
    tools: [metrics, set, update, close, status, list, record, createGoalOwnerClose()],
    sentinels: [createGoalsSentinel(source)],
    // Where a goal shows (§7): a block on Home, a rail page, and one way of
    // drawing `goal.status` on the canvas. All three are in `goals-page.ts`;
    // none of them measures anything.
    home: [createGoalHome(source)],
    pages: [goalsPage],
    queries: createGoalQueries(source),
    views: goalViews,
  };
}

/* ------------------------------------------------------------------ *
 * The watcher
 * ------------------------------------------------------------------ */

/**
 * How long an off-track goal stays quiet after it woke its holder: one
 * cadence. Whole days, not the four-hour-early "due" margin — the margin keeps
 * checks from drifting; this keeps the same news from arriving twice a week.
 */
export function offTrackCooldownMs(cadence: GoalCadence): number {
  return (cadence === 'daily' ? 1 : 7) * 24 * 60 * 60_000;
}

/** Is this goal's cadence due again? See `DAILY_DUE_MS` for the margin. */
export function cadenceDue(cadence: GoalCadence, lastAt: Date | null, now: Date): boolean {
  if (lastAt === null) return true;
  return now.getTime() - lastAt.getTime() >= (cadence === 'daily' ? DAILY_DUE_MS : WEEKLY_DUE_MS);
}

/**
 * Which cadence window an owner metric has gone quiet into, or null.
 *
 * Windows are counted from `since` — the newest value, or when the goal was
 * set — one cadence at a time: a weekly goal last told on a Monday morning is
 * stale from the next Monday morning, and again from the one after. The label
 * is the owner's day the window began, which is what the finding key and the
 * notification's dedupe key carry, so each window is said at most once.
 */
export function staleWindow(since: Date, now: Date, cadence: GoalCadence, timezone: string): string | null {
  const length = cadenceMs(cadence);
  const elapsed = now.getTime() - since.getTime();
  if (elapsed < length) return null;
  const start = new Date(since.getTime() + Math.floor(elapsed / length) * length);
  return localDateString(start, timezone);
}

/**
 * The `core.goals` watcher.
 *
 * Hourly, and per goal it does two things that must stay separate: it *takes*
 * a check when the cadence is due, and it *reports* on the checks that exist.
 * Reporting every tick rather than only on a check is what makes the findings
 * resolve honestly — "off track" stops being returned the hour the next check
 * says otherwise, not a week later when the cadence next comes round.
 *
 * A goal that reaches its target or runs past its deadline is settled here,
 * and a settled goal is no longer open, so every key under it stops being
 * returned on the next tick and resolves. The wake it raised has already gone.
 */
export function createGoalsSentinel(base: MetricSource): Sentinel {
  const source = asOwnerSource(base);

  /**
   * One tick of a frequency goal: its windows, a check on its cadence, and
   * the three things worth saying — a window that closed short, a streak
   * milestone, the deadline.
   *
   * Each is keyed so it is said once. The short window's key carries the
   * window, and it is returned only while that window is the newest closed
   * one; a streak milestone is returned while the window that reached it is
   * the newest closed one, and never again once raised for another. There is
   * no staleness line: a week with nothing said is a short week, not silence.
   */
  async function frequencyTick(goal: Goal, ctx: CoreSentinelContext, now: Date): Promise<Finding[]> {
    if (goal.target.kind !== 'frequency') return [];
    const { count, per } = goal.target;
    const unit = valueUnitOf(source, goal.metric);
    const standing = (await frequencyOf(ctx.db, goal, now, ctx.timezone)) as FrequencyStanding;
    const lastClosed = standing.lastClosed;
    const verdictOf = (w: typeof lastClosed): boolean | null =>
      w === null || w.state === 'partial' ? null : w.state === 'met';

    let checks = await recentChecks(ctx.db, goal.id, 4);
    const lastAt = checks[0]?.at ?? null;
    const pastDeadline = now.getTime() >= goal.deadline.getTime();
    const deadlineUnmeasured = pastDeadline && (lastAt === null || lastAt.getTime() < goal.deadline.getTime());
    if (deadlineUnmeasured || cadenceDue(goal.cadence, lastAt, now)) {
      // The record of the tally as it stood: the count this window, the
      // verdict of the last closed one, what is left to do.
      await recordCheck(ctx.db, {
        goalId: goal.id,
        at: now,
        value: standing.current?.count ?? lastClosed?.count ?? 0,
        note: frequencyNow(goal, standing),
        onTrack: verdictOf(lastClosed),
        paceNeeded: standing.toGo,
      });
      checks = await recentChecks(ctx.db, goal.id, 4);
    }

    const recent = standing.windows.slice(-6);
    const detail = (lead: string): string =>
      [
        lead,
        '',
        goalLine(goal, unit, checks[0] ?? null, ctx.timezone),
        '',
        `The last ${recent.length} ${per}s:`,
        ...recent.map((w) => `  ${per} of ${w.start}: ${w.count} of ${count} · ${w.state}`),
        '',
        GOAL_WAKE_INSTRUCTION,
      ].join('\n');
    const data = {
      goalId: goal.id,
      metric: goal.metric,
      target: { count, per },
      deadline: goal.deadline.toISOString(),
      streak: standing.streak,
      windows: recent.map((w) => ({ start: w.start, count: w.count, state: w.state })),
    };
    const base = { agentId: goal.agentId, data };
    const out: Finding[] = [];

    // The deadline: settled by the windows, met when more met than fell short.
    if (pastDeadline) {
      const verdict = frequencySettles(standing);
      await settleGoal(
        ctx.db,
        goal.id,
        verdict,
        verdict === 'met' ? 'more windows met the count than fell short' : 'more windows fell short than met the count',
        now,
      );
      out.push(
        verdict === 'met'
          ? {
              ...base,
              key: goalKey(goal.id, 'target-reached'),
              severity: 'info',
              wake: true,
              title: `Goal reached: ${goal.title}`,
              detail: detail(`${standing.met} ${per}s met the count and ${standing.short} fell short.`),
            }
          : {
              ...base,
              key: goalKey(goal.id, 'deadline-passed'),
              severity: 'urgent',
              title: `Goal deadline passed: ${goal.title}`,
              detail: detail(
                `The deadline was ${localDateString(goal.deadline, ctx.timezone)}: ${standing.met} ${per}s met ` +
                  `the count and ${standing.short} fell short.`,
              ),
            },
      );
      return out;
    }

    // Drift: the newest closed window fell short. Said once, for that window.
    if (lastClosed?.state === 'short') {
      out.push({
        ...base,
        key: goalKey(goal.id, `short.${lastClosed.start}`),
        severity: 'info',
        wake: true,
        title: `Short last ${per}: ${goal.title}`,
        detail: detail(`${lastClosed.count} of ${count} in the ${per} of ${lastClosed.start}.`),
      });
    }

    // Streaks: each milestone once, ever, for the window that reached it.
    if (lastClosed?.state === 'met' && goal.milestones.length > 0) {
      const { rows } = await ctx.db.query(
        `select key, data->>'window' as window from core.sentinel_findings
          where sentinel_id = $1 and key like $2`,
        [GOALS_SENTINEL_ID, `goal.${goal.id}.milestone.%`],
      );
      const raisedFor = new Map((rows as Array<{ key: string; window: string | null }>).map((r) => [r.key, r.window]));
      for (const milestone of goal.milestones) {
        if (standing.streak < milestone) continue;
        const key = goalKey(goal.id, `milestone.${milestone}`);
        if (raisedFor.has(key) && raisedFor.get(key) !== lastClosed.start) continue;
        out.push({
          ...base,
          data: { ...data, window: lastClosed.start },
          key,
          severity: 'info',
          wake: true,
          title: `Milestone on ${goal.title}`,
          detail: detail(`${milestone} ${per}s in a row at ${frequencyWords(goal.target)}.`),
        });
      }
    }
    return out;
  }

  return {
    id: GOALS_SENTINEL_ID,
    description:
      'Measures every open goal on its cadence and says when one is off track, past a milestone, out of time or done.',
    every: GOALS_SENTINEL_EVERY_S,
    async run(ctx: CoreSentinelContext): Promise<Finding[]> {
      const now = ctx.now();
      const findings: Finding[] = [];
      await source.refresh(ctx.db);
      const goals = await listGoals(ctx.db, { openOnly: true, limit: MAX_OPEN_GOALS });

      for (const goal of goals) {
        const metric = source.metric(goal.metric);
        const unit = valueUnitOf(source, goal.metric);
        const direction = metric?.direction ?? 'down';
        const owned = isOwnerMetric(metric);
        if (goal.target.kind === 'frequency') {
          findings.push(...(await frequencyTick(goal, ctx, now)));
          continue;
        }
        const currency = goal.currency;

        /*
         * What was true *before* this tick's check, which is what "newly
         * crossed" is measured against. Read before anything is written: after
         * the insert it is indistinguishable from the new reading.
         */
        const beforeThisTick = await lastMeasuredCheck(ctx.db, goal.id);

        let checks = await recentChecks(ctx.db, goal.id, 4);
        const pastDeadline = now.getTime() >= goal.deadline.getTime();
        /*
         * The deadline gets a measurement of its own, cadence or no cadence.
         * A weekly goal with a Thursday deadline is not due on Thursday, and
         * settling it `missed` off Monday's number would record a verdict
         * about a week the goal never had. The same applies in the last seven
         * days, where the urgent finding quotes a number the owner will check.
         */
        const lastAt = checks[0]?.at ?? null;
        const deadlineUnmeasured =
          pastDeadline && (lastAt === null || lastAt.getTime() < goal.deadline.getTime());
        if (deadlineUnmeasured || cadenceDue(goal.cadence, lastAt, now)) {
          // An owner metric is read against *this goal's* cadence: "older than
          // two cadences" is two weeks for a weekly goal, two days for a daily one.
          const reading = await measureMetricResult(
            source,
            goal.metric,
            owned ? { ...goal.params, cadence: goal.cadence } : goal.params,
            goalToolContext(goal, ctx),
          );
          const value = reading.ok ? reading.reading.value : null;
          /*
           * An owner metric is only news when the owner said something new.
           * Re-recording last week's number under this week's date would draw
           * a flat line the owner never reported and bend the projection
           * toward it, so a cadence with no new value records nothing — the
           * staleness finding below is what says so. The deadline still gets
           * its row, so the verdict is about a number taken at or after it.
           */
          const lastSeen = checks[0] === undefined ? null : (checks[0].asOf ?? checks[0].at);
          const nothingNew =
            owned &&
            !deadlineUnmeasured &&
            reading.ok &&
            lastSeen !== null &&
            (reading.reading.asOf?.getTime() ?? 0) <= lastSeen.getTime();
          if (!nothingNew) {
          /*
           * The arithmetic of the row about to be written, over the same
           * window every other surface reads — with this tick's number stood
           * in front of it, because it is not a row yet. `standingOf` is what
           * the page and `goal.status` call afterwards, so the number stored
           * here is the number they will read back.
           */
          const before = await measuredChecks(ctx.db, goal.id, STANDING_CHECKS);
          const pending: GoalCheck = {
            id: '',
            goalId: goal.id,
            at: now,
            asOf: null,
            value,
            currency: null,
            note: null,
            onTrack: null,
            paceNeeded: null,
            projected: null,
          };
          const prospective = standingOf(goal, direction, [pending, ...before], now);
          await recordCheck(ctx.db, {
            goalId: goal.id,
            at: now,
            asOf: reading.ok ? (reading.reading.asOf ?? null) : null,
            value,
            currency: reading.ok ? (reading.reading.currency ?? null) : null,
            // The reason it could not be measured is the check's note, so
            // "the plugin is gone" and "the bank has not synced" stay
            // different facts a week later.
            note: reading.ok ? (reading.reading.note ?? null) : (reading.note ?? null),
            onTrack: prospective.onTrack,
            paceNeeded: value === null ? null : prospective.paceNeeded,
            projected: prospective.projected,
          });
          checks = await recentChecks(ctx.db, goal.id, 4);
          }
        }

        /*
         * Every verdict below is read off *measured* checks, over the same
         * four-row window Home, the Goals page and `goal.status` use — which
         * is the whole reason `standingOf` exists. A look that failed is not
         * evidence about the goal but about the plugin, and letting a null row
         * answer "is this off track?" makes a timed-out metric look like a
         * recovery.
         */
        const measured = await measuredChecks(ctx.db, goal.id, STANDING_CHECKS);
        const standing = standingOf(goal, direction, measured, now);
        const latest = standing.latest;
        const detail = (lead: string): string =>
          [
            lead,
            '',
            goalLine(goal, unit, latest, ctx.timezone),
            '',
            'The last four checks:',
            ...checkLines(checks, unit, ctx.timezone, currency),
            '',
            GOAL_WAKE_INSTRUCTION,
          ].join('\n');
        const data = {
          goalId: goal.id,
          metric: goal.metric,
          target: targetValue(goal),
          deadline: goal.deadline.toISOString(),
          value: latest?.value ?? null,
          checks: checks.map((c) => ({ at: c.at.toISOString(), value: c.value, onTrack: c.onTrack })),
        };
        const base = { agentId: goal.agentId, data };

        // 1. Done. The goal is settled here and stops being walked: every key
        //    under it resolves on the next tick, this one included.
        if (latest !== null && reached(goal, direction, latest.value as number)) {
          await settleGoal(ctx.db, goal.id, 'met', 'the target was reached', now);
          findings.push({
            ...base,
            key: goalKey(goal.id, 'target-reached'),
            severity: 'info',
            wake: true,
            title: `Goal reached: ${goal.title}`,
            detail: detail(
              `${goal.metric} is at ${formatValue(latest.value, unit, currency)}, which meets the target of ` +
                `${formatValue(targetValue(goal), unit, currency)}.`,
            ),
          });
          continue;
        }

        // 2. Out of time, and not there. The check above means this verdict is
        //    always about a number taken at or after the deadline.
        if (pastDeadline) {
          await settleGoal(ctx.db, goal.id, 'missed', 'the deadline passed and the target was not reached', now);
          findings.push({
            ...base,
            key: goalKey(goal.id, 'deadline-passed'),
            severity: 'urgent',
            title: `Goal deadline passed: ${goal.title}`,
            detail: detail(
              `The deadline was ${localDateString(goal.deadline, ctx.timezone)} and ${goal.metric} is at ` +
                `${formatValue(latest?.value ?? null, unit, currency)}, short of ` +
                `${formatValue(targetValue(goal), unit, currency)}.`,
            ),
          });
          continue;
        }

        // 3. The deadline is close and the target is not met.
        if (goal.deadline.getTime() - now.getTime() <= DEADLINE_NEAR_MS) {
          findings.push({
            ...base,
            key: goalKey(goal.id, 'deadline-near'),
            severity: 'urgent',
            title: `A week left on: ${goal.title}`,
            detail: detail(
              `${localDateString(goal.deadline, ctx.timezone)} is within seven days and ${goal.metric} is at ` +
                `${formatValue(latest?.value ?? null, unit, currency)}, short of ` +
                `${formatValue(targetValue(goal), unit, currency)}.`,
            ),
          });
        }

        /*
         * 4. Milestones, on the tick they are *newly* crossed and no other.
         *
         * A key that keeps being returned is a fact that keeps being true, and
         * core rightly reads it back out after each cooldown — so a milestone
         * returned forever is a milestone in every weekly digest forever,
         * which is not what "fires once when crossed" means. Returned once, it
         * wakes once and resolves on the next tick.
         */
        if (latest !== null && latest.id !== beforeThisTick?.id) {
          // What the goal's current number is past — `standingOf`'s answer, off
          // the newest measured value rather than off any window — against what
          // the number before this tick was past.
          const crossedBefore =
            beforeThisTick === null
              ? []
              : milestonesCrossed(goal, direction, beforeThisTick.value as number);
          for (const milestone of standing.milestonesCrossed.filter((m) => !crossedBefore.includes(m))) {
            findings.push({
              ...base,
              key: goalKey(goal.id, `milestone.${milestone}`),
              severity: 'info',
              wake: true,
              title: `Milestone on ${goal.title}`,
              detail: detail(
                `${goal.metric} has crossed the ${formatValue(milestoneValue(goal, milestone), unit, currency)} milestone.`,
              ),
            });
          }
        }

        // 5. Off track twice running is the one thing that interrupts; coming
        //    back is news for the recap, not for a phone. Both read the last
        //    two *measured* checks — `standingOf`'s `offTrackRuns` — so a
        //    failed look leaves an open off-track finding exactly as it was.
        const newest = standing.latest;
        if (standing.offTrackRuns >= 2 && newest !== null) {
          findings.push({
            ...base,
            key: goalKey(goal.id, 'off-track'),
            severity: 'urgent',
            // Bound to the goal's cadence: a weekly goal off track wakes its
            // holder at most once a week for the same drift, a daily one once
            // a day. The first time still wakes at once.
            cooldownMs: offTrackCooldownMs(goal.cadence),
            title: `Off track: ${goal.title}`,
            detail: detail(
              `Two checks running, the pace of the last four lands at ` +
                `${formatValue(newest.projected, unit, currency)} by ` +
                `${localDateString(goal.deadline, ctx.timezone)}, short of ` +
                `${formatValue(targetValue(goal), unit, currency)}. ` +
                `From here it needs ${formatPace(newest.paceNeeded, unit, direction, currency)}.`,
            ),
          });
        } else if (newest?.onTrack === true && measured[1]?.onTrack === false) {
          findings.push({
            ...base,
            key: goalKey(goal.id, 'back-on-track'),
            severity: 'info',
            title: `Back on track: ${goal.title}`,
            detail: detail('The latest check projects to meet the target by the deadline again.'),
          });
        }

        /*
         * 6. Seven days with no number at all — counted from the last check
         *    that carried one, over the whole history, and from the baseline
         *    only when there has never been one. Counting from the last four
         *    rows would collapse onto the baseline the moment four looks fail
         *    in a row, and fire on day four of an outage saying a number that
         *    existed yesterday has been missing for months.
         */
        if (owned) {
          /*
           * 6'. For a number the owner reports, silence is not an outage: it is
           *     a week nobody said anything. Counted from the newest value (or
           *     from when the goal was set, if that is later), once per cadence
           *     that passes: the key and the notification's dedupe key carry
           *     the window, so it is said at most once in it, and the line
           *     waits for the end of the day — never `now`. "Not measurable"
           *     is not raised as well; it would be the same silence twice.
           */
          const slug = ownerSlugOf(goal.metric) as string;
          const newest = await latestOwnerValue(ctx.db, slug);
          const since = new Date(Math.max(newest?.asOf.getTime() ?? 0, goal.baseline.asOf.getTime()));
          const window = staleWindow(since, now, goal.cadence, ctx.timezone);
          if (window !== null) {
            const label = isOwnerMetric(metric) ? metric.label.toLowerCase() : goal.metric;
            const period = goal.cadence === 'daily' ? 'today' : 'this week';
            findings.push({
              ...base,
              key: goalKey(goal.id, `stale.${window}`),
              severity: 'info',
              wake: true,
              notify: { urgency: 'today', dedupeKey: `goal:${goal.id}:stale:${window}` },
              title: `Not told ${period}: ${goal.title}`,
              detail: detail(
                `The owner has not told buddi their ${label} since ${localDateString(since, ctx.timezone)}. ` +
                  `Say one line and nothing more, like "You have not told me your ${label} ${period}." ` +
                  'When they answer, record it with goal.record.',
              ),
            });
          }
          continue;
        }
        const lastMeasuredAt = latest?.at ?? goal.baseline.asOf;
        if (now.getTime() - lastMeasuredAt.getTime() >= NOT_MEASURABLE_MS) {
          findings.push({
            ...base,
            key: goalKey(goal.id, 'not-measurable'),
            severity: 'info',
            wake: true,
            title: `Not measurable: ${goal.title}`,
            detail: detail(
              `${goal.metric} has answered no number since ${localDateString(lastMeasuredAt, ctx.timezone)}. ` +
                `Last reason: ${checks[0]?.note ?? 'none recorded'}.`,
            ),
          });
        }
      }
      return findings;
    },
  };
}

/**
 * The tool context a metric is measured in, from a sentinel's context.
 *
 * `measureMetric` wraps the pool read-only itself; what this adds is who is
 * asking — the goal's holder, so a metric that scopes to an agent scopes to
 * the right one — and the owner and zone the tick was given.
 */
function goalToolContext(goal: Goal, ctx: CoreSentinelContext): CoreToolContext {
  return {
    db: ctx.db,
    ownerId: ctx.ownerId,
    now: ctx.now,
    timezone: ctx.timezone,
    agentId: goal.agentId,
  };
}
