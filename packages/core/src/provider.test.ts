import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  modelBelongsTo,
  providerAuthHeaders,
  providerForModel,
  PROVIDER_CREDENTIAL_INVARIANT,
  PROVIDER_KINDS,
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

  it('rejects a provider kind this build has no adapter for', () => {
    const r = resolveProvider({ ...apiKeyRef, kind: 'mistral' } as unknown as ProviderRef, {
      ANTHROPIC_API_KEY: 'k',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe('unknown-provider');
    expect(r.problem.message).toContain('mistral');
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


const openAiRef: ProviderRef = {
  kind: 'openai',
  credential: { kind: 'api-key', env: 'OPENAI_API_KEY' },
  model: 'gpt-5',
};

describe('resolveProvider — openai', () => {
  it('resolves an api-key credential and defaults the base URL', () => {
    const r = resolveProvider(openAiRef, { OPENAI_API_KEY: 'sk-openai' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider).toEqual({
      kind: 'openai',
      baseUrl: DEFAULT_OPENAI_BASE_URL,
      credentialKind: 'api-key',
      secret: 'sk-openai',
      model: 'gpt-5',
    });
  });

  it('sends a bearer token, never x-api-key', () => {
    const r = resolveProvider(openAiRef, { OPENAI_API_KEY: 'sk-openai' });
    expect(r.ok && providerAuthHeaders(r.provider)).toEqual({
      authorization: 'Bearer sk-openai',
    });
  });

  it('fails closed when OPENAI_API_KEY is absent, and never falls back to the Anthropic key', () => {
    const r = resolveProvider(openAiRef, { ANTHROPIC_API_KEY: 'sk-ant' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe('missing-credential');
    expect(r.problem.message).toContain('OPENAI_API_KEY');
  });

  it('refuses a credential kind that does not belong to the provider', () => {
    const r = resolveProvider(
      { ...openAiRef, credential: { kind: 'subscription-token', env: 'T' } } as unknown as ProviderRef,
      { T: 'tok' },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe('credential-mismatch');
  });
});

describe('the provider/credential/wire invariant', () => {
  it('is named as a constant', () => {
    expect(PROVIDER_CREDENTIAL_INVARIANT).toContain('api-key');
  });

  it('allows a base URL only alongside an explicit api-key credential', () => {
    // OpenAI: api-key is the only kind, so a custom base URL always resolves.
    const openai = resolveProvider(
      { ...openAiRef, baseUrl: 'https://compatible.internal/v1' },
      { OPENAI_API_KEY: 'k' },
    );
    expect(openai.ok && openai.provider.baseUrl).toBe('https://compatible.internal/v1');

    // Anthropic api-key: same.
    const withKey = resolveProvider(
      { ...apiKeyRef, baseUrl: 'https://proxy.internal' },
      { ANTHROPIC_API_KEY: 'k' },
    );
    expect(withKey.ok).toBe(true);

    // A subscription token pointed at another host is the exfiltration shape
    // the invariant exists to make hard. It never resolves.
    const withToken = resolveProvider(
      {
        ...apiKeyRef,
        baseUrl: 'https://attacker.example',
        credential: { kind: 'subscription-token', env: 'T' },
      },
      { T: 'sk-ant-oat01-secret' },
    );
    expect(withToken.ok).toBe(false);
    if (withToken.ok) return;
    expect(withToken.problem.code).toBe('base-url-not-allowed');
  });

  it('never lets a credential kind cross to the wrong provider', () => {
    for (const kind of PROVIDER_KINDS) {
      const r = resolveProvider(
        { kind, credential: { kind: 'ambient', env: 'X' }, model: 'claude-sonnet-5' } as unknown as ProviderRef,
        { X: 'v' },
      );
      expect(r.ok).toBe(false);
    }
  });
});

describe('the model catalogue', () => {
  it('validates within a provider', () => {
    expect(modelBelongsTo('anthropic', 'claude-sonnet-5')).toBe(true);
    expect(modelBelongsTo('openai', 'gpt-5')).toBe(true);
    expect(modelBelongsTo('openai', 'claude-sonnet-5')).toBe(false);
    expect(providerForModel('o3-mini')).toBe('openai');
    expect(providerForModel('llama-3')).toBeUndefined();
  });

  it('never migrates a model to the provider that does serve it', () => {
    const r = resolveProvider({ ...openAiRef, model: 'claude-sonnet-5' }, {
      OPENAI_API_KEY: 'k',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe('unknown-model');
    expect(r.problem.message).toContain('anthropic');
  });

  it('treats a model no catalogue claims as a configuration problem', () => {
    const r = resolveProvider({ ...apiKeyRef, model: 'gpt-oss-120b' }, {
      ANTHROPIC_API_KEY: 'k',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.code).toBe('unknown-model');
  });
});
