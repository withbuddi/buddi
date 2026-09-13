import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import { payoff } from '../amortization.js';
import { findAccount, loadPreferences, num, today, toDateString } from './shared.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');

const KIND = z.enum(['credit_card', 'loan', 'other']);

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function mapRow(r: Record<string, unknown>): Record<string, unknown> {
  const balance = num(r.balance);
  const creditLimit = r.credit_limit === null ? null : num(r.credit_limit);
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    balance,
    creditLimit,
    minimumPayment: num(r.minimum_payment),
    dueDay: r.due_day,
    apr: r.apr === null || r.apr === undefined ? null : num(r.apr),
    paidFrom: (r.account_name as string | null) ?? null,
    asOf: toDateString(r.as_of),
    active: r.active,
    utilization:
      r.kind === 'credit_card' && creditLimit !== null && creditLimit > 0
        ? round2((balance / creditLimit) * 100)
        : null,
    statementDay: (r.statement_day as number | null) ?? null,
    reportedBalance:
      r.reported_balance === null || r.reported_balance === undefined
        ? null
        : num(r.reported_balance),
    reportedOn: r.reported_on === null || r.reported_on === undefined
      ? null
      : toDateString(r.reported_on),
  };
}

const setInput = z.object({
  name: z
    .string()
    .min(1)
    .describe("Name of the debt, e.g. 'NFCU Mastercard'. Matched case-insensitively; an existing liability with this name is updated."),
  kind: KIND.describe("'credit_card', 'loan' or 'other'."),
  balance: z.number().min(0).describe('Amount currently owed, as a positive number.'),
  minimumPayment: z.number().min(0).describe('Minimum payment due each month.'),
  dueDay: z.number().int().min(1).max(31).describe('Day of the month the payment is due.'),
  creditLimit: z
    .number()
    .positive()
    .optional()
    .describe('Credit limit, for cards — enables the utilization figure.'),
  apr: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('Annual interest rate in percent, e.g. 24.99. Needed for payoff estimates.'),
  paidFrom: z
    .string()
    .min(1)
    .optional()
    .describe('Name of the account the payment comes out of. Must already exist.'),
  asOf: DATE.optional().describe('Date the balance was observed. Defaults to today.'),
  statementDay: z
    .number()
    .int()
    .min(1)
    .max(31)
    .optional()
    .describe(
      'Day of the month the statement closes — the day the issuer snapshots the balance it reports to the bureaus. Not the due day.',
    ),
  reportedBalance: z
    .number()
    .min(0)
    .optional()
    .describe('Balance the issuer last reported at statement close, when it is known.'),
  reportedOn: DATE.optional().describe('Date that reported balance was snapshotted.'),
});

export const setLiability: ToolDefinition<z.infer<typeof setInput>, unknown> = {
  name: 'finance.set_liability',
  description:
    'Record or update a debt — a credit card, a loan — with what is owed, the minimum payment and the due day. Debts are tracked separately from cash: they are never added to account balances and never change a projection. The monthly payment itself belongs in finance.add_recurring; if it is already a recurring item, do not add it again. For a card, statementDay (the closing day, not the due day) is what makes utilization advice possible.',
  tier: 'auto',
  input: setInput,
  async execute(input, ctx) {
    let paidFromId: string | null = null;
    if (input.paidFrom) {
      const account = await findAccount(ctx.db, input.paidFrom);
      if (!account) throw new Error(`unknown account: ${input.paidFrom}`);
      paidFromId = account.id;
    }
    const asOf = input.asOf ?? today(ctx.now);

    // Upsert by name, case-insensitively: 'test mastercard' is the same debt as
    // 'Test Mastercard', and the model will not always spell it the same way.
    const { rows: existing } = await ctx.db.query(
      `select id from finance.liabilities where lower(name) = lower($1)`,
      [input.name],
    );
    const current = existing[0];
    if (current) {
      const { rows: updated } = await ctx.db.query(
        `update finance.liabilities set
           kind = $2,
           balance = $3,
           credit_limit = coalesce($4, credit_limit),
           minimum_payment = $5,
           due_day = $6,
           apr = coalesce($7, apr),
           paid_from_account_id = coalesce($8, paid_from_account_id),
           as_of = $9,
           statement_day = coalesce($10, statement_day),
           reported_balance = coalesce($11, reported_balance),
           reported_on = coalesce($12, reported_on),
           active = true
         where id = $1
         returning id, name, kind, balance, credit_limit, minimum_payment, due_day, apr,
                   paid_from_account_id, as_of, active, statement_day, reported_balance, reported_on`,
        [
          current.id,
          input.kind,
          input.balance,
          input.creditLimit ?? null,
          input.minimumPayment,
          input.dueDay,
          input.apr ?? null,
          paidFromId,
          asOf,
          input.statementDay ?? null,
          input.reportedBalance ?? null,
          input.reportedOn ?? null,
        ],
      );
      const row = updated[0];
      const { rows: acct } = await ctx.db.query(
        `select name from finance.accounts where id = $1`,
        [row.paid_from_account_id],
      );
      return mapRow({ ...row, account_name: acct[0]?.name ?? null });
    }

    const { rows } = await ctx.db.query(
      `insert into finance.liabilities
         (name, kind, balance, credit_limit, minimum_payment, due_day, apr, paid_from_account_id,
          as_of, statement_day, reported_balance, reported_on, active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
       on conflict (name) do update set
         kind = excluded.kind,
         balance = excluded.balance,
         credit_limit = coalesce(excluded.credit_limit, finance.liabilities.credit_limit),
         minimum_payment = excluded.minimum_payment,
         due_day = excluded.due_day,
         apr = coalesce(excluded.apr, finance.liabilities.apr),
         paid_from_account_id = coalesce(excluded.paid_from_account_id, finance.liabilities.paid_from_account_id),
         as_of = excluded.as_of,
         statement_day = coalesce(excluded.statement_day, finance.liabilities.statement_day),
         reported_balance = coalesce(excluded.reported_balance, finance.liabilities.reported_balance),
         reported_on = coalesce(excluded.reported_on, finance.liabilities.reported_on),
         active = true
       returning id, name, kind, balance, credit_limit, minimum_payment, due_day, apr,
                 paid_from_account_id, as_of, active, statement_day, reported_balance, reported_on`,
      [
        input.name,
        input.kind,
        input.balance,
        input.creditLimit ?? null,
        input.minimumPayment,
        input.dueDay,
        input.apr ?? null,
        paidFromId,
        asOf,
        input.statementDay ?? null,
        input.reportedBalance ?? null,
        input.reportedOn ?? null,
      ],
    );
    const row = rows[0];
    const { rows: acct } = await ctx.db.query(
      `select name from finance.accounts where id = $1`,
      [row.paid_from_account_id],
    );
    return mapRow({ ...row, account_name: acct[0]?.name ?? null });
  },
};

const listInput = z.object({
  activeOnly: z
    .boolean()
    .optional()
    .describe('Default true. Set false to also show debts that were removed.'),
});

export const listLiabilities: ToolDefinition<z.infer<typeof listInput>, unknown> = {
  name: 'finance.list_liabilities',
  description:
    'List the recorded debts with what is owed, the minimum payment, the due day, the APR and — for credit cards with a limit — utilization, plus the total debt. Cash and debt are kept apart: this total is never subtracted from an account balance or a projection.',
  tier: 'auto',
  input: listInput,
  async execute(input, ctx) {
    const activeOnly = input.activeOnly ?? true;
    const prefs = await loadPreferences(ctx.db);
    const { rows } = await ctx.db.query(
      `select l.id, l.name, l.kind, l.balance, l.credit_limit, l.minimum_payment, l.due_day,
              l.apr, l.paid_from_account_id, l.as_of, l.active, l.statement_day,
              l.reported_balance, l.reported_on, a.name as account_name
         from finance.liabilities l
         left join finance.accounts a on a.id = l.paid_from_account_id
        where ($1::boolean is false or l.active)
        order by l.balance desc`,
      [activeOnly],
    );
    const liabilities = rows.map(mapRow);
    const active = liabilities.filter((l) => l.active);
    const totalDebt = round2(active.reduce((s, l) => s + (l.balance as number), 0));
    const totalMinimums = round2(
      active.reduce((s, l) => s + (l.minimumPayment as number), 0),
    );
    const cards = active.filter((l) => l.kind === 'credit_card' && l.creditLimit !== null);
    const limit = round2(cards.reduce((s, l) => s + (l.creditLimit as number), 0));
    const cardBalance = round2(cards.reduce((s, l) => s + (l.balance as number), 0));
    return {
      liabilities,
      count: liabilities.length,
      totalDebt,
      totalMinimumPayments: totalMinimums,
      creditUtilization: limit > 0 ? round2((cardBalance / limit) * 100) : null,
      currency: prefs.currency,
    };
  },
};

const removeInput = z.object({
  name: z.string().min(1).describe('Exact liability name (case-insensitive).'),
});

export const removeLiability: ToolDefinition<z.infer<typeof removeInput>, unknown> = {
  name: 'finance.remove_liability',
  description:
    'Stop tracking a debt — it is deactivated, not deleted, so the record stays. Use it when a card or loan is paid off or no longer the owner\'s.',
  tier: 'auto',
  input: removeInput,
  async execute(input, ctx) {
    const { rows } = await ctx.db.query(
      `update finance.liabilities set active = false
        where lower(name) = lower($1) and active
        returning id, name, kind, balance, credit_limit, minimum_payment, due_day, apr,
                  paid_from_account_id, as_of, active, statement_day, reported_balance, reported_on`,
      [input.name],
    );
    if (rows.length === 0) return { removed: 0, message: 'no active liability matched' };
    return { removed: rows.length, liabilities: rows.map((r) => mapRow(r)) };
  },
};

const payoffInput = z.object({
  name: z.string().min(1).describe('Liability name, from finance.list_liabilities.'),
  monthlyPayment: z
    .number()
    .positive()
    .describe('What would be paid each month toward this debt.'),
});

export const payoffEstimate: ToolDefinition<z.infer<typeof payoffInput>, unknown> = {
  name: 'finance.payoff_estimate',
  description:
    'Work out how many months a debt takes to clear at a given monthly payment, and how much interest that costs, using the stored APR. Says so plainly when the payment does not even cover the monthly interest. This is the only source of truth for payoff arithmetic — never estimate it yourself.',
  tier: 'auto',
  input: payoffInput,
  async execute(input, ctx) {
    const prefs = await loadPreferences(ctx.db);
    const { rows } = await ctx.db.query(
      `select name, kind, balance, apr, minimum_payment from finance.liabilities
        where lower(name) = lower($1) and active`,
      [input.name],
    );
    const row = rows[0];
    if (!row) {
      return {
        status: 'unknown-liability',
        message: `no active liability named '${input.name}'; list them with finance.list_liabilities`,
      };
    }
    if (row.apr === null || row.apr === undefined) {
      return {
        status: 'missing-apr',
        name: row.name,
        balance: num(row.balance),
        currency: prefs.currency,
        message: `no APR is recorded for '${row.name}', and the payoff cannot be computed without it. Ask the owner for the annual rate and store it with finance.set_liability.`,
      };
    }

    const apr = num(row.apr);
    const result = payoff(num(row.balance), apr, input.monthlyPayment);
    return {
      status: result.paysOff ? 'ok' : 'never-pays-off',
      name: row.name,
      kind: row.kind,
      balance: num(row.balance),
      apr,
      monthlyPayment: input.monthlyPayment,
      minimumPayment: num(row.minimum_payment),
      currency: prefs.currency,
      months: result.months,
      years: result.months === null ? null : round2(result.months / 12),
      totalInterest: result.totalInterest,
      totalPaid: result.totalPaid,
      finalPayment: result.finalPayment,
      firstMonthInterest: result.firstMonthInterest,
      message: result.message ?? null,
    };
  },
};
