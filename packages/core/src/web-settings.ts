/**
 * The dashboard's own key/value settings (`core.web_settings`).
 *
 * Deliberately untyped at this layer: the table holds a JSON value per key and
 * the module that owns a key owns its shape. Two functions, no cache — these
 * are read on a request that is already talking to Postgres, and a stale
 * answer about who may sign in is not a trade worth making.
 */
import type { Queryable } from './owner.js';

/**
 * The prefix of the canvas's per-conversation tab state (`canvas-tabs:<id>`,
 * owned by the gateway's web/canvas-tabs.ts). Named here so that deleting a
 * conversation, which happens in core, can take its key with it.
 */
export const CANVAS_TABS_PREFIX = 'canvas-tabs:';

/** Drop the settings that belonged to these conversations, now gone. */
export async function forgetConversationSettings(db: Queryable, conversationIds: readonly string[]): Promise<void> {
  if (conversationIds.length === 0) return;
  await db.query('delete from core.web_settings where key = any($1::text[])', [
    conversationIds.map((id) => `${CANVAS_TABS_PREFIX}${id}`),
  ]);
}

/** The value stored under `key`, or null when nothing is stored. */
export async function readWebSetting<T = unknown>(db: Queryable, key: string): Promise<T | null> {
  const { rows } = await db.query('select value from core.web_settings where key = $1', [key]);
  return (rows[0]?.value as T | undefined) ?? null;
}

/** Replace the value under `key`. The whole value, never a merge. */
export async function writeWebSetting(db: Queryable, key: string, value: unknown): Promise<void> {
  await db.query(
    `insert into core.web_settings (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

/** A pool that hands out a client for a transaction. */
export interface ConnectableQueryable extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

/**
 * Read, change and write the value under `key` as one step: the row is
 * created if missing and locked (`for update`) for the transaction, so two
 * writers changing different parts of one value cannot lose each other's
 * change. `change` gets the stored value (null when none) and returns the new one.
 */
export async function updateWebSetting<T = unknown>(
  pool: ConnectableQueryable,
  key: string,
  change: (current: T | null) => unknown,
): Promise<unknown> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into core.web_settings (key, value, updated_at) values ($1, 'null'::jsonb, now())
       on conflict (key) do nothing`,
      [key],
    );
    const { rows } = await client.query('select value from core.web_settings where key = $1 for update', [key]);
    const next = change((rows[0]?.value as T | undefined) ?? null);
    await client.query('update core.web_settings set value = $2::jsonb, updated_at = now() where key = $1', [key, JSON.stringify(next)]);
    await client.query('commit');
    return next;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
