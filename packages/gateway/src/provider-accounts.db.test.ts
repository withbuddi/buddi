import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryVault, createPool, providerFromEnv, runMigrations, type AgentCatalog, type AgentFrontmatter, type CatalogAgent } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { createServer } from 'node:http';
import { ProviderAccounts } from './provider-accounts.js';
const url = await testDatabaseUrl();
const suite = url ? describe : describe.skip;
const name = `buddi_provider_accounts_${process.pid}`;
suite('named provider accounts', () => {
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = createPool(url!); await admin.query(`create database ${name}`);
    const target = new URL(url!); target.pathname = `/${name}`;
    pool = createPool(target.toString()); await runMigrations(pool, []);
  }, 60_000);
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`drop database if exists ${name}`); await admin.end(); } });
  beforeEach(async () => { await pool.query('truncate core.agent_provider_accounts, core.provider_accounts, core.provider_account_migrations, core.provider_credential_state, core.provider_settings'); });
  function fixture(env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'legacy-fixture-token', OPENAI_API_KEY: 'legacy-fixture-api' }) {
    const agents = ['ledger', 'scout'].map(id => ({ id, model: 'claude-sonnet-5', provider: providerFromEnv(env) } as CatalogAgent));
    const catalog = { list: () => agents, get: (id: string) => agents.find(a => a.id === id) } as unknown as AgentCatalog;
    const vault = createMemoryVault(), reload = vi.fn(), test = vi.fn(async (_resolved: unknown) => {});
    const service = new ProviderAccounts({ pool, env, vault, catalog: () => catalog, reload, test });
    return { env, agents, catalog, vault, reload, test, service };
  }
  const settings = { label: 'Work API', kind: 'anthropic', auth: 'api-key', defaultModel: 'claude-sonnet-5', enabled: true, secret: 'private-fixture-value' };
  const codexSettings = { label: 'Personal Codex', kind: 'codex', auth: 'chatgpt', defaultModel: 'gpt-5', enabled: true };
  const metadata = (f: ReturnType<typeof fixture>, id: string) => {
    const a = f.service.view().accounts.find(a => a.id === id)!;
    return { id: a.id, revision: a.revision, label: a.label, kind: a.kind, auth: a.auth, baseUrl: a.baseUrl, defaultModel: a.defaultModel, enabled: a.enabled };
  };
  it('gates native accounts and forbids pasted tokens or API fallback', async () => {
    const disabled = fixture(); await disabled.service.initialize();
    await expect(disabled.service.save(codexSettings)).rejects.toThrow('Enable the Codex experiment');
    const f = fixture({ BUDDI_CODEX_EXPERIMENT: '1' }); await f.service.initialize();
    await expect(f.service.save({ ...codexSettings, secret: 'pasted-token' })).rejects.toThrow('device sign-in');
    await expect(f.service.save({ ...codexSettings, auth: 'api-key' })).rejects.toThrow('require ChatGPT');
    const account = await f.service.save(codexSettings);
    expect(f.service.view().accounts.find(a => a.id === account.id)).toMatchObject({ kind: 'codex', configured: false });
    await expect(f.service.test(account.id)).rejects.toThrow('output-token cap');
    expect(f.test).not.toHaveBeenCalled();
  });
  it('serializes native credentials across processes and allows disabling and removal', async () => {
    const f = fixture({ BUDDI_CODEX_EXPERIMENT: '1' }); await f.service.initialize();
    const account = await f.service.save(codexSettings);
    let finish!: () => void;
    vi.spyOn(f.service.codex!, 'login').mockResolvedValue({ view: { state: 'pending' }, finished: new Promise<void>(resolve => { finish = resolve; }) });
    await f.service.codexAction(account.id, 'login', 1);
    const other = fixture({ BUDDI_CODEX_EXPERIMENT: '1' }); await other.service.initialize();
    await expect(other.service.save({ ...metadata(other, account.id), enabled: false })).rejects.toThrow('busy');
    finish();
    await vi.waitFor(async () => {
      const client = await pool.connect();
      try {
        const result = await client.query("select pg_try_advisory_lock(hashtext('buddi-codex'),hashtext($1)) as acquired", [account.id]);
        expect(result.rows[0].acquired).toBe(true);
        await client.query("select pg_advisory_unlock(hashtext('buddi-codex'),hashtext($1))", [account.id]);
      } finally { client.release(); }
    });
    await other.service.save({ ...metadata(other, account.id), enabled: false });
    await other.service.remove(account.id, 2);
    expect(other.service.view().accounts.some(a => a.id === account.id)).toBe(false);
  });
  it('migrates existing choices atomically and never reassigns on restart or discovers another key', async () => {
    const f = fixture(); await f.service.initialize();
    expect(f.service.view().bindings).toEqual(expect.arrayContaining([{ agentId: 'ledger', accountId: 'legacy-anthropic-subscription', model: 'claude-sonnet-5' }]));
    const created = await f.service.save(settings);
    await f.service.assign('ledger', { accountId: created.id, model: 'claude-haiku-4-5' });
    f.env.BUDDI_ANTHROPIC_CREDENTIAL_KIND = 'api-key';
    await f.service.initialize();
    expect(f.service.view().bindings.find(b => b.agentId === 'ledger')).toMatchObject({ accountId: created.id, model: 'claude-haiku-4-5' });
    f.agents.push({ id: 'new-agent' } as CatalogAgent);
    await f.service.initialize();
    expect(f.service.selection({ id: 'new-agent' } as AgentFrontmatter).availability.ok).toBe(false);
  });
  it('keeps independent accounts and secret values out of SQL, UI responses and the environment', async () => {
    const f = fixture(); await f.service.initialize();
    const a = await f.service.save(settings), b = await f.service.save({ ...settings, label: 'Second', secret: 'other-private-fixture' });
    expect(a.id).not.toBe(b.id);
    const rows = (await pool.query('select * from core.provider_accounts')).rows;
    expect(JSON.stringify(rows)).not.toContain('private-fixture');
    expect(JSON.stringify(f.service.view())).not.toContain('private-fixture');
    expect(JSON.stringify(f.env)).not.toContain('private-fixture');
    await f.service.test(a.id); await f.service.test(b.id);
    expect(f.test.mock.calls.map(c => (c[0] as { secret: string }).secret)).toEqual(['private-fixture-value', 'other-private-fixture']);
  });
  it('keeps an active run pinned and refuses disabled/changed accounts before network calls', async () => {
    const f = fixture(); await f.service.initialize();
    const a = await f.service.save(settings), b = await f.service.save({ ...settings, label: 'Second' });
    await f.service.assign('ledger', { accountId: a.id, model: 'claude-sonnet-5' });
    const ref = f.service.selection({ id: 'ledger' } as AgentFrontmatter).provider;
    const runtime = f.service.provider(ref);
    await f.service.assign('ledger', { accountId: b.id, model: 'claude-sonnet-5' });
    expect(ref.accountId).toBe(a.id);
    await f.service.save({ ...metadata(f, a.id), enabled: false });
    await expect(runtime.complete({ system: '', tools: [], messages: [] })).rejects.toThrow('changed');
    expect(f.service.selection({ id: 'ledger' } as AgentFrontmatter).provider.accountId).toBe(b.id);
  });
  it('protects assignments, stale edits, endpoint credentials and unsupported auth', async () => {
    const f = fixture(); await f.service.initialize();
    const a = await f.service.save(settings);
    await f.service.assign('ledger', { accountId: a.id, model: 'claude-sonnet-5' });
    await expect(f.service.remove(a.id, 1)).rejects.toThrow('Reassign');
    await f.service.save({ ...metadata(f, a.id), label: 'Renamed' });
    await expect(f.service.save({ ...metadata(f, a.id), revision: 1 })).rejects.toThrow('changed');
    await expect(f.service.assign('ledger', { accountId: a.id, model: 'gpt-5' })).rejects.toThrow();
    await expect(f.service.save({ ...settings, auth: 'legacy-subscription-token' })).rejects.toThrow('not supported');
    const local = await f.service.save({ ...settings, kind: 'openai-compatible', baseUrl: 'https://one.example/v1', defaultModel: 'custom-model' });
    await expect(f.service.save({ ...metadata(f, local.id), baseUrl: 'https://two.example/v1' })).rejects.toThrow('credential again');
  });
  it('rotates independently and never resurrects the old environment credential', async () => {
    const f = fixture(); await f.service.initialize();
    const id = 'legacy-openai-api';
    await f.service.save({ ...metadata(f, id), secret: 'rotated-private-fixture' });
    await f.service.test(id);
    expect(f.test).toHaveBeenLastCalledWith(expect.objectContaining({ secret: 'rotated-private-fixture' }));
    const row = (await pool.query('select secret_ref, legacy_env from core.provider_accounts where id=$1', [id])).rows[0];
    expect(row.legacy_env).toBeNull();
    await f.vault.delete(row.secret_ref);
    await f.service.load();
    expect((await f.service.test(id)).state).toBe('unavailable');
    expect(f.test).toHaveBeenCalledTimes(1);
  });
  it('redacts provider failures and discards a test result if its account changed', async () => {
    const f = fixture(); await f.service.initialize();
    const a = await f.service.save(settings);
    f.test.mockRejectedValueOnce(Object.assign(new Error('SECRET RESPONSE'), { status: 401 }));
    expect(await f.service.test(a.id)).toMatchObject({ state: 'authentication-error' });
    expect(JSON.stringify(f.service.view())).not.toContain('SECRET');
    f.test.mockRejectedValueOnce(Object.assign(new Error('SECRET RESPONSE'), { status: 429, retryAt: '2026-09-19T04:00:00.000Z' }));
    expect(await f.service.test(a.id)).toMatchObject({ state: 'rate-limited', httpStatus: 429, retryAt: '2026-09-19T04:00:00.000Z' });
    expect(f.service.view().accounts.find(row => row.id === a.id)?.test?.retryAt).toBe('2026-09-19T04:00:00.000Z');
    expect(JSON.stringify(f.service.view())).not.toContain('SECRET');
    let finish!: () => void;
    f.test.mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
    const testing = f.service.test(a.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await expect(f.service.test(a.id)).rejects.toThrow('already running');
    await f.service.save({ ...metadata(f, a.id), label: 'Updated' });
    finish(); await expect(testing).rejects.toThrow('changed');
  });
  it('does not migrate a removed legacy credential back into service', async () => {
    const f = fixture();
    await pool.query("insert into core.provider_credential_state(name,removed) values ('OPENAI_API_KEY',true)");
    await f.service.initialize();
    expect(f.service.view().accounts.find(a => a.id === 'legacy-openai-api')?.enabled).toBe(false);
  });
  it('fails closed when vault deletion fails, and removal survives reinitialization', async () => {
    const f = fixture(); await f.service.initialize();
    const a = await f.service.save(settings);
    vi.spyOn(f.vault, 'delete').mockRejectedValueOnce(new Error('SECRET'));
    await expect(f.service.remove(a.id, 1)).rejects.toThrow('Account disabled');
    expect(f.service.view().accounts.find(row => row.id === a.id)?.enabled).toBe(false);
    await f.service.remove(a.id, 2);
    await f.service.initialize();
    expect(f.service.view().accounts.find(row => row.id === a.id)).toBeUndefined();
  });
  it('sends a tool-calling turn through the explicitly assigned compatible endpoint', async () => {
    const f = fixture(); await f.service.initialize();
    let requestBody: any, authorization: string | undefined;
    const server = createServer(async (req, res) => {
      authorization = req.headers.authorization;
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      requestBody = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'local-model', choices: [{ finish_reason: 'tool_calls', message: { content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: requestBody.tools[0].function.name, arguments: '{"value":1}' } }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as { port: number }).port;
      const a = await f.service.save({ label: 'Local model', kind: 'openai-compatible', auth: 'none', baseUrl: `http://127.0.0.1:${port}/v1`, defaultModel: 'local-model', enabled: true });
      await f.service.assign('ledger', { accountId: a.id, model: 'local-model' });
      const ref = f.service.selection({ id: 'ledger' } as AgentFrontmatter).provider;
      const response = await f.service.provider(ref).complete({ system: 'fixture', messages: [], tools: [{ name: 'fixture.read', description: 'Read', input_schema: { type: 'object', properties: { value: { type: 'number' } } } }] });
      expect(authorization).toBeUndefined(); expect(requestBody.model).toBe('local-model');
      expect(response.content).toContainEqual({ type: 'tool_use', id: 'call-1', name: 'fixture.read', input: { value: 1 } });
    } finally { await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())); }
  });
});
