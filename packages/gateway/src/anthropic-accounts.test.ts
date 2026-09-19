import { expect, it, vi } from 'vitest';
import { createMemoryVault } from '@buddi/core';
import { AnthropicOAuthProtocol, type AnthropicTokens } from '@buddi/runtime';
import { AnthropicAccounts } from './anthropic-accounts.js';
const tokens: AnthropicTokens = { version: 1, state: 'ready', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 4_000_000, scopes: ['user:inference'] };
function fixture() {
  let now = 1000;
  const vault = createMemoryVault(), protocol = new AnthropicOAuthProtocol();
  const exchange = vi.spyOn(protocol, 'exchange').mockResolvedValue(tokens);
  const refresh = vi.spyOn(protocol, 'refresh').mockResolvedValue({ ...tokens, accessToken: 'rotated', refreshToken: 'rotated-refresh', expiresAt: 8_000_000 });
  const service = new AnthropicAccounts(vault, protocol, () => now);
  return { vault, service, exchange, refresh, time: (value: number) => { now = value; } };
}
it('binds sign-in to the owner session, account revision, and single-use attempt', async () => {
  const f = fixture(); const p = f.service.start('one', 2, 'owner')!;
  expect(f.service.view('one', 2, 'other')).toBeNull();
  expect(f.service.view('one', 3, 'owner')).toBeNull();
  const code = `fixture-code#${new URL(p.verificationUrl).searchParams.get('state')}`;
  await expect(f.service.finish('one', 2, 'other', p.attemptId, code, 'ref')).rejects.toThrow('another session');
  await f.service.finish('one', 2, 'owner', p.attemptId, code, 'ref');
  expect(JSON.parse((await f.vault.get('ref'))!)).toEqual(tokens);
  await expect(f.service.finish('one', 2, 'owner', p.attemptId, code, 'ref')).rejects.toThrow('expired');
  expect(f.exchange).toHaveBeenCalledTimes(1);
});
it('expires and cancels pending attempts; a restart does not restore them', () => {
  const f = fixture(); f.service.start('one', 1, 'owner'); f.time(901001);
  expect(f.service.view('one', 1, 'owner')).toBeNull();
  f.service.start('one', 1, 'owner'); f.service.forget('one'); expect(f.service.view('one', 1, 'owner')).toBeNull();
  expect(new AnthropicAccounts(f.vault).view('one', 1, 'owner')).toBeNull();
});
it('keeps existing credentials after a failed reconnect and consumes bad pastes', async () => {
  const f = fixture(); await f.vault.set('ref', JSON.stringify(tokens)); const p = f.service.start('one', 1, 'owner')!;
  await expect(f.service.finish('one', 1, 'owner', p.attemptId, 'bad', 'ref')).rejects.toThrow('full authorization');
  expect(JSON.parse((await f.vault.get('ref'))!)).toEqual(tokens); expect(f.exchange).not.toHaveBeenCalled();
  expect(f.service.view('one', 1, 'owner')).toBeNull();
});
it('refreshes early, persists the entire rotated pair, and reuses it', async () => {
  const f = fixture(); await f.vault.set('ref', JSON.stringify(tokens));
  expect(await f.service.credential('ref')).toBe(tokens.accessToken); expect(f.refresh).not.toHaveBeenCalled();
  f.time(3_900_000);
  expect(await f.service.credential('ref')).toBe('rotated');
  expect(JSON.parse((await f.vault.get('ref'))!).refreshToken).toBe('rotated-refresh');
  expect(await f.service.credential('ref')).toBe('rotated'); expect(f.refresh).toHaveBeenCalledTimes(1);
});
it('does not replay a refresh after an ambiguous failure, even after restart', async () => {
  const f = fixture(); f.time(3_900_000); await f.vault.set('ref', JSON.stringify(tokens));
  f.refresh.mockRejectedValue(new Error('Ambiguous refresh'));
  await expect(f.service.credential('ref')).rejects.toThrow();
  await expect(new AnthropicAccounts(f.vault).credential('ref')).rejects.toThrow('Reconnect');
  expect(f.refresh).toHaveBeenCalledTimes(1);
});
it('never consumes a refresh token if the vault cannot save the intent', async () => {
  const f = fixture(); f.time(3_900_000); await f.vault.set('ref', JSON.stringify(tokens));
  vi.spyOn(f.vault, 'set').mockRejectedValue(new Error('vault locked'));
  await expect(f.service.credential('ref')).rejects.toThrow(); expect(f.refresh).not.toHaveBeenCalled();
});
it('does not return a rotated access token when persistence fails', async () => {
  const f = fixture(); f.time(3_900_000); await f.vault.set('ref', JSON.stringify(tokens));
  const set = f.vault.set.bind(f.vault);
  vi.spyOn(f.vault, 'set').mockImplementation(async (ref, value) => {
    if (JSON.parse(value).accessToken === 'rotated') throw new Error('vault locked');
    return set(ref, value);
  });
  await expect(f.service.credential('ref')).rejects.toThrow('could not be saved');
  await expect(f.service.credential('ref')).rejects.toThrow('Reconnect');
  expect(f.refresh).toHaveBeenCalledTimes(1);
});
