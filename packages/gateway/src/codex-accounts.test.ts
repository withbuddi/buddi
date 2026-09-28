import { describe, expect, it, vi } from 'vitest';
import { createMemoryVault } from '@buddi/core';
import type { CodexOAuthProtocol, CodexTokens, HttpTransport, TransportResponse } from '@buddi/runtime';
import { CodexAccounts } from './codex-accounts.js';

const HOUR = 3_600_000;
const tokens = (n: number, expiresAt: number): CodexTokens => ({ version: 1, state: 'ready', accessToken: `access-${n}`, refreshToken: `refresh-${n}`, accountId: 'acct-1', expiresAt });

function fakeProtocol(polls: Array<'pending' | 'slow_down' | { code: string; verifier: string } | { denied: string }> = []) {
  let now = 1_000_000;
  const protocol = {
    startDevice: vi.fn(async () => ({ deviceAuthId: 'dev-1', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device', intervalMs: 1, expiresAt: now + 15 * 60_000 })),
    pollDevice: vi.fn(async () => polls.shift() ?? 'pending'),
    exchange: vi.fn(async () => tokens(1, now + HOUR)),
    refresh: vi.fn(async (old: CodexTokens) => ({ ...tokens(Number(old.accessToken.split('-')[1]) + 1, now + HOUR) })),
  };
  return { protocol, clock: { get: () => now, set: (v: number) => { now = v; } } };
}
function sseOk(): HttpTransport {
  const body = `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'm', delta: 'OK' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`;
  return vi.fn<HttpTransport>(async (_url, init) => {
    init.onChunk?.(body, 200);
    return { ok: true, status: 200, statusText: '', headers: { get: () => null }, text: async () => body, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } satisfies TransportResponse;
  });
}
function fixture(options: { polls?: Parameters<typeof fakeProtocol>[0]; timeout?: number; transport?: HttpTransport } = {}) {
  const { protocol, clock } = fakeProtocol(options.polls);
  const vault = createMemoryVault();
  const transport = options.transport ?? sseOk();
  const service = new CodexAccounts({ vault, protocol: protocol as unknown as CodexOAuthProtocol, transport, now: clock.get, loginTimeoutMs: options.timeout ?? 60_000 });
  const access = { id: 'account1', secretRef: 'CODEX_TEST_ACCOUNT', check: vi.fn(async () => {}) };
  return { service, protocol, clock, vault, access, transport };
}
const request = { system: 's', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], tools: [] };

describe('ChatGPT device sign-in', () => {
  it('shows the code, polls until approved, and saves the envelope', async () => {
    const f = fixture({ polls: ['pending', 'pending', { code: 'code-1', verifier: 'ver-1' }] });
    const start = await f.service.login(f.access);
    expect(start.view).toMatchObject({ state: 'pending', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' });
    expect(f.service.view(f.access.id)?.state).toBe('pending');
    await start.finished;
    expect(f.protocol.exchange).toHaveBeenCalledWith({ code: 'code-1', verifier: 'ver-1' });
    expect(JSON.parse((await f.vault.get(f.access.secretRef))!)).toMatchObject({ version: 1, accessToken: 'access-1', accountId: 'acct-1' });
    expect(f.service.view(f.access.id)).toEqual({ state: 'connected' });
    expect(f.access.check).toHaveBeenCalledTimes(2);
  });

  it('reports a denial and keeps an old credential', async () => {
    const f = fixture({ polls: [{ denied: 'ChatGPT did not approve the sign-in. Start again.' }] });
    await f.vault.set(f.access.secretRef, 'old-fixture');
    const start = await f.service.login(f.access); await start.finished;
    expect(f.service.view(f.access.id)).toMatchObject({ state: 'failed', message: expect.stringContaining('did not approve') });
    expect(await f.vault.get(f.access.secretRef)).toBe('old-fixture');
  });

  it('times out and drops the one-time code from the view', async () => {
    const f = fixture({ timeout: 5 });
    const start = await f.service.login(f.access);
    f.clock.set(f.clock.get() + 10);
    await start.finished;
    expect(f.service.view(f.access.id)).toMatchObject({ state: 'failed', message: expect.stringContaining('timed out') });
    expect(f.service.view(f.access.id)?.userCode).toBeUndefined();
  });

  it('cancels, and holds the account exclusively while pending', async () => {
    const f = fixture();
    const start = await f.service.login(f.access);
    await expect(f.service.login(f.access)).rejects.toThrow('busy');
    await expect(f.service.models(f.access)).rejects.toThrow('busy');
    await f.service.cancel(f.access.id); await start.finished;
    expect(f.service.view(f.access.id)?.state).toBe('cancelled');
    expect(await f.vault.get(f.access.secretRef)).toBeNull();
  });

  it('surfaces a start failure with its owner-facing sentence', async () => {
    const f = fixture();
    f.protocol.startDevice.mockRejectedValue(new Error('Device code sign-in is not enabled on this ChatGPT account. Turn it on in ChatGPT settings, under Security.'));
    await expect(f.service.login(f.access)).rejects.toThrow();
    expect(f.service.view(f.access.id)).toMatchObject({ state: 'failed', message: expect.stringContaining('not enabled') });
    const again = await f.service.login(f.access).catch(e => e); // not left busy
    expect(String(again)).not.toContain('busy');
  });

  it('rejects a changed account before saving and redacts vault failures', async () => {
    const f = fixture({ polls: [{ code: 'c', verifier: 'v' }] });
    const start = await f.service.login(f.access);
    f.access.check.mockRejectedValue(new Error('disabled'));
    await start.finished;
    expect(f.service.view(f.access.id)?.state).toBe('failed');
    expect(await f.vault.get(f.access.secretRef)).toBeNull();
    const g = fixture({ polls: [{ code: 'c', verifier: 'v' }] });
    vi.spyOn(g.vault, 'set').mockRejectedValue(new Error('sensitive-vault-detail'));
    const s = await g.service.login(g.access); await s.finished;
    expect(g.service.view(g.access.id)?.state).toBe('failed');
    expect(JSON.stringify(g.service.view(g.access.id))).not.toContain('sensitive');
  });
});

describe('ChatGPT credential use', () => {
  it('completes with a fresh token and no refresh', async () => {
    const f = fixture();
    await f.vault.set(f.access.secretRef, JSON.stringify(tokens(1, f.clock.get() + HOUR)));
    const out = await f.service.complete(f.access, 'gpt-5.5', request);
    expect(out.content).toEqual([{ type: 'text', text: 'OK' }]);
    expect(f.protocol.refresh).not.toHaveBeenCalled();
    expect(vi.mocked(f.transport).mock.calls[0]![1].headers).toMatchObject({ authorization: 'Bearer access-1', 'chatgpt-account-id': 'acct-1' });
  });

  it('refreshes near expiry, saves the rotated pair, and uses it', async () => {
    const f = fixture();
    await f.vault.set(f.access.secretRef, JSON.stringify(tokens(1, f.clock.get() + 60_000)));
    const writes: string[] = [];
    const set = f.vault.set.bind(f.vault);
    vi.spyOn(f.vault, 'set').mockImplementation(async (ref, value) => { writes.push(JSON.parse(value).state); return set(ref, value); });
    await f.service.complete(f.access, 'gpt-5.5', request);
    expect(writes).toEqual(['refreshing', 'ready']);
    expect(JSON.parse((await f.vault.get(f.access.secretRef))!)).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', state: 'ready' });
    expect(vi.mocked(f.transport).mock.calls[0]![1].headers).toMatchObject({ authorization: 'Bearer access-2' });
  });

  it('asks for a reconnect after a failed or interrupted refresh', async () => {
    const f = fixture();
    await f.vault.set(f.access.secretRef, JSON.stringify(tokens(1, 0)));
    f.protocol.refresh.mockRejectedValue(new Error('network SECRET'));
    await expect(f.service.complete(f.access, 'gpt-5.5', request)).rejects.toThrow('ChatGPT token refresh failed. Reconnect this account.');
    await expect(f.service.complete(f.access, 'gpt-5.5', request)).rejects.toThrow('Reconnect');
    expect(f.protocol.refresh).toHaveBeenCalledTimes(1); // the marker stops a replay
  });

  it('accepts a legacy Codex auth.json credential without reconnecting', async () => {
    const f = fixture();
    const legacy = { auth_mode: 'chatgpt', tokens: { access_token: 'legacy-access', refresh_token: 'legacy-refresh', account_id: 'acct-1' } };
    await f.vault.set(f.access.secretRef, JSON.stringify(legacy));
    await f.service.complete(f.access, 'gpt-5.5', request);
    // No `exp` claim reads as expired, so the first use refreshes it into the envelope.
    expect(f.protocol.refresh).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'legacy-refresh', accountId: 'acct-1' }));
    expect(JSON.parse((await f.vault.get(f.access.secretRef))!)).toMatchObject({ version: 1, state: 'ready' });
  });

  it('refuses with no credential', async () => {
    const f = fixture();
    await expect(f.service.complete(f.access, 'gpt-5.5', request)).rejects.toThrow('Connect this ChatGPT');
    await expect(f.service.withProfile(f.access, async () => 1)).rejects.toThrow('Connect this ChatGPT');
  });
});

describe('Codex profile for a native child (image plugin)', () => {
  it('stages a private CODEX_HOME with a scrubbed env, saves a refresh, and removes the profile', async () => {
    const { readFile, writeFile, stat } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const f = fixture();
    await f.vault.set(f.access.secretRef, JSON.stringify(tokens(1, f.clock.get() + HOUR)));
    const before = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'ambient-should-not-leak';
    let home = '';
    try {
      const out = await f.service.withProfile(f.access, async (profile) => {
        home = profile.home;
        expect(profile.env.CODEX_HOME).toBe(profile.home);
        expect(profile.env.OPENAI_API_KEY).toBeUndefined();
        const file = JSON.parse(await readFile(join(profile.home, 'auth.json'), 'utf8'));
        expect(file).toMatchObject({ auth_mode: 'chatgpt', tokens: { access_token: 'access-1', account_id: 'acct-1' } });
        expect((await stat(profile.home)).mode & 0o077).toBe(0);
        await writeFile(join(profile.home, 'auth.json'), JSON.stringify({ ...file, tokens: { ...file.tokens, access_token: 'child-access', refresh_token: 'child-refresh' } }));
        return 'done';
      });
      expect(out).toBe('done');
    } finally {
      if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before;
    }
    expect(JSON.parse((await f.vault.get(f.access.secretRef))!)).toMatchObject({ version: 1, accessToken: 'child-access', refreshToken: 'child-refresh' });
    await expect(stat(home)).rejects.toThrow();
  });

  it('holds the account exclusively', async () => {
    const f = fixture();
    await f.vault.set(f.access.secretRef, JSON.stringify(tokens(1, f.clock.get() + HOUR)));
    let release: (() => void) | undefined;
    const held = f.service.withProfile(f.access, () => new Promise<void>((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(f.service.withProfile(f.access, async () => 1)).rejects.toThrow(/busy/);
    release!(); await held;
  });
});

describe('ChatGPT image through the hosted tool (image plugin)', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
  function imageSse(): HttpTransport {
    const body = [
      { type: 'response.image_generation_call.partial_image', item_id: 'ig', partial_image_b64: 'AAAA' },
      { type: 'response.output_item.done', item: { type: 'image_generation_call', id: 'ig', status: 'completed', result: png.toString('base64') } },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    return vi.fn<HttpTransport>(async (_url, init) => {
      init.onChunk?.(body, 200);
      return { ok: true, status: 200, statusText: '', headers: { get: () => null }, text: async () => body, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } satisfies TransportResponse;
    });
  }

  it('refreshes, sends with the account token, and decodes the picture', async () => {
    const f = fixture({ transport: imageSse() });
    await f.vault.set(f.access.secretRef, JSON.stringify(tokens(1, f.clock.get() + 60_000)));
    const out = await f.service.generateImage(f.access, 'gpt-5.5', { prompt: 'a fox', references: [], size: '1024x1024' });
    expect(out.bytes.equals(png)).toBe(true);
    const init = vi.mocked(f.transport).mock.calls[0]![1];
    expect(init.headers).toMatchObject({ authorization: 'Bearer access-2', 'chatgpt-account-id': 'acct-1' });
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-5.5', tools: [{ type: 'image_generation', size: '1024x1024' }] });
    expect(f.access.check).toHaveBeenCalled();
  });

  it('refuses with no credential', async () => {
    const f = fixture({ transport: imageSse() });
    await expect(f.service.generateImage(f.access, 'gpt-5.5', { prompt: 'x', references: [] })).rejects.toThrow('Connect this ChatGPT');
  });
});
