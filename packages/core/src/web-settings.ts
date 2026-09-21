/**
 * The dashboard's own key/value settings (`core.web_settings`).
 *
 * Deliberately untyped at this layer: the table holds a JSON value per key and
 * the module that owns a key owns its shape. Two functions, no cache — these
 * are read on a request that is already talking to Postgres, and a stale
 * answer about who may sign in is not a trade worth making.
 */
import type { Queryable } from './owner.js';

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
