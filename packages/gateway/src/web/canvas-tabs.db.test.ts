/**
 * The canvas's tabs per conversation: what was closed and when each was last
 * looked at, round-tripped through `core.web_settings`, one key per
 * conversation. Own database, dropped after; skipped without one.
 */
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, clearGroupHistory, createPool, migrate, purgeDeletedGroups, readWebSetting } from '@buddi/core';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '@buddi/core/testing';
import { CANVAS_TABS_LIMIT, canvasTabsKey, parseCanvasTabs, readCanvasTabs, writeCanvasTabs } from './canvas-tabs.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_canvas_tabs_${process.pid}`;

describe('the canvas tabs body', () => {
  it('takes closed stamps and touch times, and refuses anything else', () => {
    expect(parseCanvasTabs({ closed: ['t1', 'sources:t2', 't1'], touched: { t3: 5 } })).toEqual({
      ok: true, value: { closed: ['t1', 'sources:t2'], touched: { t3: 5 } },
    });
    expect(parseCanvasTabs({})).toEqual({ ok: true, value: { closed: [], touched: {} } });
    expect(parseCanvasTabs({ closed: 'no' }).ok).toBe(false);
    expect(parseCanvasTabs({ closed: ['has space'] }).ok).toBe(false);
    expect(parseCanvasTabs({ touched: { t1: 'later' } }).ok).toBe(false);
    expect(parseCanvasTabs([]).ok).toBe(false);
  });

  it('keeps the newest few of a long conversation', () => {
    const many = Array.from({ length: CANVAS_TABS_LIMIT + 5 }, (_, index) => `t${index}`);
    const parsed = parseCanvasTabs({ closed: many, touched: Object.fromEntries(many.map((id, index) => [id, index])) });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.closed).toHaveLength(CANVAS_TABS_LIMIT);
    expect(parsed.value.closed[0]).toBe('t5');
    expect(Object.keys(parsed.value.touched)).toHaveLength(CANVAS_TABS_LIMIT);
    expect(parsed.value.touched['t0']).toBeUndefined();
  });
});

suite('the canvas tabs of a conversation', () => {
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

  const conversation = async (groupId: string | null = null): Promise<string> => {
    const { rows } = await pool.query(
      `insert into core.conversations (agent_id, group_id) values ('ledger', $1::uuid) returning id`,
      [groupId],
    );
    return String(rows[0].id);
  };
  const group = async (): Promise<string> => {
    const { rows } = await pool.query(`insert into core.groups (name, coordinator_agent_id) values ('Room', 'ledger') returning id`);
    return String(rows[0].id);
  };

  it('round-trips per conversation, empty until written', async () => {
    const a = await conversation();
    const b = await conversation();
    expect(await readCanvasTabs(pool, a)).toEqual({ closed: [], touched: {} });
    await writeCanvasTabs(pool, a, { closed: ['t1'], touched: { t2: 10, t3: 20 } });
    await writeCanvasTabs(pool, b, { closed: [], touched: { t9: 1 } });
    expect(await readCanvasTabs(pool, a)).toEqual({ closed: ['t1'], touched: { t2: 10, t3: 20 } });
    expect(await readCanvasTabs(pool, b)).toEqual({ closed: [], touched: { t9: 1 } });
    // Replaced whole, never merged.
    await writeCanvasTabs(pool, a, { closed: [], touched: { t3: 30 } });
    expect(await readCanvasTabs(pool, a)).toEqual({ closed: [], touched: { t3: 30 } });
    expect(await readWebSetting(pool, canvasTabsKey(a))).toEqual({ closed: [], touched: { t3: 30 } });
  });

  it('knows no conversation that does not exist, and writes nothing for one', async () => {
    const ghost = '33333333-3333-4333-8333-333333333333';
    expect(await readCanvasTabs(pool, ghost)).toBeNull();
    expect(await writeCanvasTabs(pool, ghost, { closed: ['t1'], touched: {} })).toBe(false);
    expect(await readWebSetting(pool, canvasTabsKey(ghost))).toBeNull();
  });

  it('goes with its conversation when a room is cleared or purged', async () => {
    const cleared = await group();
    const one = await conversation(cleared);
    const kept = await conversation();
    expect(await writeCanvasTabs(pool, one, { closed: ['t1'], touched: {} })).toBe(true);
    expect(await writeCanvasTabs(pool, kept, { closed: ['t2'], touched: {} })).toBe(true);
    expect(await clearGroupHistory(pool, cleared)).toBe(1);
    expect(await readWebSetting(pool, canvasTabsKey(one))).toBeNull();
    expect(await readWebSetting(pool, canvasTabsKey(kept))).toEqual({ closed: ['t2'], touched: {} });

    const purged = await group();
    const two = await conversation(purged);
    expect(await writeCanvasTabs(pool, two, { closed: ['t3'], touched: {} })).toBe(true);
    await pool.query(`update core.groups set deleted_at = now() - interval '30 days' where id = $1::uuid`, [purged]);
    expect(await purgeDeletedGroups(pool)).toEqual([purged]);
    expect(await readWebSetting(pool, canvasTabsKey(two))).toBeNull();
  });
});
