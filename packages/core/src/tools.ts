/**
 * The plugin contract. Core knows tools only through these types; core never
 * imports a tool package (enforced by scripts/check-boundaries.mjs).
 */
import type { Pool } from 'pg';
import type { ZodType } from 'zod';

/** UX tier labels. v1 executes `auto` only; everything else fails closed. */
export type Tier = 'auto' | 'draft' | 'gated' | 'session';

export interface ToolContext {
  db: Pool;
  ownerId: string;
  now: () => Date;
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
}
