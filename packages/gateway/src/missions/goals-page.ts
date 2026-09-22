/**
 * Where a goal shows: the Home block, the Goals page and the reads behind it
 * (docs/specs/goals.md §7).
 *
 * Step 1 gave a goal a clock and a holder; this is the half the owner can see
 * without asking anybody. Three surfaces, one set of numbers:
 *
 *  - **Home** gets a block — a line per open goal, and two figures. Everything
 *    in it is already formatted, in the goal's own currency and the owner's
 *    zone, because a Home block is drawn by a page that knows no domain.
 *  - **The rail** gets a Goals page, built from the plugin-pages components
 *    like any plugin's screen (core is allowed exactly what a plugin is). The
 *    reads are `queries` — read-only by enforcement, not by promise — and the
 *    one write is `goal.owner_close`, an `ownerOnly` tool no model is shown.
 *  - **The canvas** gets one view descriptor, so `goal.status` on a single
 *    goal draws its checks rather than its JSON.
 *
 * Nothing here measures. Every number is read out of `core.goals` and
 * `core.goal_checks` as the sentinel left them: a page that measured would be
 * a second, slower, unrecorded check happening whenever a tab is open.
 */
import {
  QueryRefusal,
  closeGoal,
  getGoal,
  lastMeasuredCheck,
  listGoals,
  localDateString,
  milestoneValue,
  paceNeeded,
  progress,
  projection,
  recentChecks,
  targetValue,
  type Goal,
  type GoalCheck,
  type HomeBlock,
  type HomeContribution,
  type HomeRow,
  type MetricDirection,
  type MetricSource,
  type MetricUnit,
  type PageDescriptor,
  type PageQuery,
  type QueryRef,
  type ToolContext,
  type ToolDefinition,
  type ViewDescriptor,
} from '@buddi/core';
import { z } from 'zod';
import { formatPace, formatValue } from './goals-format.js';

/** The page parameter the chosen goal's id is bound to: `#/p/goal/goals/<id>`. */
const GOAL = 'goal';

/** How many checks the page draws. Enough to see the shape, not a ledger. */
export const PAGE_CHECKS = 24;

/** The states that are no longer running, in the order they are listed. */
const FINISHED = ['met', 'missed', 'closed'] as const;

/**
 * One read of the open goal, as a fresh object each time.
 *
 * A descriptor is a *tree* and the same object in two places is refused at
 * `register()`, so this is a function rather than a constant — the same reason
 * the Mail page's `thread()` is one.
 */
const goalRef = (): QueryRef => ({ query: 'goal', params: { id: { param: GOAL } } });

/* ------------------------------------------------------------------ *
 * The arithmetic every surface shares
 * ------------------------------------------------------------------ */

/**
 * The checks that carry a number, oldest first.
 *
 * Every verdict on this page is read off measured checks, for the reason the
 * sentinel gives: a look that failed is evidence about the plugin, not about
 * the goal, and letting a null row answer "is this on track?" makes an outage
 * look like a recovery.
 */
function measuredAscending(checks: readonly GoalCheck[]): GoalCheck[] {
  return checks
    .filter((check) => check.value !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Where a goal stands, in one word, plus whether it is the loud kind. */
export interface Standing {
  /** `on track`, `off track`, `not measured since …`, `no projection yet`. */
  word: string;
  /** Two checks running on the wrong side: the one thing that is shouted about. */
  offTrackTwice: boolean;
  onTrack: boolean;
}

/**
 * The verdict a row, a pill and a stat all read.
 *
 * `checks` is whatever the caller has in hand, newest-first or not; `latest`
 * is the newest *measured* one over the whole history, which is not the same
 * thing — a goal whose plugin went missing on Friday still has Thursday's
 * number, and saying "not measured" about it would be a lie about the goal
 * rather than a fact about the plugin.
 */
export function standingOf(
  goal: Goal,
  checks: readonly GoalCheck[],
  latest: GoalCheck | null,
  timezone: string,
): Standing {
  const measured = measuredAscending(checks);
  const newest = latest ?? measured[measured.length - 1] ?? null;
  if (newest === null) {
    return {
      word: `not measured since ${localDateString(goal.baseline.asOf, timezone)}`,
      offTrackTwice: false,
      onTrack: false,
    };
  }
  /*
   * A failed look is news of its own: the newest *row* carries no number while
   * the newest *number* is days old. The sentence names the day the number is
   * from, which is the question the owner actually has.
   */
  const newestRow = [...checks].sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
  if (newestRow !== null && newestRow.value === null) {
    return {
      word: `not measured since ${localDateString(newest.at, timezone)}`,
      offTrackTwice: false,
      onTrack: false,
    };
  }
  const previous = measured[measured.length - 2] ?? null;
  if (newest.onTrack === null) {
    // Fewer than two points is no projection, and no projection is not "off
    // track". A goal in its first week must not be reported as failing.
    return { word: 'no projection yet', offTrackTwice: false, onTrack: false };
  }
  return {
    word: newest.onTrack ? 'on track' : 'off track',
    offTrackTwice: newest.onTrack === false && previous?.onTrack === false,
    onTrack: newest.onTrack === true,
  };
}

/**
 * "progress 62% · $1,540 a week down · on track" — the line under a goal.
 *
 * The three parts §7 asks for, and each one is left out rather than guessed:
 * a goal with no number has no progress and no pace, and a deadline already
 * past has no per-week left.
 */
export function goalSub(
  goal: Goal,
  unit: MetricUnit,
  direction: MetricDirection,
  latest: GoalCheck | null,
  standing: Standing,
  now: Date,
): string {
  const parts: string[] = [];
  const value = latest?.value ?? null;
  if (value !== null) {
    const done = progress(goal, value);
    if (done !== null) parts.push(`progress ${Math.round(done * 100)}%`);
    const pace = paceNeeded(goal, value, now);
    if (pace !== null) parts.push(`pace ${formatPace(pace, unit, direction, goal.currency)}`);
  }
  parts.push(standing.word);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ *
 * Home
 * ------------------------------------------------------------------ */

/**
 * The Goals block: a line per open goal, and two figures.
 *
 * `null` when there is no open goal — a Home block exists to say something,
 * and "you have no goals" is a sentence the page does not need a card for. A
 * goal that has been met and closed is history, and history lives on the page.
 */
export function createGoalHome(source: MetricSource): HomeContribution {
  return {
    id: 'goal.goals',
    title: 'Goals',
    async produce(ctx: ToolContext): Promise<HomeBlock | null> {
      const goals = await listGoals(ctx.db, { openOnly: true, limit: 50 });
      if (goals.length === 0) return null;
      const now = ctx.now();
      const rows: HomeRow[] = [];
      let offTrack = 0;
      for (const goal of goals) {
        const unit = source.metric(goal.metric)?.unit ?? 'number';
        const direction = source.metric(goal.metric)?.direction ?? 'down';
        const checks = await recentChecks(ctx.db, goal.id, 4);
        const latest = await lastMeasuredCheck(ctx.db, goal.id);
        const standing = standingOf(goal, checks, latest, ctx.timezone);
        if (!standing.onTrack && standing.word === 'off track') offTrack += 1;
        rows.push({
          title: goal.title,
          sub: goalSub(goal, unit, direction, latest, standing, now),
          side: formatValue(latest?.value ?? null, unit, goal.currency),
          // Good when it is going to land; loud only when it has missed twice
          // running, which is the one thing the sentinel interrupts for.
          ...(standing.onTrack
            ? { tone: 'good' as const }
            : standing.offTrackTwice
              ? { tone: 'critical' as const }
              : {}),
        });
      }
      return {
        id: 'goal.goals',
        title: 'Goals',
        stats: [
          { label: 'Open', value: String(goals.length) },
          {
            label: 'Off track',
            value: String(offTrack),
            ...(offTrack > 0 ? { tone: 'critical' as const } : {}),
          },
        ],
        rows,
        rowsTitle: 'What buddi is keeping',
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * The reads
 * ------------------------------------------------------------------ */

/** One row of the list on the left of the page. */
interface GoalListRow {
  id: string;
  title: string;
  sub: string;
  value: string;
  /** `open` or `done`: what the list groups by. */
  group: 'open' | 'done';
  state: Goal['state'];
  tone: 'good' | 'critical' | 'neutral';
  holder: string;
}

/**
 * Both page queries, over one registry's metrics.
 *
 * They are handed a `ToolContext` whose `db` refuses anything but a `select`
 * (`readOnlyPool`), so "a page cannot write" is enforced by Postgres rather
 * than promised here.
 */
export function createGoalQueries(source: MetricSource): PageQuery[] {
  const unitOf = (metric: string): MetricUnit => source.metric(metric)?.unit ?? 'number';
  const directionOf = (metric: string): MetricDirection => source.metric(metric)?.direction ?? 'down';

  const goals: PageQuery = {
    name: 'goals',
    params: z.object({}),
    async produce(_params, ctx) {
      const all = await listGoals(ctx.db, { limit: 200 });
      const now = ctx.now();
      const rows: GoalListRow[] = [];
      for (const goal of all) {
        const unit = unitOf(goal.metric);
        const checks = await recentChecks(ctx.db, goal.id, 4);
        const latest = await lastMeasuredCheck(ctx.db, goal.id);
        const standing = standingOf(goal, checks, latest, ctx.timezone);
        rows.push({
          id: goal.id,
          title: goal.title,
          sub: goalSub(goal, unit, directionOf(goal.metric), latest, standing, now),
          value: formatValue(latest?.value ?? null, unit, goal.currency),
          group: goal.state === 'open' ? 'open' : 'done',
          state: goal.state,
          tone:
            goal.state === 'met'
              ? 'good'
              : goal.state === 'missed'
                ? 'critical'
                : goal.state !== 'open'
                  ? 'neutral'
                  : standing.onTrack
                    ? 'good'
                    : standing.offTrackTwice
                      ? 'critical'
                      : 'neutral',
          holder: goal.agentId,
        });
      }
      /*
       * Open first, then the finished ones in the order §7 lists them. The
       * list groups by `group`, and inside a group this order is what the
       * owner reads: the ones still running, oldest set first.
       */
      const rank = (row: GoalListRow): number =>
        row.group === 'open' ? -1 : FINISHED.indexOf(row.state as (typeof FINISHED)[number]);
      rows.sort((a, b) => rank(a) - rank(b));
      return { goals: rows, count: rows.length };
    },
  };

  const one: PageQuery = {
    name: 'goal',
    params: z.object({ id: z.string().min(1) }),
    async produce(params, ctx) {
      const { id } = params as { id: string };
      const goal = await getGoal(ctx.db, id).catch(() => null);
      // The owner asked for this one, so the refusal is an *answer* — a 400
      // carrying this sentence — rather than a defect with a generic 502.
      if (goal === null) throw new QueryRefusal('No goal here has that id.');

      const unit = unitOf(goal.metric);
      const direction = directionOf(goal.metric);
      const currency = goal.currency;
      const checks = await recentChecks(ctx.db, goal.id, PAGE_CHECKS);
      const measured = measuredAscending(checks);
      const latest = await lastMeasuredCheck(ctx.db, goal.id);
      const standing = standingOf(goal, checks, latest, ctx.timezone);
      const value = latest?.value ?? null;
      const projected = projection(
        goal,
        measured.map((check) => ({ at: check.at, value: check.value as number })),
      );
      const pace = value === null ? null : paceNeeded(goal, value, ctx.now());

      const findings = await goalFindings(ctx, goal.id);

      return {
        id: goal.id,
        title: goal.title,
        holder: `@${goal.agentId}`,
        agentId: goal.agentId,
        metric: goal.metric,
        state: goal.state,
        standing: standing.word,
        standingTone: standing.onTrack ? 'good' : standing.offTrackTwice ? 'critical' : 'neutral',
        sub: goalSub(goal, unit, direction, latest, standing, ctx.now()),
        closedNote: goal.closedNote,
        baseline: `${formatValue(goal.baseline.value, unit, currency)} on ${localDateString(
          goal.baseline.asOf,
          ctx.timezone,
        )}`,
        now: formatValue(value, unit, currency),
        target: formatValue(targetValue(goal), unit, currency),
        pace: pace === null ? 'no time left' : formatPace(pace, unit, direction, currency),
        projection: projected === null ? 'not enough checks yet' : formatValue(projected, unit, currency),
        deadline: localDateString(goal.deadline, ctx.timezone),
        cadence: goal.cadence,
        checks: [...checks]
          .sort((a, b) => b.at.getTime() - a.at.getTime())
          .map((check) => ({
            key: check.id,
            at: check.at.toISOString(),
            // What the number was true *of*, when that is not the day buddi
            // looked: a bank reading Friday's statement on Monday.
            asOf: check.asOf === null ? '' : localDateString(check.asOf, ctx.timezone),
            value: formatValue(check.value, unit, currency ?? check.currency),
            onTrack: check.onTrack === null ? 'no projection' : check.onTrack ? 'on track' : 'off track',
            onTrackTone: check.onTrack === null ? 'neutral' : check.onTrack ? 'good' : 'critical',
            note: check.note ?? '',
          })),
        milestones: goal.milestones.map((milestone) => {
          const at = milestoneValue(goal, milestone);
          const crossedAt = crossingOf(measured, direction, at);
          return {
            key: String(milestone),
            label: formatValue(at, unit, currency),
            crossed: crossedAt === null ? 'not yet' : `crossed ${localDateString(crossedAt, ctx.timezone)}`,
            crossedTone: crossedAt === null ? 'neutral' : 'good',
          };
        }),
        findings,
      };
    },
  };

  return [goals, one];
}

/**
 * The first measured check at or past a milestone, or null.
 *
 * "Crossed" is on the metric's axis, not the clock's — the same rule the
 * sentinel's `milestonesCrossed` follows — and what is wanted here is *when*,
 * so it is the earliest such check rather than whether the latest one is past.
 */
function crossingOf(
  ascending: readonly GoalCheck[],
  direction: MetricDirection,
  at: number,
): Date | null {
  for (const check of ascending) {
    const value = check.value as number;
    if (direction === 'down' ? value <= at : value >= at) return check.at;
  }
  return null;
}

/** What the watcher has said about this goal, newest first. */
async function goalFindings(
  ctx: ToolContext,
  goalId: string,
): Promise<Array<Record<string, string>>> {
  /*
   * Keyed by the goal, because that is how the sentinel keys them:
   * `goal.<id>.<event>`. The prefix is parameterised rather than interpolated
   * — the id comes off a route — and `like` is the only way to ask "every
   * event under this goal" of a column that holds one string.
   */
  const { rows } = await ctx.db.query(
    `select key, severity, title, detail, first_seen_at, last_seen_at, resolved_at
       from core.sentinel_findings
      where key like $1
      order by last_seen_at desc, key
      limit 20`,
    [`goal.${goalId}.%`],
  );
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    key: String(row.key),
    severity: String(row.severity),
    title: String(row.title),
    detail: String(row.detail ?? ''),
    state: row.resolved_at === null ? 'open' : 'resolved',
    tone: row.resolved_at !== null ? 'neutral' : row.severity === 'urgent' ? 'critical' : 'good',
    when: localDateString(new Date(String(row.last_seen_at)), ctx.timezone),
  }));
}

/* ------------------------------------------------------------------ *
 * The one write
 * ------------------------------------------------------------------ */

const ownerCloseInput = z
  .object({
    id: z.string().min(1).describe('The goal id.'),
    note: z.string().min(1).max(500).describe('Why it is ending, and where it got to.'),
  })
  .strict();

/**
 * Close a goal from the page, as the owner.
 *
 * The same store call `goal.close` makes, and deliberately **without** the
 * holder check: `goal.close` refuses a non-holder because one agent may not
 * end another's goal, and the owner is not an agent — a goal exists because
 * they approved it, and stopping one is theirs to do on any screen. It is
 * `ownerOnly`, so no model is ever shown it and `invoke` says "unknown tool"
 * to anybody but the owner's own path.
 */
export function createGoalOwnerClose(): ToolDefinition<z.infer<typeof ownerCloseInput>, unknown> {
  return {
    name: 'goal.owner_close',
    description:
      'Close a goal with a note, from the Goals page. The owner is asking, so there is no holder check; a ' +
      'goal buddi already settled as met or missed keeps that word and gains the note.',
    tier: 'auto',
    ownerOnly: true,
    input: ownerCloseInput,
    async execute(input, ctx) {
      const goal = await getGoal(ctx.db, input.id).catch(() => null);
      // A throw here is the act route's 400 carrying this sentence, which is
      // what the owner reads. Neither of these is a defect.
      if (goal === null) throw new Error('No goal here has that id.');
      const closed = await closeGoal(ctx.db, goal.id, input.note.trim(), ctx.now());
      if (closed === null) {
        throw new Error(
          `"${goal.title}" was already closed on ${localDateString(goal.closedAt ?? goal.updatedAt, ctx.timezone)}.`,
        );
      }
      return { note: `Closed "${closed.title}", and it stays ${closed.state}.` };
    },
  };
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

/**
 * The Goals page: every goal on the left, one goal's whole history on the
 * right, and the one thing the owner can do about it.
 *
 * A rail page, so it introduces no new *place* — docs/plugins.md §2.5a is
 * unchanged, and `plugin-places.test.ts` still passes. Route:
 * `#/p/goal/goals`, and `#/p/goal/goals/<id>` for one goal, which is the
 * engine's own rule for a routed list-detail.
 */
export const goalsPage: PageDescriptor = {
  id: 'goals',
  title: 'Goals',
  place: 'rail',
  icon: 'chart',
  order: 20,
  body: [
    {
      kind: 'notice',
      text:
        'Everything buddi is keeping to a number and a date. Each goal is held by one agent, which is who ' +
        'buddi wakes when it drifts; the numbers below are the checks as they were taken, never a fresh ' +
        'measurement made because you opened this page.',
    },
    {
      kind: 'section',
      title: 'Goals',
      body: [
        {
          kind: 'list-detail',
          param: GOAL,
          list: {
            kind: 'list',
            query: { query: 'goals' },
            rows: 'goals',
            key: 'id',
            groupBy: { key: 'group', labels: { open: 'Open', done: 'Finished' } },
            item: {
              title: { path: 'title' },
              sub: { path: 'sub' },
              meta: [{ path: 'value' }, { path: 'holder' }],
              pill: { value: { path: 'state' }, tone: { path: 'tone' } },
              to: { page: 'goals', item: { path: 'id' } },
            },
            empty: 'No goals yet. An agent proposes one and you approve it; buddi keeps it from there.',
          },
          detail: [
            /*
             * The parts of a goal are siblings rather than one nested tree, for
             * the reason the Mail page's are: a descriptor may be twelve
             * components deep and nothing here needs to spend that depth.
             */
            {
              kind: 'stats',
              title: 'Where it stands',
              query: goalRef(),
              items: [
                { label: 'Baseline', value: { path: 'baseline' } },
                { label: 'Now', value: { path: 'now' } },
                { label: 'Target', value: { path: 'target' } },
                { label: 'Pace needed', value: { path: 'pace' } },
                { label: 'At this pace', value: { path: 'projection' } },
                { label: 'Deadline', value: { path: 'deadline' } },
                { label: 'Held by', value: { path: 'holder' } },
              ],
            },
            {
              /*
               * The way across to whoever holds it. It sits in a `detail` and
               * not beside the stats because a link's `chat` is a path, and a
               * component is handed the data of the nearest query *above* it —
               * inside a list-detail's detail that is the page's own, which is
               * nothing. The detail is what puts the goal in front of it.
               */
              kind: 'detail',
              title: 'The holder',
              note: 'A goal belongs to one agent: the one buddi wakes about it, and the one to ask.',
              query: goalRef(),
              fields: [{ label: 'Measured by', value: { path: 'metric' } }],
              body: [
                { kind: 'link', label: "Open the holder's chat", to: { chat: { path: 'agentId' } } },
              ],
            },
            {
              kind: 'table',
              title: 'Checks',
              note: 'What buddi measured, newest first. A row with no number is a look that failed, and its note says why.',
              query: goalRef(),
              rows: 'checks',
              columns: [
                { key: 'at', label: 'Checked', type: 'date' },
                { key: 'value', label: 'Value' },
                { key: 'onTrack', label: 'Verdict', pill: { tone: { path: 'onTrackTone' } } },
                { key: 'asOf', label: 'Reading as of' },
                { key: 'note', label: 'Note' },
              ],
              empty: 'Nothing has been measured yet.',
            },
            {
              kind: 'list',
              title: 'Milestones',
              note: 'Each one is heard about once, when it is crossed.',
              query: goalRef(),
              rows: 'milestones',
              key: 'key',
              item: {
                title: { path: 'label' },
                pill: { value: { path: 'crossed' }, tone: { path: 'crossedTone' } },
              },
              empty: 'This goal has no milestones.',
            },
            {
              kind: 'list',
              title: 'What the watcher has said',
              note: 'The findings the `core.goals` watcher raised about this goal. An open one is still true.',
              query: goalRef(),
              rows: 'findings',
              key: 'key',
              item: {
                title: { path: 'title' },
                sub: { path: 'detail' },
                meta: [{ path: 'when' }],
                pills: [
                  { value: { path: 'severity' }, tone: { path: 'tone' } },
                  { value: { path: 'state' }, tone: 'neutral' },
                ],
              },
              empty: 'The watcher has had nothing to say about this one.',
            },
            {
              kind: 'form',
              title: 'Close it',
              note: 'Closing needs no approval — it is your goal. A goal already settled as met or missed keeps that word and gains your note.',
              drawer: { title: 'Close this goal', button: 'Close it' },
              fields: [
                {
                  name: 'note',
                  label: 'Note',
                  type: 'textarea',
                  required: true,
                  hint: 'One or two sentences for the record: why it is ending, and where it got to.',
                },
              ],
              submit: {
                tool: 'goal.owner_close',
                label: 'Close the goal',
                tone: 'danger',
                busy: 'Closing…',
                done: { path: 'note' },
                confirm: 'Close this goal? buddi stops checking it and stops waking its holder about it.',
                then: 'close',
                args: { id: { param: GOAL }, note: { field: 'note' } },
              },
            },
          ],
          empty: 'Choose a goal to read its history here.',
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ *
 * The canvas
 * ------------------------------------------------------------------ */

/**
 * `goal.status` on the canvas: the checks as a line, the target as a rule,
 * the milestones and the deadline as events beside it.
 *
 * §7 asks for "`keyvalue` plus a `timeseries`", and the canvas cannot do both:
 * a renderable is keyed by its tool (`renderablesFrom` builds one `byTool`
 * map), so a tool has exactly one descriptor. The timeseries is the one that
 * says something the chat does not — the figures are already in `goal.status`'s
 * own prose — so that is what this is, and the deviation is written down in
 * the spec rather than worked around.
 *
 * `unit` is `number` and not `currency` because a descriptor is one mapping
 * for every goal in the installation, and the unit belongs to the *metric*: a
 * chart declared `currency` draws an unread-mail count in dollars (the web's
 * money formatter falls back to USD when no code is given). The goal's own
 * currency is in `chart.label`, already formatted by the process that knows it.
 */
export const goalViews: ViewDescriptor[] = [
  {
    tool: 'goal.status',
    renderer: 'timeseries',
    title: 'Goal',
    map: {
      points: 'chart.points',
      x: 'at',
      y: 'value',
      unit: 'number',
      label: { path: 'chart.label' },
      referenceLines: [{ value: { path: 'chart.target' }, label: 'Target', tone: 'good' }],
      events: { path: 'chart.events', at: 'at', label: 'label' },
    },
  },
];

/** One point of the chart. */
export interface ChartPoint {
  at: string;
  value: number;
}

/**
 * What the timeseries descriptor maps: present on `goal.status` **only when
 * the result is a single goal**.
 *
 * A chart of "all of your goals" is several axes on one line, so with no id —
 * or with more than one goal in the answer — there is no `chart` key, the
 * points resolve to none, and the tab sits quietly instead of drawing the
 * first goal's history under the title of all of them.
 */
export interface GoalChart {
  /** Already formatted, in the goal's own currency: the chart's one caption. */
  label: string;
  target: number;
  points: ChartPoint[];
  events: Array<{ at: string; label: string }>;
}

/**
 * The chart for one goal, from the checks `goal.status` already read.
 *
 * Every milestone that has been crossed within those checks is an event on the
 * day it was crossed, and the deadline is an event too: "where this has to be,
 * and when" is the whole question, and a chart that drew only the line would
 * make the owner work it out.
 */
export function chartOf(
  goal: Goal,
  unit: MetricUnit,
  direction: MetricDirection,
  checks: readonly GoalCheck[],
  timezone: string,
): GoalChart {
  const ascending = measuredAscending(checks);
  const events: Array<{ at: string; label: string }> = [];
  for (const milestone of goal.milestones) {
    const at = milestoneValue(goal, milestone);
    const crossedAt = crossingOf(ascending, direction, at);
    if (crossedAt !== null) {
      events.push({ at: crossedAt.toISOString(), label: `${formatValue(at, unit, goal.currency)} crossed` });
    }
  }
  events.push({ at: goal.deadline.toISOString(), label: 'Deadline' });
  return {
    label:
      `${goal.title} — ${formatValue(targetValue(goal), unit, goal.currency)} by ` +
      `${localDateString(goal.deadline, timezone)}`,
    target: targetValue(goal),
    points: ascending.map((check) => ({ at: check.at.toISOString(), value: check.value as number })),
    events,
  };
}
