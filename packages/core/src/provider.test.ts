import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANTHROPIC_BASE_URL,
  providerAuthHeaders,
  resolveProvider,
  type ProviderRef,
} from './provider.js';

const apiKeyRef: ProviderRef = {
  kind: 'anthropic',
  credential: { kind: 'api-key', env: 'ANTHROPIC_API_KEY' },
  model: 'claude-sonnet-4-5',
};

describe('resolveProvider', () => {
  it('resolves an api-key credential and defaults the base URL', () => {
    const r = resolveProvider(apiKeyRef, { ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider).toEqual({
      kind: 'anthropic',
      baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
      credentialKind: 'api-key',
      secret: 'sk-ant-test',
      model: 'claude-sonnet-4-5',
    });
  });

  it('honours an explicit base URL', () => {
    const r = resolveProvider(
      { ...apiKeyRef, baseUrl: 'https://proxy.internal' },
      { ANTHROPIC_API_KEY: 'k' },
    );
    expect(r.ok && r.provider.baseUrl).toBe('https://proxy.internal');
  });

  it('resolves a subscription token', () => {
    const r = resolveProvider(
      {
        kind: 'anthropic',
        credential: { kind: 'subscription-token', env: 'CLAUDE_CODE_OAUTH_TOKEN' },
        model: 'claude-opus-4-1',
      },
      { CLAUDE_CODE_OAUTH_TOKEN: ' tok ' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider.credentialKind).toBe('subscription-token');
    expect(r.provider.secret).toBe('tok');
  });

  it('fails closed when the variable is absent', () => {
    const r = resolveProvider(apiKeyRef, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe('missing-credential');
  });

  it('fails closed when the variable is empty or whitespace', () => {
    for (const value of ['', '   ']) {
      const r = resolveProvider(apiKeyRef, { ANTHROPIC_API_KEY: value });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.problem.code).toBe('empty-credential');
    }
  });

  it('rejects an unsupported provider kind', () => {
    const r = resolveProvider({ ...apiKeyRef, kind: 'openai' } as unknown as ProviderRef, {
      ANTHROPIC_API_KEY: 'k',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe('unsupported');
  });

  it('rejects a ref with no model pinned', () => {
    const r = resolveProvider({ ...apiKeyRef, model: '' }, { ANTHROPIC_API_KEY: 'k' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe('unsupported');
  });

  it('never reads process.env implicitly', () => {
    process.env.BUDDI_TEST_AMBIENT = 'ambient';
    const r = resolveProvider(
      { ...apiKeyRef, credential: { kind: 'api-key', env: 'BUDDI_TEST_AMBIENT' } },
      {},
    );
    delete process.env.BUDDI_TEST_AMBIENT;
    expect(r.ok).toBe(false);
  });

  it('maps credential kind to the right wire header', () => {
    const a = resolveProvider(apiKeyRef, { ANTHROPIC_API_KEY: 'k' });
    expect(a.ok && providerAuthHeaders(a.provider)).toEqual({ 'x-api-key': 'k' });
    const b = resolveProvider(
      { ...apiKeyRef, credential: { kind: 'subscription-token', env: 'T' } },
      { T: 'k' },
    );
    expect(b.ok && providerAuthHeaders(b.provider)).toEqual({
      authorization: 'Bearer k',
    });
  });
});
