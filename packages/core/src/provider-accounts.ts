import { modelProblem, type ProviderKind, type ResolvedProvider } from './provider.js';

/** Account identity is separate from the protocol used by the runtime adapter. */
export type ProviderAccountKind = 'anthropic' | 'openai' | 'openai-compatible' | 'codex';
export type ProviderAccountAuth = 'api-key' | 'none' | 'legacy-subscription-token' | 'chatgpt' | 'anthropic-oauth';
export interface ProviderAccount {
  id: string;
  label: string;
  kind: ProviderAccountKind;
  auth: ProviderAccountAuth;
  baseUrl: string;
  defaultModel: string;
  enabled: boolean;
  revision: number;
  /**
   * What this endpoint's models hold, when the owner has said so. Null or
   * absent means the runtime's own table decides
   * (`@buddi/runtime`'s `contextWindowTokens`). It is per account because two
   * compatible endpoints are two different machines with two different
   * `num_ctx` values under the same model names.
   */
  contextWindowTokens?: number | null;
}

export function accountProtocol(kind: ProviderAccountKind): ProviderKind {
  return kind === 'anthropic' ? 'anthropic' : 'openai';
}

export function accountModelProblem(kind: ProviderAccountKind, model: string): string | undefined {
  if (!model.trim() || model.length > 150 || /[\r\n\x00-\x1f]/.test(model)) return 'Enter a valid model id (1–150 characters).';
  // Compatible servers own their model names; never apply OpenAI's prefix list.
  return kind === 'openai-compatible' ? undefined : modelProblem(accountProtocol(kind), model);
}

/** Explicit endpoint paths are preserved (OpenRouter uses /api/v1, for example). */
export function accountBaseUrl(kind: ProviderAccountKind, value?: string): string {
  const fixed = kind === 'codex' ? 'https://chatgpt.com' : kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
  if (kind !== 'openai-compatible') {
    if (value && value.replace(/\/+$/, '') !== fixed) throw new Error('Use an OpenAI-compatible account for a custom endpoint.');
    return fixed;
  }
  let url: URL;
  try { url = new URL(value ?? ''); } catch { throw new Error('Enter an absolute API base URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('The base URL cannot contain credentials, a query, or a fragment.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Use HTTPS, or HTTP on localhost for a local provider.');
  if (url.pathname === '/') url.pathname = '/v1';
  return url.toString().replace(/\/+$/, '');
}

export function resolveProviderAccount(account: ProviderAccount, model: string, secret: string | null): ResolvedProvider {
  if (account.kind === 'codex' || account.auth === 'chatgpt') throw new Error('Codex accounts require the native App Server adapter; API fallback is forbidden.');
  if (!account.enabled) throw new Error('Provider account is disabled.');
  const problem = accountModelProblem(account.kind, model);
  if (problem) throw new Error(problem);
  const subscription = account.auth === 'legacy-subscription-token' || account.auth === 'anthropic-oauth';
  if (subscription && account.kind !== 'anthropic') throw new Error('Subscription credential does not belong to this provider.');
  if (account.auth === 'none' && account.kind !== 'openai-compatible') throw new Error('This provider requires a credential.');
  if (account.auth !== 'none' && !secret?.trim()) throw new Error('Provider account credential is missing or the vault is locked.');
  return {
    kind: accountProtocol(account.kind),
    baseUrl: accountBaseUrl(account.kind, account.baseUrl),
    credentialKind: subscription ? 'subscription-token' : 'api-key',
    secret: secret ?? '', model,
    ...(account.kind === 'openai-compatible' ? { compatible: true } : {}),
  };
}

/**
 * One account as a plugin may see it: identity and state, never a secret or a
 * vault reference. What Settings → Model accounts lists.
 */
export interface ProviderAccountListing {
  id: string;
  label: string;
  kind: ProviderAccountKind;
  enabled: boolean;
  /** A credential is in the vault (or none is needed). */
  configured: boolean;
  defaultModel: string;
}

/**
 * A staged, private Codex profile: `home` is the `CODEX_HOME` a native child
 * runs under, holding this account's credential and nothing of the owner's own
 * `~/.codex`. `env` is the whole environment that child gets — the same short
 * list the chat adapter passes, ambient provider keys excluded, `CODEX_HOME`
 * set. Valid only inside the `withCodexProfile` callback.
 */
export interface CodexProfile {
  home: string;
  env: Record<string, string>;
}

/**
 * The owner's provider accounts, for a plugin that calls a model on the
 * owner's behalf with an account the owner picked on its settings page
 * (the image plugin is the first). Set by the gateway; absent in a process
 * that holds no accounts, and a tool that needs it refuses when it is.
 *
 * This is in-process code reaching credentials, which a plugin could already
 * do: it runs with everything buddi can do (docs/plugins.md §8). What the hook
 * adds is that it reaches them through the same resolver and the same
 * account lock the runtime uses, and never through ambient environment. No
 * model is ever shown any of it.
 */
export interface ProviderAccountsAccess {
  list(): ProviderAccountListing[];
  /**
   * An HTTP account's endpoint and key, resolved exactly as an agent's run
   * resolves them. A Codex account is refused: it has no key to hand out.
   */
  resolve(accountId: string, model: string, signal?: AbortSignal): Promise<ResolvedProvider>;
  /**
   * Run `use` with this Codex account's credential staged in a fresh private
   * profile, under the account's lock. A credential Codex refreshed meanwhile
   * is saved back; the profile is removed afterwards.
   */
  withCodexProfile<T>(accountId: string, use: (profile: CodexProfile) => Promise<T>, signal?: AbortSignal): Promise<T>;
}
