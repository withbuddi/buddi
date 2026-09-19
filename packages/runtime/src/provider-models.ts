import type { ResolvedProvider } from '@buddi/core';
import { defaultHttpTransport, type HttpTransport } from './transport.js';

export interface AccountModel { id: string; name: string; isDefault: boolean }
export interface AccountModels { models: AccountModel[]; truncated: boolean }

/** Only picker metadata crosses this boundary, never arbitrary provider fields. */
export function modelOptions(items: unknown[], native = false): AccountModel[] {
  const found = new Map<string, AccountModel>();
  for (const value of items) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const id = native ? item.model : item.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 150 || /[\x00-\x1f\x7f]/.test(id)) continue;
    const label = native ? item.displayName : item.display_name ?? item.name;
    const name = typeof label === 'string' && label.length <= 200 && !/[\x00-\x1f\x7f]/.test(label) ? label : id;
    found.set(id, { id, name, isDefault: native && item.isDefault === true });
  }
  return [...found.values()];
}

/** Discovery is metadata only: no completion, prompt, or credential fallback. */
export async function listProviderModels(provider: ResolvedProvider, transport: HttpTransport = defaultHttpTransport): Promise<AccountModels> {
  const anthropic = provider.kind === 'anthropic';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (anthropic) {
    headers['anthropic-version'] = '2023-06-01';
    if (provider.credentialKind === 'subscription-token') {
      headers.authorization = `Bearer ${provider.secret}`;
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    } else headers['x-api-key'] = provider.secret;
  } else if (provider.secret) headers.authorization = `Bearer ${provider.secret}`;
  const endpoint = provider.baseUrl.replace(/\/+$/, '') + (anthropic ? '/v1/models' : '/models');
  const models: AccountModel[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  const signal = AbortSignal.timeout(20_000);
  for (let page = 0; page < 10; page++) {
    const url = new URL(endpoint);
    if (anthropic) url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set(anthropic ? 'after_id' : 'after', cursor);
    const response = await transport(url.toString(), { method: 'GET', headers, signal, maxBytes: 2 * 1024 * 1024 });
    if (!response.ok) throw Object.assign(new Error('Could not retrieve the provider model list.'), { status: response.status });
    const data = await response.json();
    if (!data || !Array.isArray(data.data)) throw new Error('Invalid provider model list.');
    models.push(...modelOptions(data.data));
    if (models.length > 1000) return { models: modelOptions(models).slice(0, 1000), truncated: true };
    if (data.has_more !== true) return { models: modelOptions(models), truncated: false };
    if (typeof data.last_id !== 'string' || data.last_id.length > 2048 || seen.has(data.last_id)) throw new Error('Invalid model pagination.');
    cursor = data.last_id as string; seen.add(cursor);
  }
  return { models: modelOptions(models), truncated: true };
}
