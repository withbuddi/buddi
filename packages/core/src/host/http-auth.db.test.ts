/**
 * The `http.header` path end to end, through the host a plugin is handed
 * (docs/owner-secrets.md §3): a plugin declares `http` and asks for
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
import type { CoreToolContext, PluginManifest } from '../tools.js';
import type { BuddiHost } from './types.js';
import { createMemoryVault } from '../vault/memory.js';
import type { Vault } from '../vault/types.js';
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
    network: [{ host: 'api.example.test', why: 'the fixture API' }],
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

  it('a plugin keeps a private link as a secret it fetches and never reads (http.url, 1.9)', async () => {
    configurePluginHost({ vault, httpTransport: transportFactory as never });
    const calendar: PluginManifest = {
      ...manifest,
      name: 'calendar',
      network: [{ host: 'calendar.example.test', why: 'the fixture calendar' }],
    };
    const link = 'https://calendar.example.test/ical/me/private-abcdef0123456789/basic.ics';
    const asOwner = createPluginHost(hostBindingOf(calendar), facts({ agentId: 'owner' }));
    // Only this plugin's name in the target is accepted, and only from the owner.
    await expect(
      asOwner.secrets!.put('Calendar: Work', link, [
        { kind: 'http.url', target: { plugin: 'caller', host: 'calendar.example.test' }, rule: 'pre-approved' },
      ]),
    ).rejects.toThrow(/only to its own destinations/);
    await expect(
      createPluginHost(hostBindingOf(calendar), facts()).secrets!.put('Calendar: Work', link, [
        { kind: 'http.url', target: { plugin: 'calendar', host: 'calendar.example.test' }, rule: 'pre-approved' },
      ]),
    ).rejects.toThrow(/Only the owner/);
    await asOwner.secrets!.put('Calendar: Work', link, [
      { kind: 'http.url', target: { plugin: 'calendar', host: 'calendar.example.test' }, rule: 'pre-approved' },
    ]);

    calls.length = 0;
    const host = createPluginHost(hostBindingOf(calendar), facts());
    await host.http!.request({ url: 'https://calendar.example.test/', auth: { secret: 'Calendar: Work', as: 'url' } });
    expect(calls.map((c) => c.url)).toEqual([link]);

    // Another plugin that declares http cannot fetch it: the binding names calendar.
    const other = createPluginHost(hostBindingOf(manifest), facts());
    await expect(
      other.http!.request({ url: 'https://calendar.example.test/', auth: { secret: 'Calendar: Work', as: 'url' } }),
    ).rejects.toThrow(/not bound/);
    expect(calls).toHaveLength(1);

    // The plugin may delete what it stored.
    expect(await asOwner.secrets!.delete('Calendar: Work')).toBe(true);
    resetPluginHost();
  });

  it('a plugin signs in with a password it stored and never reads (http.basic, 1.26)', async () => {
    configurePluginHost({ vault, httpTransport: transportFactory as never });
    const calendar: PluginManifest = {
      ...manifest,
      name: 'calendar',
      network: [{ host: '*.dav.example.test', why: 'the fixture CalDAV server' }],
    };
    const asOwner = createPluginHost(hostBindingOf(calendar), facts({ agentId: 'owner' }));
    await expect(
      asOwner.secrets!.put('CalDAV: Me', 'app-pass-1234', [
        { kind: 'http.basic', target: { plugin: 'caller', host: '*.dav.example.test' }, rule: 'pre-approved' },
      ]),
    ).rejects.toThrow(/only to its own destinations/);
    await asOwner.secrets!.put('CalDAV: Me', 'app-pass-1234', [
      { kind: 'http.basic', target: { plugin: 'calendar', host: '*.dav.example.test' }, rule: 'pre-approved' },
    ]);
    calls.length = 0;
    const host = createPluginHost(hostBindingOf(calendar), facts());
    await host.http!.request({
      url: 'https://p12.dav.example.test/123/calendars/',
      method: 'PROPFIND',
      headers: { Depth: '1' },
      body: '<propfind/>',
      auth: { secret: 'CalDAV: Me', as: 'basic', username: 'me@example.test' },
    });
    expect(calls[0]?.headers).toEqual({
      Depth: '1',
      Authorization: `Basic ${Buffer.from('me@example.test:app-pass-1234').toString('base64')}`,
    });
    // Not under the bound domain, and not for another plugin.
    await expect(
      host.http!.request({ url: 'https://dav.other.test/', auth: { secret: 'CalDAV: Me', as: 'basic', username: 'me' } }),
    ).rejects.toThrow(/not bound/);
    const other = createPluginHost(hostBindingOf(manifest), facts());
    await expect(
      other.http!.request({ url: 'https://p12.dav.example.test/', auth: { secret: 'CalDAV: Me', as: 'basic', username: 'me' } }),
    ).rejects.toThrow(/not bound/);
    expect(calls).toHaveLength(1);
    expect(await asOwner.secrets!.delete('CalDAV: Me')).toBe(true);
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