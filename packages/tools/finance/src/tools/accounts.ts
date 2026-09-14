import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import type { AccountKind } from '../accounts.js';
import { ACCOUNT_KINDS, defaultIncludeInCashflow, splitTotals } from '../accounts.js';
import {
  ACCOUNT_COLUMNS,
  ensureAccount,
  findAccount,
  loadPreferences,
  mapAccountRow,
  num,
  today,
  toDateString,
} from './shared.js';

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');

const KIND = z
  .enum(ACCOUNT_KINDS)
  .describe(
    "What the account is. 'cash' for a current/checking account, 'savings' for a savings, reserve or emergency pot (still spendable, so it stays in the cash flow), 'retirement' for a 401k, IRA or pension, 'investment' for a brokerage, 'hsa' for a health savings account, 'other' for anything else. retirement/investment/hsa are counted in net worth but left OUT of the cash flow, so they never make a purchase look affordable.",
  );

const INCLUDE_IN_CASHFLOW = z
  .boolean()
  .describe(
    'Whether this account is spendable money the projection and the spending baseline may use. Defaults to true, except for retirement/investment/hsa which default to false. Only set it true for one of those if the owner has actually said they spend from it.',
  );

const INSTITUTION = z
  .string()
  .min(1)
  .describe("Bank or provider holding the account, e.g. 'Fidelity' or 'PNC'.");

const NOTES = z
  .string()
  .min(1)
  .describe(
    "A short durable note about the account, e.g. 'employer matches 4%' or 'vests 2027'.",
  );

/**
 * Which `include_in_cashflow` a write should land on.
 *
 * An explicit value always wins. Otherwise the stored value is preserved —
 * except when the kind is being *changed*, where the new kind's own default
 * applies: relabelling an account as a 401k without also taking it out of the
 * cash flow would leave retirement money looking spendable.
 */
export function resolveIncludeInCashflow(args: {
  given?: boolean;
  kind?: AccountKind;
  current?: { kind: AccountKind; includeInCashflow: boolean };
}): boolean {
  if (args.given !== undefined) return args.given;
  if (!args.current) return defaultIncludeInCashflow(args.kind ?? 'cash');
  if (args.kind !== undefined && args.kind !== args.current.kind) {
    return defaultIncludeInCashflow(args.kind);
  }
  return args.current.includeInCashflow;
}

const setBalanceInput = z.object({
  account: z
    .string()
    .min(1)
    .describe("Account name, e.g. 'Checking'. Created if it does not exist yet."),
  balance: z.number().describe('Current balance of the account, in the reporting currency.'),
  asOf: DATE.optional().describe(
    'Date the balance was observed (YYYY-MM-DD). Defaults to today.',
  ),
  kind: KIND.optional(),
  includeInCashflow: INCLUDE_IN_CASHFLOW.optional(),
  institution: INSTITUTION.optional(),
  notes: NOTES.optional(),
});

export const setBalance: ToolDefinition<z.infer<typeof setBalanceInput>, unknown> = {
  name: 'finance.set_balance',
  description:
    "Record the current balance of an account as of a date. Creates the account if it does not exist. This is the starting point every cashflow projection builds on, so keep it fresh. Pass `kind` when the account is not a plain current account — a 401k, IRA or pension is 'retirement', a brokerage is 'investment', an HSA is 'hsa': those are counted in net worth but excluded from the cash flow, so their balance can never make a purchase look affordable. `institution` and `notes` are optional and, like `kind`, are preserved when a later call omits them.",
  tier: 'auto',
  input: setBalanceInput,
  async execute(input, ctx) {
    const asOf = input.asOf ?? today(ctx);
    const existing = await findAccount(ctx.db, input.account);
    const account =
      existing ??
      (await ensureAccount(ctx.db, input.account, {
        kind: input.kind,
        includeInCashflow: input.includeInCashflow,
      }));
    const kind = input.kind ?? account.kind;
    const includeInCashflow = resolveIncludeInCashflow({
      given: input.includeInCashflow,
      kind: input.kind,
      current: existing ? { kind: existing.kind, includeInCashflow: existing.includeInCashflow } : undefined,
    });
    const { rows } = await ctx.db.query(
      `update finance.accounts
          set balance = $2,
              balance_as_of = $3,
              kind = $4,
              include_in_cashflow = $5,
              institution = coalesce($6, institution),
              notes = coalesce($7, notes)
        where id = $1
       returning ${ACCOUNT_COLUMNS}`,
      [
        account.id,
        input.balance,
        asOf,
        kind,
        includeInCashflow,
        input.institution ?? null,
        input.notes ?? null,
      ],
    );
    const row = mapAccountRow(rows[0]);
    return {
      id: row.id,
      name: row.name,
      balance: row.balance,
      balanceAsOf: row.balanceAsOf,
      kind: row.kind,
      includeInCashflow: row.includeInCashflow,
      institution: row.institution,
      notes: row.notes,
    };
  },
};

const updateAccountInput = z.object({
  account: z.string().min(1).describe('Name of the account to change. Must already exist.'),
  kind: KIND.optional(),
  includeInCashflow: INCLUDE_IN_CASHFLOW.optional(),
  institution: INSTITUTION.optional(),
  notes: NOTES.optional(),
  rename: z
    .string()
    .min(1)
    .optional()
    .describe('New name for the account. Its balance, transactions and recurring items follow it.'),
});

export const updateAccount: ToolDefinition<z.infer<typeof updateAccountInput>, unknown> = {
  name: 'finance.update_account',
  description:
    "Change what an account IS without touching its balance: its kind, whether it counts as spendable cash, the institution holding it, a note, or its name. Use this to reclassify an account the owner already has — 'that PNC Growth one is actually my brokerage' — or to record an employer match as a note. Everything omitted is left as it was; use finance.set_balance to change the balance.",
  tier: 'auto',
  input: updateAccountInput,
  async execute(input, ctx) {
    const account = await findAccount(ctx.db, input.account);
    if (!account) throw new Error(`unknown account: ${input.account}`);
    const includeInCashflow = resolveIncludeInCashflow({
      given: input.includeInCashflow,
      kind: input.kind,
      current: { kind: account.kind, includeInCashflow: account.includeInCashflow },
    });
    const { rows } = await ctx.db.query(
      `update finance.accounts
          set name = coalesce($2, name),
              kind = $3,
              include_in_cashflow = $4,
              institution = coalesce($5, institution),
              notes = coalesce($6, notes)
        where id = $1
       returning ${ACCOUNT_COLUMNS}`,
      [
        account.id,
        input.rename ?? null,
        input.kind ?? account.kind,
        includeInCashflow,
        input.institution ?? null,
        input.notes ?? null,
      ],
    );
    const row = mapAccountRow(rows[0]);
    return {
      id: row.id,
      name: row.name,
      previousName: account.name,
      renamed: row.name !== account.name,
      balance: row.balance,
      balanceAsOf: row.balanceAsOf,
      kind: row.kind,
      includeInCashflow: row.includeInCashflow,
      institution: row.institution,
      notes: row.notes,
    };
  },
};

const listAccountsInput = z.object({});

export const listAccounts: ToolDefinition<z.infer<typeof listAccountsInput>, unknown> = {
  name: 'finance.list_accounts',
  description:
    "List every known account with its last recorded balance, the date that balance was recorded, its `kind` and whether it is spendable (`includeInCashflow`). Totals are split on purpose: `cashTotal` is the money that can actually be spent (every account with includeInCashflow), `excludedTotal` is retirement/investment/HSA money — real, counted, but never available for a purchase — broken down per kind in `excludedByKind`, and `netWorth` is cashTotal + excludedTotal minus the recorded debts (finance.list_liabilities). `total` is kept as an alias of `cashTotal` for older callers and is NOT the whole balance sheet. Never quote excluded money as though it were cash, and never answer an affordability question from it.",
  tier: 'auto',
  input: listAccountsInput,
  async execute(_input, ctx) {
    const { rows } = await ctx.db.query(
      `select ${ACCOUNT_COLUMNS} from finance.accounts order by name`,
    );
    const prefs = await loadPreferences(ctx.db);
    const accounts = rows.map(mapAccountRow).map((r) => ({
      id: r.id,
      name: r.name,
      balance: r.balance,
      balanceAsOf: r.balanceAsOf,
      kind: r.kind,
      includeInCashflow: r.includeInCashflow,
      institution: r.institution,
      notes: r.notes,
    }));
    // Debts live in their own table and are never folded into a balance; net
    // worth is reported alongside the split so the three are never confused.
    const { rows: debtRows } = await ctx.db.query(
      `select coalesce(sum(balance), 0) as total, count(*)::int as n
         from finance.liabilities where active`,
    );
    const totalLiabilities = num(debtRows[0]?.total);
    const split = splitTotals(accounts, totalLiabilities);
    return {
      accounts,
      cashTotal: split.cashTotal,
      /** @deprecated Alias of `cashTotal`: spendable cash only, never the balance sheet. */
      total: split.cashTotal,
      excludedTotal: split.excludedTotal,
      excludedByKind: split.excludedByKind,
      currency: prefs.currency,
      totalLiabilities,
      liabilityCount: debtRows[0]?.n ?? 0,
      netWorth: split.netWorth,
    };
  },
};
