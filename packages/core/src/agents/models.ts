/**
 * The model catalogue this build knows about, grouped by provider.
 *
 * `MODEL_PREFIXES` in `provider.ts` is the *rule* — a prefix test, so a model
 * that shipped this morning is not refused by a list nobody updated. This file
 * is the *suggestion*: the handful of names an owner is likely to want, so
 * `buddi agents models` and the dashboard's combobox have something to show.
 *
 * The distinction matters and is deliberate. A name absent from here is still
 * accepted when its prefix belongs to the pinned provider; a name present here
 * is never accepted for the other provider. Nothing in this file widens what
 * resolves — it only says what is worth typing.
 *
 * Usability is a fact about *this machine*: a provider whose credential is not
 * set is listed, marked unusable, with the typed problem that says why. Owners
 * who never signed up for a second vendor should be able to see the choice they
 * are not making.
 */
import {
  resolveProvider,
  PROVIDER_KINDS,
  MODEL_PREFIXES,
  type ProviderKind,
  type ProviderProblem,
} from '../provider.js';
import { PROVIDER_MODEL_DEFAULTS, providerFromEnv } from './provider-from-env.js';

export interface KnownModel {
  id: string;
  /** One clause on what it is for. Never a benchmark claim. */
  note: string;
}

/**
 * Names this build suggests, newest first within a family. Not exhaustive and
 * not authoritative: the prefix rule is.
 */
export const KNOWN_MODELS: Record<ProviderKind, readonly KnownModel[]> = {
  anthropic: [
    { id: 'claude-opus-5-5', note: 'the default: long-running agent work, medium effort' },
    { id: 'claude-fable-5-1', note: 'most capable; slowest and dearest' },
    { id: 'claude-sonnet-5', note: 'fast, half the price of the default' },
    { id: 'claude-haiku-4-5', note: 'fastest and cheapest; short tasks' },
  ],
  openai: [
    { id: 'gpt-5', note: 'general purpose' },
    { id: 'gpt-5-mini', note: 'cheaper, shorter answers' },
    { id: 'gpt-4.1', note: 'previous generation, long context' },
    { id: 'gpt-4o-mini', note: 'cheapest of the 4o family' },
  ],
};

export interface ProviderModels {
  kind: ProviderKind;
  /** Which environment variable this machine would read the credential from. */
  credentialEnv: string;
  credentialKind: string;
  /** Can this installation actually run an agent on this provider today? */
  usable: boolean;
  /** Why not. Present only when `usable` is false. */
  problem?: ProviderProblem;
  /** The model an agent gets when its file pins none. */
  defaultModel: string;
  /** Where that default came from: an environment variable, or the build. */
  defaultFrom: string;
  /** The variable that overrides it, whether or not it is set. */
  defaultEnv: string;
  /** The prefix rule, for the line that explains what else would be accepted. */
  prefixes: readonly string[];
  models: readonly KnownModel[];
}

/**
 * Every provider, with its models and whether this machine can reach it.
 *
 * `env` is passed in, as everywhere else in core: nothing here reads
 * `process.env`, and nothing is discovered.
 */
export function modelCatalogue(
  env: NodeJS.ProcessEnv,
  only?: ProviderKind,
): ProviderModels[] {
  const kinds = only ? [only] : [...PROVIDER_KINDS];
  return kinds.map((kind) => {
    const ref = providerFromEnv(env, undefined, kind);
    const resolution = resolveProvider(ref, env);
    const fallback = PROVIDER_MODEL_DEFAULTS[kind];
    const pinnedByEnv = (env[fallback.env] ?? '').trim();
    return {
      kind,
      credentialEnv: ref.credential.env,
      credentialKind: ref.credential.kind,
      usable: resolution.ok,
      ...(resolution.ok ? {} : { problem: resolution.problem }),
      defaultModel: ref.model,
      defaultFrom: pinnedByEnv === '' ? 'built-in default' : fallback.env,
      defaultEnv: fallback.env,
      prefixes: MODEL_PREFIXES[kind],
      models: KNOWN_MODELS[kind],
    };
  });
}
