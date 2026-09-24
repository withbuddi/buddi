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
  MAX_OPEN_GOALS,
  QueryRefusal,
  STANDING_CHECKS,
  closeGoal,
  getGoal,
  listGoals,
  localDateString,
  measuredChecks,
  milestoneValue,
  recentChecks,
  standingChecks,
  standingOf,
  targetValue,
  type Goal,
  type GoalCheck,
  type GoalStanding,
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
import { GOALS_SENTINEL_ID, formatPace, formatValue, goalKeyPrefix } from './goals-format.js';

/** The page parameter the chosen goal's id is bound to: `#/p/goal/goals/<id>`. */
const GOAL = 'goal';

/**
 * The caps every read on this page carries, in one place, because they are
 * promises the spec repeats: a screen is bounded or it is a way to ask the
 * database for everything.
 *
 *  - `MAX_GOALS_LISTED` — the whole list, open and finished. A hundred over
 *    the twelve-open budget is a lot of history.
 *  - `PAGE_CHECKS` — the rows in the Checks table. Enough to see the shape.
 *  - `CHART_CHECKS` — what the milestones and the chart are read over: the
 *    goal's *history*, because "crossed" and "when" are facts about all of it
 *    and not about whatever a table happened to fetch.
 *  - `MAX_FINDINGS` — what the watcher has said.
 */
export const MAX_GOALS_LISTED = 200;
export const PAGE_CHECKS = 24;
export const CHART_CHECKS = 500;
export const MAX_FINDINGS = 20;

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
 * The words for one arithmetic
 *
 * The arithmetic itself is core's `standingOf` (packages/core/src/goals/
 * standing.ts), which the sentinel, `goal.status`, Home and both queries here
 * all call over the same `STANDING_CHECKS` measured rows. What is left in this
 * file is *wording*: turning one `GoalStanding` into the sentence a row shows
 * and the tone it shows it in, so that every surface says the same thing in
 * the same words as well as in the same numbers.
 * ------------------------------------------------------------------ */

/**
 * Where a goal stands, in the owner's words.
 *
 * `lastLookFailed` is the one thing a standing does not know and a screen has
 * to: the newest *row* carried no number while the newest *number* is days
 * old. That is not "off track" and it is not a verdict at all — it is news
 * about the plugin, and the sentence names the day the number is from, which
 * is the question the owner actually has.
 */
export function standingWord(
  goal: Goal,
  standing: GoalStanding,
  lastLookFailed: boolean,
  timezone: string,
): string {
  if (standing.latest === null) {
    return `not measured since ${localDateString(goal.baseline.asOf, timezone)}`;
  }
  if (lastLookFailed) {
    return `not measured since ${localDateString(standing.latest.at, timezone)}`;
  }
  switch (standing.verdict) {
    case 'on-track':
      return 'on track';
    case 'off-track':
      return 'off track';
    default:
      // Fewer than two measured points is no projection, and no projection is
      // not "off track". A goal in its first week must not read as failing.
      return 'no projection yet';
  }
}

/**
 * The tone a row carries: `good` while it is landing, `critical` only when it
 * has missed twice running — the same threshold the sentinel interrupts at.
 */
export function standingTone(
  standing: GoalStanding,
  lastLookFailed: boolean,
): 'good' | 'critical' | 'neutral' {
  if (lastLookFailed || standing.latest === null) return 'neutral';
  if (standing.verdict === 'on-track') return 'good';
  return standing.offTrackRuns >= 2 ? 'critical' : 'neutral';
}

/**
 * "progress 62% · pace $1,540 a week down · on track" — the line under a goal.
 *
 * The three parts §7 asks for, and each one is left out rather than guessed:
 * a goal with no number has no progress and no pace, and a deadline already
 * past has no per-week left.
 */
export function goalSub(
  goal: Goal,
  unit: MetricUnit,
  direction: MetricDirection,
  standing: GoalStanding,
  lastLookFailed: boolean,
  timezone: string,
): string {
  const parts: string[] = [];
  if (standing.progress !== null) parts.push(`progress ${Math.round(standing.progress * 100)}%`);
  if (standing.paceNeeded !== null) {
    parts.push(`pace ${formatPace(standing.paceNeeded, unit, direction, goal.currency)}`);
  }
  parts.push(standingWord(goal, standing, lastLookFailed, timezone));
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
      const goals = await listGoals(ctx.db, { openOnly: true, limit: MAX_OPEN_GOALS });
      if (goals.length === 0) return null;
      const now = ctx.now();
      // One statement for every goal's checks, not two per goal: Home draws
      // every open goal, and a round trip each was a dozen on every load.
      const byGoal = await standingChecks(ctx.db, goals.map((goal) => goal.id), STANDING_CHECKS);
      const rows: HomeRow[] = [];
      let offTrack = 0;
      for (const goal of goals) {
        const unit = source.metric(goal.metric)?.unit ?? 'number';
        const direction = source.metric(goal.metric)?.direction ?? 'down';
        const { measured, lastLookFailed } = byGoal.get(goal.id) ?? { measured: [], lastLookFailed: false };
        const standing = standingOf(goal, direction, measured, now);
        const tone = standingTone(standing, lastLookFailed);
        if (!lastLookFailed && standing.verdict === 'off-track') offTrack += 1;
        rows.push({
          title: goal.title,
          sub: goalSub(goal, unit, direction, standing, lastLookFailed, ctx.timezone),
          side: formatValue(standing.latest?.value ?? null, unit, goal.currency),
          // Good when it is going to land; loud only when it has missed twice
          // running, which is the one thing the sentinel interrupts for.
          ...(tone === 'neutral' ? {} : { tone }),
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
  /**
   * `standingOf`'s own word, unformatted.
   *
   * Not drawn — `sub` carries the sentence — but on the row so that "the page
   * and the chat give the same verdict" is a thing a test can assert rather
   * than a thing two strings are compared for.
   */
  verdict: GoalStanding['verdict'];
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
      const all = await listGoals(ctx.db, { limit: MAX_GOALS_LISTED });
      const now = ctx.now();
      // One statement for every goal's checks, not two per goal: this list is
      // every goal there has ever been, and a pair of round trips each was
      // four hundred of them to paint one screen.
      const byGoal = await standingChecks(ctx.db, all.map((goal) => goal.id), STANDING_CHECKS);
      const rows: GoalListRow[] = [];
      for (const goal of all) {
        const unit = unitOf(goal.metric);
        const direction = directionOf(goal.metric);
        const { measured, lastLookFailed } = byGoal.get(goal.id) ?? { measured: [], lastLookFailed: false };
        const standing = standingOf(goal, direction, measured, now);
        rows.push({
          id: goal.id,
          title: goal.title,
          sub: goalSub(goal, unit, direction, standing, lastLookFailed, ctx.timezone),
          value: formatValue(standing.latest?.value ?? null, unit, goal.currency),
          group: goal.state === 'open' ? 'open' : 'done',
          state: goal.state,
          verdict: standing.verdict,
          // A finished goal is toned by the word buddi settled on; a running
          // one by where it stands, exactly as Home tones it.
          tone:
            goal.state === 'met'
              ? 'good'
              : goal.state === 'missed'
                ? 'critical'
                : goal.state !== 'open'
                  ? 'neutral'
                  : standingTone(standing, lastLookFailed),
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
      /*
       * Three reads, and each answers a different question. The **history** is
       * what the milestones are dated from — "crossed in week two" has to stay
       * true in week twenty-seven, and a window would quietly forget it. The
       * newest `PAGE_CHECKS` of that history are what the table prints. And
       * the standing is `STANDING_CHECKS` *measured* rows, the same window
       * Home, the list and `goal.status` use, so no two of them can give this
       * goal different arithmetic.
       */
      const history = await recentChecks(ctx.db, goal.id, CHART_CHECKS);
      const ascending = [...history]
        .filter((check) => check.value !== null)
        .sort((a, b) => a.at.getTime() - b.at.getTime());
      const standing = standingOf(
        goal,
        direction,
        await measuredChecks(ctx.db, goal.id, STANDING_CHECKS),
        ctx.now(),
      );
      const lastLookFailed = history[0] !== undefined && history[0].value === null;
      const checks = history.slice(0, PAGE_CHECKS);
      const value = standing.latest?.value ?? null;
      const projected = standing.projected;
      const pace = standing.paceNeeded;

      const findings = await goalFindings(ctx, goal.id);

      return {
        id: goal.id,
        title: goal.title,
        holder: `@${goal.agentId}`,
        agentId: goal.agentId,
        metric: goal.metric,
        state: goal.state,
        standing: standingWord(goal, standing, lastLookFailed, ctx.timezone),
        // `standingOf`'s own word, the one `goal.status` returns. See GoalListRow.
        verdict: standing.verdict,
        standingTone: standingTone(standing, lastLookFailed),
        sub: goalSub(goal, unit, direction, standing, lastLookFailed, ctx.timezone),
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
        checksShown: checks.length,
        checksNote:
          history.length > PAGE_CHECKS
            ? `The newest ${PAGE_CHECKS} of ${history.length}, newest first.`
            : 'Newest first.',
        checks: checks.map((check) => ({
          key: check.id,
          at: check.at.toISOString(),
          // What the number was true *of*, when that is not the day buddi
          // looked: a bank reading Friday's statement on Monday.
          asOf: check.asOf === null ? '' : localDateString(check.asOf, ctx.timezone),
          // The goal's own currency, never the row's: a reading taken while
          // the metric answered no code must not print a different unit two
          // components under the stats, which use the goal's.
          value: formatValue(check.value, unit, currency),
          onTrack: check.onTrack === null ? 'no projection' : check.onTrack ? 'on track' : 'off track',
          onTrackTone: check.onTrack === null ? 'neutral' : check.onTrack ? 'good' : 'critical',
          note: check.note ?? '',
        })),
        /*
         * Crossed or not is `standingOf`'s answer — read off the goal's
         * current number, so it stays true however long ago it happened — and
         * the *date* is the first check past it in the history above. A
         * crossing older than the history reads "crossed", with no date,
         * rather than the page contradicting its own findings list.
         */
        milestones: goal.milestones.map((milestone) => {
          const at = milestoneValue(goal, milestone);
          const crossed = standing.milestonesCrossed.includes(milestone);
          const crossedAt = crossed ? crossingOf(ascending, direction, at) : null;
          return {
            key: String(milestone),
            label: formatValue(at, unit, currency),
            crossed: !crossed
              ? 'not yet'
              : crossedAt === null
                ? 'crossed'
                : `crossed ${localDateString(crossedAt, ctx.timezone)}`,
            crossedTone: crossed ? 'good' : 'neutral',
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
   *
   * And scoped to the watcher that writes them. A finding key is free-form
   * text each plugin chooses, and the keys share one namespace: without this
   * predicate, any other sentinel that wrote `goal.<some-uuid>.…` would have
   * its title and detail shown on this page as something the `core.goals`
   * watcher said. The section names that watcher, so the query has to mean it.
   */
  const { rows } = await ctx.db.query(
    `select key, severity, title, detail, first_seen_at, last_seen_at, resolved_at
       from core.sentinel_findings
      where sentinel_id = $2 and key like $1
      order by last_seen_at desc, key
      limit $3`,
    [goalKeyPrefix(goalId), GOALS_SENTINEL_ID, MAX_FINDINGS],
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
    /*
     * Trimmed *before* the length is checked, so three spaces is not a note.
     * The form marks it required and the record says the note is why the goal
     * ended; a required field the schema lets through empty is a promise the
     * row cannot keep.
     */
    note: z.string().trim().min(1).max(500).describe('Why it is ending, and where it got to.'),
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
      // Already trimmed by the schema, which is where an empty note is refused.
      const closed = await closeGoal(ctx.db, goal.id, input.note, ctx.now());
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
      // The page's intro, one line under the title. The numbers are the checks
      // as they were taken, never a fresh measurement made because the page opened.
      text: 'Everything buddi is keeping to a number and a date, as its last checks found it.',
    },
    {
      kind: 'section',
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
              pill: {
                value: { path: 'state' },
                tone: { path: 'tone' },
                labels: { open: 'Open', met: 'Met', missed: 'Missed', closed: 'Closed' },
              },
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
              note:
                `What buddi measured, the newest ${PAGE_CHECKS} first. A row with no number is a look ` +
                'that failed, and its note says why.',
              query: goalRef(),
              rows: 'checks',
              columns: [
                { key: 'at', label: 'Checked', type: 'date' },
                { key: 'value', label: 'Value' },
                {
                  key: 'onTrack',
                  label: 'Verdict',
                  pill: {
                    tone: { path: 'onTrackTone' },
                    labels: { 'on track': 'On track', 'off track': 'Off track', 'no projection': 'No projection' },
                  },
                },
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
                  { value: { path: 'severity' }, tone: { path: 'tone' }, labels: { urgent: 'Urgent', info: 'Info' } },
                  { value: { path: 'state' }, tone: 'neutral', labels: { open: 'Open', resolved: 'Resolved' } },
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
 * What the timeseries descriptor maps: present on `goal.status` **whenever the
 * answer holds exactly one goal** — with an id, or because the agent happens
 * to hold one.
 *
 * A chart of "all of your goals" is several axes on one line, so with more
 * than one goal in the answer there is no `chart` key and the points resolve
 * to none. The tab is still there — a declared view keeps its tab even when it
 * came back empty (`renderablesFrom`) — but it is marked unsubstantial, so it
 * never takes focus, and it says it has nothing to draw rather than drawing
 * the first goal's history under the title of all of them.
 */
export interface GoalChart {
  /** Already formatted, in the goal's own currency: the chart's one caption. */
  label: string;
  target: number;
  points: ChartPoint[];
  events: Array<{ at: string; label: string }>;
}

/**
 * The chart for one goal, over its **history** — `CHART_CHECKS` rows, oldest
 * first, not the four the tool prints.
 *
 * A six-month weekly goal drawn from the last four looks is four dots, and a
 * milestone crossed in week two would have no event on it by week twenty-seven
 * — which is exactly what a chart of a goal is for. Every crossed milestone is
 * an event on the day it was crossed, and the deadline is an event too:
 * "where this has to be, and when" is the whole question, and a chart that
 * drew only the line would make the owner work it out.
 */
export function chartOf(
  goal: Goal,
  unit: MetricUnit,
  direction: MetricDirection,
  checks: readonly GoalCheck[],
  timezone: string,
): GoalChart {
  const ascending = [...checks]
    .filter((check) => check.value !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
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
