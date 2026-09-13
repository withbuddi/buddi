/**
 * Credential choice, made once and explicitly (ARCHITECTURE.md, "Runtime provider
 * port": no ambient credentials — the caller passes `env`, nothing is discovered).
 *
 * This used to live in the gateway next to the one hardcoded agent. Agents are
 * configuration now, so the rule that turns an environment into a pinned
 * `ProviderRef` belongs to core, where the catalog can apply it to every agent.
 */
import type { ProviderRef } from '../provider.js';

/** Model used when neither the agent file nor the environment pins one. */
export const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * A subscription token if the owner ran `claude setup-token`, an API key
 * otherwise. Empty strings do not count as set — resolution would fail closed
 * anyway, but the choice should not silently land on the wrong kind.
 *
 * `model` may be pinned per agent; otherwise BUDDI_MODEL, otherwise the default.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv, model?: string): ProviderRef {
  const hasSubscriptionToken = (env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim() !== '';
  return {
    kind: 'anthropic',
    credential: hasSubscriptionToken
      ? { kind: 'subscription-token', env: 'CLAUDE_CODE_OAUTH_TOKEN' }
      : { kind: 'api-key', env: 'ANTHROPIC_API_KEY' },
    model: (model ?? '').trim() || (env.BUDDI_MODEL ?? '').trim() || DEFAULT_MODEL,
  };
}
