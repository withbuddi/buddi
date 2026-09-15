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
  PAIRING_ALPHABET,
  consumePairingCode,
  createPairingCode,
  ensureOwner,
  generatePairingCode,
  getOwnerDisplayName,
  listSurfaceIdentitiesDetailed,
  normalizePairingCode,
  touchSurfaceIdentity,
  unpairSurfaceIdentity,
  getSurfaceCursor,
  getSurfaceIdentity,
  listSurfaceIdentities,
  pairSurfaceIdentity,
  recordSurfaceUpdate,
  resolveOwnerForSurface,
  setSurfaceCursor,
} from './owner.js';
import { testDatabaseUrl } from './testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
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
  /* ---------------- pairing by one-time code (migration 007) ---------------- */

  it('mints a code that is unambiguous, short lived and single use', async () => {
    const before = Date.now();
    const { code, expiresAt } = await createPairingCode(pool, {
      surface: 'telegram',
      ttlMinutes: 10,
    });
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    // The characters that get misread are simply not in the set.
    expect(code).not.toMatch(/[IO01]/);
    expect(expiresAt.getTime()).toBeGreaterThan(before);
    expect(expiresAt.getTime()).toBeLessThan(before + 11 * 60_000);

    // A code that was never minted is invalid, and says nothing more.
    expect(
      await consumePairingCode(pool, {
        surface: 'telegram',
        code: 'ZZZZZZZZ',
        externalUserId: '777',
      }),
    ).toEqual({ ok: false, reason: 'invalid' });

    // The real one pairs — typed in the shape a phone keyboard produces.
    const result = await consumePairingCode(pool, {
      surface: 'telegram',
      code: `  ${code.toLowerCase()} `,
      externalUserId: '777',
      externalChatId: '777',
      label: '@phone',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.identity.externalUserId).toBe('777');

    const { rows } = await pool.query(
      `select label, paired_via from core.surface_identities where id = $1`,
      [result.identity.id],
    );
    expect(rows[0]).toMatchObject({ label: '@phone', paired_via: 'code' });

    // The code is spent, and the audit trail names the device it made.
    const codes = await pool.query(
      `select used_at, used_by_identity from core.pairing_codes where code = $1`,
      [code],
    );
    expect(codes.rows[0].used_at).not.toBeNull();
    expect(String(codes.rows[0].used_by_identity)).toBe(result.identity.id);

    expect(
      await consumePairingCode(pool, {
        surface: 'telegram',
        code,
        externalUserId: '888',
      }),
    ).toEqual({ ok: false, reason: 'used' });
  });

  it('refuses an expired code, and a code minted for another surface', async () => {
    const { code } = await createPairingCode(pool, { surface: 'telegram' });
    await pool.query(
      `update core.pairing_codes set expires_at = now() - interval '1 minute' where code = $1`,
      [code],
    );
    expect(
      await consumePairingCode(pool, {
        surface: 'telegram',
        code,
        externalUserId: '901',
      }),
    ).toEqual({ ok: false, reason: 'expired' });

    // A Telegram code is not a Signal code: surfaces do not share a code space.
    const other = await createPairingCode(pool, { surface: 'telegram' });
    expect(
      await consumePairingCode(pool, {
        surface: 'signal',
        code: other.code,
        externalUserId: '902',
      }),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('claims a code exactly once when two devices race for it', async () => {
    const { code } = await createPairingCode(pool, { surface: 'telegram' });
    const [a, b] = await Promise.all([
      consumePairingCode(pool, { surface: 'telegram', code, externalUserId: '1001' }),
      consumePairingCode(pool, { surface: 'telegram', code, externalUserId: '1002' }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(loser).toEqual({ ok: false, reason: 'used' });

    // And only the winner became a device.
    const paired = (await listSurfaceIdentitiesDetailed(pool)).map((d) => d.externalUserId);
    expect(paired.includes('1001') !== paired.includes('1002')).toBe(true);
  });

  it('fills in a missing label on a touch, and never overwrites one', async () => {
    // Paired by the environment allowlist: an id, and no name at all.
    const nameless = await pairSurfaceIdentity(pool, {
      surface: 'telegram',
      externalUserId: '3003',
      externalChatId: '3003',
      pairedVia: 'env',
    });
    const named = await pairSurfaceIdentity(pool, {
      surface: 'telegram',
      externalUserId: '3004',
      externalChatId: '3004',
      label: "Amen's phone",
      pairedVia: 'code',
    });

    await touchSurfaceIdentity(pool, 'telegram', '3003', { label: '@TheRealAmenophis' });
    await touchSurfaceIdentity(pool, 'telegram', '3004', { label: '@TheRealAmenophis' });

    const devices = await listSurfaceIdentitiesDetailed(pool);
    expect(devices.find((d) => d.id === nameless.id)?.label).toBe('@TheRealAmenophis');
    // A name the owner chose is theirs; the transport does not get to rename it.
    expect(devices.find((d) => d.id === named.id)?.label).toBe("Amen's phone");

    // A touch with no label, or a blank one, leaves the row exactly as it was.
    await touchSurfaceIdentity(pool, 'telegram', '3003');
    await touchSurfaceIdentity(pool, 'telegram', '3004', { label: '   ' });
    const again = await listSurfaceIdentitiesDetailed(pool);
    expect(again.find((d) => d.id === nameless.id)?.label).toBe('@TheRealAmenophis');
    expect(again.find((d) => d.id === named.id)?.label).toBe("Amen's phone");
  });

  it('records last seen, lists devices and unpairs one', async () => {
    const identity = await pairSurfaceIdentity(pool, {
      surface: 'telegram',
      externalUserId: '2002',
      externalChatId: '2002',
      label: 'Laptop',
      pairedVia: 'env',
    });

    const before = (await listSurfaceIdentitiesDetailed(pool)).find(
      (d) => d.id === identity.id,
    );
    expect(before?.lastSeenAt).toBeNull();
    expect(before?.pairedVia).toBe('env');
    expect(before?.pairedAt).toBeInstanceOf(Date);

    await touchSurfaceIdentity(pool, 'telegram', '2002');
    const after = (await listSurfaceIdentitiesDetailed(pool)).find((d) => d.id === identity.id);
    expect(after?.lastSeenAt).toBeInstanceOf(Date);

    // Pairing again from the environment must not relabel how it first arrived.
    await pairSurfaceIdentity(pool, {
      surface: 'telegram',
      externalUserId: '777',
      externalChatId: '777',
      pairedVia: 'env',
    });
    const byCode = (await listSurfaceIdentitiesDetailed(pool)).find(
      (d) => d.externalUserId === '777',
    );
    expect(byCode?.pairedVia).toBe('code');

    expect(await unpairSurfaceIdentity(pool, identity.id)).toBe(true);
    // Gone, and gone for good: a second unpair is a fact, not an error.
    expect(await unpairSurfaceIdentity(pool, identity.id)).toBe(false);
    // Nor does a string that is not a uuid ever reach the database.
    expect(await unpairSurfaceIdentity(pool, 'not-a-uuid')).toBe(false);
    expect(
      await resolveOwnerForSurface(pool, {
        surface: 'telegram',
        externalUserId: '2002',
        externalChatId: '2002',
      }),
    ).toEqual({ ok: false, reason: 'unpaired' });
  });

  it('reads back the owner display name', async () => {
    expect(await getOwnerDisplayName(pool)).toBe('Owner');
  });
});

describe('pairing codes (pure)', () => {
  it('draws from an alphabet with no look-alike characters', () => {
    expect(PAIRING_ALPHABET).not.toMatch(/[IO01]/);
    expect(new Set(PAIRING_ALPHABET).size).toBe(PAIRING_ALPHABET.length);
    const codes = new Set(Array.from({ length: 200 }, () => generatePairingCode()));
    // 32^8 of space: 200 draws colliding would be a broken generator.
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(generatePairingCode(4)).toHaveLength(4);
  });

  it('reads a code the way a person types it', () => {
    expect(normalizePairingCode('  abcd-2345 ')).toBe('ABCD2345');
    expect(normalizePairingCode('ABCD 2345')).toBe('ABCD2345');
    expect(normalizePairingCode('')).toBe('');
  });
});
