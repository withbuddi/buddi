/**
 * Goals: a target with a clock, that buddi keeps (docs/specs/goals.md).
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
  type SentinelContext,
  type ToolContext,
  type ToolDefinition,
} from '@buddi/core';
import { z } from 'zod';
import { GOALS_SENTINEL_ID, checkLines, formatPace, formatValue, goalKey, goalLine } from './goals-format.js';
import {
  CHART_CHECKS,
  chartOf,
  createGoalHome,
  createGoalOwnerClose,
  createGoalQueries,
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
  unit: MetricUnit,
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
  const lines = [
    `${envelope.title}`,
    '',
    `From ${formatValue(envelope.baseline.value, unit, currency)} today${stale} to ` +
      `${formatValue(targetValue(asGoal), unit, currency)} by ${localDateString(asGoal.deadline, timezone)}: ` +
      `${formatPace(pace, unit, direction, currency)}, checked ${envelope.cadence}, held by @${envelope.agentId}`,
    '',
    `Measured by ${envelope.metric}${
      Object.keys(envelope.params).length === 0 ? '' : ` ${JSON.stringify(envelope.params)}`
    }, every ${envelope.cadence === 'daily' ? 'day' : 'week'}, until ${localDateString(asGoal.deadline, timezone)}.`,
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
  unit: MetricUnit,
  timezone: string,
  baseline: number,
  currency: string | null = null,
): string {
  const value = (target: GoalTarget): string =>
    formatValue(targetValue({ target, baseline: { value: baseline, asOf: new Date(0) } }), unit, currency);
  const { before, after } = envelope;
  const rows: string[] = [];
  if (before.target.kind !== after.target.kind || before.target.value !== after.target.value) {
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

const targetInput = z
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

const setInput = z
  .object({
    title: z
      .string()
      .min(1)
      .max(MAX_GOAL_TITLE)
      .describe('A short name the owner will recognise on a card months from now: "Debt down by 40k".'),
    metric: z
      .string()
      .min(1)
      .describe('The namespaced metric to watch, exactly as goal.metrics lists it: "finance.total_debt".'),
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
          'something about when they are crossed. Each fires once, ever.',
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

/** A refusal a goal tool hands back instead of asking the owner anything. */
type Refusal = { ok: false; reason: string; message: string };

const refusal = (reason: string, message: string): Refusal => ({ ok: false, reason, message });

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
}

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
export function createGoalManifest(source: MetricSource): PluginManifest {
  /** The unit a goal's numbers are rendered in, or a safe default. */
  const unitOf = (metric: string): MetricUnit => source.metric(metric)?.unit ?? 'number';
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
    unit: MetricUnit,
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

  /**
   * Everything `goal.set` refuses before an approval exists, in one place.
   *
   * Read twice on purpose: by `describe`, so the call never becomes a card,
   * and again by `execute`, because the approval was recorded minutes or hours
   * ago and "a delegate may not" is a fact about the run that is executing. It
   * only reads the arguments and the context, so both readings agree.
   */
  function refuseSet(input: z.infer<typeof setInput>, ctx: ToolContext): Refusal | null {
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
    const metric = source.metric(input.metric);
    if (metric === undefined) {
      return refusal(
        'unknown-metric',
        `no metric "${input.metric}" is installed here. Call goal.metrics and name one of those; a goal ` +
          'without a metric is a reminder.',
      );
    }
    const params = checkMetricParams(metric, input.params);
    if (!params.ok) return refusal('invalid-params', params.message);
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
    return null;
  }

  /** The envelope, from the arguments and one measurement. */
  function envelopeOf(
    input: z.infer<typeof setInput>,
    ctx: ToolContext,
    baseline: GoalSetEnvelope['baseline'],
  ): GoalSetEnvelope {
    const when = parseReminderWhen(input.deadline, ctx.timezone);
    const metric = source.metric(input.metric);
    const params = metric === undefined ? { ok: false as const } : checkMetricParams(metric, input.params);
    return {
      tool: 'goal.set',
      agentId: ctx.agentId ?? '',
      title: input.title.trim(),
      metric: input.metric,
      // What the schema *made of* the input — defaults applied, unknown keys
      // already refused — so the goal row and every later measurement agree.
      params: params.ok ? params.params : (input.params ?? {}),
      target: { kind: input.target.kind, value: input.target.value },
      baseline,
      deadline: (when.ok ? when.at : new Date(0)).toISOString(),
      cadence: input.cadence,
      milestones: input.milestones ?? [],
    };
  }

  /** The baseline an approval already carries, when it carries one. */
  function approvedBaseline(ctx: ToolContext): GoalSetEnvelope['baseline'] | null {
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

  const metrics: ToolDefinition<Record<string, never>, unknown> = {
    name: 'goal.metrics',
    description:
      'Every number this installation can actually measure, with what it means, which way is better and the ' +
      'narrowing it takes. A goal watches one of these — name one from here when you propose a goal, and if ' +
      'the list is empty then nothing installed here can be measured and a goal is the wrong tool.',
    tier: 'auto',
    input: z.object({}).strict(),
    async execute() {
      return {
        metrics: source.metrics().map((metric) => ({
          id: metric.id,
          plugin: metric.plugin,
          description: metric.description,
          unit: metric.unit,
          direction: metric.direction,
          ...(metricParamsSchema(metric) === undefined ? {} : { params: metricParamsSchema(metric) }),
        })),
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
      'runs for weeks; for one future nudge use reminder.set.',
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
    async describe(input, ctx) {
      const no = refuseSet(input, ctx);
      if (no !== null) throw new Error(no.message);
      /*
       * Measure **once**, on the first description. The executor re-describes
       * before it dispatches and compares envelope hashes, so a second
       * measurement here would mean the approval survives only if the metric
       * answers the identical number at approval time — fine for a debt,
       * hopeless for an unread count, and `email.inbox_unread` is one of the
       * metrics this exists for. At re-description the approved envelope is on
       * the context, so the number the owner saw is the number that executes.
       */
      const baseline =
        approvedBaseline(ctx) ??
        (await (async (): Promise<GoalSetEnvelope['baseline']> => {
          const measured = await measureMetricResult(source, input.metric, input.params ?? {}, ctx);
          if (!measured.ok) {
            /*
             * The card is never shown for a metric nobody can read. Approving
             * "from ? today to 47,400" is approving nothing, and the baseline
             * is the one number the whole goal is relative to.
             */
            throw new Error(
              `${input.metric} cannot be measured right now, so there is no baseline to set a goal against: ` +
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

      const envelope = envelopeOf(input, ctx, baseline);
      const direction = directionOf(input.metric);
      const wrongWay = refuseDirection(
        { target: envelope.target, baseline: { value: baseline.value, asOf: new Date(baseline.asOf) } },
        envelope.milestones,
        direction,
        unitOf(input.metric),
        baseline.currency,
      );
      if (wrongWay !== null) throw new Error(wrongWay.message);
      return {
        envelope,
        preview: renderGoalSet(envelope, unitOf(input.metric), direction, ctx.timezone),
      };
    },
    async execute(input, ctx) {
      // Only `executeApproved` reaches this. The checks run again anyway: the
      // approval was recorded minutes or hours ago, and "a delegate may not"
      // is a fact about the run that is executing, not about the one that asked.
      const no = refuseSet(input, ctx);
      if (no !== null) throw new Error(no.message);
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
      const envelope = envelopeOf(input, ctx, baseline);
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

      // The baseline is also the first check: a goal's history starts where
      // the owner was told it starts, not at the first sentinel tick.
      await recordCheck(ctx.db, {
        goalId: created.goal.id,
        at: new Date(envelope.baseline.asOf),
        asOf: envelope.baseline.readingAsOf === null ? null : new Date(envelope.baseline.readingAsOf),
        value: envelope.baseline.value,
        currency: envelope.baseline.currency,
        note: 'baseline, measured when the goal was set',
        paceNeeded: paceNeeded(created.goal, envelope.baseline.value, ctx.now()),
      });
      return {
        ok: true,
        goal: renderGoal(created.goal, unitOf(envelope.metric), ctx.timezone, unchecked(created.goal, ctx.now()), [], ctx.now()),
      };
    },
  };

  /** Everything `goal.update` and `goal.close` refuse: the goal, or the holder. */
  async function holderOf(
    id: string,
    ctx: ToolContext,
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
    ctx: ToolContext,
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
    ctx: ToolContext,
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
    ctx: ToolContext,
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
    async describe(input, ctx) {
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
    async execute(input, ctx) {
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
    async execute(input, ctx) {
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
    unit: MetricUnit,
    timezone: string,
    standing: GoalStanding,
    checks: GoalCheck[],
    /** The run's clock. Never `new Date()`: `goal.status` is read under one. */
    now: Date,
  ): GoalStatusGoal {
    const currency = goal.currency;
    const latest = standing.latest;
    const value = latest?.value ?? null;
    const projected = standing.projected;
    void now;
    return {
      id: goal.id,
      title: goal.title,
      agentId: goal.agentId,
      metric: goal.metric,
      params: goal.params,
      unit,
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
    async execute(input, ctx) {
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
        out.push(renderGoal(goal, unitOf(goal.metric), ctx.timezone, standing, printed, ctx.now()));
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
          );
        }
      }
      return chart === null ? { goals: out } : { goals: out, chart };
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
    async execute(_input, ctx) {
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
    tools: [metrics, set, update, close, status, list, createGoalOwnerClose()],
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

/** Is this goal's cadence due again? See `DAILY_DUE_MS` for the margin. */
export function cadenceDue(cadence: GoalCadence, lastAt: Date | null, now: Date): boolean {
  if (lastAt === null) return true;
  return now.getTime() - lastAt.getTime() >= (cadence === 'daily' ? DAILY_DUE_MS : WEEKLY_DUE_MS);
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
export function createGoalsSentinel(source: MetricSource): Sentinel {
  return {
    id: GOALS_SENTINEL_ID,
    description:
      'Measures every open goal on its cadence and says when one is off track, past a milestone, out of time or done.',
    every: GOALS_SENTINEL_EVERY_S,
    async run(ctx: SentinelContext): Promise<Finding[]> {
      const now = ctx.now();
      const findings: Finding[] = [];
      const goals = await listGoals(ctx.db, { openOnly: true, limit: MAX_OPEN_GOALS });

      for (const goal of goals) {
        const metric = source.metric(goal.metric);
        const unit = metric?.unit ?? 'number';
        const direction = metric?.direction ?? 'down';
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
          const reading = await measureMetricResult(source, goal.metric, goal.params, goalToolContext(goal, ctx));
          const value = reading.ok ? reading.reading.value : null;
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
function goalToolContext(goal: Goal, ctx: SentinelContext): ToolContext {
  return {
    db: ctx.db,
    ownerId: ctx.ownerId,
    now: ctx.now,
    timezone: ctx.timezone,
    agentId: goal.agentId,
  };
}
