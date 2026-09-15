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

/** UX tier labels. v1 executes `auto` only; everything else fails closed. */
export type Tier = 'auto' | 'draft' | 'gated' | 'session';

export interface ToolContext {
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
}
