/**
 * Recovery mode, against real Postgres.
 *
 * The one row and its lifecycle are the whole feature, so they are checked
 * where they live: entering twice replaces rather than duplicates, leaving is
 * idempotent, and the counts are read from the same tables a restored dump
 * fills. The database is created by this suite, named after this process, and
 * dropped again.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrateCore } from './db.js';
import {
  countPending,
  enterRecovery,
  inRecovery,
  leaveRecovery,
  readRecovery,
  toPending,
} from './recovery.js';
import { urlForDatabase } from './backup/restore.js';
import { testDatabaseUrl } from './testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const DB = `buddi_recovery_${process.pid}`;

suite('recovery mode', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(urlForDatabase(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlForDatabase(databaseUrl as string, DB));
    await migrateCore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await admin?.query(`drop database if exists "${DB}"`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  it('is off until a restore says otherwise', async () => {
    expect(await inRecovery(pool)).toBe(false);
    expect(await readRecovery(pool)).toBeNull();
    // Leaving something that was never entered changes nothing and says so.
    expect(await leaveRecovery(pool)).toBe(false);
  });

  it('records one row, replaces it on a second restore, and leaves once', async () => {
    const first = await enterRecovery(pool, {
      archive: 'buddi-backup-20260101-033000.tar.gz.age',
      buddiVersion: '0.1.0',
      pending: { jobs: 3, approvals: 1 },
    });
    expect(first.active).toBe(true);
    expect(first.pending).toEqual({ jobs: 3, missions: 0, approvals: 1, telegramChats: 0, grants: 0 });
    expect(await inRecovery(pool)).toBe(true);

    expect(await leaveRecovery(pool)).toBe(true);
    expect(await leaveRecovery(pool)).toBe(false);
    expect(await inRecovery(pool)).toBe(false);
    const left = await readRecovery(pool);
    expect(left?.active).toBe(false);
    expect(left?.leftAt).toBeInstanceOf(Date);
    // The history is kept rather than deleted: this installation *was* restored.
    expect(left?.archive).toBe('buddi-backup-20260101-033000.tar.gz.age');

    const second = await enterRecovery(pool, { archive: 'buddi-backup-20260102-033000.tar.gz' });
    expect(second.active).toBe(true);
    expect(second.leftAt).toBeNull();
    const { rows } = await pool.query('select count(*)::text as n from core.recovery');
    expect(rows[0].n).toBe('1');
    await leaveRecovery(pool);
  });

  it('counts what a restored dump is carrying', async () => {
    expect(await countPending(pool)).toEqual({ jobs: 0, missions: 0, approvals: 0, telegramChats: 0, grants: 0 });

    await pool.query(`insert into core.jobs (kind, state) values ('mission-run', 'pending'), ('mission-run', 'suspended'), ('mission-run', 'succeeded')`);
    await pool.query(`insert into core.owner (id) values ('owner') on conflict do nothing`);
    await pool.query(
      `insert into core.surface_identities (owner_id, surface, external_user_id, external_chat_id)
       values ('owner', 'telegram', '1', '99'), ('owner', 'telegram', '2', null)`,
    );
    await pool.query(
      `insert into core.tool_permissions (owner_id, agent_id, tool, tool_version, conversation_id, granted_via)
       values ('owner', 'concierge', 'mail.send', '1', '', 'approval')`,
    );

    const counted = await countPending(pool);
    expect(counted.jobs).toBe(2);
    expect(counted.telegramChats).toBe(1);
    expect(counted.grants).toBe(1);
    expect(counted.approvals).toBe(0);
  });
});

describe('a pending cell', () => {
  it('survives whatever the driver hands back', () => {
    expect(toPending({ jobs: 2, approvals: '3' })).toEqual({ jobs: 2, missions: 0, approvals: 3, telegramChats: 0, grants: 0 });
    expect(toPending('{"jobs":4}')).toMatchObject({ jobs: 4 });
    for (const bad of [null, undefined, '[', [], 'nonsense', 7]) {
      expect(toPending(bad)).toEqual({ jobs: 0, missions: 0, approvals: 0, telegramChats: 0, grants: 0 });
    }
    // A negative or fractional count is data we did not write.
    expect(toPending({ jobs: -1, missions: 1.7 })).toMatchObject({ jobs: 0, missions: 1 });
  });
});
