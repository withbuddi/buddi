/**
 * The agent catalog, as the Telegram surface sees it.
 *
 * Core owns the catalog (a file-based directory of agent definitions); the
 * surface only ever *reads* it: resolve an id, list what exists, fall back to
 * the default. Nothing here loads or validates an agent file — that decision
 * belongs in core, and a surface that guessed one would be deciding policy.
 */
import type { AgentCatalog, AgentSummary, CatalogAgent } from '@buddi/core';

export type { AgentCatalog, AgentSummary, CatalogAgent };

/**
 * Is this the catalog's typed "no such agent" refusal?
 *
 * Matched by `name`, not by `instanceof`: the surface must not depend on core's
 * class identity (two copies of the package, a re-exported subclass), and an
 * unknown agent is a message to the owner either way — never a crash.
 */
export function isUnknownAgentError(err: unknown): boolean {
  return err instanceof Error && err.name === 'UnknownAgentError';
}
