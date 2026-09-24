/**
 * The `http.header` path end to end, through the host a plugin is handed
 * (docs/specs/owner-secrets.md §3): a plugin declares `http` and asks for
 * `auth: { secret }`; core finds the binding whose target names this request's
 * host and header, applies the rule, reads the vault, inserts the header after
 * the address checks, and records the use. The database is created here and
 * dropped.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrateCore } from '../db.js';
import { urlForDatabase } from '../backup/restore.js';
import { testDatabaseUrl } from '../testing/database-url.js';
import { configurePluginHost, createPluginHost, hostBindingOf, resetPluginHost } from './build.js';
import type { BuddiHost, CoreToolContext, PluginManifest } from '../tools.js';
import { createMemoryVault, type Vault } from '../vault/memory.js';
import { putOwnerSecret } from '../secrets/store.js';
import { findSecret } from '../secrets/store.js';
import { ownerSecretVaultName } from '../vault/types.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const DB = `buddi_http_auth_${process.pid}`;
const VALUE = 'bearer-token-for-the-test';
const URL_OK = 'https://api.example.test/v1/things';

suite('ctx.buddi.http auth (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let vault: Vault;
  const now = new Date('2026-09-24T12:00:00Z');

  const manifest: PluginManifest = {
    name: 'caller',
    version: '1.0.0',
    schema: 'core',
    migrationsDir: '',
    tools: [],
    uses: ['http', 'secrets'],
    network: [{ host: 'api.example.test' }],
  };

  const facts = (over: Partial<CoreToolContext> = {}): CoreToolContext => ({
    db: pool,
    ownerId: 'owner',
    now: () => now,
    timezone: 'UTC',
    agentId: 'assistant',
    ...over,
  });
  const hostFor = (): BuddiHost => createPluginHost(hostBindingOf(manifest), facts());

  /** A transport factory that records what it was handed and answers a canned response. */
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const transportFactory = () => async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => null },
      text: async () => '', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0),
    };
  };

  beforeAll(async () => {
    admin = createPool(urlForDatabase(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlForDatabase(databaseUrl as string, DB));
    await migrateCore(pool);
  }, 120_000);

  afterAll(async () => {
    resetPluginHost();
    await pool?.end().catch(() => {});
    await admin?.query(`drop database if exists "${DB}"`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  it('delivers a bound secret into the named header and records the use', async () => {
    vault = createMemoryVault();
    configurePluginHost({ vault, httpTransport: transportFactory as never });
    const host = createPluginHost(hostBindingOf(manifest), facts());
    await putOwnerSecret(pool, vault, {
      name: 'API token',
      value: VALUE,
      bindings: [{ kind: 'http.header', target: { host: 'api.example.test', header: 'Authorization' }, rule: 'pre-approved' }],
    });

    calls.length = 0;
    const res = await host.http!.request({ url: URL_OK, auth: { secret: 'API token' } });
    expect(res.status).toBe(200);
    expect(calls[0]?.headers.Authorization).toBe(VALUE);

    const { rows } = await pool.query(`select kind, plugin, outcome from core.secret_uses`);
    expect(rows).toEqual([{ kind: 'http.header', plugin: 'http', outcome: 'delivered' }]);
    const secret = (await findSecret(pool, 'API token'))!;
    expect(await vault.get(`owner-secret:${secret.id}`)).toBe(VALUE);
    resetPluginHost();
  });

  it('a host the binding does not name is refused before anything is sent', async () => {
    configurePluginHost({ vault, httpTransport: transportFactory as never });
    const host = createPluginHost(hostBindingOf(manifest), facts());
    calls.length = 0;
    await expect(
      host.http!.request({ url: 'https://other.example.test/', auth: { secret: 'API token' } }),
    ).rejects.toThrow(/not bound/);
    expect(calls).toEqual([]);
    resetPluginHost();
  });

  it('plain HTTP is refused before the vault is opened', async () => {
    configurePluginHost({ vault, httpTransport: transportFactory as never });
    const host = createPluginHost(hostBindingOf(manifest), facts());
    calls.length = 0;
    await expect(
      host.http!.request({ url: 'http://api.example.test/', auth: { secret: 'API token' } }),
    ).rejects.toThrow(/HTTPS/);
    expect(calls).toEqual([]);
    resetPluginHost();
  });
});