/**
 * Owner/surface identity tests. Skipped unless DATABASE_URL is set.
 *
 * They never touch the owner's real data: a throwaway database is created, core
 * migrations run into it, and it is dropped at the end.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from './db.js';
import {
  OWNER_ID,
  ensureOwner,
  getSurfaceCursor,
  getSurfaceIdentity,
  listSurfaceIdentities,
  pairSurfaceIdentity,
  recordSurfaceUpdate,
  resolveOwnerForSurface,
  setSurfaceCursor,
} from './owner.js';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_owner_test_${process.pid}`;

suite('owner identity (postgres)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('creates exactly one owner, idempotently', async () => {
    expect(await ensureOwner(pool, 'Owner')).toBe(OWNER_ID);
    expect(await ensureOwner(pool)).toBe(OWNER_ID);
    const { rows } = await pool.query(`select id, display_name from core.owner`);
    expect(rows).toHaveLength(1);
    // A later call without a name must not erase the one already stored.
    expect(rows[0].display_name).toBe('Owner');
  });

  it('pairs an identity and resolves the owner for it', async () => {
    const identity = await pairSurfaceIdentity(pool, {
      surface: 'telegram',
      externalUserId: '111',
      externalChatId: '111',
    });
    expect(identity.ownerId).toBe(OWNER_ID);
    expect(identity.externalChatId).toBe('111');

    // Re-pairing is idempotent: same row, no duplicate.
    await pairSurfaceIdentity(pool, {
      surface: 'telegram',
      externalUserId: '111',
      externalChatId: '111',
    });
    expect(await listSurfaceIdentities(pool, 'telegram')).toHaveLength(1);

    await expect(
      resolveOwnerForSurface(pool, {
        surface: 'telegram',
        externalUserId: '111',
        externalChatId: '111',
      }),
    ).resolves.toEqual({ ok: true, ownerId: OWNER_ID });
  });

  it('refuses an unpaired user and a mismatched chat', async () => {
    expect(
      await resolveOwnerForSurface(pool, {
        surface: 'telegram',
        externalUserId: '999',
        externalChatId: '999',
      }),
    ).toEqual({ ok: false, reason: 'unpaired' });

    expect(
      await resolveOwnerForSurface(pool, {
        surface: 'telegram',
        externalUserId: '111',
        externalChatId: '-100500',
      }),
    ).toEqual({ ok: false, reason: 'chat-mismatch' });
  });

  it('scopes identities per surface', async () => {
    expect(await getSurfaceIdentity(pool, 'signal', '111')).toBeUndefined();
    expect(
      await resolveOwnerForSurface(pool, { surface: 'signal', externalUserId: '111' }),
    ).toEqual({ ok: false, reason: 'unpaired' });
  });

  it('records an update id exactly once', async () => {
    expect(await recordSurfaceUpdate(pool, 'telegram', '42')).toBe(true);
    expect(await recordSurfaceUpdate(pool, 'telegram', '42')).toBe(false);
    expect(await recordSurfaceUpdate(pool, 'telegram', '43')).toBe(true);
    // Same update id, different surface: independent ledgers.
    expect(await recordSurfaceUpdate(pool, 'signal', '42')).toBe(true);
  });

  it('round-trips the polling cursor', async () => {
    expect(await getSurfaceCursor(pool, 'telegram')).toBeUndefined();
    await setSurfaceCursor(pool, 'telegram', '44');
    expect(await getSurfaceCursor(pool, 'telegram')).toBe('44');
    await setSurfaceCursor(pool, 'telegram', '45');
    expect(await getSurfaceCursor(pool, 'telegram')).toBe('45');
  });
});
