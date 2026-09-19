import { modelProblem, type ProviderKind, type ResolvedProvider } from './provider.js';

/** Account identity is separate from the protocol used by the runtime adapter. */
export type ProviderAccountKind = 'anthropic' | 'openai' | 'openai-compatible' | 'codex';
export type ProviderAccountAuth = 'api-key' | 'none' | 'legacy-subscription-token' | 'chatgpt';
export interface ProviderAccount {
  id: string;
  label: string;
  kind: ProviderAccountKind;
  auth: ProviderAccountAuth;
  baseUrl: string;
  defaultModel: string;
  enabled: boolean;
  revision: number;
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
  if (account.auth === 'legacy-subscription-token' && account.kind !== 'anthropic') throw new Error('Subscription credential does not belong to this provider.');
  if (account.auth === 'none' && account.kind !== 'openai-compatible') throw new Error('This provider requires a credential.');
  if (account.auth !== 'none' && !secret?.trim()) throw new Error('Provider account credential is missing or the vault is locked.');
  return {
    kind: accountProtocol(account.kind),
    baseUrl: accountBaseUrl(account.kind, account.baseUrl),
    credentialKind: account.auth === 'legacy-subscription-token' ? 'subscription-token' : 'api-key',
    secret: secret ?? '', model,
    ...(account.kind === 'openai-compatible' ? { compatible: true } : {}),
  };
}
