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
import type { SystemContext } from './system-context.js';

/** Auto executes directly; gated requires approval; session requires owner context. */
export type Tier = 'auto' | 'draft' | 'gated' | 'session';

export interface ToolContext {
  /** Fresh owner timezone and host facts, supplied by the composition root. */
  systemContext?: () => Promise<SystemContext>;
  /** Issued by an authenticated interactive surface, never by a model/tool. */
  ownerRequest?: { id: string; text: string; expiresAt: number };
  /** Runtime-resolved session tool grants. Cannot be inherited by a delegate. */
  sessionTools?: readonly string[];
  /** Cooperative cancellation. Check before each external operation. */
  signal?: AbortSignal;
  /** Set only by the executor; the exact effect the owner approved. */
  approvedEffect?: { envelope: unknown };
  db: Pool;
  ownerId: string;
  now: () => Date;
  /**
   * The owner's timezone (an IANA name). `now()` is an instant; a tool that
   * needs a *day* — a default date, the start of a projection — must render it
   * in this zone with `localDateString`, never in UTC, or "today" flips at 8 PM
   * in New York.
   */
  timezone: string;
  /**
   * Provenance for tools that record something. Optional so every existing
   * caller keeps compiling; the runtime loop fills both in for every tool call
   * it makes, and a tool that needs them must fail closed when they are absent
   * rather than guess.
   */
  conversationId?: string;
  agentId?: string;
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
}

export interface ToolDefinition<I = unknown, O = unknown> {
  /** Namespaced, e.g. 'finance.project_cashflow'. */
  name: string;
  /** Shown to the model. */
  description: string;
  tier: Tier;
  /** Opt-in only: owner may remember approval for this tool/agent/version. */
  reusableApproval?: boolean;
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
  db: Pool;
  now: () => Date;
  /** The owner's timezone (an IANA name), for a source that needs a *day*. */
  timezone: string;
  /** Operational logging. Never the owner's channel — a source notifies nobody. */
  log: (line: string) => void;
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
}

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
}
