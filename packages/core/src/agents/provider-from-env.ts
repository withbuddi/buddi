/**
 * Credential choice, made once and explicitly (ARCHITECTURE.md, "Runtime provider
 * port": no ambient credentials — the caller passes `env`, nothing is discovered).
 *
 * This used to live in the gateway next to the one hardcoded agent. Agents are
 * configuration now, so the rule that turns an environment into a pinned
 * `ProviderRef` belongs to core, where the catalog can apply it to every agent.
 *
 * Provider-aware since the port grew a second adapter. The two paths are
 * deliberately *not* symmetric:
 *
 *  - Anthropic has two credential kinds, and which one is used depends on what
 *    the owner has (a `claude setup-token` subscription token, or an API key).
 *  - OpenAI has one, `OPENAI_API_KEY`, and nothing is inferred: no token kind,
 *    no ambient discovery, no fallback to the Anthropic key.
 *
 * Nor do the two share a default model. `BUDDI_MODEL` is an Anthropic model
 * name; letting it through to OpenAI would be exactly the silent migration the
 * design withdraws, so OpenAI reads `BUDDI_OPENAI_MODEL` or its own default.
 */
import {
  DEFAULT_ANTHROPIC_API_KEY_ENV,
  DEFAULT_ANTHROPIC_TOKEN_ENV,
  DEFAULT_OPENAI_API_KEY_ENV,
  type ProviderKind,
  type ProviderRef,
} from '../provider.js';

/** Model used when neither the agent file nor the environment pins one. */
export const DEFAULT_MODEL = 'claude-sonnet-5';

/** The same, for the second adapter. Kept separate on purpose (see above). */
export const DEFAULT_OPENAI_MODEL = 'gpt-5';

/** Per-provider default model, and the variable that overrides it. */
export const PROVIDER_MODEL_DEFAULTS: Record<
  ProviderKind,
  { env: string; model: string }
> = {
  anthropic: { env: 'BUDDI_MODEL', model: DEFAULT_MODEL },
  openai: { env: 'BUDDI_OPENAI_MODEL', model: DEFAULT_OPENAI_MODEL },
};

/**
 * A subscription token if the owner ran `claude setup-token`, an API key
 * otherwise. Empty strings do not count as set — resolution would fail closed
 * anyway, but the choice should not silently land on the wrong kind.
 *
 * `model` may be pinned per agent; otherwise the provider's own environment
 * variable, otherwise the provider's default.
 */
export function providerFromEnv(
  env: NodeJS.ProcessEnv,
  model?: string,
  provider: ProviderKind = 'anthropic',
): ProviderRef {
  const fallback = PROVIDER_MODEL_DEFAULTS[provider];
  const pinned =
    (model ?? '').trim() || (env[fallback.env] ?? '').trim() || fallback.model;

  if (provider === 'openai') {
    return {
      kind: 'openai',
      credential: { kind: 'api-key', env: DEFAULT_OPENAI_API_KEY_ENV },
      model: pinned,
    };
  }

  const selection = env.BUDDI_ANTHROPIC_CREDENTIAL_KIND;
  const hasSubscriptionToken = selection === 'subscription-token' || (selection !== 'api-key' && (env[DEFAULT_ANTHROPIC_TOKEN_ENV] ?? '').trim() !== '');
  return {
    kind: 'anthropic',
    credential: hasSubscriptionToken
      ? { kind: 'subscription-token', env: DEFAULT_ANTHROPIC_TOKEN_ENV }
      : { kind: 'api-key', env: DEFAULT_ANTHROPIC_API_KEY_ENV },
    model: pinned,
  };
}
