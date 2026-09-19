import { describe, expect, it, vi } from 'vitest';
import { createMemoryVault } from '@buddi/core';
import type { CodexSession, RpcMessage } from '@buddi/runtime';
import { CODEX_EXPERIMENT_CONFIG } from '@buddi/runtime';
import { CodexAccounts } from './codex-accounts.js';

const secret = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake-access', refresh_token: 'fake-refresh' } });
function fixture(options: { early?: boolean; badUrl?: boolean; timeout?: number } = {}) {
  const messages = new Set<(m: RpcMessage) => void>();
  const closes = new Set<(e: Error) => void>();
  const emit = (id = 'login1', success = true) => { for (const listener of messages) listener({ method: 'account/login/completed', params: { loginId: id, success } }); };
  const session: CodexSession = {
    cwd: '/private/fake', credential: vi.fn(async () => secret), dispose: vi.fn(async () => {}),
    rpc: {
      request: vi.fn(async (method) => {
        if (method === 'config/read') return { config: { sandbox_mode: 'read-only', web_search: 'disabled', features: Object.fromEntries(Object.entries(CODEX_EXPERIMENT_CONFIG).filter(([key]) => key.startsWith('features.')).map(([key, value]) => [key.slice(9), value])) } };
        if (method === 'skills/list') return { data: [{ skills: [], errors: [] }] };
        if (method === 'account/login/start') {
          if (options.early) emit();
          return { type: 'chatgptDeviceCode', loginId: 'login1', verificationUrl: options.badUrl ? 'https://evil.example/collect' : 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' };
        }
        return {};
      }), notify: vi.fn(),
      close: vi.fn(async () => { for (const fn of closes) fn(new Error('closed')); }),
      onMessage(listener) { messages.add(listener); return () => { messages.delete(listener); }; },
      onClose(listener) { closes.add(listener); return () => { closes.delete(listener); }; },
    },
  };
  const vault = createMemoryVault();
  const open = vi.fn(async () => session);
  const service = new CodexAccounts({ vault, open, loginTimeoutMs: options.timeout ?? 1000 });
  const access = { id: 'account1', secretRef: 'CODEX_TEST_ACCOUNT', check: vi.fn(async () => {}) };
  return { service, session, vault, access, open, emit };
}

describe('Codex subscription session lifecycle', () => {
  it('lists paginated native models without opening a thread, and persists refresh safely', async () => {
    const f = fixture(); await f.vault.set(f.access.secretRef, secret);
    vi.mocked(f.session.rpc.request).mockImplementation(async (method, params) => {
      if (method === 'model/list') return (params as { cursor?: string }).cursor
        ? { data: [{ model: 'gpt-two', displayName: 'Two', isDefault: false }], nextCursor: null }
        : { data: [{ model: 'gpt-one', displayName: 'One', isDefault: true }], nextCursor: 'next' };
      return {};
    });
    expect((await f.service.models(f.access)).models.map(m => m.id)).toEqual(['gpt-one', 'gpt-two']);
    expect(f.session.rpc.request).not.toHaveBeenCalledWith('thread/start', expect.anything());
    expect(f.session.rpc.request).not.toHaveBeenCalledWith('turn/start', expect.anything());
    expect(f.access.check).toHaveBeenCalledTimes(2);
    expect(f.session.dispose).toHaveBeenCalled();
  });
  it('refuses model discovery during sign-in and cleans up malformed lists', async () => {
    const f = fixture(); await f.vault.set(f.access.secretRef, secret);
    const login = await f.service.login(f.access);
    await expect(f.service.models(f.access)).rejects.toThrow('busy');
    await f.service.cancel(f.access.id); await login.finished;
    await expect(f.service.models(f.access)).rejects.toThrow('Invalid native model list');
    expect(f.session.dispose).toHaveBeenCalled();
  });
  it('persists only after a matching successful login and never returns tokens', async () => {
    const f = fixture(); const start = await f.service.login(f.access);
    expect(f.open).toHaveBeenCalledWith(null);
    expect(start.view).toMatchObject({ state: 'pending', userCode: 'ABCD-1234' });
    f.emit('other-login'); expect(await f.vault.get(f.access.secretRef)).toBeNull();
    f.emit(); await start.finished;
    expect(await f.vault.get(f.access.secretRef)).toBe(secret);
    expect(f.service.view(f.access.id)?.state).toBe('connected');
    expect(JSON.stringify(f.service.view(f.access.id))).not.toContain('fake-access');
    expect(f.session.dispose).toHaveBeenCalled();
  });
  it('accepts an early matching completion but never a stale completion after cancellation', async () => {
    const f = fixture({ early: true }); const start = await f.service.login(f.access); await start.finished;
    expect(f.service.view(f.access.id)?.state).toBe('connected');
    const g = fixture(); const pending = await g.service.login(g.access);
    await g.service.cancel(g.access.id); g.emit(); await pending.finished;
    expect(await g.vault.get(g.access.secretRef)).toBeNull();
    expect(g.service.view(g.access.id)?.state).toBe('cancelled');
  });
  it('preserves an old credential when reconnect is cancelled or fails', async () => {
    for (const cancel of [true, false]) {
      const f = fixture(); await f.vault.set(f.access.secretRef, 'old-fixture');
      const start = await f.service.login(f.access);
      if (cancel) await f.service.cancel(f.access.id); else f.emit('login1', false);
      await start.finished;
      expect(await f.vault.get(f.access.secretRef)).toBe('old-fixture');
    }
  });
  it('rejects a changed/disabled account before credential persistence', async () => {
    const f = fixture(); const start = await f.service.login(f.access);
    f.access.check.mockRejectedValue(new Error('disabled')); f.emit(); await start.finished;
    expect(await f.vault.get(f.access.secretRef)).toBeNull();
    expect(f.service.view(f.access.id)?.state).toBe('failed');
  });
  it('rejects non-provider sign-in URLs and cleans up', async () => {
    const f = fixture({ badUrl: true });
    await expect(f.service.login(f.access)).rejects.toThrow('unsupported');
    expect(f.session.dispose).toHaveBeenCalled();
    expect(await f.vault.get(f.access.secretRef)).toBeNull();
  });
  it('bounds sign-in time and removes the one-time code from status', async () => {
    const f = fixture({ timeout: 5 }); const start = await f.service.login(f.access); await start.finished;
    expect(f.service.view(f.access.id)).toMatchObject({ state: 'cancelled' });
    expect(f.service.view(f.access.id)?.userCode).toBeUndefined();
    expect(f.session.dispose).toHaveBeenCalled();
  });
  it('serializes one account and redacts vault failures', async () => {
    const f = fixture(); const start = await f.service.login(f.access);
    await expect(f.service.login(f.access)).rejects.toThrow('busy');
    vi.spyOn(f.vault, 'set').mockRejectedValue(new Error('sensitive-vault-detail'));
    f.emit(); await start.finished;
    expect(f.service.view(f.access.id)?.state).toBe('failed');
    expect(JSON.stringify(f.service.view(f.access.id))).not.toContain('sensitive');
  });
});
