/**
 * The reminder budget, against a throwaway database. Skipped unless
 * DATABASE_URL is set; the owner's own database is never touched.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from '../db.js';
import {
  cancelReminder,
  createReminder,
  dueReminders,
  expireOverdueReminders,
  listReminders,
  markFired,
} from './store.js';
import {
  MAX_PENDING_PER_AGENT,
  MAX_PENDING_TOTAL,
  MAX_REMINDER_TEXT,
  MIN_LEAD_MINUTES,
  REMINDER_GRACE_MS,
} from './types.js';
import { testDatabaseUrl } from '../testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_reminders_test_${process.pid}`;

const NOW = new Date('2026-09-14T12:00:00Z');
const TZ = 'America/New_York';
const hours = (n: number): Date => new Date(NOW.getTime() + n * 3_600_000);

suite('reminders (postgres)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const testUrl = new URL(databaseUrl as string);
    testUrl.pathname = `/${TEST_DB}`;
    pool = createPool(testUrl.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate core.reminders cascade');
  });

  const set = (overrides: Partial<Parameters<typeof createReminder>[1]> = {}) =>
    createReminder(pool, {
      agentId: 'finance-advisor',
      dueAt: hours(24),
      text: 'check whether the card payment went out',
      now: NOW,
      timezone: TZ,
      ...overrides,
    });

  it('creates one and lists it back as pending', async () => {
    const created = await set();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.reminder.state).toBe('pending');
    expect(created.reminder.agentId).toBe('finance-advisor');

    const pending = await listReminders(pool, { state: 'pending' });
    expect(pending.map((r) => r.id)).toEqual([created.reminder.id]);
  });

  it('keeps the context it was given, verbatim', async () => {
    const created = await set({ context: { card: 'NFCU', amount: 120 } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.reminder.context).toEqual({ card: 'NFCU', amount: 120 });
  });

  it(`refuses anything less than ${MIN_LEAD_MINUTES} minutes out`, async () => {
    // A minute short of the line, whatever the line is set to.
    const soon = await set({ dueAt: new Date(NOW.getTime() + (MIN_LEAD_MINUTES - 1) * 60_000) });
    expect(soon.ok).toBe(false);
    if (soon.ok) return;
    expect(soon.reason).toBe('too-soon');
    expect(await listReminders(pool)).toHaveLength(0);
  });

  it('accepts one exactly at the minimum lead', async () => {
    const edge = await set({ dueAt: new Date(NOW.getTime() + MIN_LEAD_MINUTES * 60_000) });
    expect(edge.ok).toBe(true);
  });

  it('refuses one past the horizon', async () => {
    const far = await set({ dueAt: new Date(NOW.getTime() + 400 * 24 * 3_600_000) });
    expect(far.ok).toBe(false);
    if (far.ok) return;
    expect(far.reason).toBe('too-far');
  });

  it('refuses empty text and text past the cap', async () => {
    const empty = await set({ text: '   ' });
    expect(empty.ok && 'unreachable').toBe(false);
    if (!empty.ok) expect(empty.reason).toBe('empty-text');

    const long = await set({ text: 'x'.repeat(MAX_REMINDER_TEXT + 1) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.reason).toBe('text-too-long');
  });

  it('refuses a run with no agent id rather than inventing one', async () => {
    const orphan = await set({ agentId: '' });
    expect(orphan.ok).toBe(false);
    if (orphan.ok) return;
    expect(orphan.reason).toBe('no-agent');
  });

  it(`caps one agent at ${MAX_PENDING_PER_AGENT} pending`, async () => {
    for (let i = 0; i < MAX_PENDING_PER_AGENT; i += 1) {
      const ok = await set({ dueAt: hours(24 + i) });
      expect(ok.ok).toBe(true);
    }
    const eleventh = await set({ dueAt: hours(99) });
    expect(eleventh.ok).toBe(false);
    if (eleventh.ok) return;
    expect(eleventh.reason).toBe('too-many-for-agent');
    expect(eleventh.message).toContain(String(MAX_PENDING_PER_AGENT));

    // Another agent still has its own budget — the per-agent cap is per agent.
    const other = await set({ agentId: 'credit-coach' });
    expect(other.ok).toBe(true);

    // And cancelling one frees a slot.
    const pending = await listReminders(pool, { agentId: 'finance-advisor', state: 'pending' });
    await cancelReminder(pool, (pending[0] as { id: string }).id, 'no longer needed', NOW);
    expect((await set({ dueAt: hours(120) })).ok).toBe(true);
  });

  it(`caps the whole installation at ${MAX_PENDING_TOTAL} pending`, async () => {
    // Three agents of ten would exceed the global cap first.
    const agents = ['a-one', 'a-two', 'a-three'];
    let accepted = 0;
    let globalRefusal: string | undefined;
    for (const agentId of agents) {
      for (let i = 0; i < MAX_PENDING_PER_AGENT; i += 1) {
        const result = await set({ agentId, dueAt: hours(24 + i) });
        if (result.ok) accepted += 1;
        else globalRefusal = result.reason;
      }
    }
    expect(accepted).toBe(MAX_PENDING_TOTAL);
    expect(globalRefusal).toBe('too-many');
  });

  it('cancels a pending one exactly once', async () => {
    const created = await set();
    if (!created.ok) throw new Error('setup');
    const first = await cancelReminder(pool, created.reminder.id, 'already paid', NOW);
    expect(first?.state).toBe('cancelled');
    expect(first?.cancelReason).toBe('already paid');
    // Idempotent: a second cancel changes nothing and says so.
    expect(await cancelReminder(pool, created.reminder.id, 'again', NOW)).toBeNull();
    expect(await listReminders(pool, { state: 'pending' })).toHaveLength(0);
  });

  it('selects only what is due, and never what was cancelled', async () => {
    const soon = await set({ dueAt: hours(1) });
    await set({ dueAt: hours(48) });
    const cancelled = await set({ dueAt: hours(2) });
    if (!soon.ok || !cancelled.ok) throw new Error('setup');
    await cancelReminder(pool, cancelled.reminder.id, 'done', NOW);

    const due = await dueReminders(pool, hours(3));
    expect(due.map((r) => r.id)).toEqual([soon.reminder.id]);
  });

  it('marks fired once, which is what makes the loop idempotent', async () => {
    const created = await set({ dueAt: hours(1) });
    if (!created.ok) throw new Error('setup');
    const fired = await markFired(pool, created.reminder.id, hours(1));
    expect(fired?.state).toBe('fired');
    expect(await markFired(pool, created.reminder.id, hours(1))).toBeNull();
    expect(await dueReminders(pool, hours(2))).toHaveLength(0);
  });

  it('expires anything more than 24h past due instead of firing it late', async () => {
    const slept = await set({ dueAt: hours(1) });
    const fresh = await set({ dueAt: hours(25) });
    if (!slept.ok || !fresh.ok) throw new Error('setup');

    // The machine wakes up two days later.
    const wake = new Date(hours(1).getTime() + REMINDER_GRACE_MS + 3_600_000);
    const expired = await expireOverdueReminders(pool, wake);
    expect(expired.map((r) => r.id)).toEqual([slept.reminder.id]);
    expect(expired[0]?.state).toBe('expired');

    // The one still inside the window is due, not expired.
    const due = await dueReminders(pool, wake);
    expect(due.map((r) => r.id)).toEqual([fresh.reminder.id]);
  });

  it('leaves a reminder just inside the grace window alone', async () => {
    const created = await set({ dueAt: hours(1) });
    if (!created.ok) throw new Error('setup');
    const wake = new Date(hours(1).getTime() + REMINDER_GRACE_MS - 60_000);
    expect(await expireOverdueReminders(pool, wake)).toHaveLength(0);
    expect((await dueReminders(pool, wake)).map((r) => r.id)).toEqual([created.reminder.id]);
  });
});
