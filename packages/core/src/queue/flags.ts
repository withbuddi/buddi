/**
 * Global pause (`core.system_flags`).
 *
 * "Global pause control exists" is an architecture requirement, and this is the
 * whole of it: one row, read *inside* the claim statement so that pausing stops
 * every worker in every process at once — nobody is notified, nobody has to
 * agree, and a job already leased is allowed to finish rather than being cut
 * off mid-effect.
 */
import type { Pool } from 'pg';
import { appendEvent } from '../events.js';

export const PAUSED_FLAG = 'paused';

/**
 * SQL that is true when the installation is paused. Inlined into the claim
 * statement on purpose: two statements would be a race.
 */
export const PAUSED_SQL = `coalesce((select f.value = 'true'::jsonb from core.system_flags f where f.key = '${PAUSED_FLAG}'), false)`;

export async function isPaused(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ paused: boolean }>(
    `select ${PAUSED_SQL} as paused`,
  );
  return rows[0]?.paused === true;
}

/** Pause or resume the installation. Returns the state it is now in. */
export async function setPaused(pool: Pool, paused: boolean): Promise<boolean> {
  const { rows } = await pool.query<{ before: boolean }>(
    `select ${PAUSED_SQL} as before`,
  );
  const before = rows[0]?.before === true;
  await pool.query(
    `insert into core.system_flags (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [PAUSED_FLAG, JSON.stringify(paused)],
  );
  if (before !== paused) {
    await appendEvent(pool, paused ? 'system.paused' : 'system.resumed', { paused });
  }
  return paused;
}

/**
 * Write any flag. The same one row per key the pause switch uses — this is the
 * installation's small durable key-value store, and a watcher that must not
 * repeat itself across restarts keeps its place here.
 */
export async function setFlag(pool: Pool, key: string, value: unknown): Promise<void> {
  await pool.query(
    `insert into core.system_flags (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value ?? null)],
  );
}

/** Read any flag. Absent is `undefined`, never a guessed default. */
export async function getFlag(pool: Pool, key: string): Promise<unknown> {
  const { rows } = await pool.query<{ value: unknown }>(
    `select value from core.system_flags where key = $1`,
    [key],
  );
  return rows.length > 0 ? rows[0]?.value : undefined;
}
