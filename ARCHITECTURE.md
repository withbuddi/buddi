# Buddi — Architecture

A personal AI agent platform: specialized agents with real access to your data and tools,
reachable from any surface (web, phone, Telegram, native apps later), running scheduled and
event-driven work on your behalf — with mechanically enforced human-approval gates before
anything irreversible.

Reviewed by Codex (2026-09); critical findings incorporated. Revised 2026-09-11 to move
tools out of core behind explicit plugin contracts (effect tools + sources). The contracts
below are requirements, not aspirations — anything marked *fail closed* is a test case.

## Design principles

1. **Agents are not bound to surfaces.** Every surface is a thin adapter; Telegram, web UI,
   future native apps are equal.
2. **Trust is enforced in code and fails closed.** Unknown tools, invalid arguments, and
   missing configuration never execute. No agent-defined path can lower a gate.
3. **The machine sleeps — and some things cannot be recovered.** Scheduled work is
   catch-up by construction; sources with lossy retention (Telegram: ~24h for undelivered
   updates) get an explicit offline contract, not a hope.
4. **The AI layer is a swappable port, routed explicitly.** Provider choice is an
   authorization decision (it decides where your data goes) — never silently migrated.
5. **Single install, single owner.** One installation owner identity from day one
   ("multi-user later" is a rewrite, not an auth layer; only the owner concept is designed
   in now). Runs on the user's machine. Note: "local" does not mean "data never leaves" —
   prompts sent to cloud models are a data flow, per-agent provider choice governs it.
6. **The core is the trust boundary — nothing else is core.** Every world-touching
   capability (email, filesystem, computer-use) is a droppable plugin behind one of two
   contracts: an **effect tool** (agent-proposed, gated by the action/approval machinery)
   or a **source** (system-invoked, originates work). Core with zero plugins installed
   is a valid, running state; droppability is enforced by dependency direction (core
   never imports tools), not by a runtime plugin framework.

## Technology decisions (ADR-style)

| Decision | Choice | Why |
|---|---|---|
| Language | TypeScript (Node) | Owner's comfort; one language across gateway, agents, web UI |
| Database | PostgreSQL | State, queue, event log, effect ledger. One install path (docker-compose); plugin families ship their own schemas |
| Email | IMAP transport + per-account auth; Gmail app password for v1 | Gmail OAuth restricted scopes force either verification (CASA, costly) or testing mode — and unpublished apps' refresh tokens **expire weekly**, unusable for an unattended system. App passwords work on personal Gmail today (not under Advanced Protection; revoked by password change). No cross-provider promise: Exchange Online killed basic auth — the `EmailProvider` port's second auth mode is OAuth XOAUTH2 **on the same IMAP transport**, not a new stack |
| AI runtime | Own thin agent loop behind `RuntimeProvider` port | Hard requirement: provider swap. Design borrowed from Foreman, modified (see "Runtime provider port") |
| Deployment | User's machine | No infra, user-owned, data local (modulo cloud-model data flow above) |
| Computer access | Host computer-use (a11y tree + vision + synthesized input), browser-profile-scoped | CDP/browser automation is in-page detectable — serious sites (banks) flag it; OS-level input leaves no artifacts. CDP demoted to fallback for machine-friendly sites |

### Email adapter
Transport is separate from authentication. IMAP (`imapflow`) + SMTP are the transport;
auth modes are `app-password` (v1) and `xoauth2` (later) behind the same `EmailAuth`
interface. App passwords are powerful bearer secrets — buddi scoping does not narrow
their upstream privileges; verified TLS required. The adapter is a plugin
(`packages/tools/email`), not core — nothing in core mentions IMAP or SMTP.

## Process boundaries (modular monolith)

One process, five core modules plus droppable tool plugins, with strict, disjoint ownership:

- **Surfaces** — authenticate the sender, translate presentation. Never create runs.
- **Gateway** — map authenticated identity → conversation; submit *commands*; render replies.
- **Orchestrator** — owns durable runs, scheduling, retries, cancellation, suspension.
- **Runtime** — the agent loop: proposes tool calls, consumes results. Never executes effects.
- **Executor** — the *only* module that authorizes and performs effects, and the only path
  to effectful credentials.
- **Tools (plugins, outside core)** — everything that touches the world: email, filesystem,
  computer-use, browser, calendar. They enter only through registry contracts; core never
  imports a tool, tools import core. An **effect tool** is agent-proposed (`smtp.send`);
  a **source** originates work without an agent in the loop (IMAP polling → triage run).

**Commands vs events.** Commands request work; events record committed facts. Both travel
in versioned envelopes: event id, source dedup key, principal, conversation/run ids,
causation id, timestamp. Accepted input and job creation commit atomically. Notifications
go through a durable **outbox**; streaming to a surface is a transient view of durable
state, never the record itself.

## Owner and surface authentication (Phase 1, not later)

- One **installation owner**, created at setup. All authorization refers to it.
- **Paired surface identities**: a Telegram allowlist of *numeric* user id + private-chat
  id; update-id dedup; never trust usernames, forwards, or chat membership. Web UI:
  session auth, CSRF protection, Origin checks, bound to localhost by default (remote
  access = explicit authenticated transport).
- **Approval callbacks are bound**: a callback resolves exactly the pending action it
  references, from the owner identity. A plain message saying "yes" never resolves
  anything. Resolution from any paired surface races on the same atomic state transition.
- Surfaces establish *identity*; authorization lives in core.

## Trust model (structured capabilities, fail closed)

UX keeps the tier labels (`auto` / `draft` / `gated` / `session`), but enforcement is
structured: every tool call is classified by operation, resource/account, destination,
mutation/disclosure class, and authorization requirement — in a central registry that
agents cannot read or modify. Consequences:

- Classification is by capability, not by name alone: `fetch` to an external URL is a
  *disclosure-class* effect; browser "typing" is an effect, not just "submit"; "read mail"
  must not mutate flags.
- **Unknown tool → refuse. Invalid arguments → refuse.** Agent overrides may tighten
  policy; never loosen mandatory gates.
- Policy tables are inaccessible to agent tools. The Executor holds credentials; agents
  hold none. The registry contract is the *only* thing core knows about tools: no tool
  has a sibling inside core, and removing every plugin leaves the boundary intact and
  the system running.
- External/MCP tools with credentials are trusted code the registry cannot constrain —
  so they enter through **declared manifests** (see "Drop-in tools and skills"): the
  owner classifies each tool at install time; undeclared capabilities fail closed.

## Drop-in tools and skills

Tools and skills are files in the repo (`tools/`, `skills/`), auto-discovered — which is
also what keeps an install reproducible on any machine. The trust lifecycle is the
point, not the packaging — and so is the dependency direction: **core never imports a
tool; tools import core**, enforced by lint (import boundaries) and a CI check that boots
core with the tools directory absent. There is deliberately no runtime plugin framework:
for a single-owner system, "droppable" means *delete the folder and it still boots*.

Not everything that plugs in is the same kind of thing — there are two plugin contracts:

- **Effect tools** — agent-proposed capabilities (`smtp.send`, `fs.write`, `deploy`).
  They always travel the action/approval machinery and only ever execute through the
  Executor.
- **Sources** — system-invoked pollers that *originate* work without an agent in the
  loop (IMAP polling, a webhook receiver). A source carries: a poll schedule, event
  emission with source dedup keys, **transactional cursor advancement** (cursor and
  created events commit together), and an explicit offline/retention contract.
  Email is both: IMAP is a source, SMTP is an effect tool.

- **Manifests.** Every tool declares its operations and requested tier. The **owner
  classifies at install time**; unclassified tools default to `gated`; undeclared
  capabilities fail closed. This is what makes a broadly privileged drop-in like a
  Chrome MCP connection acceptable: declare `navigate/screenshot/read` at `session`
  tier, `click/type` at `gated`, and the registry enforces the rest.
- **Plugin-owned schema.** A plugin family ships its own migrations in a Postgres schema
  namespace (`email.mailboxes`, `email.email_messages`), registered with core at install;
  core's schema contains no tool-specific tables. Uninstall drops the schema and registry
  rows, nothing else. A mission that requires a missing plugin is *uninstallable* — a
  clean configuration state, not a broken system.
- **Agent-created tools** follow a probation lifecycle: *proposed* (code + manifest +
  why) → *owner approval bound to the code hash* → installed with **every call gated** →
  promoted by the owner only after observed behavior. Agent-written code that then
  executes is arbitrary code execution; the immutable-action approval machinery is what
  gates it.
- **"Install anything needed on the computer" is an action, same machinery** — package,
  version, source, and hash in the immutable action object, executed by the Executor;
  installed binaries never inherit buddi's own privileges.
- **Skills** (prompt-level knowledge and procedures — markdown, Claude-Code-style) are
  the low-risk half: agent-authored is allowed, but skills carry provenance like derived
  memory, so a "learned" skill can be traced to its source and deleted. A skill informs
  reasoning; it never grants a tool or lowers a tier.

## Computer access (host computer-use first, CDP demoted)

**Primary actuator: host-level computer use** — screen capture + OS accessibility tree
(macOS AXUIElement / Windows UI Automation) + synthesized input events (CGEvent-class),
driving buddi's **dedicated browser profile window**. At OS level the page sees no
automation artifacts (no `navigator.webdriver`, no CDP/`Runtime.enable` tells) — only a
"person" moving a mouse. Residual detection is behavioral, so the driver acts at
human-ish pacing with jitter.

- **Hybrid sensing**: the accessibility tree gives semantic, precise targets (no OCR
  misclick on "Transfer"); vision covers what a11y can't see (canvas, images). Click
  targets resolve through the tree where possible and are **confirmed before firing on
  money-class pages**.
- **Window-scoped, session tier**: looking freely within the bound window; acting is
  co-driven (approve each action or action type live). Never arbitrary desktop apps.
- **Honest risk framing**: driving your own logged-in bank at OS level is personal-use
  automation against bank ToS — the realistic downside is an account lock, not just a
  blocked page. Gentle reads, co-drive when challenged, CSV drop as fallback.
- macOS: Accessibility + Screen Recording permissions required; screen content includes
  secrets — redaction best-effort, documented as such.
- **CDP as fallback** for machine-friendly sites (own websites, CMS admins) — faster and
  more reliable there, but never the path into hostile pages. The driver tool ships as
  a drop-in with a manifest (look/session, act/gated).

## Actions and approvals (the authorization boundary)

Nothing at tier `gated` executes without an approval bound to an **immutable action
object** created *before* the approval request:

- tool implementation + version; canonical arguments; artifact version/hash;
  **the full effect envelope** (e.g. every SMTP recipient incl. BCC, body, attachment
  hashes); preconditions; expiry; policy version.
- The preview is **rendered from this object**, never from model-written text.
- Any meaningful edit invalidates the approval. Execution **atomically claims** the
  approved action, rechecks authorization, and persists the outcome separately.
- States: `pending → approved → executing → succeeded | failed | unknown`, plus
  `rejected` / `expired`. A timeout after dispatch is `unknown`, never auto-failed.
- Browser actions get bounded session grants (targets, operations, duration, revocation)
  because the page can change under an immutable argument list.

## Email ingestion (first plugin: IMAP source + SMTP effect tool)

Email is not core — it is the first plugin, chosen to prove both contracts at once:
an IMAP **source** (mail arrives → triage run, no agent in the loop) and an SMTP
**effect tool** (agent proposes, approvals gate, ledger records). Everything below is
the email plugin's implementation of the source contract:

- Identity is `(account_id, mailbox_id, uidvalidity, uid)` with a unique constraint —
  UIDs are not stable alone (RFC 9051). Handle UIDVALIDITY resets, moves, expunges,
  flag changes.
- Separate the **mailbox occurrence** from the **logical message** (Message-ID is
  evidence, not a key). Ingested rows + trigger creation + cursor advance commit in one
  transaction.
- Lifecycle is factored: message triage state, drafts, and send attempts are separate
  records — one message can have many drafts and replies. Processing versions allow
  intentional re-triage after a policy change.

## Scheduling and catch-up

- **Occurrences** are materialized rows with a unique `(mission, schedule_revision,
  instant)` constraint — idempotent by construction, not by hope. `last occurrence
  materialized` is distinct from `last successful run`.
- Per-mission **misfire policy**: `replay-all | coalesce | latest-only | skip-after-deadline`.
  A week asleep must not produce a week of stale morning briefings.
- Event-triggered work carries its own source-event dedup key.
- Timezone persisted per schedule; DST behavior defined.

## Effectful side effects (the effect ledger)

Exactly-once at the wire is impossible (RFC 5321 acknowledges duplicate delivery; the
same holds for deploys, payments, and most mutating APIs). The guarantee buddi offers
instead: **durable intent, controlled retries, explicit uncertainty**. A durable
**effect ledger** (`effect_attempts`, core-owned and generic) records the exact envelope
before dispatch for *any* non-idempotent external effect; ambiguous completion
(crash/timeout) marks the attempt `unknown` — in v1 that requires user review, never a
blind retry. SMTP is the ledger's first user; deploy and other irreversible tools reuse
it unchanged.

## Queue, concurrency, recovery (Phase 1, not Phase 2)

Even a single agent overlaps (Telegram input + mail ingest + retry + startup recovery).
Therefore, from day one: a durable Postgres queue with atomic claims, leases, bounded
retries with backoff, and a failed-job inspection path. Work per conversation and per
mail thread is serialized; drafts carry optimistic versions. Runs **suspend durably**
while awaiting approval — no worker or DB transaction held open. Tool intent and result
are persisted so recovery never re-runs completed effects. Global pause control exists.
Startup recovery is a Phase 1 deliverable.

## Offline contract

Documented, not implicit: while the machine sleeps, mail sync and schedules catch up
(durable sources); Telegram does **not** (updates retained ≤ ~24h). Telegram updates are
persisted before the polling offset advances; on resume, pending approvals are refreshed
and durable sources reconciled. Webhook sources require retention guarantees or an
optional always-on relay (which changes the deployment premise — opt-in).

## Runtime provider port (borrowed from Foreman, modified)

Reference: `~/Projects/personal/foreman-0.1.18/.../foreman/src/provider.ts`.

- **`ProviderRef` discriminated union** — provider + credential source + wire are one
  choice, so "subscription login + custom base URL" (token exfiltration) is hard to
  express. Name the invariant as a constant; assert it in tests.
- **Result-union resolution**: `{ ok: true; provider } | { ok: false; problem }` — never
  a half-usable provider with an optional problem hanging off it. Expected configuration
  failures are typed problems; programming defects fail loudly. Fail closed.
- **No ambient credentials.** Buddi's own loop never discovers ambient login state
  (Foreman's whole problem class, avoided by construction): clients are built with
  explicit credentials, credentials are bound to approved endpoint origins, redirects
  handled conservatively, no per-agent `process.env` mutation.
- **Provider is pinned per agent; the model catalogue validates within it and never
  authorizes migration.** A missing model is a configuration problem. (This *withdraws*
  Foreman's silent model↔provider repair: an endpoint is a data destination, i.e. an
  authorization decision — a transcript footnote after the fact is not consent.)
- **Alias pinning** for internal cheap calls (titles, summaries) so they don't 404 on
  foreign upstreams.
- **Per-run snapshot**: provider, concrete model, cost basis, capabilities — including
  title/summary calls.
- **Honest cost bases** `priced | unpriced | free`: decided by the endpoint's published
  rates; never defaulted to free. Dollar caps bind only on `priced` and need
  concurrency-aware reservation; **token/turn/time/concurrency limits apply to all runs
  regardless of basis**.
- **Wire formats**: Anthropic Messages and OpenAI Chat Completions natively (the latter
  as a compatibility choice — OpenAI's Responses API is the forward path), each with an
  explicit **capability matrix** (streaming tool args, tool-result ordering, multimodal,
  usage reporting, cancellation). Provider continuation state is opaque and never
  pretended to transfer between providers. The translating gateway is deferred until a
  required endpoint forces it — and when it exists, it sits inside the trust boundary,
  credentials and all.

### Credential kinds (native Anthropic wire)

- **`api-key`** — `x-api-key` header, `ANTHROPIC_API_KEY`.
- **`subscription-token`** — the `sk-ant-oat01-…` token from `claude setup-token`, sent as
  `Authorization: Bearer`. Verified 2026-09-13 against the live API: `/v1/models` accepts it
  plainly; `/v1/messages` accepts it only when the **first `system` content block is exactly**
  `You are Claude Code, Anthropic's official CLI for Claude.` — its own block, exact match, no
  trailing newline. A string system prompt, or one merged block with the agent prompt appended,
  returns 429: the check is equality on the first block, not a prefix test. So the adapter emits
  the two-block form (identity block, then the agent prompt) for this credential kind, and a
  plain string for `api-key`. The `anthropic-beta: oauth-2025-04-20` header is sent for parity
  with Claude Code but was not enforced on `/v1/messages` at verification time. Bills the
  owner's subscription; the token is revoked by a Claude Code re-login; using it outside Claude
  Code is the owner's decision under Anthropic's terms.
- **`claude-code`** (ambient install, Foreman-style, via Agent SDK) — explicitly **out of
  scope**: it is a different runtime, not a credential; it violates the "no ambient
  credentials" rule and executes its own tools outside the Executor. Reconsider only as a
  second runtime adapter with tools re-exposed over MCP and built-ins disabled.

Secrets come from the vault; in the day-1 build they come from `.env` via an explicit
env-name reference (never read ambiently by the adapter).

## Memory

Four separated kinds: **conversation history**, **run checkpoints**, **explicit user
preferences** (user-authored, versioned, correctable), **derived memories** (carrying
provenance: source message refs, timestamp, scope, expiry, embedding model/version).

- Memory informs reasoning; it **never grants permission or approval**. A "fact"
  extracted from hostile email is a lasting prompt injection unless provenance and
  deletion semantics exist.
- Publishing to shared memory is explicit. Deletion invalidates derived summaries and
  embeddings, not just the row.
- **v1 scope**: preferences + source-linked summaries. No generalized shared vector
  store yet.

## Secrets and operations

- **Vault**: OS-keychain-backed (or encrypted with keys held outside the DB). A secrets
  *table* would hand mail and model credentials to anyone with the database file.
- Locked-vault behavior is defined: unattended missions needing secrets fail with a
  typed problem; they don't hang, and they don't fall back to prompts. Rotation,
  backup/restore, and log redaction are specified.
- **Observability** is the event log: run/step/action ids, queue age, ingest lag, retry
  counts, approval age, provider usage. Policy decisions are stored with their reasons —
  never reconstructed from model reasoning. Sensitive artifacts (draft bodies, mail
  content) live separately from append-only event metadata so retention/deletion stays
  possible.

## Data model (sketch)

- `owner`, `surfaces` (paired identities)
- `agents` (prompt, pinned provider_ref + model, tier overrides — tighten only)
- `conversations` / `messages` (envelope metadata: principal, causation, dedup key)
- `missions`, `schedule_specs`, `occurrences` (unique constraint), `runs`, `steps`
- `artifacts` (versioned files: kind, content ref, owning run, previewable)
- `actions` (immutable: canonical args, hashes, envelope), `approvals` (state machine),
  `effect_attempts` (generic ledger — SMTP is the first effect type)
- `events` (append-only, outbox)
- `memories` (kind, provenance, scope, expiry)
- `installed_plugins` + `tool_registry` (capability classification, per-plugin manifests)
- secrets live in the OS vault — there is no secrets table
- **Plugin-owned schemas** — `email_accounts`, `mailboxes`, `email_messages` (identity
  quad), `drafts` (linking messages to artifact versions), `message_triage` all live in
  the `email` schema: shipped, versioned, and dropped with the email plugin. Core's own
  schema contains none of them.

## Tool families (exemplar-driven backlog)

Three concrete missions define the tool inventory; each names what the layers above must provide.

- **"Every Friday, check my bank accounts → finance recap + advice"** — the **first
  agent, not the last**. It needs no effect tools: every tool is a read over
  plugin-owned data or pure computation, so it ships before the approval machinery
  exists. Plugin: `packages/tools/finance`, schema `finance` — `accounts` (balance,
  as-of), `recurring_items` (income|charge, amount, cadence, anchor date, account),
  `transactions` (date, amount, category, account, source manual|csv, dedup hash),
  `preferences` (currency, safety floor). Tools: add/list recurring, set balance,
  record transaction, CSV import (drop folder), monthly summary, and
  `project_cashflow(horizonDays, hypothetical?)` — a deterministic day-by-day balance
  simulation returning the minimum balance and its date. **The model explains; it never
  computes.** CSV drop is the primary v1 intake, not a fallback. Bank access via the
  **host computer-use driver on a dedicated browser profile** (see "Computer access")
  stays the later strategy: no bank credential ever enters the vault, 2FA happened with
  the human present, OS-level input leaves no in-page automation artifacts; log in to
  selected sites once (sessions persist; re-login is co-driven); reads at `session`
  tier; money actions always `gated`. Open-banking adapter later (same verification pain
  as Gmail OAuth — port now, implement later). Financial data → cloud model is a
  per-agent provider decision (principle 5).
- **"Prepare slides for my next training on Trokky CMS"** — needs a **calendar read tool**
  (auto tier) and, more importantly, an **artifact store** as a first-class domain concept:
  versioned files a mission builds across steps (research → outline → deck), previewable
  from any surface, referable by approvals. Slides/pptx generation is a tool on top of
  the store.
- **"Update jemoel's website, add these hairstyles"** — the gated-write showcase:
  workspace branch → approval bound to the diff hash (preview *is* what ships) → gated
  `deploy`. Tool family: **publish pipeline** (git + deploy, or CMS admin via browser).
  Requires **surface attachment ingest** (Telegram photo → multimodal context) — surfaces
  translate more than text.

## Repo layout

```
buddi/
  packages/
    core/          domain, db, event log, queue+leases, outbox, scheduler, trust, vault
    runtime/       agent loop, RuntimeProvider port + anthropic/openai adapters
    gateway/       surface adapters (telegram, web-api), owner identity, routing
    tools/         plugins: finance (read-only: accounts, recurring, transactions, cashflow projection), email (IMAP source + SMTP tool), computer-use (a11y+vision+input), browser (CDP fallback), filesystem — import core; never imported by it
    web/           dashboard UI (React/Vite) — transcripts, missions, approvals
  docker-compose.yml   (postgres)
  .env.example         (single data dir; nothing scattered)
```

## Roadmap

1. **Finance advisor, read-only.** Scaffold; core contracts + trust registry that **fails
   closed on non-`auto` tiers**; runtime loop + Anthropic adapter with **both credential
   kinds** (`api-key`, `subscription-token`); the **finance plugin** (its own schema and
   migrations, classified at install); a CLI chat surface; the event log; core migrations
   — plus the **CI check that boots core with zero plugins installed**. No effect tools,
   no approvals: every finance tool is a read or a pure computation.
2. **Telegram surface + owner identity + the scheduled Friday recap.** One allowlisted
   Telegram surface (numeric user id + private-chat id, update-id dedup) bound to the
   installation owner; missions with materialized **occurrences** and per-mission
   **misfire policy** — a week asleep does not produce a week of stale recaps.
3. **Effects: queue, vault, approvals — and email as the first effect tool.** Durable
   Postgres queue + leases + startup recovery + pause; keychain vault; the immutable
   action object and approval state machine; the effect ledger. Then the **email**
   plugin: IMAP source, SMTP effect tool, one Gmail mailbox (app password); install runs
   its migrations, the owner classifies its manifest. Mail-triage mission is
   configuration (agent prompt + source subscription); drafts are artifacts; gated SMTP
   send exercises the approval machinery and the ledger. Approvals resolve over Telegram
   — no web UI yet. The **OpenAI adapter** lands here, proving the runtime port swaps.
4. **Dashboard + scheduler config.** Web UI over the event log (transcripts, missions,
   approvals); occurrence/misfire policy configuration.
5. **Specialization + cooperation.** Second agent; delegation via the queue; derived
   memory with provenance.
6. **Host computer-use, native apps.** The computer-use driver (a11y tree + vision +
   synthesized input) on a dedicated buddi browser profile with session grants —
   upgrades the finance agent from CSV drop to live bank reads; CDP fallback for
   machine-friendly sites; PWA before native.

## Risks

- **Gmail app passwords**: unavailable under Advanced Protection; revoked on password
  change; may be restricted further. Mitigation: XOAUTH2 auth mode on the same transport.
- **Lossy offline window**: Telegram updates expire; catch-up cannot recover them.
  Mitigation: documented offline contract; persisted offsets; resume reconciliation.
- **No exactly-once externally**: accepted; durable intent + ledger + `unknown` states.
- **Generic tools resist capability classification**: v1 ships only one narrow plugin
  (email); generic/MCP plugin support waits for a sandboxing story.
- **Plugin schema lifecycle**: plugin migrations interact with core migrations, and
  uninstall must be explicit and lossy-safe. Mitigation: install/uninstall is owner-run,
  versioned, transactional; core never references plugin tables; a dropped plugin loses
  only its schema and registry rows.
- **Host automation vs bank ToS**: undetectable ≠ permitted — behavioral analytics can
  still flag, and the realistic downside is an account lock. Mitigation: session-tier
  co-driving, human pacing, gentle reads, CSV fallback.
- **Subscription token as credential**: revoked by re-login, subject to Anthropic's terms
  for non-Claude-Code use; `api-key` kind is the fallback and needs no code change.
- **Provider drift**: pinned providers, fail-closed resolution, per-run snapshots.