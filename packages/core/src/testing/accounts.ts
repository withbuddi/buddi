/**
 * A model account for every Anthropic agent, for tests.
 *
 * Anthropic reads no credential from the environment: an agent runs only when
 * the gateway's account service binds it to a model account. A suite that just
 * needs its agents available passes this as `providerSelection` instead of
 * standing up the account service. OpenAI agents fall through to their
 * environment key, as they do in the real catalog.
 */
import type { LoadAgentCatalogOptions } from '../agents/catalog.js';
import { providerFromEnv } from '../agents/provider-from-env.js';

export function testAnthropicAccount(
  env: NodeJS.ProcessEnv = {},
): NonNullable<LoadAgentCatalogOptions['providerSelection']> {
  return ((agent) =>
    agent.provider === 'openai'
      ? undefined
      : { provider: providerFromEnv(env, agent.model), availability: { ok: true } }) as NonNullable<
    LoadAgentCatalogOptions['providerSelection']
  >;
}
