/** Shared DB helpers for the finance tools. */
import { createHash } from 'node:crypto';
import { localDateString, type ToolContext } from '@buddi/core';
import type { Pool } from 'pg';
import { defaultIncludeInCashflow } from '../accounts.js';
import type { AccountKind } from '../accounts.js';

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

/**
 * Today in the *owner's* timezone, from the injected clock — tools never read
 * the wall clock, and never render a day in UTC: from 8 PM in New York UTC is
 * already tomorrow, and a default date one day out is a wrong ledger row.
 */
export function today(ctx: Pick<ToolContext, 'now' | 'timezone'>): string {
  return localDateString(ctx.now(), ctx.timezone);
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
  kind: AccountKind;
  /** False for money that counts toward net worth but can never be spent. */
  includeInCashflow: boolean;
  institution: string | null;
  notes: string | null;
}

/** Every column the tools read back, in one place so the shapes cannot drift. */
export const ACCOUNT_COLUMNS =
  'id, name, balance, balance_as_of, kind, include_in_cashflow, institution, notes';

export function mapAccountRow(row: Record<string, unknown>): AccountRow {
  return {
    id: row.id as string,
    name: row.name as string,
    balance: num(row.balance),
    balanceAsOf: toDateString(row.balance_as_of),
    kind: (row.kind as AccountKind) ?? 'cash',
    includeInCashflow: row.include_in_cashflow !== false,
    institution: (row.institution as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
  };
}

export async function findAccount(db: Pool, name: string): Promise<AccountRow | undefined> {
  const { rows } = await db.query(
    `select ${ACCOUNT_COLUMNS} from finance.accounts where lower(name) = lower($1)`,
    [name],
  );
  const row = rows[0];
  if (!row) return undefined;
  return mapAccountRow(row);
}

/** Accounts are created on first mention; naming one is not a write worth a prompt. */
export async function ensureAccount(
  db: Pool,
  name: string,
  /** Applied only when the account is actually created; an existing one is left alone. */
  onCreate: { kind?: AccountKind; includeInCashflow?: boolean } = {},
): Promise<AccountRow> {
  const existing = await findAccount(db, name);
  if (existing) return existing;
  const kind: AccountKind = onCreate.kind ?? 'cash';
  const includeInCashflow = onCreate.includeInCashflow ?? defaultIncludeInCashflow(kind);
  const { rows } = await db.query(
    `insert into finance.accounts (name, kind, include_in_cashflow) values ($1, $2, $3)
     on conflict (name) do update set name = excluded.name
     returning ${ACCOUNT_COLUMNS}`,
    [name, kind, includeInCashflow],
  );
  return mapAccountRow(rows[0]);
}

export interface LiabilityRow {
  id: string;
  name: string;
  kind: 'credit_card' | 'loan' | 'other';
  /** What is owed, positive. A stated figure the owner confirms, never a running sum. */
  balance: number;
  creditLimit: number | null;
  minimumPayment: number;
  dueDay: number;
  statementDay: number | null;
  apr: number | null;
  paidFromAccountId: string | null;
  active: boolean;
}

export const LIABILITY_COLUMNS =
  'id, name, kind, balance, credit_limit, minimum_payment, due_day, statement_day, apr, paid_from_account_id, active';

export function mapLiabilityRow(row: Record<string, unknown>): LiabilityRow {
  return {
    id: row.id as string,
    name: row.name as string,
    kind: row.kind as LiabilityRow['kind'],
    balance: num(row.balance),
    creditLimit: row.credit_limit === null || row.credit_limit === undefined
      ? null
      : num(row.credit_limit),
    minimumPayment: num(row.minimum_payment),
    dueDay: Number(row.due_day),
    statementDay:
      row.statement_day === null || row.statement_day === undefined
        ? null
        : Number(row.statement_day),
    apr: row.apr === null || row.apr === undefined ? null : num(row.apr),
    paidFromAccountId: (row.paid_from_account_id as string | null) ?? null,
    active: row.active !== false,
  };
}

/**
 * A liability by name, case-insensitively, active ones first.
 *
 * Unlike an account, a liability is NEVER created on first mention: a debt
 * without its balance, minimum and due day is not a record, it is a guess, and
 * those three have to come from the owner.
 */
export async function findLiability(db: Pool, name: string): Promise<LiabilityRow | undefined> {
  const { rows } = await db.query(
    `select ${LIABILITY_COLUMNS} from finance.liabilities
      where lower(name) = lower($1)
      order by active desc, created_at
      limit 1`,
    [name],
  );
  const row = rows[0];
  return row ? mapLiabilityRow(row) : undefined;
}

/**
 * Which ledger a row belongs to: a cash account, or a liability.
 *
 * Exactly one of the two, enforced in the schema as well. A card purchase does
 * not move cash on the day it is made, so it belongs on the card; the cash
 * moves later, once, when the card is paid.
 */
export interface Ledger {
  kind: 'account' | 'liability';
  /** The account or liability id — whichever this ledger is. */
  id: string;
  name: string;
  accountId: string | null;
  liabilityId: string | null;
}

export async function resolveLedger(
  db: Pool,
  input: { account?: string | undefined; liability?: string | undefined },
  opts: { createAccount?: boolean; accountKind?: AccountKind } = {},
): Promise<Ledger> {
  if (input.account && input.liability) {
    throw new Error(
      'pass either account or liability, never both: a row lives on one ledger',
    );
  }
  if (input.liability) {
    const liability = await findLiability(db, input.liability);
    if (!liability) {
      throw new Error(
        `unknown liability: ${input.liability} — record it first with finance.set_liability (balance, minimum payment, due day)`,
      );
    }
    return {
      kind: 'liability',
      id: liability.id,
      name: liability.name,
      accountId: null,
      liabilityId: liability.id,
    };
  }
  if (!input.account) {
    throw new Error('provide an account (cash) or a liability (card, loan)');
  }
  const account =
    opts.createAccount === false
      ? await findAccount(db, input.account)
      : await ensureAccount(
          db,
          input.account,
          opts.accountKind ? { kind: opts.accountKind } : {},
        );
  if (!account) throw new Error(`unknown account: ${input.account}`);
  return {
    kind: 'account',
    id: account.id,
    name: account.name,
    accountId: account.id,
    liabilityId: null,
  };
}

/**
 * Stable identity for a transaction.
 *
 * Ledger/date/amount/text alone is not enough: real bank exports contain
 * genuinely distinct rows that are identical on all four (three transfers of
 * the same amount on the same day, two identical subscription charges). The
 * `occurrence` index — 0 for the first such row, 1 for the second, … in file
 * order — keeps those apart while re-importing the same file still collapses
 * onto the same hashes, so it stays a no-op.
 */
export function dedupHash(
  /** The ledger's name — a cash account's, or a liability's. */
  ledger: string,
  date: string,
  amount: number,
  description: string,
  occurrence = 0,
): string {
  return createHash('sha256')
    .update(
      `${ledger.trim().toLowerCase()}|${date}|${amount.toFixed(2)}|${description.trim()}|${occurrence}`,
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
