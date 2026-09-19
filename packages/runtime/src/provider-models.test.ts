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

it('tags what an Ollama host says can think, and leaves other hosts untagged', async () => {
  const calls: string[] = [];
  const transport = (async (url: string, init: any) => {
    calls.push(url);
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'gemma4:12b' }, { id: 'smollm:135m' }] }), { status: 200 });
    if (url.endsWith('/api/show')) {
      const { model } = JSON.parse(init.body);
      return new Response(JSON.stringify({ capabilities: model === 'gemma4:12b' ? ['completion', 'thinking'] : ['completion'] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as any;
  const local = { kind: 'openai', compatible: true, secret: '', baseUrl: 'http://localhost:11434/v1', model: 'x', credentialKind: 'api-key' } as any;
  const result = await listProviderModels(local, transport);
  expect(result.models).toEqual([
    { id: 'gemma4:12b', name: 'gemma4:12b', isDefault: false, thinks: true },
    { id: 'smollm:135m', name: 'smollm:135m', isDefault: false, thinks: false },
  ]);
  expect(calls.filter((u) => u.endsWith('/api/show'))).toHaveLength(2);

  // A host without a `/v1` suffix has no known sibling to ask.
  const other = { ...local, baseUrl: 'https://api.example.com' };
  calls.length = 0;
  const plain = await listProviderModels(other, transport);
  expect(plain.models.every((m) => m.thinks === undefined)).toBe(true);
  expect(calls.some((u) => u.endsWith('/api/show'))).toBe(false);
});
