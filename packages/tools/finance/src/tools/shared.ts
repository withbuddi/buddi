/** Shared DB helpers for the finance tools. */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export const DEFAULT_CURRENCY = 'EUR';
export const DEFAULT_SAFETY_FLOOR = 0;

export interface Preferences {
  currency: string;
  safetyFloor: number;
}

/** pg returns numeric(14,2) as a string; money stays a number in TS. */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** `Date` (or a date-ish pg value) → `YYYY-MM-DD`, UTC-safe. */
export function toDateString(value: unknown): string {
  if (value instanceof Date) {
    return new Date(
      Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()),
    )
      .toISOString()
      .slice(0, 10);
  }
  return String(value).slice(0, 10);
}

/** Today in UTC, from the injected clock — tools never read the wall clock. */
export function today(now: () => Date): string {
  return now().toISOString().slice(0, 10);
}

export async function loadPreferences(db: Pool): Promise<Preferences> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `select key, value from finance.preferences where key in ('currency', 'safety_floor')`,
  );
  const prefs: Preferences = {
    currency: DEFAULT_CURRENCY,
    safetyFloor: DEFAULT_SAFETY_FLOOR,
  };
  for (const row of rows) {
    if (row.key === 'currency' && typeof row.value === 'string') prefs.currency = row.value;
    if (row.key === 'safety_floor') prefs.safetyFloor = num(row.value);
  }
  return prefs;
}

export interface AccountRow {
  id: string;
  name: string;
  balance: number;
  balanceAsOf: string;
}

export async function findAccount(db: Pool, name: string): Promise<AccountRow | undefined> {
  const { rows } = await db.query(
    `select id, name, balance, balance_as_of from finance.accounts where lower(name) = lower($1)`,
    [name],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    balance: num(row.balance),
    balanceAsOf: toDateString(row.balance_as_of),
  };
}

/** Accounts are created on first mention; naming one is not a write worth a prompt. */
export async function ensureAccount(db: Pool, name: string): Promise<AccountRow> {
  const existing = await findAccount(db, name);
  if (existing) return existing;
  const { rows } = await db.query(
    `insert into finance.accounts (name) values ($1)
     on conflict (name) do update set name = excluded.name
     returning id, name, balance, balance_as_of`,
    [name],
  );
  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    balance: num(row.balance),
    balanceAsOf: toDateString(row.balance_as_of),
  };
}

/**
 * Stable identity for a transaction.
 *
 * Account/date/amount/text alone is not enough: real bank exports contain
 * genuinely distinct rows that are identical on all four (three transfers of
 * the same amount on the same day, two identical subscription charges). The
 * `occurrence` index — 0 for the first such row, 1 for the second, … in file
 * order — keeps those apart while re-importing the same file still collapses
 * onto the same hashes, so it stays a no-op.
 */
export function dedupHash(
  account: string,
  date: string,
  amount: number,
  description: string,
  occurrence = 0,
): string {
  return createHash('sha256')
    .update(
      `${account.trim().toLowerCase()}|${date}|${amount.toFixed(2)}|${description.trim()}|${occurrence}`,
    )
    .digest('hex');
}

export interface OccurrenceKey {
  date: string;
  amount: number;
  description: string;
}

/**
 * Number identical (date, amount, description) rows by their position in file
 * order: `[0]` for a unique row, `[0, 1, 2]` for three identical ones. Pure, so
 * the same file always yields the same indexes.
 */
export function occurrenceIndexes(rows: readonly OccurrenceKey[]): number[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = `${row.date}|${row.amount.toFixed(2)}|${row.description.trim()}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n;
  });
}
