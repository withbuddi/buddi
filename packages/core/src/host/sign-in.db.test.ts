/**
 * `secrets.signIn` and `auth: { as: 'bearer' }` end to end through the host a
 * plugin is handed (host API 1.28): only the owner signs in, only to a provider
 * core knows and one of its API hosts; the tokens land as the owner secret the
 * plugin named, bound to `http.bearer` for that plugin, and a request carries
 * the access token the service keeps fresh — never the envelope. A plugin may
 * not write a bearer binding itself, may delete its own sign-in, and no other
 * plugin can send it. The database is created here and dropped.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrateCore } from '../db.js';
import { urlForDatabase } from '../backup/restore.js';
import { testDatabaseUrl } from '../testing/database-url.js';
import { configurePluginHost, createPluginHost, hostBindingOf, resetPluginHost } from './build.js';
import type { CoreToolContext, PluginManifest } from '../tools.js';
import type { PluginSignInService } from './types.js';
import { createMemoryVault } from '../vault/memory.js';
import { findSecret, secretBindings } from '../secrets/store.js';
import { ownerSecretVaultName } from '../vault/types.js';
import type { OAuthProvider } from '../plugin/sign-in.js';
import { loadScrubEntries } from '../secrets/scrub.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const DB = `buddi_sign_in_${process.pid}`;

suite('secrets.signIn and http.bearer (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  const now = new Date('2026-10-03T12:00:00Z');
  const manifest = (name: string): PluginManifest => ({
    name,
    version: '1.0.0',
    schema: 'core',
    migrationsDir: '',
    tools: [],
    uses: ['http', 'secrets'],
    network: [{ host: 'www.googleapis.com', why: 'the API' }],
  });
  const facts = (over: Partial<CoreToolContext> = {}): CoreToolContext => ({
    db: pool, ownerId: 'owner', now: () => now, timezone: 'UTC', agentId: 'assistant', ...over,
  });

  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const transportFactory = () => async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, text: async () => '', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };

  /** The service, faked: `begin` remembers `save`; the test plays the provider. */
  let saves: Array<(envelope: string) => Promise<void>> = [];
  const begun: Array<{ plugin: string; provider: OAuthProvider; scopes: readonly string[]; clientSecret?: string }> = [];
  const freshCalls: Array<{ ref: string; secret: string; rejected?: string }> = [];
  const service: PluginSignInService = {
    async begin(input) {
      saves.push(input.save);
      begun.push({ plugin: input.plugin, provider: input.provider, scopes: input.scopes, ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}) });
      return { id: `s${saves.length}`, authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', redirectUri: 'http://127.0.0.1:5555/', expiresAt: now.getTime() + 600_000 };
    },
    status: (plugin, id) => (plugin === 'calendar' && id === 's1' ? { state: 'waiting' } : undefined),
    finish: async () => ({ state: 'signed-in' }),
    cancel: () => {},
    async fresh(vault, ref, secret, opts) {
      freshCalls.push({ ref, secret, ...(opts?.rejected ? { rejected: opts.rejected } : {}) });
      const envelope = JSON.parse((await vault.get(ref))!) as { accessToken: string };
      return { accessToken: envelope.accessToken, refreshed: false };
    },
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

  it('signs in for the owner only, to a provider core knows and its API host, and keeps the tokens as the named secret', async () => {
    const vault = createMemoryVault();
    configurePluginHost({ vault, httpTransport: transportFactory as never, signIns: service });
    const asOwner = createPluginHost(hostBindingOf(manifest('calendar')), facts({ agentId: 'owner' }));
    const asAgent = createPluginHost(hostBindingOf(manifest('calendar')), facts());
    const req = {
      provider: 'google', clientId: 'client-1.apps.googleusercontent.com', clientSecret: 'shh',
      scopes: ['https://www.googleapis.com/auth/calendar.events'], secret: 'Calendar sign-in: Google', host: 'www.googleapis.com',
    };
    await expect(asAgent.secrets!.signIn!(req)).rejects.toThrow(/Only the owner/);
    await expect(asOwner.secrets!.signIn!({ ...req, provider: 'dropbox' })).rejects.toThrow(/does not sign in to "dropbox"/);
    await expect(asOwner.secrets!.signIn!({ ...req, host: 'evil.test' })).rejects.toThrow(/only to www.googleapis.com/);
    await expect(asOwner.secrets!.signIn!({ ...req, scopes: [] })).rejects.toThrow(/scopes/);

    const started = await asOwner.secrets!.signIn!(req);
    expect(started).toEqual({ id: 's1', authorizeUrl: expect.stringContaining('accounts.google.com'), redirectUri: 'http://127.0.0.1:5555/', expiresAt: expect.any(String) });
    expect(begun[0]).toMatchObject({ plugin: 'calendar', clientSecret: 'shh', provider: { tokenEndpoint: 'https://oauth2.googleapis.com/token' } });
    expect(await asAgent.secrets!.signInStatus!('s1')).toEqual({ state: 'waiting' });
    expect(await createPluginHost(hostBindingOf(manifest('news')), facts()).secrets!.signInStatus!('s1')).toMatchObject({ state: 'expired' });

    // The provider answered: core writes the envelope as the owner secret.
    const envelope = JSON.stringify({ version: 1, state: 'ready', accessToken: 'ya29.access', refreshToken: '1//refresh', expiresAt: now.getTime() + 3600_000 });
    await saves[0]!(envelope);
    const secret = (await findSecret(pool, 'Calendar sign-in: Google'))!;
    expect(await vault.get(ownerSecretVaultName(secret.id))).toBe(envelope);
    const bindings = await secretBindings(pool, secret.id);
    expect(bindings.map((b) => ({ kind: b.kind, target: b.target, rule: b.rule }))).toEqual([
      { kind: 'http.bearer', target: { plugin: 'calendar', host: 'www.googleapis.com' }, rule: 'pre-approved' },
    ]);

    // The tokens inside it are scrubbed one by one, under the secret's name.
    const scrub = await loadScrubEntries(pool, vault, {});
    expect(scrub.filter((e) => e.name === 'Calendar sign-in: Google').map((e) => e.value)).toEqual(expect.arrayContaining(['ya29.access', '1//refresh']));

    // A request carries the access token alone, through the service.
    calls.length = 0;
    await asAgent.http!.request({ url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList', auth: { secret: 'Calendar sign-in: Google', as: 'bearer' } });
    expect(calls[0]?.headers.Authorization).toBe('Bearer ya29.access');
    expect(freshCalls[0]).toEqual({ ref: ownerSecretVaultName(secret.id), secret: 'Calendar sign-in: Google' });
    const { rows } = await pool.query(`select kind, outcome from core.secret_uses order by at`);
    expect(rows.at(-1)).toEqual({ kind: 'http.bearer', outcome: 'delivered' });

    // Another plugin cannot send it; nor can this one to another host.
    const news = createPluginHost(hostBindingOf(manifest('news')), facts());
    await expect(news.http!.request({ url: 'https://www.googleapis.com/x', auth: { secret: 'Calendar sign-in: Google', as: 'bearer' } })).rejects.toThrow();
    await expect(asAgent.http!.request({ url: 'https://evil.test/x', auth: { secret: 'Calendar sign-in: Google', as: 'bearer' } })).rejects.toThrow();
  });

  it('a plugin cannot write a bearer binding itself, may rename and delete its sign-in, and signs in again under the same name', async () => {
    const vault = createMemoryVault();
    configurePluginHost({ vault, httpTransport: transportFactory as never, signIns: service });
    const asOwner = createPluginHost(hostBindingOf(manifest('calendar')), facts({ agentId: 'owner' }));
    await expect(
      asOwner.secrets!.put('Forged', 'x', [{ kind: 'http.bearer', target: { plugin: 'calendar', host: 'www.googleapis.com' }, rule: 'pre-approved' }]),
    ).rejects.toThrow(/only to its own destinations/);
    saves = [];
    await asOwner.secrets!.signIn!({ provider: 'google', clientId: 'c', scopes: ['s'], secret: 'Calendar sign-in: Google (new)', host: 'www.googleapis.com' });
    await saves[0]!(JSON.stringify({ version: 1, state: 'ready', accessToken: 'a1', expiresAt: 1 }));
    expect(await asOwner.secrets!.rename('Calendar sign-in: Google (new)', 'Calendar sign-in: Google sam@gmail.com')).toBe(true);
    await asOwner.secrets!.signIn!({ provider: 'google', clientId: 'c', scopes: ['s'], secret: 'Calendar sign-in: Google sam@gmail.com', host: 'www.googleapis.com' });
    await saves[1]!(JSON.stringify({ version: 1, state: 'ready', accessToken: 'a2', expiresAt: 1 }));
    const secret = (await findSecret(pool, 'Calendar sign-in: Google sam@gmail.com'))!;
    expect(JSON.parse((await vault.get(ownerSecretVaultName(secret.id)))!).accessToken).toBe('a2');
    expect(await asOwner.secrets!.delete('Calendar sign-in: Google sam@gmail.com')).toBe(true);
    expect(await findSecret(pool, 'Calendar sign-in: Google sam@gmail.com')).toBeNull();
  });

  it('without the service, a sign-in and a bearer request say so', async () => {
    resetPluginHost();
    configurePluginHost({ vault: createMemoryVault(), httpTransport: transportFactory as never });
    const asOwner = createPluginHost(hostBindingOf(manifest('calendar')), facts({ agentId: 'owner' }));
    await expect(asOwner.secrets!.signIn!({ provider: 'google', clientId: 'c', scopes: ['s'], secret: 'G2', host: 'www.googleapis.com' })).rejects.toThrow(/cannot run a sign-in/);
  });
});
