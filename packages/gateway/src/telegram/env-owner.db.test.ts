/**
 * The retired `TELEGRAM_OWNER_USER_ID` / `TELEGRAM_OWNER_CHAT_ID`: adopted
 * once, recorded, and never read again, so a phone the owner unpaired in
 * Settings → Telegram stays unpaired across restarts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  ensureOwner,
  listSurfaceIdentitiesDetailed,
  pairSurfaceIdentity,
  readWebSetting,
  runMigrations,
  unpairSurfaceIdentity,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { adoptEnvOwner, ENV_OWNER_ADOPTED_KEY } from './env-owner.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const name = `buddi_tg_env_owner_${process.pid}`;
const ENV = { TELEGRAM_OWNER_USER_ID: '4242', TELEGRAM_OWNER_CHAT_ID: '9001' };

suite('adopting the .env Telegram owner', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${name}`;
    pool = createPool(url.toString());
    await runMigrations(pool, []);
    await ensureOwner(pool, 'owner');
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${name}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('delete from core.surface_identities');
    await pool.query('delete from core.web_settings where key = $1', [ENV_OWNER_ADOPTED_KEY]);
  });

  const telegram = async () => (await listSurfaceIdentitiesDetailed(pool)).filter((d) => d.surface === 'telegram');

  it('pairs the env identity once, as env, and records the adoption', async () => {
    expect(await adoptEnvOwner(pool, ENV)).toEqual({ outcome: 'adopted', userId: '4242' });
    const devices = await telegram();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ externalUserId: '4242', externalChatId: '9001', pairedVia: 'env' });
    expect(await readWebSetting(pool, ENV_OWNER_ADOPTED_KEY)).toMatchObject({ outcome: 'adopted', userId: '4242' });
    expect(await adoptEnvOwner(pool, ENV)).toEqual({ outcome: 'done' });
    expect(await telegram()).toHaveLength(1);
  });

  it('does not bring back an identity the owner unpaired on a later start', async () => {
    await adoptEnvOwner(pool, ENV);
    const [device] = await telegram();
    expect(await unpairSurfaceIdentity(pool, device!.id)).toBe(true);
    expect(await adoptEnvOwner(pool, ENV)).toEqual({ outcome: 'done' });
    expect(await telegram()).toEqual([]);
  });

  it('leaves an identity already paired by code as it is, and still records', async () => {
    await pairSurfaceIdentity(pool, { surface: 'telegram', externalUserId: '4242', externalChatId: '4242', pairedVia: 'code' });
    expect(await adoptEnvOwner(pool, ENV)).toEqual({ outcome: 'exists', userId: '4242' });
    expect(await telegram()).toEqual([expect.objectContaining({ externalChatId: '4242', pairedVia: 'code' })]);
    expect(await readWebSetting(pool, ENV_OWNER_ADOPTED_KEY)).toMatchObject({ outcome: 'exists' });
  });

  it('does nothing when the env lines are unset', async () => {
    expect(await adoptEnvOwner(pool, {})).toEqual({ outcome: 'none' });
    expect(await adoptEnvOwner(pool, { TELEGRAM_OWNER_USER_ID: '  ' })).toEqual({ outcome: 'none' });
    expect(await telegram()).toEqual([]);
    expect(await readWebSetting(pool, ENV_OWNER_ADOPTED_KEY)).toBeNull();
  });
});
