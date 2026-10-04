/**
 * A sign-in the owner saved from a page they held, end to end through the
 * real owner-secret store (docs/browser.md, "Saving a sign-in";
 * docs/owner-secrets.md §5): Save puts the password in the vault through core's
 * `secrets.put` as the owner, bound as `browser.field` to the origin the form
 * sat on; the scrubber covers it from then on, in every encoding it knows; the
 * Keys and secrets listing says whose login it is and when, never its value;
 * Remove takes the secret and its label. The database is created here and
 * dropped.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configurePluginHost,
  createMemoryVault,
  createPool,
  createSecretsManifest,
  findSecret,
  loadScrubEntries,
  migrateCore,
  ownerSecretVaultName,
  primeSecretScrubber,
  resetPluginHost,
  resetSecretDestinations,
  scrubText,
  secretBindings,
  setSecretScrubSource,
  ToolRegistry,
  type CoreToolContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { LoginKeeper } from '@buddi/tool-browser';
import { listSecrets, ownerLoginStore, secretsAct, type SecretsDeps } from './secrets.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_browser_logins_${process.pid}`;
const PASSWORD = 'captured-Pass-9f2b!x';

suite('a saved sign-in in the owner-secret store (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let dir: string;
  const vault = createMemoryVault();
  const registry = new ToolRegistry();

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrateCore(pool);
    configurePluginHost({ vault });
    registry.register(createSecretsManifest());
    setSecretScrubSource(() => loadScrubEntries(pool, vault, {}));
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-browser-logins-'));
  }, 120_000);

  afterAll(async () => {
    setSecretScrubSource(null);
    resetPluginHost();
    resetSecretDestinations();
    await pool?.end().catch(() => {});
    await admin?.query(`drop database if exists ${TEST_DB}`).catch(() => {});
    await admin?.end().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('Save stores the pair as the owner, the scrubber covers it, Settings lists its label, Remove takes both', async () => {
    const deps = (logins?: LoginKeeper): SecretsDeps => ({ pool, registry, ctx: { ownerId: 'owner', timezone: 'UTC' } as Omit<CoreToolContext, 'db'>, now: () => new Date('2026-10-03T09:00:00Z'), ...(logins ? { logins } : {}) });
    const keeper = new LoginKeeper(path.join(dir, 'logins.json'), { now: () => Date.parse('2026-10-03T09:00:00Z') });
    keeper.useStore(ownerLoginStore(deps()));

    // Before the save, the value is nothing the scrubber knows.
    await primeSecretScrubber();
    expect(scrubText(`typed ${PASSWORD}`)).toBe(`typed ${PASSWORD}`);

    const prompt = await keeper.seen('s1', { origin: 'https://www.amazon.com', username: 'sam@example.com', password: PASSWORD });
    expect(await keeper.decide(prompt!.id, 'save')).toMatchObject({ outcome: 'saved' });

    const secret = await findSecret(pool, 'login · amazon.com');
    expect(secret).not.toBeNull();
    expect(await vault.get(ownerSecretVaultName(secret!.id))).toBe(PASSWORD);
    expect((await secretBindings(pool, secret!.id)).map(({ kind, target, rule }) => ({ kind, target, rule })))
      .toEqual([{ kind: 'browser.field', target: 'https://www.amazon.com', rule: 'first-time' }]);

    // The scrubber's coverage includes the new store path, plain and encoded.
    await primeSecretScrubber();
    expect(scrubText(`page echoed ${PASSWORD}`)).toBe('page echoed ‹secret:login · amazon.com›');
    expect(scrubText(`q=${encodeURIComponent(PASSWORD)}`)).not.toContain(encodeURIComponent(PASSWORD));
    expect(scrubText(Buffer.from(`user:${PASSWORD}`).toString('base64'))).not.toBe(Buffer.from(`user:${PASSWORD}`).toString('base64'));

    // Settings: whose login and when, never the value.
    const listed = await listSecrets(deps(keeper));
    const body = JSON.stringify(listed.body);
    expect(body).not.toContain(PASSWORD);
    const row = (listed.body as { secrets: Array<{ name: string; login?: unknown }> }).secrets.find((s) => s.name === 'login · amazon.com');
    expect(row?.login).toEqual({ site: 'amazon.com', username: 'sam@example.com', savedAt: '2026-10-03T09:00:00.000Z' });

    // Remove: the secret and its label go.
    expect((await secretsAct(deps(keeper), { tool: 'secrets.delete', args: { name: 'login · amazon.com' } }, { id: 'remove-test' })).status).toBe(200);
    expect(await findSecret(pool, 'login · amazon.com')).toBeNull();
    expect(keeper.saved()).toEqual([]);
  });
});
