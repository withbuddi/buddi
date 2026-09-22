/**
 * The owner's switch on one watcher.
 *
 * A sentinel is code a plugin ships, and the owner does not get to edit it —
 * but whether it runs at all is theirs to decide, per watcher, from the
 * Watchers page. That is all this file is: one boolean per sentinel id, absent
 * meaning on.
 *
 * What "off" means, exactly, matters more than the flag does:
 *
 *  - the watcher **does not run**. Nothing is queried, nothing is raised;
 *  - and nothing is **resolved**. A tick that skipped a watcher has learned
 *    nothing about whether its facts are still true, so its open findings are
 *    left alone — switching it back on then says nothing new about a fact the
 *    owner already heard, rather than replaying it as news.
 */
import type { Pool } from 'pg';
import { appendEvent } from '../events.js';

export interface SentinelSwitch {
  sentinelId: string;
  enabled: boolean;
  updatedAt: Date;
}

/**
 * Every switch the owner has touched. Absent from the map means on — the
 * default is not written down, so a fresh installation has no rows.
 */
export async function sentinelSwitches(pool: Pool): Promise<Map<string, boolean>> {
  const { rows } = await pool.query<{ sentinel_id: string; enabled: boolean }>(
    `select sentinel_id, enabled from core.sentinel_switches`,
  );
  return new Map(rows.map((row) => [row.sentinel_id, row.enabled !== false]));
}

/** Is this watcher on? Unknown ids are on: a watcher is useful by default. */
export function sentinelIsEnabled(switches: Map<string, boolean>, sentinelId: string): boolean {
  return switches.get(sentinelId) !== false;
}

/**
 * Switch one watcher on or off. Returns what it now is.
 *
 * The id is not checked against the installed sentinels on purpose: a plugin
 * that is being reinstalled, or one whose watcher is momentarily missing from
 * the registry, must not silently lose the owner's decision about it.
 */
export async function setSentinelEnabled(
  pool: Pool,
  sentinelId: string,
  enabled: boolean,
  now: Date = new Date(),
): Promise<SentinelSwitch> {
  const { rows } = await pool.query<{ sentinel_id: string; enabled: boolean; updated_at: Date }>(
    `insert into core.sentinel_switches (sentinel_id, enabled, updated_at)
     values ($1, $2, $3)
     on conflict (sentinel_id) do update
       set enabled = excluded.enabled, updated_at = excluded.updated_at
     returning sentinel_id, enabled, updated_at`,
    [sentinelId, enabled, now.toISOString()],
  );
  const row = rows[0];
  if (!row) throw new Error(`setSentinelEnabled: no row written for ${sentinelId}`);
  await appendEvent(pool, enabled ? 'sentinel.enabled' : 'sentinel.disabled', { sentinelId });
  return {
    sentinelId: row.sentinel_id,
    enabled: row.enabled !== false,
    updatedAt: row.updated_at,
  };
}
