/**
 * Credential choice, made once and explicitly (docs/architecture.md, "Runtime provider
 * port": no ambient credentials — the caller passes `env`, nothing is discovered).
 *
 * This used to live in the gateway next to the one hardcoded agent. Agents are
 * configuration now, so the rule that turns an environment into a pinned
 * `ProviderRef` belongs to core, where the catalog can apply it to every agent.
 *
 * Provider-aware since the port grew a second adapter. The two paths are
 * deliberately *not* symmetric:
 *
 *  - Anthropic reads nothing from the environment. Its credentials live only
 *    in named model accounts (Settings → Model accounts, kept in the vault), so
 *    the ref built here names no variable and resolves to a "no model account"
 *    problem until an account is bound to the agent.
 *  - OpenAI has one, `OPENAI_API_KEY`, and nothing is inferred: no token kind,
 *    no ambient discovery.
 *
 * Nor do the two share a default model. `BUDDI_MODEL` is an Anthropic model
 * name; letting it through to OpenAI would be exactly the silent migration the
 * design withdraws, so OpenAI reads `BUDDI_OPENAI_MODEL` or its own default.
 */
import {
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
 * The environment-derived ref for an agent no model account answers for.
 * OpenAI names `OPENAI_API_KEY`; Anthropic names nothing and fails closed.
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

  return {
    kind: 'anthropic',
    credential: { kind: 'api-key', env: '' },
    model: pinned,
  };
}
