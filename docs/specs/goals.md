# Goals: a target with a clock, that buddi keeps

Status: specified 2026-09-22, not started. Core feature, agent-neutral: any
agent with a metric can hold a goal, and the finance plugin is only the first
plugin to declare one.

## 1. Why

"Help me cut my debt by 40k in six months", "inbox zero by Friday", "the
test suite green before the release", "run three times a week". Today an
agent can write the plan and set a few one-shot reminders (`reminder.set`),
and plugins ship missions on fixed cadences. Nothing measures progress, nothing
knows the pace needed, and nothing wakes the agent when the owner drifts. The
plan lives in one conversation and dies with it.

A goal is the missing object: a target, a deadline, a way to measure, an
owner agent, and a rhythm of checks that buddi runs whether or not anyone is
talking to it.

## 2. Principles

- **Agent-neutral, plugin-fed.** Goals are core. What can be measured comes
  from plugins as **metrics**, a new contribution the same shape as `home`
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

## 4. The goal

```ts
interface Goal {
  id: string;
  title: string;                 // "Debt down by 40k"
  agentId: string;               // holder
  metric: string;                // 'finance.total_debt'
  params: Record<string, unknown>;
  /** Either an absolute target or a delta from the baseline. */
  target: { kind: 'absolute'; value: number } | { kind: 'delta'; value: number };
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

## 5. Tools

- `goal.metrics` (auto): the metrics this installation can measure, with
  units and directions.
- `goal.set` (gated): title, metric (+params), target, deadline, cadence,
  milestones. `describe` measures the baseline and renders the card: "From
  X today to Y by <date>: Z per week, checked weekly, held by @ledger". The
  agent proposing it must be the holder (an agent cannot give another agent
  a goal).
- `goal.update` (gated): target, deadline, cadence, milestones; the card
  shows before/after.
- `goal.close` (auto): with a note; also how "met" and "missed" become final
  when the owner agrees.
- `goal.status` (auto): a goal or all of the agent's goals, with the last
  check, the pace needed and the projection.
- `goal.list` (auto): every open goal, any holder (read).

An agent that is not the holder gets `goal.list`/`goal.status` only.

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
| Off track for two consecutive checks | urgent | yes |
| Back on track | info | no (digest) |
| Not measurable for 7 days | info | yes, once |
| Deadline in 7 days and not met | urgent | yes |
| Deadline passed | urgent | yes; the goal becomes `missed` unless met |
| Target reached | info | yes; the goal becomes `met` |

The wake prompt carries the goal, the last four checks and the instruction:
verify with your own tools, then report or propose a change through
`goal.update`; never change the goal silently.

## 7. Where it shows

- **Home**: a "Goals" block from core: each open goal, progress, pace, on
  track or not, in the holder's words for the title only.
- **A Goals page** (core, rail): the list with progress bars, one goal's
  history (the checks as a line, the milestones, the wakes), Close with a
  note, and a link to the holder's chat. Built as a core page with the
  plugin-pages components (core is allowed what plugins are).
- **The holder's chat**: `goal.set`'s card, and `goal.status` drawn with a
  view descriptor (`keyvalue` plus a `timeseries` of the checks).
- **Telegram**: the wakes reach it like any finding.

## 8. Example, end to end

"@ledger help me cut my debt by 40k in six months." The advisor reads the
accounts, proposes: metric `finance.total_debt`, delta −40,000, deadline in
26 weeks, weekly cadence, milestones at −10k, −20k, −30k. The card says
"From $87,400 today to $47,400 by 22 March: $1,540 a week, checked weekly,
held by @ledger". The owner approves. Every week core measures; in week 6
the projection lands short, the second miss wakes the advisor, which reads
the cards and the statement dates, and answers with what changed and one
recommendation, or proposes `goal.update`. At −10k the advisor says so, once.

The email plugin declares `email.inbox_unread` and `email.waiting_on_me`; the
developer plugin `developer.failing_tests` for a workspace; none of them knows
about goals.

## 9. What it is not

Not a task list, not habits with streaks (a goal has a metric or it is a
reminder), not a plan document (the agent's plan lives in its memory and
skills as today), not a forecast engine (linear projection over four points,
stated as such).

## 10. Acceptance

1. The example in §8 works with the finance plugin: card, weekly checks
   recorded, an off-track wake reaching the chat and Telegram, the milestone
   wake once, the Home block and the Goals page showing the same numbers.
2. A goal on a metric whose plugin is later uninstalled shows "not measured"
   and wakes once after 7 days, never a number.
3. A delegate cannot set a goal; a non-holder cannot update or close one.
4. Every metric measures under the read-only pool.
5. 13th open goal is refused with the sentence.

## 11. Order of work

1. Core: metrics contribution, `core.goals` tables, the tools with cards,
   the sentinel and its findings, the wake prompt, docs (`docs/plugins.md`
   gains `metrics`), tests. (2 days)
2. Home block, Goals page, chat view, Telegram parity. (1 day)
3. Metrics in finance (`total_debt`, `card_balance`, `cash_available`) and
   email (`inbox_unread`, `waiting_on_me`); the developer plugin's
   `failing_tests` when it lands. (half a day, in buddi-plugins for finance)
