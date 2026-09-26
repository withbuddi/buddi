import { createPublicKey, verify } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createMemoryVault } from '@buddi/core';
import { OllamaConnectProtocol } from '@buddi/runtime';
import { OLLAMA_CONNECT_TTL_MS, OllamaAccounts, connectedLine, ollamaDeviceName, readOllamaDevice } from './ollama-accounts.js';

function service(answer: Awaited<ReturnType<OllamaConnectProtocol['whoami']>>) {
  let clock = 1_790_000_000_000;
  const protocol = new OllamaConnectProtocol();
  const whoami = vi.spyOn(protocol, 'whoami').mockResolvedValue(answer);
  const vault = createMemoryVault();
  const accounts = new OllamaAccounts(vault, protocol, () => clock, () => 'buddi on studio');
  return { vault, accounts, whoami, advance: (ms: number) => { clock += ms; } };
}

it('names the device after this computer', () => {
  expect(ollamaDeviceName('Amens-MacBook-Pro.local')).toBe('buddi on Amens-MacBook-Pro');
  expect(ollamaDeviceName('')).toBe('buddi');
  expect(connectedLine({ deviceName: 'buddi on studio', username: 'amen', connectedAt: '2026-09-26T00:00:00Z' })).toBe('connected as amen, device buddi on studio');
});

it('puts a key pair in the vault, returns only the connect URL, and connects on the first answer with a name', async () => {
  const s = service({ state: 'connected', username: 'amen' });
  const started = await s.accounts.start('acct', 2, 'owner', 'OLLAMA_DEVICE_1');
  expect(JSON.stringify(started)).not.toContain('PRIVATE KEY');
  const url = new URL(started.verificationUrl);
  expect(url.origin + url.pathname).toBe('https://ollama.com/connect');
  expect(url.searchParams.get('name')).toBe('buddi on studio');
  const stored = readOllamaDevice((await s.vault.get('OLLAMA_DEVICE_1'))!);
  expect(Buffer.from(url.searchParams.get('key')!, 'base64url').toString()).toBe(stored.publicKey);
  expect(stored).toMatchObject({ deviceName: 'buddi on studio', connectedAt: null, username: null });
  await expect(s.accounts.credential('OLLAMA_DEVICE_1')).rejects.toThrow('Connect this Ollama account first');

  expect(await s.accounts.poll('acct', 2, 'owner', started.attemptId, 'OLLAMA_DEVICE_1')).toEqual({ state: 'connected', username: 'amen', deviceName: 'buddi on studio' });
  const connected = readOllamaDevice((await s.vault.get('OLLAMA_DEVICE_1'))!);
  expect(connected).toMatchObject({ username: 'amen', privateKey: stored.privateKey });
  expect(connected.connectedAt).not.toBeNull();
  const key = await s.accounts.credential('OLLAMA_DEVICE_1');
  expect(verify(null, Buffer.from('x'), createPublicKey(key), Buffer.alloc(64))).toBe(false); // a real ed25519 key
  expect(s.accounts.view('acct', 2, 'owner')).toBeNull(); // the attempt is over
});

it('waits, then expires after 15 minutes; refuses another session or a stale attempt', async () => {
  const s = service({ state: 'waiting' });
  const started = await s.accounts.start('acct', 2, 'owner', 'REF');
  expect((await s.accounts.poll('acct', 2, 'owner', started.attemptId, 'REF')).state).toBe('waiting');
  expect((await s.accounts.poll('acct', 2, 'intruder', started.attemptId, 'REF')).state).toBe('failed');
  expect((await s.accounts.poll('acct', 3, 'owner', started.attemptId, 'REF')).state).toBe('failed');
  expect((await s.accounts.poll('acct', 2, 'owner', 'other', 'REF')).state).toBe('failed');
  s.advance(OLLAMA_CONNECT_TTL_MS);
  expect(await s.accounts.poll('acct', 2, 'owner', started.attemptId, 'REF')).toEqual({ state: 'failed', message: expect.stringContaining('15 minutes') });
  expect(s.whoami).toHaveBeenCalledTimes(1);
});

it('reports a refused key and ends the attempt', async () => {
  const s = service({ state: 'failed', message: 'ollama.com refused this device key.' });
  const started = await s.accounts.start('acct', 1, 'owner', 'REF');
  expect((await s.accounts.poll('acct', 1, 'owner', started.attemptId, 'REF')).state).toBe('failed');
  expect(s.accounts.view('acct', 1, 'owner')).toBeNull();
});

it('rejects a tampered envelope', () => {
  expect(() => readOllamaDevice('{}')).toThrow('Invalid Ollama device key');
  expect(() => readOllamaDevice(JSON.stringify({ version: 1, privateKey: 'x', publicKey: 'y', deviceName: 'd', createdAt: 'c', connectedAt: null, username: null }))).toThrow('Invalid Ollama device key');
});
