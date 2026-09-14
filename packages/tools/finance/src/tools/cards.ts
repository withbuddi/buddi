/**
 * Card ledger tools: what a card has been doing, and what it will report.
 *
 * Both are reads over the card's own transactions and recurring items plus one
 * pure computation from `../cards.js` — the model explains, it never computes.
 */
import type { ToolDefinition } from '@buddi/core';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  isPaymentToward,
  statementForecast,
  summarizeCardActivity,
  type CardTransaction,
  type StatementForecast,
} from '../cards.js';
import type { RecurringItem } from '../projection.js';
import {
  findLiability,
  loadPreferences,
  num,
  today,
  toDateString,
  type LiabilityRow,
} from './shared.js';

/** Active recurring items billed to this card. */
async function loadCardItems(db: Pool, liabilityId: string): Promise<RecurringItem[]> {
  const { rows } = await db.query(
    `select kind, name, amount, cadence, anchor_date
       from finance.recurring_items
      where active and liability_id = $1
      order by anchor_date`,
    [liabilityId],
  );
  return rows.map((r) => ({
    name: r.name as string,
    kind: r.kind as RecurringItem['kind'],
    amount: num(r.amount),
    cadence: r.cadence as RecurringItem['cadence'],
    anchorDate: toDateString(r.anchor_date),
  }));
}

/**
 * Cash-side recurring charges that look like payments of this card, matched on
 * the name the owner gave them ('NFCU Mastercard payment' → the NFCU
 * Mastercard). Nothing is inferred from an account: the owner can pay a card
 * from anywhere, and the name is the only thing they actually stated.
 */
async function loadPaymentItems(
  db: Pool,
  liabilityName: string,
): Promise<RecurringItem[]> {
  const { rows } = await db.query(
    `select kind, name, amount, cadence, anchor_date
       from finance.recurring_items
      where active and kind = 'charge' and liability_id is null
      order by anchor_date`,
  );
  return rows
    .filter((r) => isPaymentToward(r.name as string, liabilityName))
    .map((r) => ({
      name: r.name as string,
      kind: 'charge' as const,
      amount: num(r.amount),
      cadence: r.cadence as RecurringItem['cadence'],
      anchorDate: toDateString(r.anchor_date),
    }));
}

/**
 * The forecast for one card, from the DB. Shared by finance.statement_forecast,
 * the credit tools and the statement-closing sentinel, so all four answer the
 * same number.
 */
export async function loadStatementForecast(
  db: Pool,
  liability: Pick<LiabilityRow, 'id' | 'name' | 'balance' | 'creditLimit' | 'statementDay'>,
  asOf: string,
): Promise<StatementForecast> {
  const [cardItems, paymentItems] = await Promise.all([
    loadCardItems(db, liability.id),
    loadPaymentItems(db, liability.name),
  ]);
  return statementForecast({
    today: asOf,
    balance: liability.balance,
    statementDay: liability.statementDay,
    creditLimit: liability.creditLimit,
    cardItems,
    paymentItems,
  });
}

const forecastInput = z.object({
  liability: z
    .string()
    .min(1)
    .describe("The card, by name, e.g. 'NFCU Mastercard Platinum 9012'."),
});

export const statementForecastTool: ToolDefinition<z.infer<typeof forecastInput>, unknown> = {
  name: 'finance.statement_forecast',
  description:
    "What a card is expected to report at its next statement close: forecastBalance = the balance today + the recurring charges billed to the card that fall due on or before the closing day − the payments scheduled to land before it. Every movement is listed in `events` with its date, so the answer can say WHEN a charge hits ('the GEICO premium posts on the 3rd, four days before the statement closes'). Utilization is given for the balance today and for the forecast one. This is the only source of truth for a forecast balance — never add the charges up yourself. Returns hasForecast: false when no statement closing day is recorded for the card; ask the owner for it and store it with finance.set_liability.",
  tier: 'auto',
  input: forecastInput,
  async execute(input, ctx) {
    const prefs = await loadPreferences(ctx.db);
    const liability = await findLiability(ctx.db, input.liability);
    if (!liability) {
      return {
        status: 'unknown-liability',
        message: `no liability named '${input.liability}'; list them with finance.list_liabilities`,
      };
    }
    const asOf = today(ctx);
    const forecast = await loadStatementForecast(ctx.db, liability, asOf);
    return {
      status: 'ok',
      asOf,
      liability: liability.name,
      kind: liability.kind,
      creditLimit: liability.creditLimit,
      minimumPayment: liability.minimumPayment,
      dueDay: liability.dueDay,
      statementDay: liability.statementDay,
      currency: prefs.currency,
      ...forecast,
      message: forecast.hasForecast
        ? null
        : `no statement closing day is recorded for '${liability.name}', so the balance it will report cannot be forecast; ask the owner which day the statement closes and store it with finance.set_liability`,
    };
  },
};

const activityInput = z.object({
  liability: z
    .string()
    .min(1)
    .describe("The card or loan, by name, e.g. 'NFCU Mastercard Platinum 9012'."),
  months: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe('How many months back, counting the current one. Default 3.'),
});

export const cardActivity: ToolDefinition<z.infer<typeof activityInput>, unknown> = {
  name: 'finance.card_activity',
  description:
    'What has actually been recorded on one card, month by month: charges (purchases), payments and credits, and interest, each as a positive figure, plus netBalanceChange = charges + interest − payments, which is how much what is owed grew that month. Months with no activity are listed as zeros. Use it to answer "what am I putting on this card", "how much interest is it costing me" and "when did that charge hit" — the recent rows come back under `transactions`. It reads recorded rows only and never guesses: a card with no transactions recorded yet says so, and the balance on the liability is the owner\'s stated figure, not a sum of these rows.',
  tier: 'auto',
  input: activityInput,
  async execute(input, ctx) {
    const prefs = await loadPreferences(ctx.db);
    const liability = await findLiability(ctx.db, input.liability);
    if (!liability) {
      return {
        status: 'unknown-liability',
        message: `no liability named '${input.liability}'; list them with finance.list_liabilities`,
      };
    }
    const months = input.months ?? 3;
    const asOf = today(ctx);
    const { rows } = await ctx.db.query(
      `select occurred_on, amount, description, category, status
         from finance.transactions
        where liability_id = $1
          and superseded_by is null
          and occurred_on >= (date_trunc('month', $2::date) - make_interval(months => $3::int))
        order by occurred_on desc, created_at desc`,
      [liability.id, asOf, months - 1],
    );
    const txns: CardTransaction[] = rows.map((r) => ({
      occurredOn: toDateString(r.occurred_on),
      amount: num(r.amount),
      description: r.description as string,
      category: (r.category as string | null) ?? null,
    }));
    const activity = summarizeCardActivity(txns, { today: asOf, months });

    return {
      status: 'ok',
      asOf,
      liability: liability.name,
      kind: liability.kind,
      balance: liability.balance,
      creditLimit: liability.creditLimit,
      currency: prefs.currency,
      months: activity.months,
      totals: activity.totals,
      /** The rows themselves, newest first, so a charge can be named and dated. */
      transactions: rows.map((r, i) => ({
        ...txns[i],
        status: r.status as string,
      })),
      message:
        txns.length === 0
          ? `no transactions are recorded on '${liability.name}' for this window; record card purchases with finance.record_transaction and the card's name as \`liability\`, or import the card statement`
          : null,
    };
  },
};
