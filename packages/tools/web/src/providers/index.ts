/**
 * Choosing a backend, and resolving its key.
 *
 * Two facts decide everything here, and both are *owner configuration*, never
 * an agent's choice — the same rule `@buddi/tool-email` applies to which
 * mailbox it reads. There is no `web.set_provider` tool for a model to argue
 * with: which company sees the owner's questions is a decision he makes in
 * `.env` or the vault, at startup.
 *
 * The key is read by **name**, through the environment the composition root
 * already hydrated from the vault (`hydrateSecrets`), exactly as
 * `GMAIL_APP_PASSWORD` is. Nothing in this package opens a keychain, and
 * nothing in this package holds a key between calls: it is read at the moment
 * of the search and dropped.
 */
import { parseSearchBackend, NATIVE_BACKEND_ID, SEARCH_BACKEND_VAR } from '@buddi/runtime';
import { brave, BRAVE_KEY_NAME } from './brave.js';
import { tavily, TAVILY_KEY_NAME } from './tavily.js';
import type { SearchProvider } from '../ports.js';

export { tavily, TAVILY_HOST, TAVILY_KEY_NAME } from './tavily.js';
export { brave, BRAVE_HOST, BRAVE_KEY_NAME } from './brave.js';

export type EnvLike = Record<string, string | undefined>;

/**
 * The env var that names the backend.
 *
 * Re-exported from `@buddi/runtime` rather than spelled again, because the
 * runtime is the one that has to read it *before* a request is built — it
 * decides whether the provider will search server-side, which the plugin
 * cannot know (it never sees the agent, and therefore never sees the provider).
 * One parser, one meaning. `@buddi/tool-web` already depends on the runtime for
 * its transport, so this costs nothing new.
 */
export const PROVIDER_VAR = SEARCH_BACKEND_VAR;

/** What `BUDDI_SEARCH_PROVIDER=native` names: the provider's own search. */
export { NATIVE_BACKEND_ID };

/** Every backend this build knows, in the order `buddi doctor` lists them. */
export const PROVIDERS: readonly SearchProvider[] = [tavily, brave];

/** The default. See `providers/tavily.ts` for why it is this one. */
export const DEFAULT_PROVIDER: SearchProvider = tavily;

/** Every secret name a search backend might need — what the vault is told about. */
export const SEARCH_KEY_NAMES: readonly string[] = [TAVILY_KEY_NAME, BRAVE_KEY_NAME];

/**
 * Which backend this installation uses.
 *
 * An unknown name is not a silent fallback: it returns the default *and* says
 * what happened, so `buddi doctor` can show a typo instead of the owner
 * wondering why `BUDDI_SEARCH_PROVIDER=braev` changed nothing.
 */
export function selectProvider(env: EnvLike = process.env): {
  provider: SearchProvider;
  /**
   * True when the owner asked for the provider's own server-side search. The
   * HTTP backend still comes back beside it: it is what an agent on a provider
   * with no server-side search falls back to, and what `web.search` uses if it
   * is ever called anyway.
   */
  native?: boolean;
  problem?: string;
} {
  const choice = parseSearchBackend(env);
  if (choice.mode === 'auto') return { provider: DEFAULT_PROVIDER };
  if (choice.mode === 'native') return { provider: DEFAULT_PROVIDER, native: true };
  const found = PROVIDERS.find((p) => p.id === choice.id);
  if (found) return { provider: found };
  return {
    provider: DEFAULT_PROVIDER,
    problem: `${PROVIDER_VAR} names "${choice.id}", which this build does not have (it knows ${[...PROVIDERS.map((p) => p.id), NATIVE_BACKEND_ID].join(', ')}); using ${DEFAULT_PROVIDER.id}`,
  };
}

export type KeyState =
  | { configured: true; key: string }
  | { configured: false; reason: string };

/**
 * The provider's key, or the sentence saying it is not there.
 *
 * `<vault>` is the marker `buddi vault import-env` leaves in `.env` after
 * moving a secret; it is never a key. A process that sees it has not been
 * hydrated, which is a real condition worth naming rather than a key that
 * happens to be wrong.
 */
export function resolveKey(provider: SearchProvider, env: EnvLike = process.env): KeyState {
  const raw = (env[provider.keyName] ?? '').trim();
  if (raw === '') {
    return {
      configured: false,
      reason: `no ${provider.keyName} is set, so ${provider.label} cannot be called`,
    };
  }
  if (raw === '<vault>' || raw === '"<vault>"') {
    return {
      configured: false,
      reason: `${provider.keyName} still holds the "<vault>" marker, which means this process never read the vault`,
    };
  }
  return { configured: true, key: raw };
}
