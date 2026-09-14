/**
 * The plugin contract. Core knows tools only through these types; core never
 * imports a tool package (enforced by scripts/check-boundaries.mjs).
 */
import type { Pool } from 'pg';
import type { ZodType } from 'zod';
import type { Sentinel } from './sentinels/types.js';

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
}

export interface ToolDefinition<I = unknown, O = unknown> {
  /** Namespaced, e.g. 'finance.project_cashflow'. */
  name: string;
  /** Shown to the model. */
  description: string;
  tier: Tier;
  input: ZodType<I>;
  execute(input: I, ctx: ToolContext): Promise<O>;
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
}
