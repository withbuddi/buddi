import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryVault, createPool, runMigrations, type AgentCatalog } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { OllamaConnectProtocol } from '@buddi/runtime';
import type { Pool } from 'pg';
import { ProviderAccounts } from './provider-accounts.js';
import { readOllamaDevices } from './ollama-accounts.js';
const url = await testDatabaseUrl();
const suite = url ? describe : describe.skip;
const name = `buddi_ollama_accounts_${process.pid}`;
suite('Ollama Cloud with a device key', () => {
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = createPool(url!); await admin.query(`create database ${name}`);
    const target = new URL(url!); target.pathname = `/${name}`;
    pool = createPool(target.toString()); await runMigrations(pool, []);
  }, 60_000);
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`drop database if exists ${name}`); await admin.end(); } });
  beforeEach(async () => { await pool.query('truncate core.agent_provider_accounts, core.provider_accounts, core.provider_account_migrations, core.provider_credential_state, core.provider_settings'); });
  function fixture() {
    const catalog = { list: () => [], get: () => undefined } as unknown as AgentCatalog;
    const vault = createMemoryVault();
    const protocol = new OllamaConnectProtocol();
    const whoami = vi.spyOn(protocol, 'whoami').mockResolvedValue({ state: 'waiting' });
    const test = vi.fn(async (_resolved: unknown) => {});
    const listModels = vi.fn(async (_provider: unknown) => ({ models: [{ id: 'gpt-oss:120b', name: 'gpt-oss:120b', isDefault: false }], truncated: false }));
    const service = new ProviderAccounts({ pool, env: {}, vault, catalog: () => catalog, reload: vi.fn(), test, listModels, ollama: { protocol, deviceName: () => 'buddi on studio' } });
    return { vault, whoami, test, listModels, service };
  }
  const cloud = { label: 'Ollama Cloud', kind: 'openai-compatible', auth: 'device-key', defaultModel: 'gpt-oss:120b', enabled: true };

  it('saves to ollama.com only, never with a pasted key, and is not configured until connected', async () => {
    const f = fixture(); await f.service.initialize();
    await expect(f.service.save({ ...cloud, secret: 'pasted' })).rejects.toThrow('not pasted');
    await expect(f.service.save({ ...cloud, kind: 'openai' })).rejects.toThrow('not pasted');
    await expect(f.service.save({ ...cloud, baseUrl: 'https://evil.example/v1' })).rejects.toThrow('only connects to Ollama Cloud');
    const { id } = await f.service.save(cloud);
    const account = f.service.view().accounts.find(a => a.id === id)!;
    expect(account).toMatchObject({ baseUrl: 'https://ollama.com/v1', configured: false, device: null, login: null });
    await expect(pool.query(`update core.provider_accounts set base_url='https://evil.example/v1' where id=$1`, [id])).rejects.toThrow('device_key');
    await expect(f.service.models(id)).rejects.toThrow('Connect this Ollama account first');
  });

  it('connects: key in the vault, URL to the owner, poll until the name comes back, then runs sign with it', async () => {
    const f = fixture(); await f.service.initialize();
    const { id } = await f.service.save(cloud);
    await expect(f.service.ollamaAction(id, 'connect', { revision: 99 }, 'owner')).rejects.toThrow('changed');
    const started = await f.service.ollamaAction(id, 'connect', { revision: 1 }, 'owner') as { state: string; attemptId: string; verificationUrl: string; deviceName: string };
    expect(started).toMatchObject({ state: 'pending', deviceName: 'buddi on studio' });
    expect(new URL(started.verificationUrl).searchParams.get('name')).toBe('buddi on studio');
    expect(JSON.stringify(started)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(f.service.view('owner'))).not.toContain('PRIVATE KEY');
    expect(JSON.stringify((await pool.query('select * from core.provider_accounts')).rows)).not.toContain('PRIVATE KEY');
    expect(f.service.view('owner').accounts[0]).toMatchObject({ configured: false, login: { state: 'pending', attemptId: started.attemptId } });
    expect(f.service.view('someone else').accounts[0]!.login).toBeNull();

    expect(await f.service.ollamaAction(id, 'poll', { attemptId: started.attemptId }, 'owner')).toMatchObject({ state: 'waiting' });
    f.whoami.mockResolvedValue({ state: 'connected', username: 'amen' });
    expect(await f.service.ollamaAction(id, 'poll', { attemptId: started.attemptId }, 'owner')).toEqual({ state: 'connected', username: 'amen', deviceName: 'buddi on studio' });
    expect(f.service.view('owner').accounts[0]).toMatchObject({ configured: true, login: null, device: { username: 'amen', deviceName: 'buddi on studio' } });

    await f.service.models(id); await f.service.test(id);
    for (const call of [f.listModels.mock.calls[0]![0], f.test.mock.calls[0]![0]]) {
      expect(call).toMatchObject({ baseUrl: 'https://ollama.com/v1', secret: '', compatible: true });
      expect((call as { deviceKey: string }).deviceKey).toContain('PRIVATE KEY');
    }
    expect(await readOllamaDevices(pool, f.vault)).toEqual([{ label: 'Ollama Cloud', username: 'amen', deviceName: 'buddi on studio', connectedAt: expect.any(String) }]);
  });

  it('disconnects: the key leaves the vault, runs stop, and the owner is told where the device is still listed', async () => {
    const f = fixture(); await f.service.initialize();
    const { id } = await f.service.save(cloud);
    const started = await f.service.ollamaAction(id, 'connect', { revision: 1 }, 'owner') as { attemptId: string };
    f.whoami.mockResolvedValue({ state: 'connected', username: 'amen' });
    await f.service.ollamaAction(id, 'poll', { attemptId: started.attemptId }, 'owner');
    const ref = (await pool.query('select secret_ref from core.provider_accounts where id=$1', [id])).rows[0].secret_ref as string;
    expect(await f.vault.get(ref)).not.toBeNull();
    const done = await f.service.ollamaAction(id, 'disconnect', { revision: 2 }, 'owner') as { note: string };
    expect(done.note).toContain('stays listed on ollama.com');
    expect(await f.vault.get(ref)).toBeNull();
    expect(f.service.view().accounts[0]).toMatchObject({ configured: false, device: null, revision: 3 });
    await expect(f.service.test(id)).resolves.toMatchObject({ state: expect.not.stringMatching(/^connected$/) });
  });

  it('a reconnect or another session cannot finish an older attempt', async () => {
    const f = fixture(); await f.service.initialize();
    const { id } = await f.service.save(cloud);
    const first = await f.service.ollamaAction(id, 'connect', { revision: 1 }, 'owner') as { attemptId: string };
    await f.service.ollamaAction(id, 'connect', { revision: 2 }, 'owner');
    f.whoami.mockResolvedValue({ state: 'connected', username: 'amen' });
    expect(await f.service.ollamaAction(id, 'poll', { attemptId: first.attemptId }, 'owner')).toMatchObject({ state: 'failed' });
    await expect(f.service.ollamaAction(id, 'poll', { attemptId: first.attemptId }, '')).rejects.toThrow();
    expect(f.service.view().accounts[0]!.configured).toBe(false);
  });
});
