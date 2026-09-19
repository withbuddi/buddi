import { expect, it, vi } from 'vitest';
import type { ResolvedProvider } from '@buddi/core';
import { listProviderModels, modelOptions } from './provider-models.js';
import type { HttpTransport } from './transport.js';
const provider: ResolvedProvider = { kind: 'openai', baseUrl: 'https://example.test/api/v1', secret: 'fixture-secret', credentialKind: 'api-key', model: 'gpt-test' };
const response = (data: unknown, status = 200) => ({ ok: status === 200, status, json: async () => data }) as Awaited<ReturnType<HttpTransport>>;
it('uses only the configured account endpoint and key without sending a prompt', async () => {
  const transport = vi.fn<HttpTransport>().mockResolvedValue(response({ data: [{ id: 'gpt-test' }, { id: 'custom/model' }] }));
  expect((await listProviderModels(provider, transport)).models.map(m => m.id)).toEqual(['gpt-test', 'custom/model']);
  expect(transport).toHaveBeenCalledWith('https://example.test/api/v1/models', expect.objectContaining({ method: 'GET', headers: { accept: 'application/json', authorization: 'Bearer fixture-secret' }, maxBytes: 2097152 }));
  expect(transport.mock.calls[0]?.[1].body).toBeUndefined();
});
it('paginates Anthropic lists with the right authentication and deduplicates', async () => {
  const transport = vi.fn<HttpTransport>().mockResolvedValueOnce(response({ data: [{ id: 'claude-test', display_name: 'Claude Test' }], has_more: true, last_id: 'claude-test' }))
    .mockResolvedValue(response({ data: [{ id: 'claude-test' }, { id: 'claude-next' }], has_more: false }));
  const result = await listProviderModels({ ...provider, kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }, transport);
  expect(result.models).toHaveLength(2);
  expect(transport.mock.calls[0]?.[1].headers).toMatchObject({ 'x-api-key': 'fixture-secret', 'anthropic-version': '2023-06-01' });
  expect(transport.mock.calls[1]?.[0]).toContain('after_id=claude-test');
});
it('uses subscription bearer auth without falling back and omits auth for no-key servers', async () => {
  const transport = vi.fn<HttpTransport>().mockResolvedValue(response({ data: [] }));
  await listProviderModels({ ...provider, kind: 'anthropic', credentialKind: 'subscription-token' }, transport);
  expect(transport.mock.calls[0]?.[1].headers).toMatchObject({ authorization: 'Bearer fixture-secret', 'anthropic-beta': 'oauth-2025-04-20' });
  await listProviderModels({ ...provider, secret: '' }, transport);
  expect(transport.mock.calls[1]?.[1].headers.authorization).toBeUndefined();
});
it('redacts error bodies and rejects malformed or looping pagination', async () => {
  const transport = vi.fn<HttpTransport>().mockResolvedValue(response({ secret: 'LEAK' }, 401));
  await expect(listProviderModels(provider, transport)).rejects.toMatchObject({ status: 401, message: 'Could not retrieve the provider model list.' });
  transport.mockResolvedValue(response({ data: [], has_more: true, last_id: 'same' }));
  await expect(listProviderModels(provider, transport)).rejects.toThrow('pagination');
  transport.mockResolvedValue(response({ data: 'LEAK' }));
  await expect(listProviderModels(provider, transport)).rejects.toThrow('Invalid provider');
});
it('returns only bounded model metadata, including native defaults', () => {
  expect(modelOptions([{ model: 'gpt-test', displayName: 'Test', isDefault: true, secret: 'LEAK' }], true)).toEqual([{ id: 'gpt-test', name: 'Test', isDefault: true }]);
  expect(modelOptions([{ id: 'bad\nmodel' }, { id: 'x'.repeat(151) }, null])).toEqual([]);
});
