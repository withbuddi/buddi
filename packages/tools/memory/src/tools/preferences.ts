/**
 * Explicit user preferences: user-authored, versioned, correctable.
 *
 * A correction never overwrites. It supersedes the previous revision and adds a
 * new one, so the tool can tell the model what the value used to be — which is
 * what lets an agent say "you told me EUR before; noting USD now".
 */
import type { ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import {
  fromAgentScope,
  resolveScope,
  scopeInput,
  toAgentScope,
  toIso,
  visibleScopes,
} from './shared.js';

const rememberInput = z.object({
  key: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "Short stable name for the preference, lower_snake_case, e.g. 'reporting_currency', 'tone', 'pay_cycle'. Reuse the same key when the owner changes their mind — that stores a correction rather than a second, conflicting preference.",
    ),
  value: z
    .string()
    .min(1)
    .max(2000)
    .describe('The preference itself, in the owner\'s own terms, e.g. "paid biweekly on Thursdays".'),
  scope: scopeInput,
});

export interface RememberedPreference {
  key: string;
  value: string;
  scope: string;
  revision: number;
  previousValue: string | null;
  previousRevision: number | null;
}

export const rememberPreference: ToolDefinition<
  z.infer<typeof rememberInput>,
  RememberedPreference
> = {
  name: 'memory.remember_preference',
  description:
    'Record something the owner has stated they want — a standing choice, not a fact about the world. Storing the same key again is a correction: it creates a new revision, supersedes the old one, and returns the previous value so you can acknowledge the change. Use this the moment the owner says "from now on", "I prefer", "always", "call me X".',
  tier: 'auto',
  input: rememberInput,
  async execute(input, ctx) {
    const scope = resolveScope(input.scope, ctx);
    const agentScope = toAgentScope(scope);
    const now = ctx.buddi!.clock.now();

    const { rows: currentRows } = await ctx.buddi!.db.query<{ value: string; revision: number }>(
      `select value, revision from memory.preferences
        where key = $1 and agent_scope is not distinct from $2 and superseded_at is null
        order by revision desc
        limit 1`,
      [input.key, agentScope],
    );
    const previous = currentRows[0];

    const { rows: maxRows } = await ctx.buddi!.db.query<{ max: number }>(
      `select coalesce(max(revision), 0)::int as max from memory.preferences
        where key = $1 and agent_scope is not distinct from $2`,
      [input.key, agentScope],
    );
    const revision = (maxRows[0]?.max ?? 0) + 1;

    await ctx.buddi!.db.query(
      `update memory.preferences set superseded_at = $3
        where key = $1 and agent_scope is not distinct from $2 and superseded_at is null`,
      [input.key, agentScope, now],
    );
    await ctx.buddi!.db.query(
      `insert into memory.preferences (key, value, revision, agent_scope, created_at)
       values ($1, $2, $3, $4, $5)`,
      [input.key, input.value, revision, agentScope, now],
    );

    return {
      key: input.key,
      value: input.value,
      scope,
      revision,
      previousValue: previous?.value ?? null,
      previousRevision: previous?.revision ?? null,
    };
  },
};

const getInput = z.object({});

export interface PreferenceView {
  key: string;
  value: string;
  scope: string;
  revision: number;
  updatedAt: string | null;
}

export interface PreferenceRow {
  key: string;
  value: string;
  agent_scope: string | null;
  revision: number;
  created_at: unknown;
}

/**
 * Current revisions visible to one agent: shared plus its own. When a key
 * exists in both, the agent's own value wins — a private correction is a
 * narrowing, and the shared row stays untouched for everyone else.
 */
export async function currentPreferences(
  db: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
  scopes: readonly string[],
): Promise<PreferenceView[]> {
  const agentScopes = scopes.filter((s) => s !== 'shared');
  const { rows } = await db.query(
    `select key, value, agent_scope, revision, created_at
       from memory.preferences
      where superseded_at is null
        and (agent_scope is null or agent_scope = any($1::text[]))
      order by key asc, agent_scope nulls first`,
    [agentScopes],
  );
  const byKey = new Map<string, PreferenceView>();
  for (const row of rows as PreferenceRow[]) {
    // `nulls first` puts the shared row before the agent's own, so the agent's
    // own overwrites it here.
    byKey.set(row.key, {
      key: row.key,
      value: row.value,
      scope: fromAgentScope(row.agent_scope),
      revision: row.revision,
      updatedAt: toIso(row.created_at),
    });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export const getPreferences: ToolDefinition<
  z.infer<typeof getInput>,
  { preferences: PreferenceView[] }
> = {
  name: 'memory.get_preferences',
  description:
    'List the preferences the owner has stated that you can see: the shared ones plus your own. Each is the current revision. Call this before assuming what the owner wants.',
  tier: 'auto',
  input: getInput,
  async execute(_input, ctx) {
    return { preferences: await currentPreferences(ctx.buddi!.db, visibleScopes(ctx)) };
  },
};
