/**
 * The digest — where `info` findings wait.
 *
 * Nothing here decides *when* the digest is read: the weekly recap appends the
 * pending items to its prompt and consumes them once it has actually been
 * delivered. Consumption is the commit point, so a recap that failed to send
 * leaves the items pending rather than swallowing a week of observations.
 */
import type { Pool } from 'pg';
import { DIGEST_ITEM_COLUMNS, toDigestItem, type DigestItem } from './types.js';

/** Everything noted since the last consumed digest, oldest first. */
export async function pendingDigestItems(pool: Pool, limit = 50): Promise<DigestItem[]> {
  const { rows } = await pool.query(
    `select ${DIGEST_ITEM_COLUMNS} from core.digest_items
     where consumed_at is null
     order by created_at, id
     limit $1`,
    [limit],
  );
  return rows.map(toDigestItem);
}

/**
 * Mark items consumed and stamp their findings as delivered. Idempotent: an
 * item already consumed is not consumed twice.
 */
export async function consumeDigestItems(
  pool: Pool,
  ids: string[],
  at: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const { rows } = await pool.query<{ finding_key: string }>(
    `update core.digest_items
     set consumed_at = $2
     where id = any($1::uuid[]) and consumed_at is null
     returning finding_key`,
    [ids, at.toISOString()],
  );
  if (rows.length > 0) {
    await pool.query(
      `update core.sentinel_findings
       set delivered_at = $2
       where key = any($1::text[])`,
      [rows.map((r) => r.finding_key), at.toISOString()],
    );
  }
  return rows.length;
}

/** The digest as one plain-text block, or '' when there is nothing to say. */
export function renderDigest(items: DigestItem[]): string {
  if (items.length === 0) return '';
  const lines = items.map((item) => `- ${item.title}: ${item.detail}`);
  return [
    'Items noted this week by the watchers. They are deterministic readings, ' +
      'not yet verified; check each one before repeating it, and mention only ' +
      'the ones that still matter, briefly:',
    ...lines,
  ].join('\n');
}
