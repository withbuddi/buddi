/**
 * The Cloudflare API token as an owner secret (postgres): kept under
 * CLOUDFLARE_API_TOKEN bound pre-approved to the gateway's access.cloudflare
 * destination, read back once per run with the use recorded, masked by the
 * scrubber once saved, and forgotten by Remove. The database is created here
 * and dropped.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryVault, createPool, findSecret, resetSecretDestinations, runMigrations, scrubText, setSecretScrubSource } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { CLOUDFLARE_TOKEN_SECRET } from './cloudflare-setup.js';
import { ownerSecretTokenStore } from './cloudflare-token.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_cf_token_${process.pid}`;
const TOKEN = 'cf-token-abcdefghijklmnopqrstuvwxyz012345';

suite('the Cloudflare token as an owner secret (postgres)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    setSecretScrubSource(null);
    resetSecretDestinations();
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('keeps, uses, masks and forgets the token', async () => {
    const vault = createMemoryVault();
    setSecretScrubSource(async () => [{ name: CLOUDFLARE_TOKEN_SECRET, value: (await vault.get(`owner-secret:${(await findSecret(pool, CLOUDFLARE_TOKEN_SECRET))?.id}`)) ?? '' }]);
    const store = ownerSecretTokenStore(pool, vault);
    expect(await store.has()).toBe(false);
    expect(await store.use()).toBeNull();
    await store.put(` ${TOKEN} `);
    expect(await store.has()).toBe(true);
    expect(await store.use()).toBe(TOKEN);
    const { rows } = await pool.query(`select outcome, kind, plugin from core.secret_uses where secret_name = $1 and outcome = 'delivered'`, [CLOUDFLARE_TOKEN_SECRET]);
    expect(rows).toEqual([{ outcome: 'delivered', kind: 'access.cloudflare', plugin: 'access' }]);
    expect(scrubText(`token=${TOKEN}`)).not.toContain(TOKEN);
    await store.remove();
    expect(await store.has()).toBe(false);
  });
});
