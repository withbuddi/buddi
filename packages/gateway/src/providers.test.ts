import { describe, expect, it, vi } from 'vitest';
import { createMemoryVault, providerFromEnv, resolveProvider, VaultLockedError } from '@buddi/core';
import { ProviderSettings } from './providers.js';

export class ProviderDb {
  configs = new Map<string, any>(); removed = new Map<string, boolean>(); writes: unknown[] = [];
  async query(sql: string, args: any[] = []) {
    if (sql.startsWith('select provider')) return { rows: [...this.configs.values()] };
    if (sql.startsWith('select name')) return { rows: [...this.removed].map(([name, removed]) => ({ name, removed })) };
    this.writes.push(args);
    if (sql.startsWith('insert into core.provider_settings')) this.configs.set(args[0], { provider: args[0], credential_kind: args[1], default_model: args[2] });
    else if (sql.startsWith('insert into core.provider_credential_state')) this.removed.set(args[0], sql.includes('values ($1,true)'));
    else throw new Error('Unexpected query');
    return { rows: [] };
  }
}
function fixture(env: NodeJS.ProcessEnv = {}) {
  const pool = new ProviderDb(), vault = createMemoryVault(), reload = vi.fn(), test = vi.fn(async () => {});
  const manager = new ProviderSettings({ pool, vault, env, reload, test });
  return { pool, vault, env, reload, test, manager };
}
describe('owner provider management', () => {
  it('keeps keys out of Postgres and responses, reloads credentials and preserves explicit auth selection', async () => {
    const f = fixture();
    await f.manager.load();
    await f.manager.credential('ANTHROPIC_API_KEY', 'save', { value: 'private-api-value' });
    await f.manager.credential('CLAUDE_CODE_OAUTH_TOKEN', 'save', { value: 'private-token-value' });
    await f.manager.configure('anthropic', { credentialKind: 'api-key', defaultModel: 'claude-sonnet-5' });
    expect(providerFromEnv(f.env).credential.env).toBe('ANTHROPIC_API_KEY');
    expect(await f.vault.get('ANTHROPIC_API_KEY')).toBe('private-api-value');
    expect(JSON.stringify(f.pool.writes)).not.toContain('private-');
    expect(JSON.stringify(f.manager.view())).not.toContain('private-');
    expect(f.reload).toHaveBeenCalled();
    expect(f.test).not.toHaveBeenCalled();
  });
  it('removal survives restart and suppresses stale environment fallback', async () => {
    const f = fixture({ OPENAI_API_KEY: 'old-env-key' });
    await f.manager.credential('OPENAI_API_KEY', 'save', { value: 'vault-key' });
    await f.manager.credential('OPENAI_API_KEY', 'remove', {});
    expect(f.env.OPENAI_API_KEY).toBeUndefined();
    expect(await f.vault.get('OPENAI_API_KEY')).toBeNull();
    const env = { OPENAI_API_KEY: 'old-env-key' };
    const restarted = new ProviderSettings({ ...f, env }); await restarted.load();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(restarted.view().providers.find(p => p.kind === 'openai')?.usable).toBe(false);
    await restarted.credential('OPENAI_API_KEY', 'save', { value: 'replacement-key' });
    expect(env.OPENAI_API_KEY).toBe('replacement-key');
  });
  it('never falls back to another auth kind when the owner explicitly selected a missing key', async () => {
    const f = fixture({ CLAUDE_CODE_OAUTH_TOKEN: 'subscription' });
    await f.manager.configure('anthropic', { credentialKind: 'api-key', defaultModel: 'claude-sonnet-5' });
    expect(resolveProvider(providerFromEnv(f.env), f.env).ok).toBe(false);
  });
  it('refuses invalid settings and arbitrary secret names without side effects', async () => {
    const f = fixture();
    expect(() => f.manager.configure('openai', { credentialKind: 'subscription-token', defaultModel: 'gpt-5' })).toThrow('Invalid');
    expect(() => f.manager.configure('openai', { credentialKind: 'api-key', defaultModel: 'claude-sonnet-5' })).toThrow('Model');
    expect(() => f.manager.credential('DATABASE_URL', 'save', { value: 'x' })).toThrow('Unknown');
    expect(() => f.manager.credential('OPENAI_API_KEY', 'save', { value: ' ' })).toThrow('non-empty');
    expect(f.pool.writes).toEqual([]);
  });
  it('redacts vault errors and keeps removal disabled even when physical deletion fails', async () => {
    const f = fixture();
    vi.spyOn(f.vault, 'set').mockRejectedValue(new Error('SECRET MUST NOT APPEAR'));
    await expect(f.manager.credential('OPENAI_API_KEY', 'save', { value: 'x' })).rejects.toThrow('Could not save');
    expect(f.pool.writes).toEqual([]);
    vi.spyOn(f.vault, 'delete').mockRejectedValue(new VaultLockedError('SECRET MUST NOT APPEAR'));
    await expect(f.manager.credential('OPENAI_API_KEY', 'remove', {})).rejects.toThrow('Credential disabled');
    expect(f.pool.removed.get('OPENAI_API_KEY')).toBe(true);
  });
  it.each([401, 403, 429, 500])('reports a safe connection-test result for status %s', async status => {
    const f = fixture({ OPENAI_API_KEY: 'fixture' });
    f.test.mockRejectedValue(Object.assign(new Error('SECRET MUST NOT APPEAR'), { status }));
    const result = await f.manager.test('openai');
    expect(result.state).toBe(status === 429 ? 'rate-limited' : status === 500 ? 'unavailable' : 'authentication-error');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('does not label a changed credential with an old in-flight test result', async () => {
    const f = fixture({ OPENAI_API_KEY: 'fixture' });
    let finish!: () => void;
    f.test.mockImplementation(() => new Promise<void>(r => { finish = r; }));
    const pending = f.manager.test('openai');
    await expect(f.manager.test('openai')).rejects.toThrow('already running');
    await f.manager.credential('OPENAI_API_KEY', 'save', { value: 'new' });
    finish();
    await expect(pending).rejects.toThrow('settings changed');
    expect(f.manager.view().providers.find(p => p.kind === 'openai')?.test).toBeNull();
  });
});
