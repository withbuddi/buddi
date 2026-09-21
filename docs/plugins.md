# Writing a plugin

Everything an agent can actually *do* is a plugin. This document is the guide to
writing one: the contract, the five things a plugin can contribute, the rules
that bite, and a complete worked example you can copy.

Read `packages/core/src/tools.ts` first. It is 200 lines and it is the whole
contract. This document explains it; it does not replace it.

---

## 1. What a plugin is, and is not

A plugin is a package that exports a `PluginManifest` and imports `@buddi/core`.
Core never imports a plugin. That direction is not a convention:

- `scripts/check-boundaries.mjs` scans `packages/core` and fails the build if any
  source file or `package.json` dependency there names `@buddi/runtime`,
  `@buddi/gateway` or `@buddi/tool-*`. It runs first in `pnpm test`. The same
  script also fails the build on outbound HTTP that does not go through the
  shared transport — see "Outbound HTTP" below.
- `packages/gateway/src/generic-install.test.ts` boots the system with no plugins
  at all. Core with zero plugins installed is a valid, running state — the
  registry is empty, the sentinel tick returns `[]`, the source tick returns
  `[]`, and `buddi missions add-defaults` registers only the gateway's own
  `sentinel-wake`.

"Droppable" here means exactly that: **delete the directory, remove one
registration line, drop one Postgres schema, and the system still boots.** There
is no runtime plugin framework, no dynamic loading, no sandbox. A plugin is
compiled into the gateway at its composition root, and the security properties
come from the registry and the approval machinery, not from isolation.

What a plugin is *not*:

- It is not trusted to decide what reaches the owner. A sentinel returns
  findings; core decides whether any of them wake anybody.
- It is not trusted to execute its own effects. A `gated` tool is executed by
  one function, `executeApproved`, and only against an approval row.
- It does not schedule anything by being installed. Missions are suggestions.

---

## 2. The contributions

```ts
export interface PluginManifest {
  name: string;            // 'finance'
  version: string;         // part of the approved args hash — see §2.1
  schema: string;          // the Postgres schema this plugin owns
  migrationsDir: string;   // absolute path to a directory of *.sql, or ''
  tools: ToolDefinition<any, any>[];
  sentinels?: Sentinel[];
  sources?: Source[];
  missions?: SuggestedMission[];
  views?: ViewDescriptor[];   // how the dashboard should draw your results
  agents?: SuggestedAgent[];  // agents you PROPOSE; the owner approves each one
  skills?: SuggestedSkill[];  // shared procedures you propose
  description?: string;       // one line, shown before anyone installs you
  network?: NetworkUse[];     // the hosts you intend to reach, and why
}
```

Only `tools` is required, and it may be empty. The last four exist for one
reason: somebody who is not you has to decide whether to run your code. See
§2.6 and §8.

### 2.1 Tools

```ts
export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;            // namespaced: 'finance.project_cashflow'
  description: string;     // shown to the model
  tier: Tier;              // 'auto' | 'draft' | 'gated' | 'session'
  input: ZodType<I>;
  execute(input: I, ctx: ToolContext): Promise<O>;
  describe?(input: I, ctx: ToolContext): EffectDescription | Promise<EffectDescription>;
  timeoutMs?: number;
}
```

**Choosing a tier.** `packages/core/src/registry.ts` executes exactly one:

```ts
export const EXECUTABLE_TIERS: readonly Tier[] = ['auto'];
export const GATED_TIERS: readonly Tier[] = ['gated'];
```

- **`auto`** — a read, or a write to your own schema. It runs inline inside the
  model's turn. Everything in `memory`, `artifacts` and `finance` is `auto`.
- **`gated`** — it changes something outside this machine. `email.send` is the
  only one shipped. `invoke` never runs it: the call becomes an immutable action
  plus a pending approval, and the model is told `approval-required` with the
  action id.
- **`draft` and `session`** — refused with `tier-not-executable`. The machinery
  those tiers need does not exist yet. Declaring one means your tool never runs.

The rule of thumb: if you would want to read the arguments before it happened,
it is `gated`.

**`invoke` fails closed.** Four refusals, in order:

| Situation | `reason` |
| --- | --- |
| Name not registered | `unknown-tool` |
| Zod rejects the arguments | `invalid-args` |
| Tier `gated` | *not a refusal* — `approval-required` plus an `actionId` |
| Tier `draft` / `session` | `tier-not-executable` |
| `execute` threw | `tool-error` |

A defect never surfaces as success, and the model never sees a raw exception.

**`describe` is how a gated tool earns its approval.** It returns:

```ts
export interface EffectDescription {
  envelope: unknown;   // everything that decides what the world will see
  preview: string;     // plain text, short, owner-facing
}
```

Four rules, all of them load-bearing:

1. **The envelope is complete.** Every recipient including BCC, the resolved
   account, the body and its hash, attachment hashes. `core.effect_attempts`
   stores `envelope_hash` before dispatch; if a fact is not in the envelope, the
   owner did not approve it. `email.send`'s `SendEnvelope` is the model to copy.
2. **The preview is rendered from the envelope and from nothing else.** Never
   from text the model wrote. Plain text, no markdown.
3. **`describe` is pure and read-only.** It runs *before* any approval exists. A
   `describe` that sent an email is the exact bug this boundary exists to stop.
4. **If you omit it**, the registry falls back to the canonical arguments as the
   envelope and their JSON as the preview. Honest, complete, and plainly a
   fallback. `@buddi/tool-email` defines a `GatedToolDefinition` that makes
   `describe` required; copy that narrowing (`packages/tools/email/src/types.ts`).

**`execute` on a gated tool is only ever called by the Executor.** The single
caller is `executeApproved` in `packages/core/src/actions/execute.ts`, which:

1. claims the approval atomically (`approved` → `executing`) — two racing
   workers produce one winner and one `already-claimed`;
2. recomputes `hashArgs(tool, toolVersion, canonicalArgs)` and refuses with
   `args-hash-mismatch` if it no longer matches what the owner approved. This is
   why `manifest.version` matters: bumping it voids standing approvals;
3. writes the `effect_attempts` row *before* dispatch;
4. dispatches under a deadline.

**`ctx.actionId` is your idempotency key.** It is set only by `executeApproved`,
from the action being executed. A tool that must not act twice must:

```ts
const actionId = ctx.actionId?.trim();
if (!actionId) {
  throw new Error('weather.x: no approved action id in the tool context; refusing');
}
```

and then claim on it — atomically, in SQL, not in TypeScript. `email.send`'s
claim is one statement:

```sql
update email.drafts set sent_action_id = $2
 where id = $1 and sent_action_id is null
returning ...
```

Zero rows back means someone else owns it: if the owner is the *same* action and
the row is already sent, return the recorded receipt (`replayed: true`); if it is
a different action, refuse. Re-dispatching is never the answer.

**`timeoutMs` and what `unknown` means.** The Executor waits `timeoutMs`
(`DEFAULT_EFFECT_TIMEOUT_MS` when you declare none) and then records the attempt
as **`unknown` — never as failed, and never auto-retried**. `unknown` is the
honest state for "the effect may or may not have happened": SMTP does not offer
exactly-once, and pretending otherwise is how mail gets sent twice. Only the
owner decides what an `unknown` means. Set `timeoutMs` to the longest your
transport can legitimately take (`email.send` uses 60s), and when your dispatch
throws after the wire was touched, leave the claim in place and record the error
rather than releasing it.

**`ToolContext`, in full:**

```ts
interface ToolContext {
  db: Pool;
  ownerId: string;
  now: () => Date;          // never read the wall clock
  timezone: string;         // IANA; render days with localDateString, never UTC
  conversationId?: string;  // provenance
  agentId?: string;         // provenance
  delegationDepth?: number;
  jobId?: string;
  actionId?: string;        // gated execute only
}
```

The optional fields are optional so every caller keeps compiling. A tool that
*needs* one must fail closed when it is absent rather than guess — see
`resolveScope` in `packages/tools/memory/src/tools/shared.ts`, which refuses to
widen a private note to shared just because no agent id arrived.

### 2.2 Sources

```ts
export interface Source {
  id: string;          // 'email.inbox-poll' — namespaced, stable; keys the ledger
  description: string;
  every: number;       // poll period in SECONDS
  poll(ctx: SourceContext): Promise<void>;
}

export interface SourceContext {
  db: Pool;
  now: () => Date;
  timezone: string;
  log: (line: string) => void;   // operational logging; a source notifies nobody
  enqueueRun(input: {
    agentId: string;
    prompt: string;
    dedupKey: string;
    conversationHint?: string;
  }): Promise<void>;
}
```

A source is the half of the contract with no agent in the loop: mail arrives and
a triage run begins, because mail arrived. Core decides only *when* a source is
due — the ledger is `core.source_runs`, one row per source id — and hands it a
context. What it polls and how it advances is entirely yours.

The rules, all of them learned from `packages/tools/email/src/sources/inbox-poll.ts`:

- **Identity is not a number you invented.** An IMAP UID means nothing without
  its UIDVALIDITY, so the messages table is unique on
  `(account, mailbox, uidvalidity, uid)`. When the server's UIDVALIDITY changes,
  every stored uid for that mailbox belongs to a generation that no longer
  exists: the change is logged, the cursor is re-planted, and the old rows are
  kept because the unique constraint keeps the generations apart. Find the
  equivalent fact in your world and store it.
- **A new cursor starts at *now*, not at record one.** "No cursor" must never
  mean "read 140,000 messages from UID 1". The inbox plants the cursor at
  `UIDNEXT - 1`, and `EMAIL_BACKFILL=N` plants it N lower on purpose. The same
  policy runs on a UIDVALIDITY reset: re-reading a decade of mail is not a
  re-sync, it is an outage.
- **Cursor advancement is transactional.** Rows and the cursor commit in one
  transaction, so a crash can re-fetch but can never skip.
- **`enqueueRun` is idempotent on `dedupKey`.** It cannot join your transaction —
  the queue is the gateway's. So commit your rows with the enqueue stamp null,
  enqueue after the commit, and write the stamp last. A crash in between leaves
  the row unstamped, the next poll re-enqueues the same key, and the dedup makes
  that a no-op. Choose a key that is stable for the life of the row:
  `triage:<message row id>`, never a timestamp.
- **Every outbound call has a deadline.** A socket can accept your connection and
  then say nothing. Time out, close, throw. `runSources` writes the message to
  `core.source_runs.last_error` and emits `source.polled` with it, so a source
  that stopped answering is visible rather than silent. A source that throws
  never stops the others.
- **State the offline/retention contract.** The inbox's is: IMAP keeps the
  messages, the cursor is where we left off, and a machine that slept a week
  walks forward `MAX_PER_POLL` (50) messages per poll until it catches up.
  Nothing is lost the way a webhook is. If your world does not keep the
  backlog for you, say so at the top of the file.
- **A missing configuration is a valid state, not a failure.** No account
  configured: log once and return.

A source may also be pure housekeeping — `email`'s retention source originates no
run and wakes nobody; it rides the contract only for the period ledger.

### 2.3 Sentinels

```ts
export interface Sentinel {
  id: string;        // 'finance.floor-breach' — namespaced, stable; keys the ledger
  description: string;
  every: number;     // period in SECONDS
  run(ctx: SentinelContext): Promise<Finding[]>;
}

export interface Finding {
  key: string;             // stable dedup key
  severity: 'urgent' | 'info';
  title: string;
  detail: string;
  agentId?: string;        // who should speak about it
  data?: unknown;          // structured evidence, handed over verbatim
}
```

A sentinel is deterministic: SQL and TypeScript, no model, no prompt, no
judgement call that needs a sentence to explain. It answers one question — is
something true right now that the owner would want to know? — and returns
findings. It never speaks to anybody.

**The key is the identity of a fact, not a description of it.** The same
condition must produce the same key on every run, and a different fact a
different key. `floor-breach:2026-10-02` is a key; `floor-breach` with a moving
date is not — it would report one breach as four across a day of six-hourly runs.
Anchor the key to the date or the row the condition rests on.

**What core does with a finding** (`packages/core/src/sentinels/run.ts`):

- A finding already in the table has its `last_seen_at` touched and nothing else
  happens. The same fact is not news twice.
- A finding fires when it is new, when it had resolved and came back, or when its
  cooldown ran out. `urgent` enqueues an occurrence of the gateway's
  `sentinel-wake` mission, then stays quiet for `URGENT_COOLDOWN_MS` (24 h).
  `info` lands in the weekly digest, then stays quiet for `INFO_COOLDOWN_MS`
  (7 days). **Silence is the default, not an optimization.**
- **A finding you stop returning is resolved.** `resolveMissing` marks every open
  finding you did not return this run as resolved and clears its cooldown, so if
  it comes back the owner hears about it. Returning a shorter list is how you say
  "that stopped being true".
- **A sentinel that throws is recorded and never aborts the tick.** The message
  lands in `core.sentinel_runs.last_error`, the tick continues, and the findings
  of the failed run are ignored entirely — a half-list is not evidence that
  anything resolved.

Two more things that hold in practice:

- **Severity is a rule, not a mood.** Finance encodes it as constants
  (`URGENT_BREACH_DAYS = 7`, `URGENT_DUE_DAYS = 3`) in one file of pure functions
  and calls into it from every sentinel. Copy that split: a query that shapes
  rows, then a pure function that decides. It is the only way the judgement is
  testable without a database.
- **Reuse the tool rather than re-deriving.** `finance.floor-breach` calls
  `projectCashflow.execute` instead of writing its own projection, so the
  sentinel and the agent can never quote the owner two different numbers for the
  same week.

### 2.4 Suggested missions

```ts
export interface SuggestedMission {
  id: string;                    // 'friday-recap'
  name: string;
  agentRole?: string;            // resolved through the agent catalog
  agentId?: string;              // or pinned by name
  cron: string;                  // five fields
  timezone?: string;             // the installation's BUDDI_TZ when omitted
  misfirePolicy?: MisfirePolicy; // 'coalesce' | 'latest-only' | 'skip-after-deadline'
  prompt: string;
  alwaysDeliver?: boolean;       // default false
  enabledByDefault?: boolean;    // default true
}
```

A default mission is domain knowledge — "every Friday, recap the week" only means
something because the finance tools exist — so it travels with the plugin.
Nothing is scheduled by installing a plugin: `buddi missions add-defaults` is the
owner accepting the suggestion.

- **Name a role, not an agent.** `agentRole: 'recap'` lands on whichever agent
  this installation gave that role. `agentId` pins one agent by name and is right
  only when the mission is meaningless anywhere else. A suggestion whose role
  nobody claims is skipped with a printed reason — never silently registered on
  the default agent — and so is one that names neither
  (`packages/gateway/src/missions/defaults.ts`).
- **Misfire policy is what a closed laptop owes the owner.** `coalesce` (the
  default) runs the missed occurrences as one; `latest-only` runs just the most
  recent — a laptop shut for three days owes one morning message, not three;
  `skip-after-deadline` drops anything past its deadline.
- **`alwaysDeliver: true` means the owner asked for this message whatever it
  says.** The Friday recap is the one mission that has it. Everything else is
  false.
- **`enabledByDefault: false` registers the mission switched off** — a
  placeholder for work whose tools do not exist yet.
- **An unattended run must end in `mission.report` or `mission.silent`.** With
  `alwaysDeliver: false`, the executor delivers *only* when the run called
  `mission.report`; a run that ends without calling either is logged as a warning
  and treated as silent. So write the decision into the prompt: say what counts
  as worth speaking, and say "otherwise call mission.silent with the one-line
  reason". A prompt that does not say this produces a mission that never speaks.

### 2.5 View descriptors

```ts
export interface ViewDescriptor {
  tool: string;        // 'weather.forecast'
  renderer: 'timeseries' | 'table' | 'bars' | 'keyvalue' | 'document'
          | 'envelope' | 'structured';
  title?: string;      // the canvas panel's heading
  map: ViewMap;        // declarative: paths, columns, formats. Never a function.
}
```

The dashboard has a canvas beside the conversation, and it draws tool results on
it. The renderers are **shapes, not domains** — a line, a table, a bar, a list of
figures — and nothing in `packages/web` is allowed to know the word "cashflow".
A view descriptor is the join between the two: your plugin knows what your output
means, the page knows how to draw a line, and this says which is which.

- **The mapping is data.** It is serialised to JSON and served to the browser by
  `GET /api/chat/views`. No plugin code runs in the page, no build step changes
  when a plugin is installed, and an installation without your plugin ships none
  of your mapping. That is why `map` holds field paths and column definitions
  rather than a function: a function cannot cross that boundary.
- **A path is a path, not an expression.** `days`, `summary.dateRange.from`,
  `cards[0].name`. If a descriptor needs arithmetic, the *tool* should be
  returning the number — the owner cannot audit a calculation that happens in a
  chart.
- **It is validated at load.** `ToolRegistry.register` parses every descriptor
  with zod (`packages/core/src/views.ts`), checks the renderer against its own
  map shape, and refuses a descriptor naming a tool your manifest does not
  contribute. A typo is a startup error naming the plugin and the tool, not an
  empty panel nobody can explain.
- **Not every tool deserves one.** A result whose *shape* carries meaning the
  digits do not — a balance over time, utilization against its limit, spending
  by category — earns a descriptor. Everything else falls back to `structured`,
  a readable view of the JSON, which is often the honest answer.

The shipped example is `examples/plugins/weather/src/views.ts`: eight lines that
turn a forecast into a line chart with freezing drawn on it. The real thing is
the finance plugin's `src/views.ts` (in the `buddi-plugins` repository), which
has thirteen.

An agent can also draw deliberately, with the platform's own `canvas.show` — for
something it worked out that no single tool result covers. Precedence in the
page is: an explicit `canvas.show` in the run, else a declared descriptor for the
tool, else `structured`.


---

### 2.6 Proposed agents and skills

```ts
export interface SuggestedAgent {
  id: string;            // 'meteo' — the directory name too
  handle: string;        // what the owner types: @meteo
  name: string;
  description: string;   // one line; other agents read it to hand it work
  persona: string;       // the body of the file, in markdown
  tools: string[];       // THE GRANT. Names or family globs.
  roles?: string[];
  model?: string;
  provider?: 'anthropic' | 'openai';
  maxTurns?: number;
  language?: 'mirror' | 'en' | 'fr';
  skills?: SuggestedSkill[];   // written into this agent's own skills/
}
```

Tools without an agent are a box of parts. You know what a useful agent made of
your tools sounds like, and that knowledge should travel with the plugin exactly
as a suggested mission does — so a manifest can carry `agents` and, for
procedures every agent should read, `skills`.

**They are proposals, and a plugin can never create one.** Creating an agent is
creating a principal, and the `tools:` line in its file is the only thing that
decides what that principal can reach. So there is no code path anywhere that
writes an agent file because a plugin was installed. What exists instead:

| | |
| --- | --- |
| `platform.plugin_agents` | tier `auto`. Every agent and shared skill the installed plugins propose, with the grant each asks for and whether the owner has accepted it. |
| `platform.accept_plugin_agent` | tier **`gated`**. Builds exactly the envelope `platform.create_agent` builds, from your proposal's fields. |
| `platform.accept_plugin_skill` | tier **`gated`**. The same, for a shared skill. |

Accepting reuses `create_agent` wholesale, which is the point — your proposal
gets no shorter path to a principal than the owner's own agent does:

- **the same validation, before the action exists.** A duplicate id, a taken
  handle, a tool that is not installed here, a model that does not belong to the
  provider, a file the loader would refuse: every one of them is a refusal in
  `describe`, so the owner is never asked to approve something that cannot
  happen;
- **the same preview.** It names your plugin and its version, then the whole
  grant in the *registered tools' own words* — what it reaches, tool by tool,
  and what it does not reach, named;
- **the same refusal to hand over the platform's write tools.** A proposal
  naming `platform.create_agent` — or `platform.*`, which resolves to it — is
  refused outright. One approval must never buy a second agent that can write
  the installation for ever after.

#### Whose file is it?

**The owner's, from the moment they accept.** It is written into their private
agents directory, and your plugin cannot rewrite it, at any version, ever.

That is a decision with a cost — you cannot ship a fix to a persona — and it is
the right one, because the alternative is worse in a way that matters: a file
your upgrade could rewrite is a *tool grant* your upgrade could widen, with no
approval anywhere. It would also mean an owner who improved your persona loses
the improvement next Tuesday.

So an upgrade tells the truth and changes nothing. A small `plugin.json` beside
`agent.md` records which plugin proposed it, at which version, with a hash of
the proposal and a hash of the file as written. `buddi plugins install <dir>`
on a plugin that is already installed prints, per proposed agent, one of:

```
  meteo — accepted from weather@0.1.0, unchanged on both sides
  meteo — the plugin proposes a different meteo now (you accepted 0.1.0, this is
          0.2.0). Your copy is untouched — accepting again is an approval you
          make, grant and all.
  meteo — you have edited your copy; it is yours and nothing will change it
  meteo — you have not accepted this one
```

And then it stops. If you have changed the proposal and the owner wants it, they
accept it again, see the new grant, and approve it — or they do not.

#### Writing a good one

- **Propose the smallest grant that does the job.** `weather.*` and nothing
  else. An agent that also asks for `memory.*` "for context" is an agent the
  owner has to think about instead of accept.
- **Ship its skill with it.** A persona says who it is; a skill says how it
  works. Skills listed on the agent are written into its own directory by the
  same approval, and they grant nothing.
- **Write the persona for someone else's installation.** You do not know what
  else is installed. Say what the agent cannot see, and what it should do when
  the answer depends on something it cannot see.

`examples/plugins/weather/src/agents.ts` is the worked example.

---

## 3. Schema and migrations

A plugin owns one Postgres schema, named after the plugin: `finance`, `email`,
`memory`, `weather`. Core owns `core` and references none of your tables.

`migrationsDir` is an **absolute** path to a directory of `*.sql` files applied
in filename order, resolved from the *built* file so it works from `dist`:

```ts
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);
```

and `migrations` goes in the package's `files` array. Use `fileURLToPath`, never
`new URL('./migrations', import.meta.url).pathname`: that form percent-encodes a
space, so under a data directory called `owner data` — or
`~/Library/Application Support/...` — the path does not exist on disk. A
`migrationsDir` that is not there is now an error naming the directory
(`migrate` used to treat it as "nothing to do"), reported on install as
`migrationProblem`.

`migrate(pool, { schema, dir })` (`packages/core/src/db.ts`) is per-plugin and
additive:

- `core.migrations` and the target schema are created if missing;
- each file runs in its own transaction with
  `set local search_path to <schema>, public` — so write `create table if not
  exists location (...)`, unqualified, and the file cannot touch another
  plugin's tables by accident;
- applied files are tracked by `(schema, filename)` and skipped next time. **Files
  are never re-run and never rolled back: add a new file, never edit an applied
  one.** Number them `001_`, `002_`.
- the schema name is checked against `/^[a-z_][a-z0-9_]*$/` before it is quoted.

`runMigrations(pool, manifests, { optional, onProblem })` runs core's first,
then each manifest's. `optional` names the installed third-party plugins: one
of those failing is that plugin failing to load (`docs/install.md` §7), so it
is reported through `onProblem`, left out of `installedManifests` for the rest
of the run and listed by `pluginLoadReport` — the Plugins page and doctor say
why. Core's own migrations and a compiled-in plugin's still throw. Both start
paths go through the gateway's `migrateInstalled(pool, env)`, which fills those
two options in. A manifest with an empty `migrationsDir` is skipped — that is `@buddi/tool-artifacts`
saying it owns no schema at all, not a missing path. Its tools read `core.artifacts`
because a dropped plugin must not take the owner's files with it.

**How your schema gets applied.** Two entry points, both over the manifests the
gateway has installed:

- `buddi migrate` → `runMigrations(pool, installedManifests())`;
- `pnpm db:migrate` → `scripts/migrate.mjs`, which imports
  `packages/tools/<name>/dist/index.js` for each name in its list and **skips any
  plugin that is not built** (`if (!existsSync(entry)) continue`). Core with zero
  plugins is a valid state, so a missing `dist` is not an error.

**Uninstalling.** Delete the package directory, remove the registration line, and
`drop schema weather cascade`. Core keeps no reference to your tables — the rows
in `core.migrations` for that schema are the only trace, and they are harmless.
The exception is data core owns on your behalf (artifacts): that stays.

---

## 4. A worked example: `weather`

A complete plugin, in this repository at
[`examples/plugins/weather`](../examples/plugins/weather). One read tool, one
sentinel, one suggested mission, one schema holding the owner's location. It
builds and its test passes in this workspace; it is deliberately **not**
registered in the gateway.

### `package.json`

```json
{
  "name": "@buddi/tool-weather",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --emitDeclarationOnly",
    "test": "vitest run"
  },
  "dependencies": {
    "@buddi/core": "workspace:*",
    "pg": "^8.13.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@types/pg": "^8.11.10",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  },
  "files": ["dist", "migrations"]
}
```

### `tsconfig.json`

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "tsBuildInfoFile": "./dist/.tsbuildinfo"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"],
  "references": [{ "path": "../../../packages/core" }]
}
```

A plugin under `packages/tools/` is already in the workspace; this one lives in
`examples/`, so `pnpm-workspace.yaml` names `examples/plugins/*` too.

### `migrations/001_weather.sql`

```sql
-- weather plugin schema (applied with search_path = weather, public).
--
-- One row: where the owner is. The singleton is enforced in the table rather
-- than in TypeScript, so two processes racing cannot leave two locations and a
-- forecast for whichever one the query happened to sort first.
create table if not exists location (
  id integer primary key default 1 check (id = 1),
  label text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  updated_at timestamptz not null default now()
);
```

### `src/ports.ts` — the seam to the network

```ts
export interface DailyForecast {
  /** `YYYY-MM-DD` in the owner's timezone. */
  date: string;
  lowC: number;
  highC: number;
  summary: string;
}

export interface ForecastQuery {
  latitude: number;
  longitude: number;
  timezone: string;
  days: number;
}

export type FetchForecast = (query: ForecastQuery) => Promise<DailyForecast[]>;
```

The forecast service is a parameter, not an import, so the tool and the sentinel
are both testable against a stub that opens no socket — the same thing
`@buddi/tool-email` does with IMAP and SMTP.

### `src/location.ts`

```ts
import type { Pool } from 'pg';

export interface Location {
  label: string;
  latitude: number;
  longitude: number;
}

/** The owner's location, or null when nobody has set one. */
export async function loadLocation(db: Pool): Promise<Location | null> {
  const { rows } = await db.query<Location>(
    `select label, latitude, longitude from weather.location where id = 1`,
  );
  const row = rows[0];
  return row
    ? { label: row.label, latitude: Number(row.latitude), longitude: Number(row.longitude) }
    : null;
}

/**
 * What a caller is told when there is no location. A plugin that needs
 * configuration says which line fixes it; it never guesses a city.
 */
export const NO_LOCATION =
  'weather: no location is set. Insert one: ' +
  "insert into weather.location (id, label, latitude, longitude) values (1, 'Paris', 48.86, 2.35);";
```

A real plugin would add a small `weather.set_location` tool at tier `auto`; it is
left out here to keep the example one tool long.

### `src/frost.ts` — the rule, as a pure function

```ts
import type { Finding } from '@buddi/core';
import type { DailyForecast } from './ports.js';

/** Below this, tomorrow's low is worth saying out loud tonight. */
export const FREEZING_C = 0;

/**
 * The key is anchored to the date the forecast is *about*, never to "tomorrow":
 * a watch that runs every six hours must produce the same key all four times,
 * and a different day must produce a different one.
 */
export function frostFinding(day: DailyForecast, place: string): Finding | null {
  if (day.lowC >= FREEZING_C) return null;
  return {
    key: `weather.frost:${day.date}`,
    severity: 'urgent',
    title: `Frost in ${place} on ${day.date}`,
    detail:
      `The forecast low for ${day.date} is ${day.lowC.toFixed(1)}°C in ${place} ` +
      `(high ${day.highC.toFixed(1)}°C, ${day.summary}). Anything outside that ` +
      'minds the cold needs covering tonight.',
    data: { date: day.date, lowC: day.lowC, highC: day.highC, place },
  };
}
```

### `src/open-meteo.ts` — the adapter

```ts
import type { DailyForecast, FetchForecast } from './ports.js';

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

/** How long one forecast call may take before it is a failure, not a wait. */
export const FETCH_TIMEOUT_MS = 10_000;

/** WMO codes, collapsed to the handful of words a person actually wants. */
export function describeCode(code: number | undefined): string {
  if (code === undefined) return 'unknown';
  if (code === 0) return 'clear';
  if (code <= 3) return 'cloudy';
  if (code <= 48) return 'fog';
  if (code <= 67) return 'rain';
  if (code <= 77) return 'snow';
  if (code <= 82) return 'showers';
  return 'storms';
}

/** Shape the payload into days. Pure, so the parsing is testable on its own. */
export function toDays(payload: unknown): DailyForecast[] { /* … */ }

export const openMeteo: FetchForecast = async (query) => {
  const url = new URL(OPEN_METEO_URL);
  url.searchParams.set('latitude', String(query.latitude));
  url.searchParams.set('longitude', String(query.longitude));
  url.searchParams.set('timezone', query.timezone);
  url.searchParams.set('forecast_days', String(query.days));
  url.searchParams.set('daily', 'temperature_2m_min,temperature_2m_max,weather_code');

  // Never the global `fetch`. See "Outbound HTTP" below.
  const response = await defaultHttpTransport(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    idleTimeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw new Error(`weather: forecast service answered ${response.status}`);
  }
  return toDays(await response.json());
};
```

### Outbound HTTP

A plugin that talks to the network uses `defaultHttpTransport` (or
`createHttpTransport`) from `@buddi/runtime` — never the global `fetch`, never
`undici`, never its own `node:http(s)` client with an agent.

The reason is not style. `fetch` is undici, and undici keeps a connection pool
per origin. When a pooled connection dies — an idle keep-alive socket the far
end closed, an HTTP/2 session that was destroyed — undici hands the dead one
back for ever: every later request in the process fails in about a millisecond
with a bare `fetch failed`, and the process never recovers by itself. In a
one-shot script that is invisible. Inside `buddi serve`, which runs for weeks
and whose sentinels and sources fire on a timer, it took the whole assistant
down for hours and killed twelve unattended jobs in one evening.

The shared transport speaks HTTP/1.1 with `keepAlive: false`: one connection
per request, nothing held between them, so a failed request cannot poison the
next one. `scripts/check-boundaries.mjs` fails the build on any other outbound
client (tests and the browser bundle excepted), and names the file. Pass a fake
transport in tests rather than stubbing a global — and keep the network behind a
port like `FetchForecast` anyway, so the plugin's own tests open no socket.

### `src/tools/forecast.ts` — the read tool

```ts
import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import { loadLocation, NO_LOCATION } from '../location.js';
import type { DailyForecast, FetchForecast } from '../ports.js';

const forecastInput = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(7)
    .optional()
    .describe('How many days ahead, starting today. Defaults to 3, at most 7.'),
});

export type ForecastInput = z.infer<typeof forecastInput>;
export interface ForecastOutput { place: string; days: DailyForecast[] }
export const DEFAULT_DAYS = 3;

export function createForecastTool(
  fetchForecast: FetchForecast,
): ToolDefinition<ForecastInput, ForecastOutput> {
  return {
    name: 'weather.forecast',
    description:
      'The forecast for where the owner lives, day by day: low, high and a one-word sky. Use it when the owner asks about the weather, and before suggesting anything that happens outdoors.',
    tier: 'auto',
    input: forecastInput,
    async execute(input, ctx) {
      const location = await loadLocation(ctx.db);
      // Fail closed and say the line that fixes it; never guess a city.
      if (!location) throw new Error(NO_LOCATION);
      const days = await fetchForecast({
        latitude: location.latitude,
        longitude: location.longitude,
        // The owner's zone, from the context — a forecast rendered in UTC is a
        // forecast for the wrong day after 8 PM in New York.
        timezone: ctx.timezone,
        days: input.days ?? DEFAULT_DAYS,
      });
      return { place: location.label, days };
    },
  };
}
```

Note the two things every tool description should do: say *when* to use it, and
say it in the second person to the model. The zod `.describe()` on each field is
what the model sees as the parameter's documentation — `zodToJsonSchema` turns
the whole input into the JSON Schema in the tool spec.

### `src/sentinels/frost.ts` — the watcher

```ts
import { localDateString, type Finding, type Sentinel, type SentinelContext } from '@buddi/core';
import { frostFinding } from '../frost.js';
import { loadLocation } from '../location.js';
import type { FetchForecast } from '../ports.js';

/** Four looks a day: enough for a forecast that changes, cheap enough to run. */
export const EVERY_6H = 6 * 60 * 60;

export function createFrostSentinel(fetchForecast: FetchForecast): Sentinel {
  return {
    id: 'weather.frost',
    description: "Warns when tomorrow's forecast low is below freezing.",
    every: EVERY_6H,
    async run(ctx: SentinelContext): Promise<Finding[]> {
      const location = await loadLocation(ctx.db);
      // No location configured is a valid, quiet state — not a failure.
      if (!location) return [];

      const days = await fetchForecast({
        latitude: location.latitude,
        longitude: location.longitude,
        timezone: ctx.timezone,
        days: 2,
      });
      const tomorrow = localDateString(
        new Date(ctx.now().getTime() + 86_400_000),
        ctx.timezone,
      );
      const day = days.find((d) => d.date === tomorrow);
      if (!day) return [];

      const finding = frostFinding(day, location.label);
      return finding === null ? [] : [finding];
    },
  };
}
```

Two things to notice. The sentinel returns a list of length zero or one and never
tracks what it said last time: when the forecast changes its mind, the key stops
appearing and core resolves it. And it reaches the network, which most sentinels
do not — "deterministic" means no model in the loop, not no I/O — so the same
injected `FetchForecast` keeps it testable, and a throw here is recorded in
`core.sentinel_runs.last_error` rather than breaking the tick.

### `src/missions.ts` — the suggestion

```ts
import type { SuggestedMission } from '@buddi/core';

export const MORNING_WEATHER_ID = 'morning-weather';
export const MORNING_WEATHER_CRON = '0 7 * * *';

export const weatherMissions: SuggestedMission[] = [
  {
    id: MORNING_WEATHER_ID,
    name: 'Morning weather',
    agentRole: 'overview',
    cron: MORNING_WEATHER_CRON,
    // A missed morning owes the owner one message this morning, not four.
    misfirePolicy: 'latest-only',
    prompt: `Call weather.forecast for the next 2 days.

Stay silent unless the owner would change their day because of it. That means one of:
- tomorrow's low is below freezing;
- rain, snow or storms on a day that is currently forecast clear or cloudy in the message you would otherwise send.

If none of that holds, call mission.silent with the one-line reason. Otherwise call mission.report with at most 300 characters, plain text, no markdown: the day, the numbers, and the one thing to do about it.`,
    // It speaks only when it calls mission.report.
    alwaysDeliver: false,
  },
];
```

### `src/index.ts` — the manifest

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@buddi/core';
import { weatherMissions } from './missions.js';
import { openMeteo } from './open-meteo.js';
import type { FetchForecast } from './ports.js';
import { createFrostSentinel } from './sentinels/frost.js';
import { createForecastTool } from './tools/forecast.js';

/** Absolute path to this plugin's migrations, resolved from the *built* file. */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/** The manifest, with the forecast service as a parameter. */
export function createWeatherManifest(
  fetchForecast: FetchForecast = openMeteo,
): PluginManifest {
  return {
    name: 'weather',
    version: '0.1.0',
    schema: 'weather',
    migrationsDir: MIGRATIONS_DIR,
    tools: [createForecastTool(fetchForecast)],
    sentinels: [createFrostSentinel(fetchForecast)],
    missions: weatherMissions,
  };
}

/** The installed manifest: the real forecast service. */
export const manifest: PluginManifest = createWeatherManifest();

export default manifest;
```

### Installing it

```bash
pnpm build                                  # in your plugin's directory
buddi plugins install /path/to/weather      # reads what it contributes, installs nothing
buddi plugins install /path/to/weather --yes
```

That is the whole of it, and none of it touches buddi's source. The record is
`plugins.json` in the owner's private directory; the next process to start reads
it, imports your entry point, and registers your manifest alongside the built-in
ones. Your tools appear in `platform.installed_tools`, the `serve` loop ticks
your sentinels and sources over `wiring.registry.manifests()`, `buddi migrate`
applies your schema, `buddi missions add-defaults` reads your suggestions, and
`platform.plugin_agents` offers your agents. See §8.

**The plugins this repository ships are different**: `email`, `memory`,
`artifacts` and `web` are compiled into the build, registered in
`createToolRegistry` in `packages/gateway/src/agents/catalog.ts`, and they cannot
be uninstalled because they are part of it. (`installedManifests()` derives the
migratable subset from the registry rather than repeating the list — a
hand-written one was the defect that let `web` ship without being migrated.) If
you are adding a plugin *to buddi itself*, `createToolRegistry` is the one line
to add. If you are distributing one, you never touch that file.

**Neither is done for the example.** The `weather` plugin is in the workspace so
it compiles and is tested against the real types — and it is what the end-to-end
install is exercised against.

---

## 5. Testing your plugin

**Pure helpers first.** Put every judgement in a function that takes plain values
and returns a `Finding`, a number or a string, and test it with no database and
no clock. The finance plugin's `src/sentinels/helpers.ts` (in `buddi-plugins`)
is the pattern: the sentinels are a query plus a call into it, and
`helpers.test.ts` covers the rules. The weather example does the same with `frostFinding`.

**The throwaway database.** Anything that needs SQL gets a real Postgres, never a
mock, and never the developer's own database. The suite creates a database,
migrates into it, and drops it at the end; without `DATABASE_URL` it skips. From
`packages/tools/memory/src/tools/tools.db.test.ts`:

```ts
const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_memory_test_${process.pid}`;

suite('memory tools (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  const registry = new ToolRegistry();

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);

    const testUrl = new URL(databaseUrl as string);
    testUrl.pathname = `/${TEST_DB}`;
    pool = createPool(testUrl.toString());
    await migrate(pool, { schema: manifest.schema, dir: manifest.migrationsDir });

    registry.register(manifest);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });
});
```

`${process.pid}` in the name is what lets two suites run at once. Use
`runMigrations(pool, [manifest])` instead of `migrate` when your plugin also
reads a core table — that applies core's migrations first (the finance plugin's
`src/sentinels/sentinels.db.test.ts` does exactly that).

Drive tools **through the registry**, not by calling `execute` directly. That is
what proves the tier, the zod schema and the refusal paths, which is most of what
can go wrong:

```ts
const result = await registry.invoke(name, args, contextFor(agentId));
if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
```

**Testing a gated tool without sending anything.** Three layers, and only the
third needs a fake transport:

1. **`describe` alone.** It is pure and read-only: call it and assert on the
   envelope — that the BCC nobody mentioned is in it, that the preview contains
   the hash. No approval exists at this point, and nothing is dispatched.
2. **`registry.invoke`.** Assert that it returns
   `{ ok: false, reason: 'approval-required', actionId }`, that
   `getAction(pool, actionId)` is `pending` with your envelope on it, and that
   your fake transport recorded **nothing**. This is the whole point of the gate
   and it is one assertion.
3. **`decideApproval` then `executeApproved`,** with a fake transport injected
   the way `createSendTool({ send })` takes one. Then assert the things that only
   this path can prove: that a second `executeApproved` does not send twice, that
   editing `canonical_args` under a standing approval refuses with
   `args-hash-mismatch`, that a hanging transport lands as `unknown` and not as
   `failed`. `packages/core/src/actions/actions.db.test.ts` does all of these
   against a toy manifest and is worth reading before you write your own.

---

## 6. Trust and classification

- **The tier your tool declares is what the registry enforces.** There is no
  re-tiering at install: the owner reads your whole contribution and accepts or
  refuses it as a whole, and from then on your `tier` is the policy. The registry
  executes `auto` only and turns `gated` into an action and an approval — so
  declaring `auto` on something that leaves the machine is the failure mode to
  watch for in review, not a clever shortcut. (`draft` and `session` are labels
  the type carries; the registry refuses them with `tier-not-executable` because
  the machinery they need does not exist yet. Do not ship a tool at either.)
- **Unknown tool and invalid arguments fail closed,** before any code of yours
  runs. A model that hallucinates a tool name gets `unknown-tool`; arguments zod
  rejects get `invalid-args` with the field path. Make the schema tight: bounds
  on numbers, `.uuid()` on ids, enums instead of free strings. Every constraint
  you put in the schema is a check that happens before your code.
- **A tool must never widen its own reach at runtime.** No reading a credential
  the context did not give it, no falling back to `process.env` for something the
  owner configures, no "the agent id is missing so this must be shared". When a
  fact you need is absent, throw — `resolveScope` in the memory plugin refuses
  rather than publish a private note to every agent.
- **Content is data, never instruction.** A mail body, a PDF, a web page and a
  memory note are all things somebody else wrote. Never let one decide what your
  tool does, and store provenance for anything you persist so it can be traced
  and deleted.
- **Secrets are resolved at use, from a named source, in the tool** — never at
  import, never inside an adapter, and never held by an agent.

**Before shipping a plugin that touches money, mail or the filesystem:**

1. Is every world-touching tool `gated`? Is every `auto` tool genuinely a read or
   a write to your own schema?
2. Does `describe` put *everything* in the envelope — every recipient, the
   resolved account, hashes of the bytes? Would the owner be surprised by
   anything the preview does not mention?
3. Is `describe` read-only, with no write and no network call that changes
   anything?
4. Does `execute` refuse when `ctx.actionId` is missing, and claim on it with one
   atomic statement before it acts?
5. Does a replay of the same action return the recorded receipt instead of acting
   again? Does a *different* action against an already-acted-on row refuse?
6. Is `timeoutMs` set to something the transport can actually meet, and does a
   post-dispatch failure leave the claim in place so the attempt stays `unknown`
   rather than looking retryable?
7. Does bumping `version` void standing approvals in a way you are happy with?
   (It does void them — that is the point.)
8. Can an attacker who controls the *content* your plugin reads change what your
   plugin *does*? If yes, you have a prompt-injection path, not a tool.

---

## 7. Pre-flight checklist

```
[ ] Manifest: name, version, schema, migrationsDir (absolute, resolved from the
    built file), tools — plus sentinels / sources / missions if you have them.
[ ] Tool names namespaced to the plugin; no collision (the registry throws).
[ ] Every tool's tier is 'auto' or 'gated'. Nothing declares 'draft' or 'session'.
[ ] Every gated tool has describe(); the envelope is complete and the preview is
    rendered from it.
[ ] Every gated execute() refuses without ctx.actionId and claims atomically on it.
[ ] timeoutMs set on anything slower than a local query.
[ ] No wall clock (ctx.now()), no UTC days (localDateString(ctx.now(), ctx.timezone)).
[ ] Optional context fields (agentId, conversationId) fail closed, never guessed.
[ ] Sources: stable dedupKey, transactional cursor advancement, a deadline on
    every outbound call, a first-contact cursor that starts at now, and a
    documented offline/retention contract.
[ ] Sentinels: stable key anchored to the fact; severity by rule; a shorter list
    means resolved; no model, no delivery.
[ ] Missions: agentRole not agentId; a prompt that ends in mission.report or
    mission.silent unless alwaysDeliver is true.
[ ] Migrations: numbered, additive, never edited after they are applied,
    unqualified table names, `migrations` in package.json "files".
[ ] Tests: pure helpers with no database; a throwaway database for the SQL;
    tools driven through registry.invoke; a gated tool proven not to send.
[ ] `pnpm -r build && pnpm typecheck && pnpm test` green — check-boundaries
    included.
[ ] Proposed agents (if any): the smallest grant that does the job; no
    platform.* write tool and no platform.* glob; a skill shipped with each one;
    a persona that says what the agent cannot see.
[ ] `description` and `network` filled in: they are what a stranger reads before
    they run your code.
[ ] `buddi plugins install <dir>` (no --yes) read end to end, as the owner will:
    is the auto-tier list what you meant it to be?
[ ] `buddi plugins uninstall <name>` read end to end: does anything dangle?
[ ] Distributed: nothing to register by hand. A register() line in
    createToolRegistry is only for plugins shipped *inside* buddi.
```

---

## 8. Distributing it: install, upgrade, uninstall

### What a plugin *is*, on disk

A built npm-style package directory:

```
weather/
  package.json        # "main": "./dist/index.js"  (or exports["."])
  dist/index.js       # exports `manifest` (or a default export)
  migrations/*.sql    # if you own tables
```

`buddi plugins install <spec>` resolves `main` (or the `.` export), imports it,
and expects `manifest` or `default` to be a `PluginManifest`.

### The three sources

`parsePluginSpec` decides, in this order:

| What you type | What it is |
| --- | --- |
| a path that **exists and is a directory** | the developer path: your own build, in place |
| a path ending `.tgz` | a tarball on disk, for a plugin that should never be public |
| anything else | an npm package: `weather`, `@you/buddi-plugin-weather@1.2.3` |

A directory wins over a registry name on purpose. A developer with a `finance`
directory beside them means *that* directory; resolving the registry instead
would install a stranger's package with the same name and say nothing.

### Publishing one

```jsonc
{
  "name": "buddi-plugin-weather",
  "version": "1.0.0",
  "main": "./dist/index.js",
  "keywords": ["buddi-plugin"],
  "buddi": { "manifest": "manifest", "core": "^0.1.0" },
  "peerDependencies": { "@buddi/core": "^0.1.0" }
}
```

`@buddi/core` is a **peer** dependency and never a normal one. A plugin holding
its own copy of core would get a second registry, a second pool and a second set
of module-level singletons: its tools would register into an object nobody reads
and its approvals would be written by a machine nobody asks. Staging enforces
this — the staged tree's `node_modules/@buddi/core` is replaced by a symlink to
the core the gateway is running — but declaring it correctly is what makes
`npm install` of your package outside buddi behave the same way.

Ship a `buddi.md` beside it. It is prose, it is what the owner reads *before*
anything of yours is imported, and two labelled lines are parsed out of it:

```markdown
# weather

Looks up the forecast for a place you name and remembers nothing else.

Schema: weather
Hosts: api.open-meteo.com
```

Anything else in the file is shown verbatim. There is no schema to learn: what
matters is that an owner can read it and that it agrees with your manifest,
because those two are compared and any difference costs them a second approval.

### Install is two halves, and nothing runs in the first

Importing a module executes it, so an install splits at exactly that line.

**Stage.** `npm view` for the exact version, the integrity hash and the
publisher; `npm pack` to fetch it; extract; `npm install --ignore-scripts
--omit=dev` for its dependencies; symlink core. Then read *static metadata only*
— `package.json`, the integrity hash and publisher, your `buddi.md`, and which
packages in the installed tree declare `preinstall`/`install`/`postinstall` or
ship a `binding.gyp` (node-gyp is an install script nobody wrote down).
Nothing is imported, nothing is registered, no schema exists. The staged package
sits in `<data>/plugins/staging/<id>/`, and a stage nobody decides on is deleted
after a day.

Four things are checked before any of that is shown, and each one refuses
rather than warns:

- **the tarball is the one the registry named.** The sha512 of what `npm pack`
  wrote is compared with the `dist.integrity` of the packument, and the
  extracted `package.json` has to carry the same name and version npm resolved.
- **it is files and directories.** The extracted tree is walked with `lstat`,
  and a symlink, a device, a fifo or anything whose real path is outside the
  staging directory is refused and the whole stage deleted. This is not
  hypothetical tidiness: a member called `node_modules/@buddi` pointing
  somewhere else turns the `@buddi/core` peer link that comes next into a write
  outside the stage. `tar` is also run with `--no-same-owner
  --no-same-permissions`, because an archive's mode bits are its author's
  opinion.
- **the tree is hashed.** `stagedHash` is sha256 over the extracted package
  *and* its `node_modules` — every path, every byte, and the target of every
  link npm wrote among the dependencies — with `node_modules/@buddi/core`
  excluded, since that is the link to the running installation's core and not
  part of your package. It is shown beside the integrity hash.
- **the entry point is inside the package.** `main` (or the `.` export) is
  resolved with its links followed and has to land under the package's own real
  path.

**Approve 1.** The owner is shown all of it and this sentence:

> A plugin runs inside buddi's process with everything buddi can do; it is not
> sandboxed, and a plugin that wants to can bypass tool approvals and the
> network allowlist. Install only what you would run as yourself.

They approve by passing back the integrity hash they were shown; a mismatch
refuses and still imports nothing. `--yes` does not stand in for this: for a
registry or a tarball source, `buddi plugins install <spec> --yes` without
`--integrity <hash>` prints the card and the `approve` command and installs
nothing, because a yes typed before the fetch cannot be a yes to a particular
package. It **exits 3** when it does that: "staged, not installed", distinct
from 1 (something failed) and from 0, so a `set -e` install step in somebody's
setup notes cannot read a refusal as success. A directory source has no hash
and keeps the plain `--yes`.

Immediately before the first import the staged tree is hashed again and has to
equal `stagedHash`; a stage that changed while it waited is refused. Only then
is the entry point imported for the first time, the plan below runs, and your
`buddi.md` is compared with your manifest.

**Approve 2**, and only when that comparison found a difference. Then the
record is written first, marked `placing`, and only then does the package move
to `<data>/plugins/<name>/` — so a machine that dies in between leaves a record
that says what was happening rather than a directory nothing accounts for, and
the sweep at the next start can tell an orphan from an install. After the move
the tree is hashed once more and must still equal the pre-import hash: a plugin
that rewrote its own files while it was being imported is refused and removed.
Then its migrations are applied into its own schema, and the record is
finalised with its provenance: the source, the integrity hash, the publisher,
the hash of the files as installed, and when it was approved.

Approvals are serialised per plugin name, so two of them for the same name
cannot both rename into the same directory.

The tools are registered by the next process start. The CLI and the API both
say so; the API returns `restartNeeded: true`.

### What is recorded, and what doctor does with it

`plugins.json` is version 2. A v1 file still reads — every entry in one is a
directory source with no provenance, which is exactly what it was. A registry
entry carries `installedHash`: sha256 over the package's files and its
`node_modules`, path and content both, sorted, with `node_modules/@buddi/core`
(the link to the running installation) and `.git` excluded. It is the hash that
was taken before the plugin was ever imported. `buddi doctor` recomputes it —
for every plugin in the record, including the ones that did not load — and
warns, naming the plugin, when it no longer matches.

Including `node_modules` is deliberate and it has a consequence worth stating:
the hash covers the bytes that actually run, dependencies and all, so a
dependency rewritten in place is now visible. It is not a reproducibility claim
about `npm install`. Installing the same version twice on two machines can
produce two different trees and therefore two different hashes; what is
recorded is *what was staged here*, and an update is the only thing that is
supposed to change those files afterwards. A symlink among the package's own
files is refused rather than skipped, because a hash that ignores what it
cannot read proves nothing; links inside `node_modules` are hashed by their
target.

Be clear about what that buys. It detects a plugin whose files changed after the
owner approved them. It is not a signature, and it protects nobody from what the
plugin does while running. A plugin is trusted code; the honest controls are the
sentence above, the recorded hash, and doctor saying when what is on disk is no
longer what was agreed to.

### What the owner sees before they say yes

`install` with no `--yes` stages and prints, and installs nothing. After
approval the same contribution summary is printed, and it lists:

- every tool, and — first, and in capitals — **the ones at tier `auto`**, which
  run the moment a model decides to call them, with nobody asked. A plugin
  quietly shipping one is exactly what this exists to surface;
- the Postgres schema it will own;
- everything that runs on a timer, with its period: "every 6 hours, by itself";
- the hosts it declares in `network`, and — when it declares none — one line
  saying that nothing enforces this, so an undeclared host means the author did
  not write one down, not that the plugin cannot reach the network;
- the agents it proposes, each with the grant it asks for, and the sentence that
  nothing is created by installing.

That summary is produced by importing your entry point — there is no way to
describe a module without loading it — which is why it comes *after* the first
approval and never before it. What the staged screen shows beforehand is your
own claim, labelled as one.

### The name, and where the files go

A published package is usually called `buddi-plugin-weather` while its manifest
is `weather`, so the rule is written down rather than guessed:

> The manifest's `name` must equal the package's `name`, or the `buddi.name`
> the package declares in its `package.json`.

An install refuses when it does neither. Otherwise a package called
`buddi-plugin-weather` could carry a manifest called `finance`, take that name
in the record, take that schema, and be granted to an agent under a name the
owner never installed. A directory source is exempt: the owner typed a path to
a build on their own disk, and the identity of that build is the path.

The name also decides a directory: `<data>/plugins/<name>`, with a scoped name
folded to one segment (`@you/weather` → `@you+weather`). It is validated against
npm's charset first, `staging` is reserved, and the resolved directory is
checked to be inside the plugins root before anything is renamed or removed. A
schema name is validated too, against `^[a-z_][a-z0-9_]*$`, before it is ever
recorded — it reaches `create schema`, `set search_path` and, on a purge, `drop
schema`, where it is also quoted.

### What a plugin may not be called

Install refuses a manifest that takes something this build already ships: the
name of a built-in family (`finance`, `web`, `platform`, and the per-run
families `mission` and `conversation`), the name of a tool one of them already
answers to, or a Postgres schema one of them owns (`core` and `public`
included). Two plugins with one name collide on every tool; two plugins with one
schema share tables, because `db:migrate` applies each plugin's migrations into
the schema it declares.

None of those sets is written down anywhere. They are derived from the registry
this build actually creates (`builtInManifests` in
`packages/gateway/src/agents/catalog.ts`) and from the manifests the runs
actually register per run, so a plugin added to buddi tomorrow is reserved the
moment it is registered. The lists that used to be there had already fallen
behind by one plugin.

### Upgrades

```bash
buddi plugins update weather                 # stages the newer version
buddi plugins update weather --version 2.1.0
buddi plugins update weather --yes --integrity <hash>   # ...and approves it
```

An update is a stage plus the same two approvals, because a new version is
somebody else's code exactly as the first one was. It is **newer only**:
migrations in this system run forward and nothing knows how to undo one, so a
downgrade is refused with both versions named rather than silently left
half-migrated. The comparison is semver's own, prerelease rules included, and a
version it cannot parse is refused rather than guessed at — "not newer" is the
answer that stops an update, so guessing is how a downgrade gets through.

Installing the same plugin again does the same thing. The record is replaced;
the migrations run forward; **no agent file is written**. Per proposed agent you get one line
saying where the owner's copy stands — untouched, edited by them, or superseded
by a proposal you have changed. See §2.6.

A version that claims a *different* schema is refused: that is a data move, not
an upgrade, and it should be decided deliberately.

### Uninstall

```bash
buddi plugins uninstall weather              # shows what it would do
buddi plugins uninstall weather --yes        # removes the code, KEEPS the data
buddi plugins uninstall weather --yes --purge --confirm weather   # ...and drops the schema
```

The default keeps the data, and the command prints the schema, its tables and
its row counts so the owner knows exactly what is being kept and where.
`--purge` also requires the plugin's own name typed back (`--confirm <name>`, or
the same field on the dashboard); the engine requires it too, so a caller that
forgets is refused rather than obeyed.
Reinstalling finds it again. For the finance plugin the alternative would be
every account, transaction and card ledger the owner has, destroyed by a verb
that sounds like "remove the code" — so destroying is a separate flag that
prints what it is about to destroy first, and is recoverable only from a backup.

It also stands down everything that would otherwise be left pointing at tools
that no longer exist, because a half-removed plugin is worse than one that
stays:

| What | What happens |
| --- | --- |
| An agent whose grant names your tools | **Refused**, naming the agents. A `tools:` entry that resolves to nothing is a catalog *load error* — the installation would not start. `--detach-agents` removes those entries first (it only ever removes names). |
| Missions registered from your suggestions | Disabled, not deleted. A disabled mission is a row the owner can see and re-enable; a deleted one is a mystery next month. |
| Jobs queued for those missions | Cancelled. |
| Approvals pending on your tools | Rejected: they could never execute. |
| Agents the owner accepted from your proposals | Left alone — except for the grant rewrite above. They are the owner's files. |
| Your schema | Kept, unless `--purge`. |
| The package directory under `<data>/plugins` | Removed — buddi put it there. A `directory` source is left exactly where it is, because buddi did not. |
| Rows in core's tables (the action ledger, the event log) | Kept. They are the record of what happened, and history does not become false because a plugin left. |

Everything above is planned before anything happens, printed, and only then
applied — the same shape as an approval.
