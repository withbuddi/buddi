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
  lastCheck,
  listGoals,
  localDateString,
  measureMetricResult,
  metricParamsSchema,
  milestonesCrossed,
  onTrack,
  paceNeeded,
  parseReminderWhen,
  progress,
  projection,
  reached,
  recentChecks,
  recordCheck,
  settleGoal,
  targetValue,
  updateGoal,
  type Finding,
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

/** Plugin family name for the goal tools. The rows live in core's schema. */
export const GOAL_PLUGIN = 'goal';

/** The watcher's id. Core's own, like the goals it reads. */
export const GOALS_SENTINEL_ID = 'core.goals';

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
 * ------------------------------------------------------------------ */

/** A metric's number, in its own unit. Already formatted, like a Home stat. */
export function formatValue(
  value: number | null,
  unit: MetricUnit,
  currency?: string | null,
): string {
  if (value === null || !Number.isFinite(value)) return 'not measured';
  if (unit === 'currency') {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency ?? 'USD',
        maximumFractionDigits: 0,
      }).format(value);
    } catch {
      return value.toFixed(2);
    }
  }
  if (unit === 'percent') return `${new Intl.NumberFormat('en-US').format(round(value, 1))}%`;
  if (unit === 'minutes') return `${new Intl.NumberFormat('en-US').format(Math.round(value))} min`;
  return new Intl.NumberFormat('en-US').format(round(value, 2));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** A pace, in the owner's words: the size of the weekly move, never its sign. */
function formatPace(pace: number | null, unit: MetricUnit, currency?: string | null): string {
  if (pace === null) return 'no time left';
  return `${formatValue(Math.abs(pace), unit, currency)} per week`;
}

/** One goal, on one line: what `goal.list` prints and what a wake carries. */
export function goalLine(
  goal: Goal,
  unit: MetricUnit,
  last: GoalCheck | null,
  timezone: string,
): string {
  const currency = last?.currency ?? null;
  const at = last?.value ?? null;
  const pct = at === null ? null : progress(goal, at);
  return (
    `${goal.title} — ${goal.metric} ${formatValue(at, unit, currency)} ` +
    `toward ${formatValue(targetValue(goal), unit, currency)} by ${localDateString(goal.deadline, timezone)}` +
    `${pct === null ? '' : ` (${Math.round(pct * 100)}%)`}, ` +
    `checked ${goal.cadence}, held by @${goal.agentId}`
  );
}

/** The last four checks, oldest first, one line each. Evidence, not prose. */
export function checkLines(checks: readonly GoalCheck[], unit: MetricUnit, timezone: string): string[] {
  return [...checks]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((check) => {
      const parts = [`${localDateString(check.at, timezone)}: ${formatValue(check.value, unit, check.currency)}`];
      if (check.onTrack !== null) parts.push(check.onTrack ? 'on track' : 'off track');
      if (check.projected !== null) {
        parts.push(`projected ${formatValue(check.projected, unit, check.currency)}`);
      }
      if (check.note) parts.push(check.note);
      return `  ${parts.join(' · ')}`;
    });
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
   * The number the owner saw, and the moment the goal was set.
   *
   * `asOf` is the *description clock*, not the reading's own `asOf`. The
   * executor re-describes before it dispatches and refuses anything that
   * changed since the preview (`effect-changed`), freezing `now` at the
   * action's creation to do it — so a metric that answers `asOf: new Date()`,
   * which is the obvious way to write one, would void every approval a second
   * after it was made. What the owner approved is the *value*; if that moves
   * between the card and the yes, the approval is refused and the agent
   * proposes again, which is the platform's rule and the right one. The
   * reading's own `asOf` is kept on the first check instead, where a reader
   * wants it.
   */
  baseline: { value: number; currency: string | null; asOf: string };
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
  timezone: string,
): string {
  const asGoal = {
    target: envelope.target,
    baseline: { value: envelope.baseline.value, asOf: new Date(envelope.baseline.asOf) },
    deadline: new Date(envelope.deadline),
    milestones: envelope.milestones,
  };
  const currency = envelope.baseline.currency;
  const pace = paceNeeded(asGoal, envelope.baseline.value, new Date(envelope.baseline.asOf));
  const lines = [
    `${envelope.title}`,
    '',
    `From ${formatValue(envelope.baseline.value, unit, currency)} today to ` +
      `${formatValue(targetValue(asGoal), unit, currency)} by ${localDateString(asGoal.deadline, timezone)}: ` +
      `${formatPace(pace, unit, currency)}, checked ${envelope.cadence}, held by @${envelope.agentId}`,
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
  before: { target: GoalTarget; deadline: string; cadence: GoalCadence; milestones: number[] };
  after: { target: GoalTarget; deadline: string; cadence: GoalCadence; milestones: number[] };
}

/** The card: one line per field that actually changes, before → after. */
export function renderGoalUpdate(
  envelope: GoalUpdateEnvelope,
  unit: MetricUnit,
  timezone: string,
  baseline: number,
): string {
  const value = (target: GoalTarget): string =>
    formatValue(targetValue({ target, baseline: { value: baseline, asOf: new Date() } }), unit, null);
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
    if (source.metric(input.metric) === undefined) {
      return refusal(
        'unknown-metric',
        `no metric "${input.metric}" is installed here. Call goal.metrics and name one of those; a goal ` +
          'without a metric is a reminder.',
      );
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
    return null;
  }

  /** The envelope, from the arguments and one measurement. */
  function envelopeOf(
    input: z.infer<typeof setInput>,
    ctx: ToolContext,
    baseline: { value: number; currency: string | null; asOf: Date },
  ): GoalSetEnvelope {
    const when = parseReminderWhen(input.deadline, ctx.timezone);
    return {
      tool: 'goal.set',
      agentId: ctx.agentId ?? '',
      title: input.title.trim(),
      metric: input.metric,
      params: input.params ?? {},
      target: { kind: input.target.kind, value: input.target.value },
      baseline: {
        value: baseline.value,
        currency: baseline.currency,
        asOf: baseline.asOf.toISOString(),
      },
      deadline: (when.ok ? when.at : new Date(0)).toISOString(),
      cadence: input.cadence,
      milestones: input.milestones ?? [],
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
      const measured = await measureMetricResult(source, input.metric, input.params ?? {}, ctx);
      if (!measured.ok) {
        /*
         * The card is never shown for a metric nobody can read. Approving
         * "from ? today to 47,400" is approving nothing, and the baseline is
         * the one number the whole goal is relative to.
         */
        throw new Error(
          `${input.metric} cannot be measured right now, so there is no baseline to set a goal against: ` +
            `${measured.note ?? 'no reason given'}. Fix that first — a goal needs a number to start from.`,
        );
      }
      const envelope = envelopeOf(input, ctx, {
        value: measured.reading.value,
        currency: measured.reading.currency ?? null,
        asOf: ctx.now(),
      });
      return { envelope, preview: renderGoalSet(envelope, unitOf(input.metric), ctx.timezone) };
    },
    async execute(input, ctx) {
      // Only `executeApproved` reaches this. The checks run again anyway: the
      // approval was recorded minutes or hours ago, and "a delegate may not"
      // is a fact about the run that is executing, not about the one that asked.
      const no = refuseSet(input, ctx);
      if (no !== null) throw new Error(no.message);
      /*
       * The baseline is taken from the approval, not re-measured: it is the
       * number the owner saw, and a goal measured against a different one is
       * a different goal. Everything else is rebuilt from the arguments, so
       * `assertApprovedEffect` still catches a model that changed the target
       * or the deadline between the card and the yes.
       */
      const approved = (ctx.approvedEffect?.envelope ?? null) as GoalSetEnvelope | null;
      if (approved === null || typeof approved.baseline?.value !== 'number') {
        throw new Error('the effect no longer matches the approved preview; propose it again');
      }
      const envelope = envelopeOf(input, ctx, {
        value: approved.baseline.value,
        currency: approved.baseline.currency,
        asOf: new Date(approved.baseline.asOf),
      });
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
        milestones: envelope.milestones,
      });
      if (!created.ok) return { ok: false, reason: created.reason, message: created.message };

      // The baseline is also the first check: a goal's history starts where
      // the owner was told it starts, not at the first sentinel tick.
      await recordCheck(ctx.db, {
        goalId: created.goal.id,
        at: new Date(envelope.baseline.asOf),
        value: envelope.baseline.value,
        currency: envelope.baseline.currency,
        note: 'baseline, measured when the goal was set',
        paceNeeded: paceNeeded(created.goal, envelope.baseline.value, ctx.now()),
      });
      return { ok: true, goal: renderGoal(created.goal, unitOf(envelope.metric), ctx.timezone) };
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
      if (goal.state !== 'open') {
        throw new Error(`goal ${goal.id} is ${goal.state}; only an open goal can be changed`);
      }
      if (input.deadline !== undefined) {
        const when = parseReminderWhen(input.deadline, ctx.timezone);
        if (!when.ok) throw new Error(when.message);
        if (when.at.getTime() <= ctx.now().getTime()) {
          throw new Error(
            `${localDateString(when.at, ctx.timezone)} is not in the future; a goal needs time left on its clock`,
          );
        }
      }
      const envelope: GoalUpdateEnvelope = {
        tool: 'goal.update',
        id: goal.id,
        agentId: goal.agentId,
        title: goal.title,
        before: {
          target: goal.target,
          deadline: goal.deadline.toISOString(),
          cadence: goal.cadence,
          milestones: goal.milestones,
        },
        after: afterOf(input, goal, ctx),
      };
      return {
        envelope,
        preview: renderGoalUpdate(envelope, unitOf(goal.metric), ctx.timezone, goal.baseline.value),
      };
    },
    async execute(input, ctx) {
      const mine = await holderOf(input.id, ctx);
      if (!mine.ok) throw new Error(mine.message);
      const goal = mine.goal;
      if (goal.state !== 'open') {
        throw new Error(`goal ${goal.id} is ${goal.state}; only an open goal can be changed`);
      }
      const envelope: GoalUpdateEnvelope = {
        tool: 'goal.update',
        id: goal.id,
        agentId: goal.agentId,
        title: goal.title,
        before: {
          target: goal.target,
          deadline: goal.deadline.toISOString(),
          cadence: goal.cadence,
          milestones: goal.milestones,
        },
        after: afterOf(input, goal, ctx),
      };
      assertApprovedEffect(ctx, envelope);
      const updated = await updateGoal(
        ctx.db,
        goal.id,
        {
          target: envelope.after.target,
          deadline: new Date(envelope.after.deadline),
          cadence: envelope.after.cadence,
          milestones: envelope.after.milestones,
        },
        ctx.now(),
      );
      if (updated === null) return refusal('not-found', `no goal ${goal.id}`);
      return { ok: true, goal: renderGoal(updated, unitOf(updated.metric), ctx.timezone) };
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
      const closed = await closeGoal(ctx.db, mine.goal.id, input.note.trim(), ctx.now());
      if (closed === null) {
        return refusal('already-closed', `goal ${mine.goal.id} was already closed on ${mine.goal.closedAt?.toISOString()}`);
      }
      return { ok: true, goal: renderGoal(closed, unitOf(closed.metric), ctx.timezone) };
    },
  };

  /** A goal and its arithmetic, as a tool result. Numbers, and the words for them. */
  function renderGoal(goal: Goal, unit: MetricUnit, timezone: string, checks: GoalCheck[] = []): Record<string, unknown> {
    const measured = checks.filter((c) => c.value !== null);
    const latest = measured[0] ?? null;
    const value = latest?.value ?? null;
    const projected = projection(
      goal,
      measured.map((c) => ({ at: c.at, value: c.value as number })),
    );
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
      milestones: goal.milestones,
      state: goal.state,
      closedNote: goal.closedNote,
      value,
      valueFormatted: formatValue(value, unit, latest?.currency ?? null),
      progress: value === null ? null : progress(goal, value),
      paceNeeded: value === null ? null : paceNeeded(goal, value, new Date()),
      projected,
      onTrack: onTrack(goal, directionOf(goal.metric), projected),
      line: goalLine(goal, unit, latest, timezone),
      checks: checks.map((check) => ({
        at: check.at.toISOString(),
        value: check.value,
        valueFormatted: formatValue(check.value, unit, check.currency),
        note: check.note,
        onTrack: check.onTrack,
        paceNeeded: check.paceNeeded,
        projected: check.projected,
      })),
    };
  }

  const status: ToolDefinition<z.infer<typeof statusInput>, unknown> = {
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
      const out = [];
      for (const goal of goals) {
        const checks = await recentChecks(ctx.db, goal.id, 4);
        out.push(renderGoal(goal, unitOf(goal.metric), ctx.timezone, checks));
      }
      return { goals: out };
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
        const last = await lastCheck(ctx.db, goal.id);
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
    tools: [metrics, set, update, close, status, list],
    sentinels: [createGoalsSentinel(source)],
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

/** `goal.<id>.<event>` — one fact, one key, so each resolves on its own. */
export function goalKey(goalId: string, event: string): string {
  return `goal.${goalId}.${event}`;
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

        let checks = await recentChecks(ctx.db, goal.id, 4);
        if (cadenceDue(goal.cadence, checks[0]?.at ?? null, now)) {
          const measured = await measureMetricResult(source, goal.metric, goal.params, goalToolContext(goal, ctx));
          const value = measured.ok ? measured.reading.value : null;
          const points = checks
            .filter((c) => c.value !== null)
            .map((c) => ({ at: c.at, value: c.value as number }));
          if (value !== null) points.push({ at: now, value });
          const projected = projection(goal, points);
          await recordCheck(ctx.db, {
            goalId: goal.id,
            at: now,
            value,
            currency: measured.ok ? (measured.reading.currency ?? null) : null,
            // The reason it could not be measured is the check's note, so
            // "the plugin is gone" and "the bank has not synced" stay
            // different facts a week later.
            note: measured.ok ? (measured.reading.note ?? null) : (measured.note ?? null),
            onTrack: onTrack(goal, direction, projected),
            paceNeeded: value === null ? null : paceNeeded(goal, value, now),
            projected,
          });
          checks = await recentChecks(ctx.db, goal.id, 4);
        }

        const measuredChecks = checks.filter((c) => c.value !== null);
        const latest = measuredChecks[0] ?? null;
        const detail = (lead: string): string =>
          [
            lead,
            '',
            goalLine(goal, unit, latest, ctx.timezone),
            '',
            'The last four checks:',
            ...checkLines(checks, unit, ctx.timezone),
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
        //    under it resolves on the next tick.
        if (latest !== null && reached(goal, direction, latest.value as number)) {
          await settleGoal(ctx.db, goal.id, 'met', 'the target was reached', now);
          findings.push({
            ...base,
            key: goalKey(goal.id, 'target-reached'),
            severity: 'info',
            wake: true,
            title: `Goal reached: ${goal.title}`,
            detail: detail(
              `${goal.metric} is at ${formatValue(latest.value, unit, latest.currency)}, which meets the target of ` +
                `${formatValue(targetValue(goal), unit, latest.currency)}.`,
            ),
          });
          continue;
        }

        // 2. Out of time, and not there.
        if (now.getTime() >= goal.deadline.getTime()) {
          await settleGoal(ctx.db, goal.id, 'missed', 'the deadline passed and the target was not reached', now);
          findings.push({
            ...base,
            key: goalKey(goal.id, 'deadline-passed'),
            severity: 'urgent',
            title: `Goal deadline passed: ${goal.title}`,
            detail: detail(
              `The deadline was ${localDateString(goal.deadline, ctx.timezone)} and ${goal.metric} is at ` +
                `${formatValue(latest?.value ?? null, unit, latest?.currency ?? null)}, short of ` +
                `${formatValue(targetValue(goal), unit, latest?.currency ?? null)}.`,
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
              `${localDateString(goal.deadline, ctx.timezone)} is within seven days and the target is not met.`,
            ),
          });
        }

        // 4. Milestones. One key each, so each one is news exactly once.
        if (latest !== null) {
          for (const milestone of milestonesCrossed(goal, direction, latest.value as number)) {
            findings.push({
              ...base,
              key: goalKey(goal.id, `milestone.${milestone}`),
              severity: 'info',
              wake: true,
              title: `Milestone on ${goal.title}`,
              detail: detail(
                `${goal.metric} has crossed the ${formatValue(milestone, unit, latest.currency)} milestone.`,
              ),
            });
          }
        }

        // 5. Off track twice running is the one thing that interrupts; coming
        //    back is news for the recap, not for a phone.
        const [newest, previous] = checks;
        if (newest?.onTrack === false && previous?.onTrack === false) {
          findings.push({
            ...base,
            key: goalKey(goal.id, 'off-track'),
            severity: 'urgent',
            title: `Off track: ${goal.title}`,
            detail: detail(
              `Two checks running, the pace of the last four lands at ` +
                `${formatValue(newest.projected, unit, newest.currency)} by ` +
                `${localDateString(goal.deadline, ctx.timezone)}, short of ` +
                `${formatValue(targetValue(goal), unit, newest.currency)}. ` +
                `From here it needs ${formatPace(newest.paceNeeded, unit, newest.currency)}.`,
            ),
          });
        } else if (newest?.onTrack === true && previous?.onTrack === false) {
          findings.push({
            ...base,
            key: goalKey(goal.id, 'back-on-track'),
            severity: 'info',
            title: `Back on track: ${goal.title}`,
            detail: detail('The latest check projects to meet the target by the deadline again.'),
          });
        }

        // 6. Seven days with no number at all. The goal shows "not measured"
        //    and the holder hears it once, rather than a made-up figure.
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
