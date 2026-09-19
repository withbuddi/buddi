import { describe, expect, it } from 'vitest';
import { accountBaseUrl, accountModelProblem, resolveProviderAccount, type ProviderAccount } from './provider-accounts.js';
import { providerAuthHeaders, resolveProvider } from './provider.js';
const local: ProviderAccount = { id: 'local', label: 'Local', kind: 'openai-compatible', auth: 'none', baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen3:8b', enabled: true, revision: 1 };
describe('provider account domain', () => {
  it('never sends native subscription credentials through an API adapter', () => {
    expect(accountBaseUrl('codex')).toBe('https://chatgpt.com');
    expect(accountModelProblem('codex', 'gpt-5')).toBeUndefined();
    expect(() => resolveProviderAccount({ ...local, kind: 'codex', auth: 'chatgpt' }, 'gpt-5', 'native-secret')).toThrow('fallback is forbidden');
  });
  it('cannot bypass an account assignment by resolving ambient credentials', () => {
    const result = resolveProvider({ kind: 'anthropic', model: 'claude-sonnet-5', accountId: 'disabled-account', credential: { kind: 'api-key', env: 'ANTHROPIC_API_KEY' } }, { ANTHROPIC_API_KEY: 'fixture' });
    expect(result).toMatchObject({ ok: false, problem: { code: 'unsupported' } });
  });
  it('separates compatible model names and authentication from OpenAI', () => {
    expect(accountModelProblem('openai-compatible', 'qwen3:8b')).toBeUndefined();
    expect(accountModelProblem('openai', 'qwen3:8b')).toBeDefined();
    const resolved = resolveProviderAccount(local, local.defaultModel, null);
    expect(resolved).toMatchObject({ kind: 'openai', compatible: true, secret: '' });
    expect(providerAuthHeaders(resolved)).toEqual({});
  });
  it('normalizes endpoints without destroying custom API paths', () => {
    expect(accountBaseUrl('openai-compatible', 'http://localhost:11434')).toBe('http://localhost:11434/v1');
    expect(accountBaseUrl('openai-compatible', 'https://openrouter.ai/api/v1/')).toBe('https://openrouter.ai/api/v1');
    for (const url of ['http://remote.example/v1', 'https://user:secret@remote.example/v1', 'https://remote.example/?key=secret', 'file:///tmp/x']) {
      expect(() => accountBaseUrl('openai-compatible', url)).toThrow();
    }
    expect(() => accountBaseUrl('anthropic', 'https://other.example')).toThrow();
  });
  it('refuses disabled, missing-key, wrong-auth and redirected subscription accounts', () => {
    expect(() => resolveProviderAccount({ ...local, enabled: false }, local.defaultModel, null)).toThrow('disabled');
    expect(() => resolveProviderAccount({ ...local, auth: 'api-key' }, local.defaultModel, null)).toThrow('missing');
    expect(() => resolveProviderAccount({ ...local, auth: 'legacy-subscription-token' }, local.defaultModel, 'token')).toThrow('does not belong');
    expect(() => resolveProviderAccount({ ...local, kind: 'anthropic', auth: 'legacy-subscription-token' }, 'claude-sonnet-5', 'token')).toThrow('custom endpoint');
  });
});
