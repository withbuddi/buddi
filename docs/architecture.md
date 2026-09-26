---
title: Architecture
status: reference
updated: 2026-09-25
---

# Architecture

buddi is a personal agent platform. Specialized agents get real access to the
owner's data and tools, answer on any surface (the dashboard, Telegram, the
terminal), and run scheduled and event-driven work on the owner's behalf.
Anything irreversible stops at an approval the code enforces.

This page is the design: the boundaries, the contracts and the rules the code
holds to. The code cites it by section name. Where the two disagree, the code
wins. The pages linked from each section have the operational detail.

## Design principles

1. **Agents are not bound to surfaces.** Every surface is a thin adapter.
   Telegram, the dashboard and the terminal are equal.
2. **Trust is enforced in code and fails closed.** Unknown tools, invalid
   arguments and missing configuration never execute. No path an agent defines
   can lower a gate.
3. **The machine sleeps, and some things cannot be recovered.** Scheduled work
   catches up by construction. A source that loses data while the machine is
   off (Telegram keeps undelivered updates for about a day) has an explicit
   offline contract.
4. **The AI layer is a swappable port, routed explicitly.** Choosing a provider
   is an authorization decision, because it decides where the owner's data
   goes. It is never migrated silently.
5. **One installation, one owner.** buddi runs on the owner's machine and every
   authorization refers to one installation owner. "Local" does not mean the
   data never leaves: a prompt sent to a cloud model is a data flow, and each
   agent's provider choice governs it.
6. **The core is the trust boundary, and nothing else is core.** Every
   capability that touches the world (email, the web, files, the browser, the
   host shell) is a plugin behind the plugin contract. Two contributions act:
   an **effect tool**, which an agent proposes and the approval machinery gates,
   and a **source**, which the system invokes to originate work. The rest is
   the plugin telling core what its domain means; core never learns the domain.
   Core with zero plugins is a valid, running state, and dependency direction
   enforces it: core never imports a tool.

## Process boundaries

One process, five core modules and the tool plugins, each with its own
ownership:

- **Surfaces** authenticate the sender and translate presentation. They never
  create runs and never name an agent: a command that needs a capability
  (`/status`, `/recap`) asks the catalog by role (see "Agent roles").
- **Gateway** maps an authenticated identity to a conversation, submits
  commands and renders replies.
- **Orchestrator** owns durable runs, scheduling, retries, cancellation and
  suspension.
- **Runtime** is the agent loop. It proposes tool calls and consumes results,
  and never executes effects.
- **Executor** is the only module that authorizes and performs effects, and
  the only path to effectful credentials.
- **Tools** are plugins, outside core, entering only through the registry
  contract (see "Drop-in tools and skills").

The **composition root** is the gateway: it is the one place that resolves a
plugin's path and imports it, and `scripts/check-boundaries.mjs` refuses a
computed dynamic import anywhere in core. The **outbound HTTP transport** lives
in the runtime and every caller uses it (see "Runtime provider port").

**Commands and events.** Commands request work; events record committed facts.
Accepted input and job creation commit together. Streaming to a surface is a
transient view of durable state, never the record.

`core.events` holds `id` (a monotonic bigserial, so append order is the
ordering), `kind`, `conversation_id`, `payload` and `created_at`. There is no
principal column, because there is one owner; `run.started` carries the agent
and the per-run snapshot, written before the first provider call. Dedup keys
are unique constraints (`core.jobs.dedup_key`, a source's cursor, the Telegram
offset), and enqueueing a key twice returns the existing job. Run, job and
action ids sit in the payloads. There is no causation id: two interleaved runs
in one conversation are ordered but not linked.

**There is no outbox.** A notification is sent by the code that decided to send
it (the mission runner, the sentinel loop, the dead-letter watch). Each runs
under a durable job with a lease and bounded retries, so a crash re-runs the
job. A send that succeeded just before its job's commit failed can be
delivered twice.

## Owner and surface authentication

- One **installation owner**, created at setup. All authorization refers to
  it.
- **Paired surface identities.** Telegram pairs by numeric user id and
  private-chat id, dedups on update id, and never trusts usernames, forwards or
  chat membership.
- **The dashboard** binds to `127.0.0.1` by default, and on loopback it is
  open: the binding is the credential, with no token and no expiry. CSRF
  (double-submit) and `Origin` checks still gate every write, and there is no
  CORS. Binding it elsewhere (`BUDDI_WEB_HOST`) turns on the ticket exchange
  and session cookies: remote access is an explicit, authenticated transport
  (`packages/gateway/src/web/server.ts`).
- **Cookies are named per port.** A browser keeps one cookie of a name per
  host whatever the port, so the session and CSRF cookies carry the port the
  request arrived on, from its Host: `buddi_csrf_4317` on `127.0.0.1:4317`,
  `buddi_csrf_9443` on the tailnet address. Two buddis on one machine, or one
  reached both ways, keep their sessions apart.
- **Approval callbacks are bound.** A callback resolves exactly the pending
  action it names, from the owner identity. A plain message saying "yes"
  resolves nothing. Decisions from any paired surface race on the same atomic
  state transition, and the loser is told which way it went.
- Surfaces establish identity. Authorization lives in core.

## Trust model

Every tool declares its operations and its tier in a central registry that
agents cannot read or modify (`packages/core/src/registry.ts`).

- Classification is by capability, not by name. A fetch to an external URL is
  a disclosure. Typing into a page is an effect, not only the submit. Reading
  mail must not change its flags.
- **Unknown tool: refuse. Invalid arguments: refuse** (zod decides). A tool
  that throws is a `tool-error`, never a success.
- Policy tables are out of reach of agent tools. The Executor holds
  credentials; agents hold none. Removing every plugin leaves the boundary
  intact.
- A plugin's declared tier is what the registry enforces. A tool may pick its
  tier per call (`tierFor`) among `auto`, `gated` and `session`.
- **The tiers:**
  - `auto` executes directly.
  - `gated` never executes in the registry. The call becomes an immutable
    action and a pending approval, and only `executeApproved` runs it (see
    "Actions and approvals").
  - `session` executes only inside an authenticated owner request that has not
    expired, for a tool resolved into the agent's grant, in a run that is not
    delegated. The browser tools use it (see "Computer access").
  - `draft` is a label. The registry refuses it with `tier-not-executable`.

## Drop-in tools and skills

[plugins.md](plugins.md) is the guide to writing a plugin, with every
contribution, its type signature and a worked example. This section is the
shape.

**Core never imports a tool; tools import core.** `check-boundaries.mjs`
enforces the direction, and `pnpm check:generic` boots the gateway with none of
this owner's agents.

**Agents and skills are found on a search path**, because a clone of this
repository is both a platform anybody may read and one owner's private
configuration. The platform half ships `examples/agents` and
`examples/skills`. The owner's half is `BUDDI_AGENTS_DIR` if set, else
`<repo>/private/agents` when it exists, else `~/.buddi/agents` (skills
likewise; a packaged install uses `<data>/agents` and `<data>/skills`). Both
load, examples first, and the owner's half wins: an agent or skill with the
same id is replaced whole, never merged. Each agent records its half
(`source: 'example' | 'private'`). A `default: true` in the owner's half beats
one in the examples; two inside one directory are a load error.

A `PluginManifest` carries a name, a version, a Postgres schema and a
migrations directory, then its contributions. Only tools are required:

- **Effect tools.** Agent-proposed capabilities (`email.send`, `host.exec`).
  They travel the approval machinery and execute only through the Executor;
  `auto` tools use the same registry with nothing to wait for. A tool declares
  `describe`, the pure rendering of its effect envelope and preview, and
  optionally `timeoutMs`, after which the attempt is `unknown`, not failed.
- **Sources.** System-invoked pollers: an id, a description, a period in
  seconds and a `poll`. A source owns its cursor and its transaction. Core
  decides only when it is due, from `core.source_runs`, and hands it
  `enqueueRun(agentId, prompt, dedupKey)`, idempotent on the key, so a poll
  that crashed between its commit and its enqueue recovers. A source notifies
  nobody.
- **Sentinels.** Deterministic watchers. See "Sentinels".
- **Suggested missions.** Id, cron, prompt, and the role of the agent that
  should run it. `buddi missions add-defaults` is the owner accepting them; a
  role no agent claims is skipped out loud, with the line that would fix it.
- **View descriptors.** How results are drawn on the canvas. See "The canvas
  and view descriptors".
- **Pages, queries, home cards and metrics.** A plugin's screens, as data
  ([plugin-pages.md](plugin-pages.md)).
- **Proposed agents and skills.** A `SuggestedAgent` is exactly the arguments
  of `platform.create_agent`, including the `tools:` grant the owner is shown
  tool by tool. A `SuggestedSkill` is a procedure, never a privilege. Neither
  is written by installing (see "Plugin lifecycle").
- **Secret destinations**, through which an owner secret is delivered without
  the agent reading it ([owner-secrets.md](owner-secrets.md)).
- **`description` and `network`**, one line per host the plugin reaches and
  what it sends. Nothing enforces `network` at runtime; the install summary
  shows it.

Around the contract:

- **Plugin-owned schema.** A plugin's migrations live in its own Postgres
  schema, applied at install. Core's schema holds no tool-specific table. A
  mission that needs a missing plugin is a configuration state, not a broken
  system.
- **Agent-created agents.** Making an agent creates a principal, and its
  `tools:` line decides what it reaches. The `platform.*` reads (roster, one
  persona, installed tools, skills) are `auto`; every write (`create_agent`,
  `update_agent`, `write_skill`, `delete_agent`) is `gated`, validated in
  `describe` before the action exists, with the complete resulting file and
  the resolved grant in the envelope. A widened grant lists what was added.
  `examples/` is never written. Two rules hold in code: the write tools cannot
  be granted through the write tools, and no `delegates.json` may name an
  agent that holds them (checked when proposed and at catalog load), since
  delegation would otherwise be a corridor from the agent that reads untrusted
  mail to `create_agent`. The shipped `agent-father` holds them and claims
  `maker`. After an approved write the catalog is rebuilt and swapped in, so
  the new agent answers everywhere without a restart.
- **Skills** are knowledge and procedures, in markdown. A skill never grants a
  tool or lowers a tier; a skill file with a `tools` or `tier` key fails the
  load. `agents/<id>/skills/*.md` are private to that agent and always loaded;
  `skills/*.md` are shared. A shared skill with an `agents:` list loads for
  those agents; with no `agents:` key it loads for every agent, which is how a
  house rule reaches agents nobody edited. An agent may name shared skills in
  its `skills:` frontmatter; an unknown name fails the load.

## Plugin lifecycle

Six plugins are compiled in: `email`, `memory`, `artifacts`, `web`, `browser`
and `host`. The gateway registers its own tool families beside them, which own
no schema: system context, owner secrets, reminders and schedules, goals,
learning, the canvas, the owner profile, `platform.*`, the `buddi mcp`
requests and delegation, plus the per-run families (the mission decision,
`conversation.ask`, `conversation.offer`). The built-in list is derived from
the registry (`builtInManifests` in `packages/gateway/src/agents/catalog.ts`),
so an installed plugin cannot take a built-in name or schema.

Any other plugin is **installed**, and the record is a file: `plugins.json` in
the owner's private directory names each plugin, its version, its package
directory and its entry point. Every long-running entry point loads it once
before building a registry, and installed manifests stand where compiled-in
ones do. The record is not in Postgres on purpose: "what is installed here" is
the question an owner asks when something is broken, so `buddi plugins list`
answers with the database down.

**Core does not load plugins.** The composition root does
(`packages/gateway/src/plugins/load.ts`). A plugin that does not load becomes a
reported problem and everything else loads.

**Installing runs someone else's code.** It is explicit (`--yes`), and the
owner sees the whole contribution first: every tool with its tier (the `auto`
ones counted in the headline and listed first, because they run the first time
a model calls them), the schema, what runs on a timer, the hosts, the proposed
agents. The owner accepts or refuses that, and so trusts the author's tiering
along with the code. The summary is rendered by pure code
in core (`packages/core/src/plugins/contribution.ts`) and says plainly that
reading it already imported the module. There is no sandbox.

**A plugin proposes agents and skills; it never installs one.** Acceptance goes
through `platform.accept_plugin_agent` or `platform.accept_plugin_skill`:
`gated`, validated first, previewed as the whole grant, and refusing the
`platform.*` write tools as `create_agent` does. The accepted file lands in the
owner's directory and is theirs. A sidecar records which plugin and version
proposed it; an upgrade reports drift and rewrites nothing, because a file an
upgrade could rewrite is a grant an upgrade could widen.

**Uninstall removes the code and keeps the data.** The schema stays, with its
row count printed; `--purge` is a separate, irreversible verb that prints what
it destroys first. Uninstall disables the plugin's suggested missions, cancels
their queued jobs and rejects approvals pending on its tools. It refuses while
an agent's grant still names those tools, because an unresolvable tool stops
the catalog from loading.

## Agent roles

An agent file may declare `roles: [overview, recap]`: kebab strings whose shape
core validates and whose meaning it does not. A role is the only way a surface
or a suggested mission asks for an agent. buddi's surfaces look up four
(`packages/gateway/src/agents/roles.ts`):

- `overview`: `/status` runs its holder, and `sentinel-wake` speaks through it.
- `recap`: `/recap` runs the recap mission with its holder.
- `maker`: `/new` hands the chat to its holder, which opens the interview.
- `front-desk`: the agent to go to when the owner does not know who to go to.

Telegram's menu carries `/new` only while a `maker` holder exists and can run,
and it is republished when the catalog reloads.

`agentForRole` returns the first claimant in declaration order, or a typed
problem. A role nobody claims is a configuration state: the surface says so in
one sentence and names the frontmatter key. The gateway never contains the name
of somebody's agent.

An agent's Setup tab offers the four as chips under Access, says which agent holds each one
now, and keeps any other role in a line of text below them.

## What the agent is told about the surface

Every run gets a paragraph of facts about where the owner is (`packages/core/src/surfaces.ts`): whether markdown renders, whether tables do, the message cap, whether files and buttons exist, whether a canvas is there, whether anyone can answer. The rules follow from the facts; the paragraph states no rule. One fact is about reading: on Telegram, "the owner reads this on a phone, between other things: lead with the point, keep to a few short sentences, and offer detail rather than giving it." The dashboard and the terminal carry no such line. The bot's `/help` says the same to the owner, so nothing about how buddi speaks on the phone is calibrated out of sight.

## Conversations, questions and offered actions

A conversation is the unit of context, and it ends by itself
(`packages/gateway/src/surfaces/conversation-lifetime.ts`). The previous
conversation is judged when the owner writes, never mid-turn, on two axes:
**idle** (three hours) and **size** (80,000 characters of transcript). Either
ends it. A boundary is one of context, not identity: memory and the owner's
profile survive; a pending approval survives, and its run resumes the
conversation that proposed it; offers do not; an empty conversation never
ends; a database failure degrades to carrying on. The owner is told in one
line what carried over. What the model sees is in
[conversations.md](conversations.md).

**A failed turn is closed.** In order: close the turn in the transcript, write
the cause chain to the log, say something human, offer a retry only when a
retry is honest. A dangling `tool_use` is answered first, because the API
requires one result per call, and a marker says the message above was not
answered, so the next turn cannot mistake a dead turn for a done one.

**A message sent while the agent works joins that run.** It waits in
`core.pending_input`, not `core.messages`: it arrives mid-tool-call, and a user
row between a `tool_use` and its `tool_result` makes the transcript
unreplayable. Its states (`pending → leased → delivered`, or `pending →
promoted`) survive a restart. The run takes it after every tool call of a turn
is answered and before the next model step, framed as "the owner adds: …" in
that tool-results turn. A lease is not a delivery: rows are marked delivered
only once a model has seen them, so a step that never happens hands them back.
What no run took becomes the next turn, in order. Files are refused in a
sentence rather than queued.

**Asking is a tool-dispatch boundary.** A successful tool marked
`waitsForOwner` (`conversation.ask`) blocks every remaining call in that run,
including later calls in the same batch. The model may finish its question as
text, with tools withheld. A failed call does not set the boundary, and tool
output cannot forge it.

**The agent that asked owns the answer.** The owner's next message is claimed
by the agent that called `conversation.ask` (tier `auto`: it sends nothing and
authorizes nothing), or, as a narrow fallback, by one whose reply plainly ended
in a question. The claim covers one message, expires after fifteen minutes,
and is released by anything plainly new: a slash command, an `@handle`, a long
message, an imperative. Answering with a question still answers.

**Offered actions are a shortcut for typing a sentence, not a capability.** An
agent may end a turn with a few next moves (`conversation.offer`). Taking one
runs that agent with the prompt it wrote, and every tier, approval and preview
applies as usual: a tapped "Send it" still reaches `email.send`, which still
stops and shows every recipient and the whole body. The tap carries an id and
nothing else. The claim is atomic, so a tap on Telegram and a click on the
dashboard produce one run and one "already taken". Offers expire.

A chip clicked in the conversation that offered it is sent as a turn of that
conversation, stamped `offer:<label>`. Anywhere else (the Offers page, a
Telegram button) it is a queued `agent-run` placed in the offer's conversation.
Rendering branches on whether a surface declares the owner can tap something,
never on the surface's name.

## The attention model

A surface answers "who is waiting on me" at a glance
(`packages/gateway/src/web/attention.ts`). Exactly two things count:

1. **A pending approval.** A run proposed a gated effect and stopped. It is
   drawn as a count. One raised inside a delegation counts for every agent that
   asked on the way down.
2. **A held question.** A turn called `conversation.ask`. It is drawn as a dot,
   because a question is not a quantity.

**Activity is not a state.** A dot that is always lit is a dot the owner stops
reading, so triaged mail puts no number on an agent's face, and there are no
unread counts.

Both are projected from the event log, so a badge survives a reload. A
question stops counting on the same fifteen-minute timer that releases the
routing claim, so nothing gets stuck lit. A stream frame only means "ask
again", so one place decides what counts as waiting.

The dashboard draws this as a rail of agents grouped by role, in a fixed
order. An agent that cannot run is greyed, with the reason on hover.

**Notifications are rows, not state.** What buddi tells the owner unasked
goes through one call, `notifyOwner` in core, which writes a row in
`core.owner_notifications` and routes it by urgency and presence
([notifications.md](notifications.md)). A row records where the message
went and whether it was seen or acted on; it never lights a permanent dot.
The two things above stay the only things that count as waiting, and an
unseen notification adds nothing to them.

## The canvas and view descriptors

The dashboard is chat-first: a conversation with a panel that draws what the
answer cannot say. The panel is built from the transcript's tool call and
result pairs.

- **The mapping is data, not a function.** A `ViewDescriptor` names a tool, a
  renderer and paths into the result. It is serialised to JSON; no plugin code
  runs in the page. The paths are not an expression language: a descriptor
  that needs arithmetic belongs to a tool that should return the number. A
  malformed descriptor is a startup error naming the plugin, tool and field.
- **The renderers are generic:** `timeseries`, `table`, `bars`, `keyvalue`,
  `document`, `diff`, `terminal`, `image`, `preview`, `envelope`,
  `structured` (`packages/core/src/views.ts`). Shapes, not domains; a test
  keeps domain words out of the web bundle. An unknown renderer falls back to
  `structured`.

Precedence, highest first: an explicit `canvas.show` from the agent; a
plugin's descriptor; a fallback that infers shape from the result. Inference is
about shape, never meaning ("an array of objects that mostly agree on their
keys is a table"). Where it guesses about money it chooses a format, so a wrong
guess prints `1200` instead of `$1,200.00`, never a wrong number. A gated call
awaiting the owner overrides all of it with the approval envelope.

**A result earns a tab by having something to draw**: points, bars, a document,
a table with rows, a list or record carrying figures. A receipt, an empty
result and a wall of prose do not; a failure always does. Tabs that do not fit
go behind an overflow, which carries a dot when something hidden failed.

The owner's profile panel is the one renderer an agent cannot reach, so no
agent can draw a convincing properties panel with data it made up.

## First run

A fresh installation's first contact is a conversation, not a form
([onboarding.md](onboarding.md)). The interview is a skill the shipped agent
follows (`examples/skills/first-run.md`): one thing at a time, read the profile
before asking, record each answer as it comes. There is no script in the code.
The claim to run it is one conditional upsert, so two surfaces racing the same
first message produce one interview. The `owner.*` tools that record it are
`auto`: nothing they do is irreversible or leaves the machine.

Then a daily mission, `getting-started`, tries for about two weeks to show the
owner one useful thing that is true for them, found by calling a tool that day.
"Just checking in" is forbidden. It ends by itself:

- **The rule is in a skill** (`examples/skills/earning-attention.md`), where the
  owner can read and change it.
- **The budget is in code**, because a model cannot hold a counter it cannot
  see: a maximum number of messages, a minimum gap, a cap on consecutive
  unanswered ones, and a window after onboarding beyond which the arc never
  opens. Declining the interview closes it too.
- **The refusals are ordered and named**, so the event log records why it went
  quiet.

The last message is the one allowed to carry no finding: it says it stops
suggesting things and how to reach the agent.

## Computer access

### Host execution

`host.exec` runs Bash, Python and other utilities on the host. Its first
command asks for Allow once, auto-mode for the conversation, or Always for this
agent. Only tools that opt into `reusableApproval` hold standing permissions,
scoped to owner, agent, tool and version, and to one conversation or,
explicitly, all. Every command still creates a hashed action and runs through
the Executor and the effect ledger, and the Executor rechecks the permission
before dispatch. Delegates never inherit it, a tool upgrade needs reapproval,
and revocation is an authenticated dashboard or Telegram control, never a
model-facing tool.

This is unrestricted code execution as the host user, **not an OS sandbox**. A
working directory, a clean environment, a timeout and process-group
cancellation do not keep a command away from other files, the network or
credentials on disk. Staying within the task is model conduct, not a security
boundary. See [host-execution.md](host-execution.md).

### Browser and native apps

The `browser` plugin has three backends behind the same `browser.*` tools
([browser.md](browser.md)):

- **The agents' own browser** (Playwright), the default: a dedicated persistent
  profile, per-conversation tab controllers, public-web egress through a
  DNS-checked proxy.
- **Your browser**: the Chrome extension (`packages/extension`), working in the
  owner's own Chrome in background tabs.
- **Use my apps**: native control on macOS 14 and up. A fixed Swift helper
  uses the accessibility tree, capture of the selected window only, and
  synthesized input; no shell, AppleScript or browser debugging is exposed.
  Apps beyond the browser need an owner allowlist entry, one conversation
  controls the desktop at a time, and secure fields are masked.

An agent cannot tell which backend answered. buddi never switches backend on
its own when a permission or a site fails.

**Authority.** `browser.act` is a `session`-tier tool. An authenticated owner
request ("book an appointment on this site") authorizes the actions needed to
finish that task within the owner's stated constraints; routine navigation,
form entry and the requested submission do not each ask again. The agent asks
when a choice is missing or an action would exceed the request. A page, a tool
result or another agent cannot supply owner authorization. The registry checks
the request's provenance, expiry and the agent's grant; the host controller
adds ownership, step and time limits, network restrictions and owner-only
revocation. Scheduled, source and delegated runs never hold this authority.
Release and Stop end input and never quit the owner's apps.

**Page content is untrusted input**, like mail: evidence, never instructions.

## Actions and approvals

Nothing at tier `gated` executes without an approval bound to an **immutable
action object** created before the approval request
(`packages/core/src/actions/`):

- It carries the tool and version, canonical arguments, artifact versions and
  hashes, **the full effect envelope** (every SMTP recipient including BCC,
  the body, attachment hashes), preconditions, an expiry and a policy version.
- The preview is **rendered from this object, never from model-written text**.
- A meaningful edit invalidates the approval. Execution atomically claims the
  approved action, rechecks authorization and persists the outcome separately.
- Policy version 2 hashes the resolved effect envelope with the tool, version
  and arguments. Before dispatch the Executor describes the effect again, with
  the original agent identity and preview clock, and refuses changed state.
  Tools that resolve mutable inputs check their final snapshot against
  `ctx.approvedEffect` just before use.
- An action may carry **choices** the tool declared at describe time (which
  alias to send from). They are part of the hashed action, and the owner's pick
  is validated against them.
- States: `pending → approved → executing → succeeded | failed | unknown`, plus
  `rejected`, `expired`, and `refused` for an approved effect that no longer
  matches and so never left the machine. A timeout after dispatch is
  `unknown`, never failed.
- Tool contexts carry a cancellation signal. An effect deadline signals it and
  keeps `unknown` completion, since an external effect cannot be retracted.
  Losing the queue lease and worker shutdown abort active runs, delegated runs,
  provider requests and retry waits. Plugins honour it before each external
  operation: cooperative cancellation, not process isolation.
- **Approvals resolve from any paired surface** (the terminal, a Telegram
  callback, the dashboard), racing on the same atomic claim. The run suspends
  durably meanwhile and is resumed by the decision, not by a waiting worker.

## Email ingestion

Email is a plugin (`packages/tools/email`) that uses both acting contracts: an
IMAP **source** (mail arrives, a triage run starts) and an SMTP **effect tool**
(the agent proposes, an approval gates, the ledger records).
[email.md](email.md) covers accounts, threads, policies and watchers.

- Identity is `(account_id, mailbox_id, uidvalidity, uid)`, unique, because
  UIDs are not stable alone (RFC 9051).
- The **mailbox occurrence** is separate from the **logical message**;
  Message-ID is evidence, not a key. Ingested rows, trigger creation and cursor
  advance commit in one transaction.
- Triage state, drafts and send attempts are separate records. Drafts are
  artifacts: the body is saved in the core artifact store and the draft row
  points at that version, so an approval references a version and the preview
  is what ships.
- **A new mailbox starts at now.** The cursor is planted at `UIDNEXT - 1`
  (`EMAIL_BACKFILL` lowers it). A UIDVALIDITY reset is a new mailbox too.
- **Every IMAP call has a deadline**, thrown so the source tick records it as
  that source's `last_error`.
- **Reading never mutates.** Every fetch is a peek, so `\Seen` stays what the
  owner's mail client made it. The poll re-reads flags changed elsewhere,
  incrementally where the server supports CONDSTORE.

### Email adapter

Transport is separate from authentication. IMAP (`imapflow`) and SMTP are the
transport; `app-password` and `xoauth2` are auth modes behind one `EmailAuth`
interface (`packages/tools/email/src/ports.ts`). This build accepts
`app-password` and refuses `xoauth2` at configuration time with a typed
problem. An app password is a powerful bearer secret that buddi's scoping does
not narrow upstream. Verified TLS is required. Nothing in core mentions IMAP or
SMTP.

## The web plugin

What happens when an agent reads text a stranger wrote and nobody sent? The web
plugin is a capability, not a persona: `web.search`, `web.read` and
`web.status`, all `auto`, granted only by an agent's own `tools:` line
([web.md](web.md)).

Searching changes nothing, so it is a read. It is not free of consequence: **a
search sends the owner's question, in their words, to a third party that logs
it**. So the backend is owner configuration, and no tool lets a model change
it.

**Everything fetched is untrusted text.** No sentence on a page can change an
agent's rules, grant a tool, raise an urgency or authorise a send. The rule is
written in every tool description, every result payload, a shared skill and
web.md, on purpose. The extractor drops `<script>`, `<style>`, `<svg>`,
`<noscript>`, page chrome, HTML comments with their contents, and every
attribute. Each result item carries its own `source` and `url`.

**Address blocking** lives in core and applies to every plugin's requests
through `ctx.buddi.http` (`packages/core/src/host/`), so no agent reaches the
dashboard or the database. The guard refuses, in order: any scheme but `http`
and `https`; any port but 80 and 443, before DNS; embedded credentials; local
suffixes (`localhost`, `.local`, `.internal`, `.home.arpa`, `.lan`); then every
resolved address in loopback, private, link-local, CGNAT, multicast, reserved
and documentation ranges, in IPv4, IPv6 and IPv6-wrapped IPv4. **The guard is
the socket's own resolver**, so the address approved is the address dialled.
Redirects are walked by hand, at most three, each through the whole guard.
Size limits apply to the byte stream, not to `content-length`.

`web.fetches` is an audit log, not a cache: agent, time, purpose, host and
outcome, with no page bodies. Its `blocked` rows record attempts to reach a
place an agent may not.

**Where searching happens is a runtime decision.** An agent on Anthropic
searches natively on its own credential, and `web.search` is withheld from it
so the model has one way to search. `web.read` is never withheld, because the
guard is what makes fetching safe. Native search honours a grant, never goes
around one, and writes the same audit row. On that path the untrusted-content
notice cannot travel in the tool result, so a system-prompt paragraph stands in;
`BUDDI_SEARCH_PROVIDER=tavily` is the supported alternative.

## Sentinels

A **sentinel** is code that runs on a period, reads its own plugin's schema,
and returns findings: no model, no prompt. A finding is a key, a severity
(`urgent` or `info`), a title, a detail and optional evidence.

What happens to a finding is core's decision, in `runSentinels`
(`packages/core/src/sentinels/`). No plugin can decide to interrupt the owner.

- **`urgent`** enqueues `sentinel-wake`, a mission the gateway ships, with the
  finding as payload. Its prompt says the finding is evidence, not a verdict:
  verify it with tools, then report in under 600 characters with one
  recommended action, or go silent with a reason.
- **`info`** goes into a weekly digest, deduped on the key, folded into
  whichever mission the `recap` holder runs. The digest is consumed after
  delivery, so a failed recap leaves the items pending.
- **Cooldowns are arithmetic**: 24 hours for `urgent`, 7 days for `info`. A
  finding speaks when it is new, when it resolved and came back, when its
  cooldown ran out, or when it escalated from `info` to `urgent`. A key the
  sentinel stops returning is resolved, which clears its cooldown. A snoozed
  finding never fires.

Sentinels run on their own 30-second loop. Like sources, the period is a
ledger (`core.sentinel_runs`), not a timer, so a machine that slept finds
everything due at once. A sentinel that throws records its error; its findings
are ignored, because a partial list is not evidence that anything resolved.
The owner can switch a sentinel off (`core.sentinel_switches`).

**Silence is the default.** A scheduled run speaks only if it called
`mission.report`. A run that calls neither `mission.report` nor
`mission.silent` is silent with the reason `no-decision`, and a warning is
logged. `alwaysDeliver` is the exception the owner turns on; the weekly recap
carries it.

## Scheduling and catch-up

- **Occurrences** are materialized rows, unique on `(mission,
  schedule_revision, instant)`, so they are idempotent by construction. "Last
  occurrence materialized" is distinct from "last successful run".
- Each mission has a **misfire policy**: `replay-all`, `coalesce`,
  `latest-only` or `skip-after-deadline`. A week asleep does not produce a week
  of stale briefings.
- Event-triggered work carries its own source-event dedup key.
- Each schedule stores its timezone, and DST behaviour is defined.

### Reminders and agent-proposed schedules

A **reminder** is a single instant an agent promised to look at.
`reminder.set` is `auto` because a reminder cannot do anything: it wakes an
agent with a note and the instruction to check with its tools that the fact is
still true, then report or go silent. The limits are arithmetic, in code, and
visible to the owner (`BUDDI_REMINDER_*`): pending wake-ups per agent and in
total, a minimum lead, a horizon, and a grace period after which a reminder is
`expired` rather than fired, because "pay the card before midnight" delivered
the next day is wrong, not late.

**`schedule.propose` is `gated`.** A standing schedule costs model calls
indefinitely, and the owner did not type it. The cron is parsed in `describe`,
so an unparseable one is refused before any approval; nothing more frequent
than hourly is accepted; the preview names the cadence in words, the next
three instants in the owner's zone, and the exact instruction. Only
`executeApproved` writes the mission, with the agent id taken from the action,
and `alwaysDeliver: false`. `schedule.cancel_mine` is `auto`: an agent may
always take its own foot off the pedal.

Goals, a target with a clock over a plugin's metric, are in [goals.md](goals.md).

## Effectful side effects

Exactly-once at the wire is impossible: RFC 5321 accepts duplicate delivery,
and so do most mutating APIs. buddi offers **durable intent, controlled
retries and explicit uncertainty** instead. The **effect ledger**
(`core.effect_attempts`, generic and core-owned) records the exact envelope
before dispatch for any non-idempotent external effect. An ambiguous completion
(a crash, a timeout) marks the attempt `unknown`, which needs the owner's
review and is never retried blindly. Every effect tool uses the same ledger.

## Queue, concurrency, recovery

Even one agent overlaps: Telegram input, mail ingest, retries, restarts. So
buddi has a durable Postgres queue (`core.jobs`) with atomic claims, leases,
bounded retries with backoff, and an inspection path (`buddi jobs`). Work per
conversation and per mail thread is serialized; drafts carry optimistic
versions. Runs **suspend durably** while awaiting approval, with no worker or
transaction held open. Tool intent and result are persisted, so recovery never
re-runs a completed effect. A job whose worker died is reclaimed once its lease
expires. `buddi pause` and `buddi resume` stop and restart all work.

**Two retry horizons**, because somebody waiting is a different problem from
nobody waiting (`packages/core/src/queue/retry-policy.ts`). A failure is
classified first (transient, permanent or `unknown`) over the whole cause
chain. An interactive run gets three attempts inside fifteen minutes. An
unattended one gets eight attempts over rising delays inside six hours,
whichever bound comes first. `unknown` is retried only on the short horizon.
The long wait lives in the queue, not in a process holding a lease.

**Failures have two audiences.** The whole cause chain (every wrapped `cause`,
every `AggregateError` member, bounded in depth) goes to the log. The owner
gets a sentence written for a person: no tool names, no stack. Both come from
the same classifier, so the sentence and the offer of a retry always agree. A
retry is withheld for a permanent failure and for a turn that already called a
tool.

**A restored installation starts in recovery mode** (`core.recovery`): its
loops stay off until the owner has been through a checklist, so it does not act
on the queue of the day the backup was taken ([operations.md](operations.md)).

### The dead-letter watch

Silence means nothing needs the owner, and a dead job breaks that: a network
blip kills a dozen triage runs and mail stops being read, silently. So a job of
an unattended kind that reaches `failed` is watched.

- Exhausted attempts and a permanent error are the same to the owner: the work
  is not going to happen.
- The incident is reported **once**, on a fixed window after the first death,
  so an outage that never clears is still reported. A long gap ends the
  incident.
- The state lives in `core.system_flags`, so a restart does not announce it
  again.
- The message is plain and grouped by what was lost ("Mail is not being
  read"), says nothing more is sent about this outage, and gives the two
  commands: `buddi jobs --state failed` and `buddi jobs retry --all`.
- **Dead jobs are never retried on restart**, because a restart is unrelated to
  the outage clearing. Re-running them is the owner's verb, and it lifts the old
  attempt cap.

## Offline contract

While the machine sleeps, mail sync and schedules catch up: they are durable
sources. Telegram does not: it keeps undelivered updates for about a day.
Telegram updates are persisted (`core.surface_updates`) before the polling
offset advances. On resume, pending approvals are refreshed and durable sources
reconciled. A webhook source needs the sender's own retention, or an always-on
relay the owner opts into.

## Runtime provider port

The runtime talks to models through a `RuntimeProvider` port with two wires,
Anthropic Messages and OpenAI Chat Completions (`packages/core/src/provider.ts`,
`packages/runtime/src/`).

### Named provider accounts

The serving composition root resolves **agent → account and model → wire
adapter**. `core.provider_accounts` holds named, versioned account metadata and
vault references; `core.agent_provider_accounts` holds each agent's account and
model. No secret enters Postgres or the browser. A compatible endpoint uses the
OpenAI wire without claiming to be OpenAI. The assignment overrides provider
and model frontmatter; the agent file owns persona, tools, language and turn
budget. There is no cross-account fallback.

A run pins its account and model. Before each model call the account's revision
is checked and its credential read, so a disabled or edited account stops the
next call; a changed assignment never redirects a run in flight.
[providers.md](providers.md) has the detail, including experimental
subscription accounts.

### Provider invariants

- **`ProviderRef` is a discriminated union.** Provider, credential source and
  wire are one choice, so "subscription token plus custom base URL" (token
  exfiltration) is hard to express. `PROVIDER_CREDENTIAL_INVARIANT` names the
  rule and tests assert it.
- **Resolution is a result union**: `{ ok: true; provider } | { ok: false;
  problem }`. Configuration failures are typed problems; defects fail loudly.
- **No ambient credentials.** Clients are built with explicit credentials bound
  to approved endpoint origins, and nothing mutates `process.env` per agent.
- **A model never migrates between providers.** The catalogue validates within
  the pinned provider. An endpoint is a data destination, so a silent re-route
  is not consent.
- **Per-run snapshot.** `run.started` records the provider, the concrete model
  and its capabilities.
- Token, turn, time and concurrency limits apply to every run. Provider
  continuation state is never transferred between providers.

### Credential kinds

On the Anthropic wire, **`api-key`** is the `x-api-key` header, and
**`subscription-token`** is the `sk-ant-oat01-…` token from `claude
setup-token`, sent as `Authorization: Bearer`. `/v1/messages` accepts that
token only when the first `system` block is exactly `You are Claude Code,
Anthropic's official CLI for Claude.`, as its own block, so the adapter sends
that two-block form for this kind. It bills the owner's subscription, and
using it outside Claude Code is the owner's decision under Anthropic's terms.

On the OpenAI wire, **`api-key`** is the only kind. The Claude Code identity
block and Anthropic model names never reach it: an OpenAI agent reads
`BUDDI_OPENAI_MODEL` or the default `gpt-5`.

Credentials come from the vault, or from `.env` by explicit name; the adapter
never reads the environment ambiently.

### Capability matrix

`providerCapabilities(kind)` (`packages/runtime/src/capabilities.ts`) states
what each adapter carries: streaming tool arguments, images, documents,
tool-result ordering, parallel tool calls, cancellation, usage reporting and
native web search. A row is what this adapter implements, not what the vendor
sells. The loop consults it and degrades what the provider cannot carry into a
placeholder: a PDF sent to Chat Completions becomes a sentence naming the file.
The transcript keeps the artifact reference, so an Anthropic agent still gets
the file. Both adapters share one retry policy (`Retry-After` honoured, capped
at 60 seconds).

A missing credential for one agent never takes the catalog down: that agent
is marked unavailable with the typed problem, and the run path fails closed.

### One outbound HTTP transport

Node's `fetch` pools connections and keeps HTTP/2 sessions. When the far end
closes an idle session, every later request in the process fails at once
(`ERR_HTTP2_INVALID_SESSION`, no packet sent), and retries draw the same dead
session.

So there is one transport (`packages/runtime/src/transport.ts`), on
`node:https`, HTTP/1.1, **keep-alive off**: nothing is held between requests,
at the cost of one TLS handshake per request. Its single retry covers only a
reused idle socket with no response byte received, because `email.send` sits
downstream; an aborted request is never retried. It owns a byte-stream size
limit and a pluggable `lookup`, which is how the address guard becomes the
socket's own resolver. Every caller uses it, including the Telegram long poll,
and `check-boundaries.mjs` refuses a bare `fetch`, an `undici` import or a
hand-rolled agent. The dashboard's browser bundle uses the browser's `fetch`.

## Memory

Four kinds stay separate: **conversation history**, **run checkpoints**,
**explicit preferences** (owner-authored, versioned, correctable) and
**derived memories** (with provenance).

- Memory informs reasoning and **never grants permission or approval**. A
  "fact" taken from hostile mail is a lasting prompt injection unless it has
  provenance and can be deleted.
- Publishing to shared memory is explicit.

Conversation history is core's (`core.messages`); run checkpoints are the event
log. The `memory` plugin (`packages/tools/memory`) owns its schema and the
other two:

- **Preferences are versioned.** A correction is a new revision; the previous
  one is superseded, not overwritten.
- **Notes carry provenance**: the agent, the conversation, a scope that is
  private unless shared explicitly, an optional expiry, and a soft delete so
  the row stays auditable.
- Recall is a keyword search.

Every memory tool is `auto`. [learning.md](learning.md) covers how buddi
proposes changes and the owner keeps them.

## Secrets and operations

Rotation, backup/restore, and log redaction are specified:

- **Vault.** Secret values live in the OS keychain (service `buddi`), or in a
  file vault (`~/.buddi/vault.json`) encrypted with `BUDDI_VAULT_KEY`, held
  outside the file and the database (`packages/core/src/vault/`). A secrets
  *table* would hand mail and model credentials to anyone with the database
  file. `core.secrets` holds the owner's secret names and bindings, never a
  value.
- **A locked vault fails closed.** An unattended mission that needs a secret
  fails with a typed problem; it does not hang or fall back to a prompt.
- **Owner secrets** are used and never seen: an agent asks for delivery to a
  destination a plugin registered ([owner-secrets.md](owner-secrets.md)).
- **Backup and restore** are owner-run commands over the database, the artifact
  files and the owner's private directory. Secrets are never in an archive
  ([operations.md](operations.md)).
- **Rotation.** `buddi db secure` rotates the database password, idempotently,
  and refuses a credential it did not issue. A provider key is replaced in
  Settings → Model accounts; any other secret is set again in the vault.
- **Redaction.** Every text that leaves core for a model, a log, the canvas,
  Activity or Telegram is scrubbed for every stored value and its common
  encodings, each match replaced by `‹secret:NAME›`
  (`packages/core/src/secrets/scrub.ts`). `redactDatabaseUrl` masks the
  password wherever a connection string is printed.
- **Observability** is the event log: run, step and action ids, queue age, ingest
  lag, retry counts, approval age, provider usage. Policy decisions are stored
  with their reasons, never reconstructed from model reasoning. Sensitive
  content (draft bodies, mail) lives apart from event metadata, so retention
  and deletion stay possible.

## Data model

Four things are deliberately **not** tables:

- **No `agents` table.** An agent is a markdown file on the search path, and
  its `tools:` line must be reviewable in a diff. (The account and model it
  runs on are rows; see "Runtime provider port".)
- **No `runs` or `steps`.** A run is a span in the event log, from
  `run.started` to `run.finished`, with `tool.called` and `tool.result`
  between. Durable work is a row in `core.jobs`, which is a unit of scheduled
  work, not a transcript.
- **No installed-plugins or tool-registry table.** Installation is
  `plugins.json`; the registry is built in memory from the manifests.
- **No memories in core.** Memory is a plugin with its own schema.

What core owns, in the `core` schema (`packages/core/migrations/`):

| Area | Tables |
| --- | --- |
| Owner and surfaces | `owner`, `surface_identities`, `pairing_codes`, `surface_conversations`, `surface_active_agent`, `surface_cursors`, `surface_updates` |
| Conversations | `conversations`, `messages`, `pending_input`, `questions`, `offers`, `groups`, `group_members`, `group_requests` |
| Event log | `events` (append-only) |
| Scheduling | `missions`, `schedule_specs`, `occurrences`, `last_materialized`, `reminders`, `goals`, `goal_checks` |
| Queue | `jobs` (lease, attempts, unique `dedup_key`, failure class), `system_flags` (pause, dead-letter state), `recovery` |
| Watchers | `sentinel_runs`, `sentinel_findings`, `sentinel_switches`, `digest_items`, `source_runs` |
| Files | `artifacts`, `artifact_uses`, `surface_attachments`, `surface_last_attachment`, `plugin_files` |
| Authorization | `actions` (immutable), `approvals` (state machine), `effect_attempts` (ledger), `tool_permissions` (standing grants) |
| Owner state | `onboarding`, `proposals`, `agent_avatars`, `web_settings` |
| Providers | `provider_accounts`, `agent_provider_accounts`, `provider_settings`, `provider_credential_state`, `provider_account_migrations`, `plugin_account_bindings` |
| Owner secrets | `secrets`, `secret_bindings`, `secret_uses` (values stay in the vault) |

**Plugin-owned schemas.** `email` holds `accounts`, `mailboxes`, `messages`
(the identity quad), `drafts`, `triage` and the rest of the mail plugin's
tables; `memory` and `web` own theirs (`web.fetches` is the whole of the web
plugin's). Each is versioned with its plugin and kept on uninstall unless
purged.

**Artifacts are core's.** The `artifacts` plugin owns no schema: approvals,
transcripts and runs all reference artifacts, and removing a plugin must not
take the owner's files. The plugin adds the agent-facing reads over the store
([files.md](files.md)).

## Repo layout

```
buddi/
  packages/
    core/        domain, db, event log, queue and leases, scheduler, sentinels,
                 sources, views and pages, actions and approvals, offers,
                 reminders, goals, onboarding, trust registry, vault, secrets,
                 the plugin host API
    runtime/     agent loop, RuntimeProvider port and the Anthropic and OpenAI
                 adapters, capability matrix, native-search planning,
                 delegation, the shared HTTP transport
    gateway/     composition root: surfaces (telegram, chat, web), owner
                 identity, agent catalog, missions, plugin install, load and
                 uninstall, `buddi mcp`, and the tool families that own no
                 schema (canvas, reminders, schedule, owner, platform,
                 delegation, learning, goals)
    cli/         the `buddi` command: init, doctor, db, service, backup,
                 plugins, vault, jobs, mcp
    install/     the packaged install: data directory, bundled Postgres,
                 supervisor, launcher, upgrade
    extension/   the Chrome extension behind the "Your browser" backend
    tools/       the platform plugins: email, memory, artifacts, web, browser,
                 host. They import core; core never imports them. Domain
                 plugins live in their own repositories and are installed
    web/         dashboard UI (React, Vite): chat, canvas, agent rail,
                 approvals, settings, plugin pages
  examples/
    agents/      the shipped personas (concierge, agent-father), replaced
                 whole by an owner's file of the same id
    skills/      shared skills that load for every agent
    plugins/     weather, the worked example plugins.md builds
  private/       gitignored: this owner's agents, skills and plugins.json
  docs/          reference pages; README.md is the index
  scripts/       migrate, check-boundaries, install and release scripts
  docker-compose.yml   Postgres for a developer checkout
  .env.example         configuration, with every default shown
```
