import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import { ensureAccount, loadPreferences, num, today, toDateString } from './shared.js';

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');

const setBalanceInput = z.object({
  account: z
    .string()
    .min(1)
    .describe("Account name, e.g. 'Checking'. Created if it does not exist yet."),
  balance: z.number().describe('Current balance of the account, in the reporting currency.'),
  asOf: DATE.optional().describe(
    'Date the balance was observed (YYYY-MM-DD). Defaults to today.',
  ),
});

export const setBalance: ToolDefinition<z.infer<typeof setBalanceInput>, unknown> = {
  name: 'finance.set_balance',
  description:
    'Record the current balance of an account as of a date. Creates the account if it does not exist. This is the starting point every cashflow projection builds on, so keep it fresh.',
  tier: 'auto',
  input: setBalanceInput,
  async execute(input, ctx) {
    const asOf = input.asOf ?? today(ctx.now);
    const account = await ensureAccount(ctx.db, input.account);
    const { rows } = await ctx.db.query(
      `update finance.accounts set balance = $2, balance_as_of = $3
       where id = $1
       returning id, name, balance, balance_as_of`,
      [account.id, input.balance, asOf],
    );
    const row = rows[0];
    return {
      id: row.id,
      name: row.name,
      balance: num(row.balance),
      balanceAsOf: toDateString(row.balance_as_of),
    };
  },
};

const listAccountsInput = z.object({});

export const listAccounts: ToolDefinition<z.infer<typeof listAccountsInput>, unknown> = {
  name: 'finance.list_accounts',
  description:
    'List every known account with its last recorded balance and the date that balance was recorded, plus the total cash across accounts. `netWorth` is that cash total minus the recorded debts (finance.list_liabilities) — the account total itself is always pure cash and never nets debt out.',
  tier: 'auto',
  input: listAccountsInput,
  async execute(_input, ctx) {
    const { rows } = await ctx.db.query(
      `select id, name, balance, balance_as_of from finance.accounts order by name`,
    );
    const prefs = await loadPreferences(ctx.db);
    const accounts = rows.map((r) => ({
      id: r.id,
      name: r.name,
      balance: num(r.balance),
      balanceAsOf: toDateString(r.balance_as_of),
    }));
    const total = Math.round(accounts.reduce((s, a) => s + a.balance, 0) * 100) / 100;
    // Debts live in their own table and are never folded into `total`; net
    // worth is reported alongside it so the two are never confused.
    const { rows: debtRows } = await ctx.db.query(
      `select coalesce(sum(balance), 0) as total, count(*)::int as n
         from finance.liabilities where active`,
    );
    const totalLiabilities = num(debtRows[0]?.total);
    return {
      accounts,
      total,
      currency: prefs.currency,
      totalLiabilities,
      liabilityCount: debtRows[0]?.n ?? 0,
      netWorth: Math.round((total - totalLiabilities) * 100) / 100,
    };
  },
};
