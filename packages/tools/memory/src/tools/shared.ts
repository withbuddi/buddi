/** Shared helpers for the memory tools. */
import type { ToolContext } from '@buddi/core';
import { z } from 'zod';

/** How many notes the preamble and a default recall return. */
export const DEFAULT_RECALL_LIMIT = 10;
export const MAX_RECALL_LIMIT = 50;

/** The scope an agent may ask for. `agent` means "private to me". */
export const scopeInput = z
  .enum(['shared', 'agent'])
  .optional()
  .describe(
    "Who this is for. 'agent' (the default) keeps it private to you. 'shared' publishes it to every agent — only do that when the owner says it applies everywhere.",
  );

export type ScopeInput = 'shared' | 'agent' | undefined;

/** The literal scope string stored on a note: 'shared' or an agent id. */
export const SHARED = 'shared';

/**
 * Resolve a requested scope to a stored value.
 *
 * Fail closed: `agent` scope without a calling agent would silently widen to
 * shared, so it throws instead. The runtime always supplies `agentId`.
 */
export function resolveScope(requested: ScopeInput, ctx: ToolContext): string {
  if ((requested ?? 'agent') === 'shared') return SHARED;
  const agentId = ctx.agentId;
  if (!agentId || agentId.trim() === '') {
    throw new Error(
      "memory: scope 'agent' needs a calling agent, and this run supplied none; " +
        "pass scope 'shared' explicitly if the memory really is for every agent",
    );
  }
  return agentId;
}

/** Scopes this agent may read: shared, plus its own. */
export function visibleScopes(ctx: ToolContext): string[] {
  const agentId = ctx.agentId;
  return agentId && agentId.trim() !== '' ? [SHARED, agentId] : [SHARED];
}

/** `null` means shared in `preferences.agent_scope`. */
export function toAgentScope(scope: string): string | null {
  return scope === SHARED ? null : scope;
}

export function fromAgentScope(value: string | null): string {
  return value ?? SHARED;
}

/** ISO instant for a timestamptz coming back from pg. */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** `YYYY-MM-DD` — what the model shows the owner. */
export function toDay(value: unknown): string {
  return (toIso(value) ?? '').slice(0, 10);
}

/**
 * Split a free-text query into ILIKE terms. Every term must match (AND), which
 * makes "rent relative" narrow rather than widen. Capped so a pathological
 * query cannot build an unbounded SQL statement.
 */
export function searchTerms(query: string | undefined): string[] {
  if (!query) return [];
  return query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 8);
}
