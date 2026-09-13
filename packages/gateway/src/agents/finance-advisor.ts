/**
 * The finance advisor — now a *file*, not code.
 *
 * The persona, its tool grant, its turn budget and its default flag live in
 * `agents/finance-advisor/agent.md`. What is left here is a loader kept for the
 * callers that already ask for this agent by name (the Telegram surface, the
 * CLI, the Friday recap): it reads the catalog and hands back the same
 * `AgentDefinition` as before.
 *
 * Nothing here reads `process.env` ambiently: the caller passes `env`, and the
 * credential kind is chosen by core's `providerFromEnv` — an explicit, tested
 * decision (ARCHITECTURE.md, "Runtime provider port": no ambient credentials).
 */
import {
  DEFAULT_MODEL,
  injectToday,
  providerFromEnv,
  toDateString,
  type AgentDefinition,
  type CatalogAgent,
} from '@buddi/core';
import { gatewayCatalog, loadGatewayCatalog } from './catalog.js';

export { DEFAULT_MODEL, injectToday, providerFromEnv, toDateString };

/** The catalog id of the agent this module loads. */
export const FINANCE_AGENT_ID = 'finance-advisor';

/**
 * The agent as configured, resolved against no environment — the persona and
 * the tool grant do not depend on one, and loading with `process.env` here
 * would pin a provider before `.env` is read.
 */
const configured: CatalogAgent = loadGatewayCatalog({ env: {} }).resolve(FINANCE_AGENT_ID);

/**
 * Every finance tool the agent file's `finance.*` grant resolves to, in registry
 * order — derived from the manifest via the catalog, never a hardcoded list.
 */
export const FINANCE_TOOLS: string[] = configured.tools;

/** System prompt template as loaded, including the generated wiring section. */
export const SYSTEM_PROMPT_TEMPLATE = configured.systemPromptTemplate;

export interface FinanceAdvisorOptions {
  env: NodeJS.ProcessEnv;
  /** The run's clock — the same one the tool context carries. */
  now: Date;
}

export function createFinanceAdvisor(opts: FinanceAdvisorOptions): AgentDefinition {
  return gatewayCatalog(opts.env).resolve(FINANCE_AGENT_ID).definition(opts.now);
}
