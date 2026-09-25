/**
 * The plugin contract. Core knows tools only through these types; core never
 * imports a tool package (enforced by scripts/check-boundaries.mjs).
 */
import type { Pool } from 'pg';
import type { ZodType } from 'zod';
import type { MisfirePolicy } from './scheduler/types.js';
import type { Sentinel } from './sentinels/types.js';
import type { SurfaceProfile } from './surfaces.js';
import type { ViewDescriptor } from './views.js';
import type { HomeContribution } from './home.js';
import type { MetricDefinition } from './metrics.js';
import type { PageDescriptor, PageQuery, WorkspaceFiles } from './pages.js';
import type { SystemContext } from './system-context.js';
import type { PolicyHandler, RunProvenance, UntrustedKind } from './learning/types.js';
import type { ProviderAccountsAccess } from './provider-accounts.js';
import type { BuddiHost, RegisterHost, SecretDestination } from './host/types.js';
import type { PluginUse } from './plugin/uses.js';

/** Auto executes directly; gated requires approval; session requires owner context. */
export type Tier = 'auto' | 'draft' | 'gated' | 'session';

/** A group run's room, as the orchestration establishes it. */
export interface GroupContext {
  id: string;
  name: string;
  coordinator: string;
  /** Member agent ids, in roster order. */
  members: readonly string[];
  /** The owner request this run spends against. */
  requestId: string;
}

export interface ToolContext {
  /**
   * The host: everything a plugin reaches beyond its arguments, bound to this
   * plugin (docs/specs/plugin-host-api.md). Set by core every time it hands a
   * plugin a context; absent only on a context no plugin has been handed yet.
   * `CoreToolContext` carries the facts it is built from.
   */
  buddi?: BuddiHost;
  /** Fresh owner timezone and host facts, supplied by the composition root. */
  systemContext?: (run?: { agentId: string; tools: readonly string[] }) => Promise<SystemContext>;
  /** Issued by an authenticated interactive surface, never by a model/tool. */
  ownerRequest?: { id: string; text: string; expiresAt: number };
  /** Runtime-resolved session tool grants. Cannot be inherited by a delegate. */
  sessionTools?: readonly string[];
  /** Cooperative cancellation. Check before each external operation. */
  signal?: AbortSignal;
  /** Set only by the executor; the exact effect the owner approved. */
  approvedEffect?: { envelope: unknown };
  /**
   * Provenance for tools that record something. Optional so every existing
   * caller keeps compiling; the runtime loop fills both in for every tool call
   * it makes, and a tool that needs them must fail closed when they are absent
   * rather than guess.
   */
  conversationId?: string;
  agentId?: string;
  /**
   * The id of the `tool_use` block this call answers, stamped per call by the
   * loop. It is provenance, not authorization: a tool that starts work of its
   * own — a delegation opening a conversation for a colleague — records it so
   * a reader can tie that work back to the exact call that asked for it,
   * before any result exists. Absent outside the loop, and every tool that
   * wants it must cope with that.
   */
  toolUseId?: string;
  /**
   * The group this run speaks in, when it is a group run. Set by the group
   * orchestration from the group row — trusted context, never something a
   * model supplies — and read by the tools that scope to a room: memory
   * writes land in the group's scope, and a member request is checked
   * against `members`.
   */
  group?: GroupContext;
  /**
   * Set by the loop. A tool that completed but left the run waiting on an
   * owner decision elsewhere — a group member paused inside `group.ask` —
   * says so here, and the loop stops dispatching and ends the run as
   * awaiting that action, exactly as if the gate had been its own.
   */
  suspend?: (actionId: string) => void;
  /**
   * How many delegations deep this run is: absent or 0 for a run the owner
   * started, 1 inside a run another agent delegated. The delegation tool reads
   * it and refuses at >= 1, so a delegate never delegates again and a cycle
   * cannot exist. Optional because every other tool ignores it.
   */
  delegationDepth?: number;
  /**
   * The surface this run is answering on, when one was declared.
   *
   * On the context rather than on a tool's construction options because a
   * process wires one registry and answers on several surfaces: the profile is
   * a property of the *run*, and the loop stamps it here for the same reason it
   * stamps `agentId`. Delegation is its one reader — a delegate's words reach
   * the same screen as its caller's, so it must be told about that screen.
   */
  surface?: SurfaceProfile;
  /**
   * Set by the runtime when this run's provider is doing the web searching
   * itself, server-side, instead of a search tool being dispatched.
   *
   * It is on the context for one reader: `web.status`, whose whole job is to
   * answer "can I search right now?" honestly *before* an agent promises the
   * owner something current. Without it the plugin would answer from the
   * Tavily key alone and tell an agent on Anthropic that it cannot search,
   * moments before it searches. Core knows no backend and no vendor here — only
   * that something other than a tool call is providing the capability.
   */
  nativeSearch?: { provider: string; maxUses: number };
  /**
   * The durable job this run belongs to, when a job started it. The approval
   * machinery records it on the action so the decision can wake exactly the
   * run that is suspended on it; a run the owner is watching live has none.
   */
  jobId?: string;
  /**
   * The approved action a **gated** `execute` is running under, and therefore
   * its idempotency key. Only `executeApproved` sets it — it is the single
   * caller of a gated tool — so a tool that must not send the same thing twice
   * fails closed when it is absent rather than dispatching without a key.
   */
  actionId?: string;
  /**
   * What the owner chose on the approval card, by choice key — validated by
   * core against the `choices` the tool declared at describe time, with every
   * key the owner did not answer filled in from its default.
   *
   * Set only by `executeApproved`, for the same reason `actionId` is: it is a
   * statement about a decision, and a tool that read it from anywhere else
   * would be reading something nobody approved. A gated tool that declares
   * choices must still cope with it being absent (an older action, a surface
   * that never asked) by falling back to its own default.
   */
  choices?: Readonly<Record<string, string>>;
  /**
   * What this run knows about itself when the call is made: its id, the owner
   * turn it answers, and the untrusted inputs in its context (web pages, mail,
   * files, chat). Stamped per call by the runtime loop from the messages the
   * model was actually shown — never from anything the model said. The
   * learning tools record it as a proposal's provenance; a tool that needs it
   * fails closed when it is absent.
   */
  provenance?: () => RunProvenance;
}

/**
 * What core runs a call on: the call (`ToolContext`) and the facts a plugin's
 * host is built from — the pool, the owner, the clock and zone, the preview
 * port, the protected paths, the provider accounts. Core's own; a plugin is
 * typed against `ToolContext` and reaches these through `ctx.buddi`
 * (docs/specs/plugin-host-api.md §3), and `@buddi/core/plugin` does not
 * export this.
 */
export interface CoreToolContext extends ToolContext {
  /** The pool. A plugin's host wraps it as `buddi.db`. */
  db: Pool;
  /** The owner's id: `buddi.owner.id`. */
  ownerId: string;
  /** The clock: `buddi.clock.now`. */
  now: () => Date;
  /**
   * The owner's timezone (an IANA name). `now()` is an instant; a tool that
   * needs a *day* — a default date, the start of a projection — must render it
   * in this zone with `localDateString`, never in UTC, or "today" flips at 8 PM
   * in New York.
   */
  timezone: string;
  /**
   * The port this gateway serves previews on, when it is serving them.
   *
   * A plugin with `previews` needs it for one thing: building a URL that is
   * not this process's to build — a `tailscale serve` target, a line in a log,
   * a link in a tool result. It is *not* how a preview is reached from the
   * dashboard; that is the link route, which mints a credential. This is only
   * the number, and it is here rather than guessed as "the dashboard plus one"
   * because that guess is wrong the moment the port next door was taken.
   *
   * Absent when previews could not be bound, and outside a gateway process.
   * `BUDDI_PREVIEW_PORT` in the environment carries the same number, for a
   * plugin that reads its configuration rather than its context.
   */
  previewPort?: number;
  /**
   * Directories no tool may write into, whatever it was granted: the owner's
   * agent files and skills, learned ones included (docs/specs/learning.md §6).
   * An agent learns by proposing; a file tool pointed at its own skills
   * directory refuses rather than letting it rewrite itself. Absolute paths,
   * set by the composition root; a tool that writes files checks them.
   */
  protectedPaths?: readonly string[];
  /**
   * The owner's provider accounts (Settings → Model accounts), for a plugin
   * that calls a model with an account the owner chose on its own settings
   * page. Set by the gateway's composition root; absent elsewhere, and a tool
   * that needs it refuses. See `ProviderAccountsAccess`.
   */
  providerAccounts?: ProviderAccountsAccess;
}

/**
 * What a gated tool says will actually happen — the *whole* of it.
 *
 * ARCHITECTURE.md, "Actions and approvals": the immutable action object carries
 * «the full effect envelope (e.g. every SMTP recipient incl. BCC, body,
 * attachment hashes)», and «the preview is rendered from this object, never
 * from model-written text». So the envelope is the tool's own structured
 * account of the effect, and the preview is the sentence the owner approves.
 */
export interface EffectDescription {
  /**
   * Everything that decides what the world will see. Recipients the model did
   * not mention, a resolved account id, a file hash: if it changes the effect,
   * it belongs here, because this is what the ledger hashes before dispatch.
   */
  envelope: unknown;
  /** Plain text, short, owner-facing. Never markdown, never model prose. */
  preview: string;
  /**
   * Settings on this effect the *owner* decides, at the moment they approve it.
   *
   * "What is approved is what is shown" is unchanged and is the reason this
   * exists in the description rather than on the decision: the owner can only
   * pick among options the tool itself listed, before anyone was asked, in the
   * same object the preview was rendered from. A surface that offered a value
   * that is not in `options` is offering something nobody described, and core
   * refuses it (`resolveOwnerChoices`).
   *
   * Declare a choice only when there is something to choose: a single-option
   * list is a fact, and a fact belongs in the preview.
   */
  choices?: OwnerChoice[];
}

/**
 * One thing the owner may set on an approval: a named control with a fixed set
 * of values and one of them preselected.
 *
 * `default` is what happens if the owner says nothing — on a surface that draws
 * no control, on an approval decided from the CLI, on a Telegram keyboard that
 * ran out of buttons. It must be one of `options`.
 */
export interface OwnerChoice {
  /** Stable, machine-facing; the key of the map `execute` receives. */
  key: string;
  /** Owner-facing, one short line: what this control is for. */
  label: string;
  /** Every value the owner may pick. Nothing outside this list is accepted. */
  options: string[];
  /** The value used when the owner picks nothing. One of `options`. */
  default: string;
}

/**
 * The key of a tool result's text for the model only.
 *
 * A result is read by two audiences: the agent, which gets all of it, and the
 * owner, who sees it drawn on the canvas. An instruction such as "you have not
 * seen this picture; say what you asked for" is written for the first and
 * reads as nonsense to the second. A plugin puts such a sentence under this
 * key at the top level of its result: the model receives it like any other
 * field, and the canvas never draws it — not through a view descriptor, not in
 * the generic fallback. Owner-facing words belong in their own field.
 */
export const AGENT_ONLY_FIELD = 'forAgent';

/**
 * A refusal a tool raises on purpose, whose message is already the sentence
 * the agent and the owner should read.
 *
 * Thrown from `tierFor` or `describe`, an ordinary error is a defect and is
 * reported as one ("could not decide what this call needs: …"). A refusal is
 * not a defect: it is the tool saying no before anyone is asked — no account
 * chosen, a limit reached — so its message is passed through as it stands and
 * no approval is raised. Recognised by the `refusal` flag rather than by
 * class, so a plugin built against another copy of core is understood too.
 */
export class ToolRefusal extends Error {
  readonly refusal = true;
  constructor(message: string) {
    super(message);
    this.name = 'ToolRefusal';
  }
}

/** Whether a thrown value is a deliberate refusal (see `ToolRefusal`). */
export function isToolRefusal(err: unknown): err is Error & { refusal: true } {
  return err instanceof Error && (err as { refusal?: unknown }).refusal === true;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  /** Namespaced, e.g. 'finance.project_cashflow'. */
  name: string;
  /** Shown to the model. */
  description: string;
  tier: Tier;
  /**
   * Decide this one call's tier from its arguments — the same tool, gated or
   * not depending on what it was asked to do.
   *
   * `tier` above is what the tool *is*: it is what a model is told, what an
   * agent's grant is checked against, and what the runtime resolves session
   * grants from. This is what one call *costs*, and it can only be read from
   * the arguments: `rm -rf .` and `ls` are both "run a command", and the first
   * is the reason approvals exist. So a tool whose tier is a property of its
   * input declares the strictest tier it can ever need and narrows it here.
   *
   * Called by `registry.invoke` after the arguments are parsed and before the
   * tier is acted on; what it returns replaces `tier` **for that call only**.
   * Three rules keep it from becoming a way around the gate:
   *
   *  - it may return `auto`, `gated` or `session` and nothing else;
   *  - a throw refuses the call (`tool-error`) — a rule that cannot be
   *    evaluated is not a rule that passed;
   *  - `session` still means everything it meant: a live owner request, an
   *    explicit grant resolved from the *declared* tier, and no delegate.
   *
   * `reason` is one plain sentence naming the rule that decided, carried into
   * the approval's preview so the card says why it is asking. Nothing calls
   * this again later: `executeApproved` runs what the action recorded, and the
   * action was created under the tier this returned.
   */
  tierFor?(input: I, ctx: ToolContext): Promise<{ tier: Tier; reason?: string }>;
  /** Opt-in only: owner may remember approval for this tool/agent/version. */
  reusableApproval?: boolean;
  /**
   * The owner may call this from one of the plugin's pages; no model ever
   * sees it. `ToolRegistry.list()` leaves it out, which is the one place a
   * provider's tool list and an agent's grant are both built from, so a
   * glob in an agent file cannot reach it and a suggested agent naming it is
   * refused at install. `registry.invoke` still runs it for `agentId: 'owner'`
   * — the act route — and refuses it for anyone else as an unknown tool,
   * which is what a model would have been told anyway.
   *
   * For a write that is the owner's to make and nobody else's:
   * `email.add_account` stores a secret, and is the first one.
   */
  ownerOnly?: boolean;
  /**
   * This tool saves files and names them in its output as `artifacts: [{ id }]`.
   * Only a tool that says so here has its outputs recorded as produced; a
   * tool that merely lists or returns files never does.
   */
  producesArtifacts?: boolean;
  /**
   * This tool's output is text somebody other than the owner wrote: a page, a
   * mail, a file, a chat. Declared, so a run that called it is known to have
   * had untrusted text in view whatever the result looked like — which is
   * what a learning proposal's provenance is built from
   * (`learning/sources.ts`). Absent for a tool whose output is the owner's or
   * the platform's own.
   */
  untrusted?: UntrustedKind;
  input: ZodType<I>;
  execute(input: I, ctx: ToolContext): Promise<O>;
  /**
   * Render the effect envelope and the owner-facing preview for one proposed
   * call. Required in spirit for every `gated` tool: the registry falls back to
   * the canonical arguments and their JSON when a tool declares none, which is
   * honest but rarely the clearest thing to show a human at 7 a.m.
   *
   * It must be pure and read-only. It runs *before* any approval exists, so a
   * `describe` that sent an email would be the exact bug this boundary exists
   * to prevent.
   */
  describe?(input: I, ctx: ToolContext): EffectDescription | Promise<EffectDescription>;
  /**
   * Take exclusive hold of what this effect is about, immediately before the
   * effect ledger row is written — the last moment at which "nothing has
   * happened" is still true.
   *
   * Only for a `gated` tool whose subject somebody else can edit while the
   * owner is deciding. `describe` cannot close that race: it reads, and between
   * that read and the tool's first write the row can move. So the guard goes
   * here, as one conditional statement over the thing itself — `email.send`
   * claims the draft row on the artifact version the envelope names — and it
   * throws when the statement matches nothing.
   *
   * A throw settles the approval `refused` and records **no effect attempt**:
   * the claim is what decides whether anything is attempted, so a lost claim
   * means nothing was.
   */
  claim?(input: I, ctx: ToolContext): Promise<void>;
  /**
   * How long the Executor waits for this tool before recording the attempt as
   * `unknown` (never as failed, and never auto-retried). Defaults to
   * `DEFAULT_EFFECT_TIMEOUT_MS`.
   */
  timeoutMs?: number;
  /** Dependent calls in the same model turn must be skipped after a failure. */
  sequential?: boolean;
  /** A successful call leaves a decision with the owner: no more tools this run. */
  waitsForOwner?: boolean;
  /** Optional ephemeral image for the next model call; never stored as base64. */
  image?(output: O, ctx: ToolContext): Promise<{ mime: string; data: string } | undefined>;
}

/**
 * What a source is handed when it polls.
 *
 * `enqueueRun` is the seam: a source *originates* work, but it does not know
 * what a run is made of. It hands over an agent id, a prompt and a dedup key,
 * and whoever wired the process turns that into a durable job. Idempotent on
 * `dedupKey`, which is what makes a post-commit enqueue recoverable: a poll
 * that crashed between the commit and the enqueue re-enqueues the same key on
 * its next pass and creates nothing new.
 */
export interface SourceContext {
  /** The host, bound to the plugin this source belongs to. See `ToolContext.buddi`. */
  buddi?: BuddiHost;
}

/** What core polls a source with: the host's facts beside it. Core's own, like `CoreToolContext`. */
export interface CoreSourceContext extends SourceContext {
  /** The pool: `buddi.db`. */
  db: Pool;
  /** The clock: `buddi.clock.now`. */
  now: () => Date;
  /**
   * The owner's timezone (an IANA name), for a source that needs a *day*.
   */
  timezone: string;
  /**
   * Operational logging. Never the owner's channel — a source notifies nobody.
   */
  log: (line: string) => void;
  /** How a run is started: `buddi.schedule.enqueueRun`. */
  enqueueRun(input: {
    agentId: string;
    prompt: string;
    dedupKey: string;
    conversationHint?: string;
  }): Promise<void>;
}

/**
 * A source: the half of the plugin contract that starts work with no agent in
 * the loop (ARCHITECTURE.md, "Drop-in tools and skills"). Mail arrives and a
 * triage run begins; nobody asked, and no model decided to look.
 *
 * A source owns its own cursor and its own transaction. Core only decides
 * *when* it is due — the period ledger is `core.source_runs` — and hands it a
 * context; what it polls and how it advances is entirely the plugin's.
 */
export interface Source {
  /** Namespaced and stable, e.g. 'email.inbox-poll'. Keys the run ledger. */
  id: string;
  description: string;
  /** Poll period in **seconds**. */
  every: number;
  poll(ctx: SourceContext): Promise<void>;
}

/**
 * A scheduled mission a plugin *suggests*, not one it installs.
 *
 * Default missions are domain knowledge — "every Friday, recap the week" is the
 * finance plugin's idea, not the gateway's — so they travel with the plugin
 * that knows what they mean. `buddi missions add-defaults` is the owner's act
 * of accepting the suggestion; nothing is scheduled by installing a plugin.
 *
 * The agent is named by **role** wherever possible (`agentRole: 'recap'`), so
 * the same plugin lands on whichever agent this installation gave that role. An
 * `agentId` pins one agent by name; a suggestion whose role nobody claims is
 * skipped with a printed reason, never silently registered on the default.
 */
export interface SuggestedMission {
  /** Stable mission id, e.g. `friday-recap`. */
  id: string;
  name: string;
  /** Which agent runs it, by capability. Resolved through the agent catalog. */
  agentRole?: string;
  /** Or by name, when the mission is meaningless on any other agent. */
  agentId?: string;
  /** Five-field cron. Missions with no schedule are infrastructure, not this. */
  cron: string;
  /** IANA zone; the installation's own (`BUDDI_TZ`) when omitted. */
  timezone?: string;
  misfirePolicy?: MisfirePolicy;
  prompt: string;
  /** Speaks whether or not the run decided to. Default false. */
  alwaysDeliver?: boolean;
  /** Registered enabled. Default true; false ships a placeholder switched off. */
  enabledByDefault?: boolean;
}

/**
 * A skill a plugin *suggests*: a procedure, never a privilege.
 *
 * Same standing as a suggested mission — installing the plugin proposes it and
 * nothing more. It is written into the owner's own tree only when the owner
 * approves the gated `platform.accept_plugin_skill` (or accepts the agent that
 * carries it), and from that moment the file is the owner's.
 */
export interface SuggestedSkill {
  /** Kebab-case, and also the file name: `staging-an-import`. */
  name: string;
  /** One line on when this procedure applies. */
  description: string;
  /** The procedure itself, in markdown. */
  body: string;
}

/**
 * An agent a plugin *proposes*.
 *
 * Tools without an agent are a box of parts: the finance plugin knows what an
 * advisor made of its tools should be, and that knowledge travels with the
 * plugin, exactly as a suggested mission does. What it is **not** is an
 * install: a plugin can never write an agent file. The fields here are the
 * arguments of `platform.create_agent`, and the owner approves that tool's
 * gated action — the same validation, the same preview naming what the grant
 * reaches, the same refusal to hand over the tools that write the installation.
 *
 * The file the owner accepts is written into *their* private agents directory
 * and belongs to them from that moment. A plugin upgrade never rewrites it; it
 * can only propose again, out loud (see `docs/plugins.md`, "Upgrades").
 */
export interface SuggestedAgent {
  /** Agent id and directory name, kebab-case. */
  id: string;
  /** What the owner types to address it, without the `@`. */
  handle: string;
  name: string;
  /** One line: what it is for. Other agents read this to hand it work. */
  description: string;
  /** The persona, in markdown. The body of the file. */
  persona: string;
  /**
   * The proposed grant, as names or family globs. THE PRIVILEGE BOUNDARY —
   * this is what the owner is shown, tool by tool, before they say yes. A
   * proposal naming a tool this installation does not have is refused, and one
   * naming a `platform.*` write tool is refused outright.
   */
  tools: string[];
  /** Capabilities it answers for, e.g. `['overview']`. */
  roles?: string[];
  model?: string;
  provider?: 'anthropic' | 'openai';
  maxTurns?: number;
  language?: 'mirror' | 'en' | 'fr';
  /** Skills written into this agent's own `skills/` when it is accepted. */
  skills?: SuggestedSkill[];
  /**
   * Offer it on Home while no agent has its id (optional): `text` is the card's
   * one line, and `query`, when given, names one of this plugin's page queries
   * whose answer carries `wanted: true` while the offer is worth making — a
   * mail agent is not worth offering before there is a mailbox. Accepting is
   * the same gated `platform.accept_plugin_agent`; the owner may dismiss it.
   */
  offer?: { text: string; query?: string };
  /**
   * One of the mascots the dashboard ships (`packages/web/public/mascot/`),
   * by name. When the proposal is accepted the gateway keeps that picture as
   * the new agent's own, as if the owner had uploaded it. Optional; an agent
   * without one draws its initials.
   */
  avatar?: BundledMascot;
}

/** The mascots the dashboard ships, by file name (`mascot/<name>.png`). */
export const BUNDLED_MASCOTS = ['core', 'coding', 'finance', 'garage', 'mail', 'maker', 'playground', 'research'] as const;
export type BundledMascot = (typeof BUNDLED_MASCOTS)[number];

/**
 * A host this plugin reaches, and why.
 *
 * Declared so that *before* installing someone else's code the owner can read
 * one line per destination it intends to talk to. It is documentation, not a
 * sandbox: nothing enforces it at runtime. Saying so plainly is the point — an
 * undeclared host is a plugin author who did not write this down, not a plugin
 * that cannot reach the network.
 */
export interface NetworkUse {
  /** `api.open-meteo.com`, or `*.example.com` when it really is several. */
  host: string;
  /** One line the owner can weigh: what it sends there and what it fetches. */
  why: string;
}

/**
 * A plugin that has a process of its own listening on a loopback port, and can
 * say which port stands behind a given name.
 *
 * The gateway serves `/preview/<plugin>/<name>/…` from that port on its
 * **preview origin** — a second loopback listener with a credential of its
 * own, never the dashboard's, because the app behind the port is untrusted
 * code (docs/plugins.md §2.5c). The plugin owns the process and the naming;
 * core owns the gate. Neither knows the other's half: this interface is the
 * whole of the seam, and a plugin with no long-lived processes simply has no
 * `previews`.
 *
 * `resolve` is asked on **every** proxied request, not once per process, so
 * that a port that has stopped being this name's port stops being served the
 * moment it does. It is a lookup, not a launcher: it starts nothing, and
 * returning `null` is how a plugin says "there is no such preview", which the
 * gateway answers 404.
 *
 * It must answer with a port the plugin is *actually running that process on*.
 * The gateway forces loopback and refuses the obviously wrong ports — its own
 * two listeners, Postgres, anything privileged — but a plugin whose record an
 * agent can influence is the one deciding where the owner's browser is
 * pointed, and that is the plugin's half of the boundary.
 */
export interface PreviewProvider {
  /**
   * The port behind `/preview/<plugin>/<name>/`, or null when there is none.
   *
   * A name may also be `<name>.<port>`: the same process, framed on another
   * port it listens on — a server that answers on several (a site, its admin
   * and its API). The canvas asks for it when the owner picks a port from the
   * list a result carried. A provider that does not offer that answers null;
   * one that does answers only for a port the process itself (or a child of
   * it) holds right now, checked as afresh as the plain name is.
   */
  resolve(name: string, ctx: ToolContext): Promise<{ port: number; host?: '127.0.0.1' } | null>;
}

export interface PluginManifest {
  /** Plugin family name, e.g. 'finance'. */
  name: string;
  version: string;
  /** Postgres schema owned by this plugin. */
  schema: string;
  /** Absolute path to a directory of *.sql files, applied in filename order. */
  migrationsDir: string;
  tools: ToolDefinition<any, any>[];
  /**
   * Deterministic watchers this plugin ships (optional). A sentinel runs on a
   * period with no model in the loop and returns findings; core decides what a
   * finding does — see `packages/core/src/sentinels`. A plugin with none is the
   * normal case.
   */
  sentinels?: Sentinel[];
  /**
   * Sources this plugin ships (optional). A source polls the world on a period
   * and originates runs; see `packages/core/src/sources`. A plugin with none —
   * the normal case — simply omits the field.
   */
  sources?: Source[];
  /**
   * Scheduled missions this plugin suggests (optional). Suggestions only:
   * `buddi missions add-defaults` registers them, resolving `agentRole`
   * through the agent catalog and skipping — out loud — any role nobody claims.
   */
  missions?: SuggestedMission[];
  /**
   * How this plugin's tool results should be drawn on the dashboard canvas
   * (optional). Descriptors are **data**: they are serialised to the browser,
   * which owns a small set of generic renderers and knows nothing about any
   * plugin's domain. See `views.ts`. A plugin with none — the normal case —
   * falls back to a readable structured view of its JSON.
   */
  views?: ViewDescriptor[];
  /**
   * Blocks this plugin puts on the dashboard's Home page (optional). See
   * `home.ts`. Read-only, already formatted, and absent for most plugins.
   */
  home?: HomeContribution[];
  /**
   * Numbers this plugin can answer (optional). A metric is the same shape as a
   * Home block — a named read-only function — and it is what a *goal* watches.
   * Core never learns the domain: it learns that `finance.total_debt` is a
   * currency that should go `down`. See `metrics.ts`. Most plugins have none.
   */
  metrics?: MetricDefinition[];
  /**
   * Screens this plugin puts in the dashboard (optional): a rail entry, a
   * settings tab. Descriptors are **data**, exactly like `views` — a tree of
   * generic components bound to this plugin's `queries` and tools, serialised
   * to the browser, with no plugin code running in the page. See `pages.ts`.
   */
  pages?: PageDescriptor[];
  /**
   * The reads those pages are drawn from (optional). Read-only by
   * enforcement: a query is handed a pool that refuses anything but a
   * `select`. A plugin with `pages` needs these; nothing else uses them.
   */
  queries?: PageQuery[];
  /**
   * The page queries that read a per-agent directory, for the canvas's Files
   * tab (optional; see `WorkspaceFiles`). Each must name one of `queries`.
   */
  files?: WorkspaceFiles;
  /**
   * Agents this plugin proposes (optional). Proposals only, exactly like
   * `missions`: installing a plugin never creates a principal. The owner
   * accepts one through `platform.accept_plugin_agent`, which is `gated` and
   * shows the whole tool grant in the granted tools' own words.
   */
  agents?: SuggestedAgent[];
  /**
   * Shared skills this plugin proposes (optional). Accepted through
   * `platform.accept_plugin_skill`; a skill grants no tool and lowers no tier.
   */
  skills?: SuggestedSkill[];
  /**
   * A loopback process of this plugin's, served on the gateway's preview
   * origin at `/preview/<plugin>/<name>/` (optional). See `PreviewProvider`;
   * almost no plugin has one, and the field is absent when it does not.
   */
  previews?: PreviewProvider;
  /**
   * One line on what this plugin is, shown before it is installed. Optional so
   * every existing manifest still compiles; a plugin meant to be distributed
   * should write one.
   */
  description?: string;
  /**
   * Hosts this plugin intends to reach, declared for the pre-install summary.
   * Documentation, not a sandbox — see `NetworkUse`.
   */
  network?: NetworkUse[];
  /**
   * How this plugin applies a policy the owner kept (optional). A plugin that
   * proposes rules through `proposePolicy` registers this; keeping a policy
   * proposal for a plugin without one is refused and the card stays open.
   */
  policies?: PolicyHandler;
  /**
   * What this plugin reaches in buddi beyond itself: the areas of `ctx.buddi`
   * that are not always present (docs/specs/plugin-host-api.md §5). Shown on
   * the install card one plain line each, and repeated in `package.json` as
   * `buddi.uses` because the card is drawn before anything is imported; the
   * two must match or the plugin does not register. An area not declared is
   * absent from `ctx.buddi`.
   */
  uses?: PluginUse[];
  /**
   * Where the owner's secrets can be delivered into this plugin
   * (docs/specs/owner-secrets.md §3): each kind in the plugin's own namespace,
   * `<plugin>.<what>`. Registered at `register()`; only a plugin that declares
   * `secrets` in `uses` may have any. The same as calling
   * `ctx.buddi.secrets.registerDestination` for each, before any context exists.
   */
  destinations?: SecretDestination[];
  /**
   * Called once by `register()`, after every check has passed, with the parts
   * of the host that need no call (`RegisterHost`): the place for a plugin to
   * learn its directory before any context exists. Nothing is awaited.
   */
  register?(host: RegisterHost): void;
}
