---
title: "Goals: a target with a clock, that buddi keeps"
status: reference
updated: 2026-09-26
---

# Goals: a target with a clock, that buddi keeps

A core feature, agent-neutral: any agent with a metric can hold a goal. The
metrics come from plugins: finance declares `finance.total_debt`,
`finance.card_balance` and `finance.cash_available`; email
`email.waiting_on_me` and `email.inbox_unread`; developer
`developer.failing_tests`. None of them knows about goals. A number no plugin
measures — a weight, a time, how often the owner runs — is a metric the owner
reports (§3a), kept by core.

## 1. Why

"Help me cut my debt by 40k in six months", "inbox zero by Friday", "the
test suite green before the release", "run three times a week". An
agent can write the plan and set a few one-shot reminders (`reminder.set`),
and plugins ship missions on fixed cadences. Without goals nothing measures
progress, nothing knows the pace needed, and nothing wakes the agent when the
owner drifts. The plan lives in one conversation and dies with it.

A goal is that object: a target, a deadline, a way to measure, an
owner agent, and a rhythm of checks that buddi runs whether or not anyone is
talking to it.

## 2. Principles

- **Agent-neutral, plugin-fed.** Goals are core. What can be measured comes
  from plugins as **metrics**, a contribution the same shape as `home`
  blocks: a named read-only function that answers a number. Core never knows
  the word "debt".
- **The check is deterministic; the voice is the agent's.** Core computes
  progress and pace on a schedule and raises a finding, exactly like a
  watcher. The owning agent is woken to verify, then to speak. No model call
  happens in the check itself.
- **Setting a goal is an approval.** A goal changes what buddi will do on its
  own for months, so `goal.set` is gated and the card shows the whole shape:
  target, deadline, metric, cadence, who holds it. Changing it is a card too;
  closing it is not.
- **A goal has one home.** It belongs to one agent and shows in that agent's
  chat, on Home, and on a Goals page; a different agent can read it, never
  hold it.
- **Bounded.** At most 12 open goals per installation, one check per goal per
  day at most, findings resolve when the fact stops being true.

## 3. Metrics: what a plugin contributes

```ts
export interface PluginManifest {
  // …
  metrics?: MetricDefinition[];
}

export interface MetricDefinition {
  /** Namespaced, stable: `finance.total_debt`, `email.inbox_unread`, `developer.failing_tests`. */
  id: string;
  /** A sentence: "Everything you owe across cards and loans, in your currency." */
  description: string;
  unit: 'number' | 'currency' | 'percent' | 'count' | 'minutes';
  /** Which way is better. A goal's target is checked against this. */
  direction: 'down' | 'up';
  /** Optional narrowing, validated: `{ account?: string }`. Strict object, like page queries. */
  params?: z.ZodObject<any>;
  /** Read-only, under the same read-only pool as a page query. Answers the value now. */
  measure(params: unknown, ctx: ToolContext): Promise<{ value: number; currency?: string; asOf: Date; note?: string } | null>;
}
```

`null` means "cannot measure right now" (no data yet, plugin missing); the
check records it and the goal shows "not measured since …" rather than a
made-up number. The registry validates metrics at `register()`, exposes
`metrics()`, and lists them to agents through `goal.metrics` so an agent can
name one when it proposes a goal.

## 3a. Metrics the owner reports

A metric is a named series with a source. A plugin is one source; the owner is
the other. "288 pounds to 220 by the end of the year" has no plugin behind it:
the owner is the sensor. Sources, in priority order: a plugin (if finance
measures debt, buddi never asks the owner to type it), then the owner. A
connection (a scale, Strava) will be plugin-shaped when it comes.

**The definition.** `goal.set` accepts `metric: { owner: { slug, label, unit,
direction, unitLabel? } }` in place of a metric id. The goal's `metric` is
`owner.<slug>`. The slug is kebab (`weight`, `resting-heart-rate`), at most 40
characters, unique per installation. `unit` is the same enum a plugin metric
uses; `unitLabel` is a free word printed after the number (`lb`, `kg`, `km`),
so weight does not grow the enum. A definition naming a slug that exists must
agree with it on unit, unit label and direction, or the call is refused before
a card: two goals reading one series in opposite directions is a
contradiction.

**The tables** (migration 044):

```sql
core.owner_metrics (slug primary key, label, unit, unit_label, direction, created_at)
core.owner_metric_values (id, slug → owner_metrics, at, as_of, value, note,
                          source: 'chat' | 'telegram' | 'api', conversation_id)
```

`at` is when buddi wrote the value down; `as_of` is when it was true ("285
this morning", said at noon). Values are appended and never rewritten: a
correction is a newer value. `source` is the surface the run answered on —
`chat` for the dashboard and the terminal, `telegram`, and `api` for anything
else, including the executor that runs an approved `goal.set`.

**Creation.** The definition and the first value are written by `goal.set`'s
`execute`, after `createGoal` succeeded: a card is not a goal, and a goal the
budget refused leaves nothing behind.

**The baseline.** `goal.set` with an owner metric takes `baseline: { value }`
from the sentence that set it ("I'm 288"), so the goal starts measured; that
value is also the metric's first value. With no baseline, the metric's newest
value is measured like any metric; a new metric with no baseline is refused
("ask the owner where they are today"). A plugin metric refuses `baseline`: it
is measured.

**Measure.** `ownerMetricSource(registry)` (`packages/core/src/goals/owner.ts`)
answers the plugin metrics and every owner metric behind one `metric(id)`, so
every goal surface keeps asking one question. Owner metrics live in a table
and `metric()` is synchronous, so the source keeps a cache that each entry
point — every tool, the watcher, Home, both page queries — refreshes with one
`select`. An owner metric's `measure()` returns the newest value with its
`as_of`, or `null` when there is none or it is older than two of the goal's
cadences (the goal passes `cadence` as the metric's one parameter; weekly when
absent). An id under `owner.` is always the owner's: a plugin cannot shadow
one.

**The sane band.** `goal.record` refuses a value more than 50 % away from the
last one, or on the other side of zero, with a sentence asking the agent to
confirm with the owner; it is kept only when the call is repeated with
`confirmed: true`. A last value of zero has no percentage, so only the sign
rule applies to it. A typo ("28.5" for 285) must not become the number a goal
is judged by.

## 4. The goal

```ts
interface Goal {
  id: string;
  title: string;                 // "Debt down by 40k"
  agentId: string;               // holder
  metric: string;                // 'finance.total_debt'
  params: Record<string, unknown>;
  /** An absolute target, a delta from the baseline, or a count per window (§4a). */
  target:
    | { kind: 'absolute'; value: number }
    | { kind: 'delta'; value: number }
    | { kind: 'frequency'; count: number; per: 'week' | 'month' };
  baseline: { value: number; asOf: Date };   // measured when the goal is set
  deadline: Date;
  /** How often core checks. Daily is the floor. */
  cadence: 'daily' | 'weekly';
  /** Milestones the agent proposed; each fires once when crossed. */
  milestones: number[];
  createdAt: Date; updatedAt: Date;
  state: 'open' | 'met' | 'missed' | 'closed';
  closedAt: Date | null; closedNote: string | null;
}
```

Tables in core: `core.goals`, `core.goal_checks (goal_id, at, value, note,
onTrack boolean, paceNeeded numeric, projected numeric)`, migration 037.

`core.goals` also carries `currency`, taken from the first reading:
a card rendering a target or a milestone has no check in its hand, and a euro
debt shown in dollars is worse than a bare number, which is what a currency
metric with no currency prints. A check carries `currency` too, and `as_of` —
what the metric said its number was true *of*, which for a bank reading
Friday's statement is not the day buddi looked. `updated_at` is the goal's
*version*: `goal.update` carries the one its card was drawn from into the
UPDATE's WHERE clause, so the column is `timestamptz(3)` — a version has to
survive a round trip through JavaScript, whose Date stops at milliseconds.

`milestones` are on the target's own scale: deltas when the target is a delta
(which is how §8 writes them), absolutes when it is absolute. `goal.set` and
`goal.update` refuse a target that is not on the improving side of the
baseline for the metric's `direction`, and milestones that do not lie strictly
between the two in the order they will be crossed — without that, a sign slip
in one field of a model's JSON makes a goal the first tick settles `met`.

The 12-goal budget is a count in the INSERT's own WHERE clause taken under
`pg_advisory_xact_lock`. The count alone is not a limit: under READ COMMITTED
two racing statements both see eleven and both commit, and a thirteenth goal
is one the sentinel never even walks.

## 4a. Frequency goals

"Run three times a week" is a second target shape on the same series:
`target: { kind: 'frequency', count, per: 'week' | 'month' }`, stored as
`target_kind = 'frequency'`, `target_value = count` and `target_per`
(migration 045; a level goal's `target_per` is null, a frequency goal's never
is). A value is one occurrence ("ran today" records 1), whatever number it
carries. A frequency goal needs an owner metric — only those have values to
count — and starts with nothing counted: its baseline is 0 and `goal.set`
refuses a `baseline`.

**Windows** are calendar weeks, Monday to Sunday, or calendar months, in the
owner's timezone, from the one the goal was set in to the one holding the
deadline. A value counts in the window its `as_of` falls in on the owner's
clock, from the day the goal was set to the deadline's day. The arithmetic is
`frequencyStandingOf` (`packages/core/src/goals/frequency.ts`), pure, over the
owner's values (at most `FREQUENCY_VALUES`, 5,000, since the goal was set).
Each window is `met` (the count reached, closed or not), `open` (the current
one, short of it so far), `short` (closed below the count) or `partial`: the
window the goal was set in and the one the deadline cuts short, when they
closed below the count. A partial window is never a gap — a goal set on a
Friday is not a week missed — and a partial window that met the count is met.

- **Pace** is occurrences so far against the current window: "2 of 3 this
  week, 1 to go by 2026-10-04".
- **Drift** is a window that closed short.
- **Milestones are streaks**: `milestones: [4, 8]` is four and eight windows
  met in a row, whole numbers listed smallest first. The streak counts closed
  windows back from the newest, skipping partial ones.
- **The deadline** settles the goal `met` when more closed windows met the
  count than fell short, `missed` otherwise. There is no early `met`.

`goal.update` keeps a goal's shape: a level goal cannot become a frequency
goal, nor the reverse, because the baseline means something different in
each. The card says "3 times a week until 2026-12-31, checked weekly, held by
@coach". "Finish X by Friday" is not a goal: it is a reminder or a mission, and
the agent should say so.

## 5. Tools

- `goal.metrics` (auto): the metrics this installation can measure, with
  units and directions, each with its `source`: `plugin` (with the plugin and
  its params) or `owner` (with its label and unit label).
- `goal.set` (gated): title, metric (+params), target, deadline, cadence,
  milestones. `describe` measures the baseline and renders the card: "From
  X today to Y by <date>: Z per week, checked weekly, held by @ledger". The
  agent proposing it must be the holder (an agent cannot give another agent
  a goal). `metric` may be an owner definition and `baseline: { value }` the
  number the owner said (§3a); `target` may be a frequency (§4a). The card
  names the source: "Measured by you, when you tell buddi" for an owner metric
  ("(a new metric, owner.weight)" when this card creates it), "Measured by
  finance.total_debt" for a plugin's.
- `goal.update` (gated): target, deadline, cadence, milestones; the card
  shows before/after.
- `goal.close` (auto): with a note; also how "met" and "missed" become final
  when the owner agrees.
- `goal.status` (auto): a goal or all of the agent's goals, with the last
  check, the pace needed and the projection. For a goal on an owner metric it
  adds `values`, the newest ten the owner told buddi; for a frequency goal
  `windows` (the newest twelve, oldest first), `streak`, and the tally as the
  value ("1 of 2 this week, 1 to go by 2026-10-11").
- `goal.list` (auto): every open goal, any holder (read).
- `goal.record` (auto): `{ goal | metric, value, asOf?, note?, confirmed? }`
  appends one value to an owner metric and answers with where each open goal
  on it stands, in one sentence: "288 to 220 by December: 285 lb now, 4% of
  the way; 4.89 lb a week down from here reaches 220 lb by 2026-12-31." It names
  the goal or the metric (`owner.weight` or `weight`), never the agent, so "285
  this morning" said to whichever agent is listening on Telegram lands on the
  weight goal. `asOf` is an ISO date or datetime in the owner's zone; a date
  later than today is refused, and today's date before nine means now. A plugin
  metric is refused: its number is measured. `confirmed` answers the sane band
  (§3a).

An agent that is not the holder gets `goal.list`, `goal.status` and
`goal.record` only: recording a number is the owner speaking, whoever relays
it.

The tools live in `packages/gateway/src/missions/goals.ts`, beside the reminder
and schedule manifests, for the same reason they do: nothing there owns a
schema, and `createGoalManifest` takes the registry because a goal watches a
metric.

A gated tool is gated on every call (the registry refuses a `tierFor`
that narrows it), so every refusal before the card — a delegate, a deadline in
the past, a metric nobody installed, a metric that cannot be measured, a target
pointed the wrong way, parameters a metric never declared — is a throw out of
`describe`, which runs before any action exists. Nothing is recorded and the
model is handed the sentence.

"The baseline the owner saw is the baseline stored" is implemented by measuring
**once**. The executor re-describes before it dispatches and refuses anything
that changed (`effect-changed`); a `describe` that measured again would put a
live number into a hashed envelope, so one mail arriving between the card and
the tap would void a perfectly good approval — fine for a debt, hopeless for
`email.inbox_unread` (a count that moves with every poll). At
re-description the approved envelope is on the context and `describe` reuses
its baseline. Everything else still re-derives, so an approval whose target,
deadline or holder changed is still refused.

The envelope's `baseline.asOf` is the description clock — when the goal was set
— and `baseline.readingAsOf` is what the metric said its number was true of.
Both are stored: the first as the goal's baseline instant, the second on the
first check row. When the reading is more than a day behind the card, the card
says "(reading as of <date>)", because the owner is approving six months of
behaviour off that number.

`goal.update`'s envelope carries the goal's `updated_at`, and the store's
UPDATE is predicated on it. The executor's re-description catches a goal that
moved before dispatch; the predicate covers the window between that check and
the write, which re-describing cannot. `goal.close` accepts `open`, `met` and
`missed` and refuses only an already-closed goal: buddi decides the word, the
holder adds the note and the date, and the word is kept — which is what "met
and missed become final when the owner agrees" means.

## 6. The check

A core sentinel `core.goals` runs hourly and, for each open goal whose
cadence is due, measures, records a `goal_checks` row and computes:

- **progress**: `(baseline − value) / (baseline − target)` for `down`,
  mirrored for `up`;
- **pace needed**: what per week from now to the deadline;
- **projection**: linear over the last four checks, where the deadline lands
  at that pace;
- **on track**: projection meets the target by the deadline.

Findings, keyed per goal and per event so each is one fact that resolves:

| Event | Severity | Wakes the holder? |
| --- | --- | --- |
| A milestone crossed | info | yes, once |
| Off track for two consecutive checks | urgent | yes, then at most once per cadence while it stays off |
| Back on track | info | no (digest) |
| Not measurable for 7 days | info | yes, once |
| Deadline in 7 days and not met | urgent | yes |
| Deadline passed | urgent | yes; the goal becomes `missed` unless met |
| Target reached | info | yes; the goal becomes `met` |

An urgent finding speaks again every 24 hours while it stays true; the off-track
one is bound to the goal's cadence instead (`Finding.cooldownMs`). The first
drift wakes the holder at once, and the same drift wakes it again at most once
a day for a daily goal and once a week for a weekly one.

The wake prompt carries the goal, the last four checks and the instruction:
verify with your own tools, then report or propose a change through
`goal.update`; never change the goal silently.

"Due" has a four-hour margin — no check in the last 20 h (daily) or
6 d 20 h (weekly) — because a strict 24 h makes a goal checked at 09:04 slip
an hour every day until a morning goal is a midnight one. The cost is that a
daily goal *can* take two checks in one calendar day, so §2's "one check per
goal per day at most" is a near-miss rather than an invariant; it is one extra
row and never a second wake, because findings dedup by key. `Finding.wake` is
the core field that makes the "yes, once" column work: an `info` finding
that wakes its agent on its first raise instead of taking a digest line. The
milestone event is keyed per milestone (`goal.<id>.milestone.<n>`), since one
key per goal could only ever fire once for the whole list — and it is returned
only on the tick where it is *newly* crossed, so it wakes once and then
resolves. A key returned for as long as the fact is true would be read out in
every weekly digest, once per cooldown, for a payment made in September.

Two more rules. The sentinel takes a check
at the deadline whatever the cadence says, when no check exists at or after it:
a weekly goal with a Thursday deadline is not due on Thursday, and settling it
`missed` off Monday's number would record a verdict about a week the goal never
had. And every verdict — off track, back on track, milestones, met, missed — is
read off *measured* checks only: a look that failed is evidence about the
plugin, not about the goal, so a timed-out metric leaves an open off-track
finding open instead of looking like a recovery. "Not measurable for 7 days" is
counted from the last check that carried a number over the whole history, not
over the last four rows, which would collapse onto the baseline the moment four
looks failed in a row.

**Owner metrics.** A cadence with nothing new said records no check:
re-recording last week's number under this week's date would draw a flat line
the owner never reported and bend the projection toward it. A new value is
checked on the first tick after it arrives once the cadence is due, so a weekly
goal takes at most one check a week however often the owner speaks; a value
older than two cadences is a check with no number ("not measured since …").
The deadline still gets its check. "Not measurable for 7 days" is not raised
for an owner metric; staleness replaces it.

**Staleness.** When a cadence passes with no value — counted from the newest
value, or from when the goal was set if that is later — the watcher raises
`goal.<id>.stale.<day>`: `info`, `wake: true`, and `notify: { urgency:
'today', dedupeKey: 'goal:<id>:stale:<day>' }`, where `<day>` is the owner's
day that cadence window began (`staleWindow`). The holder is woken once and
says one line — "You have not told me your weight this week." — which goes out
through `notifyOwner` as a `watcher` notification held for the end of the day:
never `now`, never twice in a window (the key and the dedupe key both carry
it). A value resolves the finding; the next silent window is a new key and one
more line. `Finding.notify` is the plugin contract's way to ask for this
([plugins.md](plugins.md), Finding): the mission executor carries it to
`ownerDeliver`, which otherwise sends a wake's report `now`.

**Frequency goals.** The watcher counts windows (§4a) instead of measuring. On
its cadence it records a check whose value is the current window's count, whose
note is the tally ("2 of 3 this week; 4 weeks in a row") and whose `on_track`
is the newest closed window's verdict. Three events, each said once:

| Event | Severity | Wakes the holder? |
| --- | --- | --- |
| A window closed short (`goal.<id>.short.<start>`) | info | yes, once, while it is the newest closed window |
| A streak milestone (`goal.<id>.milestone.<n>`) | info | yes, once ever: returned while the window that reached it is the newest closed one, never for another |
| Deadline passed | info (met) or urgent (missed) | yes; settled by the windows |

A frequency goal has no staleness line: a week with nothing said is a short
week, not silence.

**A known gap.** The sentinel settles `met`/`missed` in the same tick it returns
the finding, and the finding is only written after the loop. A throw later in
that loop — a failed `recordCheck` on another goal — loses the wake while the
state change is already committed, and the next tick no longer walks the goal,
so the wake is never raised. The digest still carries the fact and the goal
reads correctly everywhere it is shown; making the two atomic needs the finding
write to move inside the per-goal step, which is a change to core's
`runSentinels`; it is not made.

## 7. Where it shows

- **Home**: a "Goals" block from core: each open goal, progress, pace, on
  track or not, in the holder's words for the title only.
- **A Goals page** (core, rail): the list with progress bars, one goal's
  history (the checks as a line, the milestones, the wakes), Close with a
  note, and a link to the holder's chat. Built as a core page with the
  plugin-pages components (core is allowed what plugins are).
- **The holder's chat**: `goal.set`'s card, and `goal.status` drawn with a
  view descriptor (`keyvalue` plus a `timeseries` of the checks). For an owner
  metric the timeseries is the owner's values, as they were said, with the
  target line; for a frequency goal it is one point per window, its count,
  with the count per window as the target line.
- **Telegram**: the wakes reach it like any finding.

The first three are contributed from
`packages/gateway/src/missions/goals-page.ts` on the `goal` manifest beside the
tools — `home`, `pages`, `queries`, `views` — because a goal has no schema of
its own and this is only a surface onto core's rows. The fourth needs no code
of its own (rule 8 below); it is a test, in `goals.db.test.ts`. Nothing on any of
these surfaces measures: every number is read out of `core.goals` and
`core.goal_checks` as the sentinel left them, so opening a tab is never a
second, slower, unrecorded check.

**One arithmetic.** The verdict, the projection, the pace, the progress and the
crossings are `standingOf` (`packages/core/src/goals/standing.ts`), called by
the sentinel, `goal.status`, the Home block and both page queries over the same
`STANDING_CHECKS` (four) newest **measured** checks, read by
`measuredChecks`/`standingChecks`. Surfaces that each put `math.ts` together
over whatever rows they had fetched would disagree the moment a look failed:
with two good checks and then four failed ones, one would still have two points
and draw a projection while another had one and said there was none. The window is fixed rather than "as many as
you fetched" for exactly that reason — a surface that passed twenty-four rows
would get a different slope. "Off track" is the two newest measured checks both
recorded off; crossings are read off the newest measured *value*, so a
milestone crossed in week two still reads crossed in week twenty-seven.

**What each read is capped at**, because a screen is bounded or it is a way to
ask the database for everything: the goals list 200 (`MAX_GOALS_LISTED`), the
Checks table the newest 24 (`PAGE_CHECKS`, and its heading says so), the chart
and the milestone dates the newest 500 (`CHART_CHECKS` — the goal's history,
not a window, which is what makes a crossing datable), the findings 20
(`MAX_FINDINGS`), the standing 4 (`STANDING_CHECKS`). Home and the list read
every goal's checks in **one** statement (`standingChecks`, two lateral joins),
not a pair of round trips per goal.

Eight rules, each one a thing the engine decides rather than a choice:

1. **One descriptor per tool, so `goal.status` draws a timeseries and not
   also a `keyvalue`.** The canvas keys renderables by tool name
   (`renderablesFrom` builds one `byTool` map), so a tool has exactly one
   descriptor. The timeseries is the one that says something the chat does
   not — the figures are already in `goal.status`'s own prose.
2. **`goal.status` carries a `chart` key, present whenever the answer holds
   exactly one goal** — with an id, or because the agent happens to hold one.
   That is what the descriptor maps: `chart.points` (the measured checks of
   the goal's *history*, `CHART_CHECKS` rows, oldest first — not the four the
   tool prints, or a six-month goal would be four dots), `chart.target` as a
   reference line, and `chart.events` — every crossed milestone on the day it
   was crossed, plus the deadline. With more than one goal there is no `chart`
   and the points resolve to none. The tab is still drawn — a declared view
   keeps its tab even when it came back empty (`renderablesFrom`) — but it is
   marked unsubstantial, so it never takes focus, and it says it has nothing
   rather than drawing the first goal's history under the title of all of them.
3. **The chart's `unit` is `number`, not `currency`.** A `TimeseriesMap.unit`
   is a fixed enum, not a path, and one descriptor covers every metric in the
   installation; declaring `currency` would draw an unread-mail count in
   dollars, because the web's money formatter falls back to USD when no code
   is given. The goal's own currency is in `chart.label`, already formatted by
   the process that knows it.
4. **A page may link to one agent's chat.** `RouteRef` has
   `{ chat: ValueRef }` — an agent id read out of the data, never a URL —
   because "a link to the holder's chat" is not otherwise expressible: any
   other `RouteRef` names a page of the same plugin. The grammar, the
   browser's mirror of it and `docs/plugins.md` §2.5b all say so.
5. **The link sits inside the `detail` that names the holder**, not beside the
   stats: a component is handed the data of the nearest query *above* it, and
   inside a list-detail's detail that is the page's own, which is nothing.
6. **The Home block is `null` when no goal is open**, not only when there are
   none at all: a block exists to say something, and a met-and-closed goal is
   history, which lives on the page.
7. **The row's fourth verdict.** §7 names on track, off track and "not
   measured since"; a goal with fewer than two measured checks has no
   projection, and that is neither on track nor off it, so it reads "no
   projection yet". The row is toned `good` on track and `critical` only on
   two misses running — the same threshold the sentinel interrupts at.
8. **Telegram parity needs no code of its own.** A goal finding already becomes a
   pending `sentinel-wake` occurrence carrying the finding as its payload; the
   mission executor reads it with `findingOf`, runs it **as the goal's
   holder** (a finding's own `agentId` overrides the mission's), and appends
   `renderFinding`'s fenced block to the prompt. What the holder then says
   with `mission.report` goes wherever its surface sends it. The test is
   `goals.db.test.ts`, "reaches Telegram the way any finding does".

**Goals the owner measures, on the page.** A goal on an owner metric adds
"What you told buddi", a table of its values (newest `PAGE_CHECKS` first: true
of, value, where it was said, note). A frequency goal adds "Windows", a list
of its windows newest first, each "Week of <date>, 2 of 3" with a pill: Met,
Short, Partial or Under way. Its stats keep their places and say what they
mean for a count per window (Now "2 of 3 this week, 1 to go by …", Target "3
times a week", At this pace "4 of 5 weeks met"), its milestones are streaks
("4 weeks in a row", reached on the day the watcher said so), and its row on
the list and on Home is the tally and the verdict ("short last week"), loud
after two whole weeks short running. Both sections sit in a titleless `detail`
over the goal query, because `when` reads the data a component is handed and
inside a list-detail's detail that is the page's own.

The series is a table and the windows a list, not a chart: page descriptors
have no chart component, by design ([plugin-pages.md](plugin-pages.md) §4,
"charts are canvas views"). The points and the target line are drawn on the
canvas, by `goal.status`. A frequency goal's windows are read per goal
(`frequencyOf`, one statement each), not in the one statement Home and the list
use for checks.

The Goals page is a **rail** page, so it introduces no new place: the table in
`docs/plugins.md` §2.5a holds and `plugin-places.test.ts` still holds.
Its one write is `goal.owner_close` — the same store call `goal.close` makes,
without the holder check, because the owner is not an agent: a goal exists
because they approved it, and stopping one is theirs to do on any screen. It
is `ownerOnly`, so no model is listed it and `invoke` answers "unknown tool" to
anybody but the owner's own path. Its note is trimmed **before** the length is
checked, so three spaces is not a note: the field is required because the row
explains itself afterwards.

Everything the page shows about a goal is in the goal's own currency
(`goal.currency`), including the Checks table — never the currency a particular
reading happened to carry, which would print `$75` one component under a bare
`75`. The findings read is scoped to `sentinel_id = 'core.goals'` as well as to
the goal's key prefix: keys are free-form text out of one namespace, and the
section names that watcher.

## 8. Example, end to end

"@ledger help me cut my debt by 40k in six months." The advisor reads the
accounts, proposes: metric `finance.total_debt`, delta −40,000, deadline in
26 weeks, weekly cadence, milestones at −10k, −20k, −30k. The card says
"From $87,400 today to $47,400 by 22 March: $1,540 a week, checked weekly,
held by @ledger". The owner approves. Every week core measures; in week 6
the projection lands short, the second miss wakes the advisor, which reads
the cards and the statement dates, and answers with what changed and one
recommendation, or proposes `goal.update`. At −10k the advisor says so, once.

"I'm 288, I want to be at 220 by December," on 22 September. No plugin measures weight, so the
concierge proposes `goal.set` with `metric: { owner: { slug: 'weight', label:
'Weight', unit: 'number', direction: 'down', unitLabel: 'lb' } }`, `baseline:
{ value: 288 }`, an absolute target of 220, deadline 2026-12-31, weekly,
milestones at 260 and 240. The card says "From 288 lb today to 220 lb by
2026-12-31: 4.76 lb a week down, checked weekly, held by @concierge" and
"Measured by you, when you tell buddi (a new metric, owner.weight)". The owner
approves; `owner.weight` and its first value exist from then. A week later the
owner says "285 this morning" to whichever agent is on Telegram, which calls
`goal.record { metric: 'weight', value: 285 }` and repeats the sentence it
answers. A week with nothing said is one end-of-day line, "You have not told me
your weight this week." At 260 the concierge says so, once.

The email plugin declares `email.waiting_on_me`; the developer plugin
`developer.failing_tests` for a workspace; none of them knows about goals.

`email.inbox_unread` depends on the inbox poll re-syncing flags
([email.md](email.md) §7a): a count over `flags` written once at ingest would
only ever climb whatever the owner read, and a goal on it would be settled
`missed` for an inbox somebody had actually emptied.

## 9. What it is not

Not a task list, not a habit tracker (a frequency goal counts what the owner
reports, with streaks as milestones; anything without a metric is a
reminder), not a plan document (the agent's plan lives in its memory and
skills), not a forecast engine (linear projection over four points,
stated as such).

## 10. End to end

1. The example in §8 works with the finance plugin: card, weekly checks
   recorded, an off-track wake reaching the chat and Telegram, the milestone
   wake once, the Home block and the Goals page showing the same numbers.
2. A goal on a metric whose plugin is later uninstalled shows "not measured"
   and wakes once after 7 days, never a number.
3. A delegate cannot set a goal; a non-holder cannot update or close one.
4. Every metric measures under the read-only pool.
5. A 13th open goal is refused with the sentence.
6. The weight example in §8: the metric and its first value exist only once
   the card is approved, a value said to another agent lands on the goal, and
   a silent week is one end-of-day line, never two.
7. A frequency goal counts Monday weeks in the owner's zone, says a short week
   once and a streak once, and settles by its windows at the deadline.
