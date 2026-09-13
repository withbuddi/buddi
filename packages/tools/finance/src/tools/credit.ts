/**
 * Credit tools: the score over time, what the cards report at statement close,
 * and whether the minimums landed. Reads and pure computation only — tier auto.
 */
import type { ToolDefinition } from '@buddi/core';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  creditPlan,
  round2,
  upcomingStatements,
  utilizationReport,
  type CreditCard,
} from '../credit.js';
import { loadPreferences, num, today, toDateString } from './shared.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');

/** Active credit cards, shaped for the pure helpers. */
async function loadCards(db: Pool): Promise<CreditCard[]> {
  const { rows } = await db.query(
    `select name, balance, credit_limit, apr, minimum_payment, statement_day,
            reported_balance, reported_on, due_day
       from finance.liabilities
      where active and kind = 'credit_card'`,
  );
  return rows.map((r) => ({
    name: r.name as string,
    balance: num(r.balance),
    creditLimit: r.credit_limit === null || r.credit_limit === undefined ? null : num(r.credit_limit),
    apr: r.apr === null || r.apr === undefined ? null : num(r.apr),
    minimumPayment: num(r.minimum_payment),
    statementDay: (r.statement_day as number | null) ?? null,
  }));
}

/* ------------------------------------------------------------------ scores */

const recordScoreInput = z.object({
  source: z
    .string()
    .min(1)
    .describe("Where the score came from — a bureau ('Experian') or an app ('Credit Karma')."),
  score: z.number().int().min(250).max(900).describe('The score itself.'),
  model: z
    .string()
    .min(1)
    .optional()
    .describe("Scoring model, when known: 'FICO 8', 'VantageScore 3'. Scores from different models are not comparable."),
  observedOn: DATE.optional().describe('Date the score was seen. Defaults to today.'),
  note: z.string().min(1).optional().describe('Anything that explains a move.'),
});

export const recordCreditScore: ToolDefinition<z.infer<typeof recordScoreInput>, unknown> = {
  name: 'finance.record_credit_score',
  description:
    'Store a credit score the owner reports, with its source, scoring model and the date it was observed. Scores are kept as a history, never overwritten, so the trend stays readable.',
  tier: 'auto',
  input: recordScoreInput,
  async execute(input, ctx) {
    const observedOn = input.observedOn ?? today(ctx.now);
    const { rows } = await ctx.db.query(
      `insert into finance.credit_scores (bureau_or_source, score, model, observed_on, note)
       values ($1, $2, $3, $4, $5)
       returning id, bureau_or_source, score, model, observed_on, note`,
      [input.source, input.score, input.model ?? null, observedOn, input.note ?? null],
    );
    const row = rows[0];
    const { rows: prev } = await ctx.db.query(
      `select score, observed_on from finance.credit_scores
        where lower(bureau_or_source) = lower($1) and id <> $2
        order by observed_on desc, created_at desc limit 1`,
      [input.source, row.id],
    );
    const previous = prev[0];
    return {
      id: row.id,
      source: row.bureau_or_source,
      score: row.score,
      model: row.model,
      observedOn: toDateString(row.observed_on),
      note: row.note,
      previousScore: previous ? previous.score : null,
      previousObservedOn: previous ? toDateString(previous.observed_on) : null,
      delta: previous ? (row.score as number) - (previous.score as number) : null,
    };
  },
};

const historyInput = z.object({
  limit: z.number().int().min(1).max(100).optional().describe('How many entries. Default 12.'),
});

export const creditScoreHistory: ToolDefinition<z.infer<typeof historyInput>, unknown> = {
  name: 'finance.credit_score_history',
  description:
    'The recorded credit scores, newest first, each with the change against the previous score from the same source. Says plainly when nothing has been recorded yet. This is the only source of truth for the score trend — never estimate a score.',
  tier: 'auto',
  input: historyInput,
  async execute(input, ctx) {
    const limit = input.limit ?? 12;
    const { rows } = await ctx.db.query(
      `select id, bureau_or_source, score, model, observed_on, note
         from finance.credit_scores
        order by observed_on desc, created_at desc
        limit $1`,
      [limit],
    );
    // Delta against the previous entry from the same source, in date order.
    const bySource = new Map<string, { score: number; observedOn: string }[]>();
    const ordered = [...rows].reverse();
    const deltas = new Map<string, number | null>();
    for (const r of ordered) {
      const key = String(r.bureau_or_source).toLowerCase();
      const seen = bySource.get(key) ?? [];
      const last = seen[seen.length - 1];
      deltas.set(String(r.id), last ? (r.score as number) - last.score : null);
      seen.push({ score: r.score as number, observedOn: toDateString(r.observed_on) });
      bySource.set(key, seen);
    }
    const scores = rows.map((r) => ({
      id: r.id,
      source: r.bureau_or_source,
      score: r.score,
      model: r.model,
      observedOn: toDateString(r.observed_on),
      note: r.note,
      delta: deltas.get(String(r.id)) ?? null,
    }));
    return {
      scores,
      count: scores.length,
      latest: scores[0] ?? null,
      message:
        scores.length === 0
          ? 'no credit score has been recorded yet; ask the owner for their latest score and its source'
          : null,
    };
  },
};

/* ---------------------------------------------------------------- payments */

const recordPaymentInput = z.object({
  liability: z.string().min(1).describe('Name of the debt, from finance.list_liabilities.'),
  dueOn: DATE.describe('Date the payment was due.'),
  paidOn: DATE.optional().describe('Date it was actually paid, when it was.'),
  amount: z.number().min(0).optional().describe('Amount paid.'),
  status: z
    .enum(['scheduled', 'paid_on_time', 'paid_late', 'missed'])
    .describe("'scheduled' for one still ahead; otherwise how it went."),
});

export const recordPayment: ToolDefinition<z.infer<typeof recordPaymentInput>, unknown> = {
  name: 'finance.record_payment',
  description:
    'Record one payment against a debt — due date, when it was paid, how much, and whether it was on time, late or missed. Payment history is the single heaviest factor in a credit score, so every minimum matters; a duplicate (same debt, same due date) is updated rather than added twice.',
  tier: 'auto',
  input: recordPaymentInput,
  async execute(input, ctx) {
    const { rows: liab } = await ctx.db.query(
      `select id, name from finance.liabilities where lower(name) = lower($1)`,
      [input.liability],
    );
    const target = liab[0];
    if (!target) {
      return {
        status: 'unknown-liability',
        message: `no liability named '${input.liability}'; list them with finance.list_liabilities`,
      };
    }
    const { rows: existing } = await ctx.db.query(
      `select id from finance.payment_events where liability_id = $1 and due_on = $2`,
      [target.id, input.dueOn],
    );
    const current = existing[0];
    // One row per (debt, due date): a correction updates it rather than adding
    // a second event, so the on-time rate is never double-counted.
    const { rows } = current
      ? await ctx.db.query(
          `update finance.payment_events
              set paid_on = $2, amount = $3, status = $4
            where id = $1
            returning id, due_on, paid_on, amount, status`,
          [current.id, input.paidOn ?? null, input.amount ?? null, input.status],
        )
      : await ctx.db.query(
          `insert into finance.payment_events (liability_id, due_on, paid_on, amount, status)
           values ($1, $2, $3, $4, $5)
           returning id, due_on, paid_on, amount, status`,
          [target.id, input.dueOn, input.paidOn ?? null, input.amount ?? null, input.status],
        );
    const row = rows[0];
    return {
      status: 'ok',
      updated: Boolean(current),
      id: row.id,
      liability: target.name,
      dueOn: toDateString(row.due_on),
      paidOn: row.paid_on === null ? null : toDateString(row.paid_on),
      amount: row.amount === null ? null : num(row.amount),
      paymentStatus: row.status,
    };
  },
};

const paymentHistoryInput = z.object({
  liability: z.string().min(1).optional().describe('Limit to one debt. Default: all of them.'),
  months: z.number().int().min(1).max(120).optional().describe('How far back to look. Default 12.'),
});

export const paymentHistory: ToolDefinition<z.infer<typeof paymentHistoryInput>, unknown> = {
  name: 'finance.payment_history',
  description:
    'The recorded payments over the last months, with the on-time rate, the count of late and missed payments, and anything still scheduled. This is the only source of truth for the on-time rate — never compute it yourself.',
  tier: 'auto',
  input: paymentHistoryInput,
  async execute(input, ctx) {
    const months = input.months ?? 12;
    const prefs = await loadPreferences(ctx.db);
    const { rows } = await ctx.db.query(
      `select p.id, p.due_on, p.paid_on, p.amount, p.status, l.name as liability
         from finance.payment_events p
         join finance.liabilities l on l.id = p.liability_id
        where p.due_on >= ($1::date - make_interval(months => $2::int))
          and ($3::text is null or lower(l.name) = lower($3))
        order by p.due_on desc`,
      [today(ctx.now), months, input.liability ?? null],
    );
    const payments = rows.map((r) => ({
      id: r.id,
      liability: r.liability,
      dueOn: toDateString(r.due_on),
      paidOn: r.paid_on === null ? null : toDateString(r.paid_on),
      amount: r.amount === null ? null : num(r.amount),
      status: r.status,
    }));
    const settled = payments.filter((p) => p.status !== 'scheduled');
    const onTime = settled.filter((p) => p.status === 'paid_on_time').length;
    const late = settled.filter((p) => p.status === 'paid_late').length;
    const missed = settled.filter((p) => p.status === 'missed').length;
    return {
      payments,
      count: payments.length,
      months,
      settled: settled.length,
      onTime,
      late,
      missed,
      scheduled: payments.length - settled.length,
      onTimeRate: settled.length === 0 ? null : round2((onTime / settled.length) * 100),
      currency: prefs.currency,
      message:
        payments.length === 0
          ? 'no payments have been recorded yet; record each minimum as it is paid to build the history'
          : null,
    };
  },
};

/* ------------------------------------------------------------- utilization */

export const creditUtilization: ToolDefinition<Record<string, never>, unknown> = {
  name: 'finance.credit_utilization',
  description:
    'Per credit card: the balance, the limit, the utilization percentage, the statement closing day, and exactly what to pay to land at 30% and at 10% of the limit — plus the overall utilization across all cards. paymentFor30 = the amount to PAY now; targetBalanceFor30 = the balance that remains AFTER that payment (same for paymentFor10 / targetBalanceFor10). Quote both: pay paymentFor30 so the balance becomes targetBalanceFor30 — never quote a payment as if it were the resulting balance. totalToReach30 / totalToReach10 are the summed payments across cards. Sorted by APR, dearest first. This is the only source of truth for utilization arithmetic.',
  tier: 'auto',
  input: z.object({}),
  async execute(_input, ctx) {
    const prefs = await loadPreferences(ctx.db);
    const cards = await loadCards(ctx.db);
    const report = utilizationReport(cards);
    return {
      cards: report.cards.map((c) => ({
        name: c.name,
        balance: c.balance,
        creditLimit: c.creditLimit,
        utilization: c.utilization,
        apr: c.apr,
        minimumPayment: c.minimumPayment,
        statementDay: c.statementDay,
        paymentFor30: c.paymentFor30,
        targetBalanceFor30: c.targetBalanceFor30,
        paymentFor10: c.paymentFor10,
        targetBalanceFor10: c.targetBalanceFor10,
      })),
      count: report.cards.length,
      totalBalance: report.totalBalance,
      totalLimit: report.totalLimit,
      overallUtilization: report.overallUtilization,
      totalToReach30: report.totalToReach30,
      totalToReach10: report.totalToReach10,
      currency: prefs.currency,
      message:
        report.cards.length === 0
          ? 'no active credit cards are recorded; add them with their limits to track utilization'
          : report.totalLimit === 0
            ? 'no credit limits are recorded, so utilization cannot be computed; ask the owner for each card limit'
            : null,
    };
  },
};

const planInput = z.object({
  monthlyBudget: z
    .number()
    .min(0)
    .describe(
      'Money available this month for extra payments, on top of the minimums. Check it against a cash-flow projection before proposing it.',
    ),
});

export const creditPlanTool: ToolDefinition<z.infer<typeof planInput>, unknown> = {
  name: 'finance.credit_plan',
  description:
    'Allocate a monthly extra-payment budget across the cards: first bring every card under 30% utilization, dearest APR first, then put whatever is left on the highest-APR card. Returns, per card, payment (the amount to PAY on top of the minimum) and balanceAfter (the balance that remains AFTER that payment) — quote both: pay `payment` so the balance becomes `balanceAfter` — plus the utilization each card and the portfolio would land at, and how many months the highest-APR card takes to clear at that pace. Deterministic — this is the only source of truth for the allocation.',
  tier: 'auto',
  input: planInput,
  async execute(input, ctx) {
    const prefs = await loadPreferences(ctx.db);
    const cards = await loadCards(ctx.db);
    const plan = creditPlan(cards, input.monthlyBudget);
    return {
      ...plan,
      currency: prefs.currency,
      message:
        cards.length === 0
          ? 'no active credit cards are recorded, so there is nothing to allocate'
          : plan.shortfall > 0
            ? `this budget is ${plan.shortfall.toFixed(2)} short of putting every card under 30%`
            : null,
    };
  },
};

const upcomingInput = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(120)
    .optional()
    .describe('Window ahead, in days. Default 30.'),
});

export const upcomingStatementsTool: ToolDefinition<z.infer<typeof upcomingInput>, unknown> = {
  name: 'finance.upcoming_statements',
  description:
    'Cards whose statement closes within the window, soonest first — the closing date, the date to pay by for the payment to post first, and what to pay for the card to report at 30% and at 10%. paymentFor30 = the amount to PAY before the statement closes; targetBalanceFor30 = the balance that would then be reported (same for paymentFor10 / targetBalanceFor10). Quote both: pay paymentFor30 so the reported balance becomes targetBalanceFor30. Utilization is scored off the balance reported at statement close, not off the due date, so this is the calendar that matters.',
  tier: 'auto',
  input: upcomingInput,
  async execute(input, ctx) {
    const days = input.days ?? 30;
    const prefs = await loadPreferences(ctx.db);
    const cards = await loadCards(ctx.db);
    const from = today(ctx.now);
    const statements = upcomingStatements(cards, from, days);
    const noStatementDay = cards.filter((c) => c.statementDay === null).map((c) => c.name);
    return {
      from,
      days,
      statements: statements.map((s) => ({
        name: s.name,
        statementDate: s.statementDate,
        daysUntil: s.daysUntil,
        payBefore: s.payBefore,
        balance: s.balance,
        creditLimit: s.creditLimit,
        utilization: s.utilization,
        apr: s.apr,
        paymentFor30: s.paymentFor30,
        targetBalanceFor30: s.targetBalanceFor30,
        paymentFor10: s.paymentFor10,
        targetBalanceFor10: s.targetBalanceFor10,
      })),
      count: statements.length,
      cardsWithoutStatementDay: noStatementDay,
      currency: prefs.currency,
      message:
        noStatementDay.length > 0
          ? `no statement closing day is recorded for: ${noStatementDay.join(', ')} — ask the owner and store it`
          : null,
    };
  },
};
