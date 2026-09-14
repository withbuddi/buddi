import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import { num, resolveLedger, toDateString } from './shared.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');

const CADENCE = z.enum(['monthly', 'weekly', 'biweekly', 'yearly', 'once']);

function mapRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    amount: num(r.amount),
    cadence: r.cadence,
    anchorDate: toDateString(r.anchor_date),
    account: r.account_name ?? null,
    /**
     * The card or loan this charge is billed to, when it is not paid in cash.
     * A charge with a `billedTo` moves no cash on its date — it raises what is
     * owed on that card, and the cash moves later as the card payment — so it
     * is deliberately absent from the cash-flow projection and present in the
     * card's statement forecast.
     */
    billedTo: r.liability_name ?? null,
    category: r.category ?? null,
    active: r.active,
  };
}

const addInput = z.object({
  kind: z
    .enum(['income', 'charge'])
    .describe("'income' for money coming in, 'charge' for money going out."),
  name: z.string().min(1).describe("Human label, e.g. 'Salary' or 'Rent'."),
  amount: z
    .number()
    .positive()
    .describe('Always a positive number; the direction comes from `kind`.'),
  cadence: CADENCE.describe(
    "How often it repeats. 'once' is a single dated event (monthly recurs on the anchor day-of-month, clamped to the month end).",
  ),
  anchorDate: DATE.describe(
    'First (or only, for `once`) occurrence, YYYY-MM-DD. For monthly items its day-of-month is the recurring day.',
  ),
  account: z.string().min(1).optional().describe('Cash account it hits. Created if unknown. Not with `liability`.'),
  liability: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The card this charge is billed to, e.g. 'NFCU Mastercard Platinum 9012' for a GEICO premium on autopay to the card. The liability must already exist (finance.set_liability). A charge billed to a card moves no cash on its date, so it is left out of the cash-flow projection and counted in that card's statement forecast instead. Not with `account`.",
    ),
  category: z.string().min(1).optional().describe("Free-form category, e.g. 'housing'."),
})
  .refine((v) => !(v.account && v.liability), {
    message: 'a recurring item is billed to a card or paid from an account, never both',
  });

export const addRecurring: ToolDefinition<z.infer<typeof addInput>, unknown> = {
  name: 'finance.add_recurring',
  description:
    "Add a recurring income or charge (salary, rent, subscription, loan payment). These items drive the cashflow projection, so add every known one. Pass `liability` instead of `account` when the charge is billed to a credit card — a subscription or an insurance premium on autopay to the card: it then shows as `billedTo` on that card, counts toward the card's statement forecast, and is deliberately kept OUT of the cash projection, because the cash only moves when the card is paid and that payment is its own recurring item. Returns the created item.",
  tier: 'auto',
  input: addInput,
  async execute(input, ctx) {
    // An item with neither account nor liability stays legal: it is assumed to
    // hit the cash, which is how most of the owner's items are already recorded.
    const ledger =
      input.account || input.liability ? await resolveLedger(ctx.db, input) : undefined;
    const { rows } = await ctx.db.query(
      `insert into finance.recurring_items
         (kind, name, amount, cadence, anchor_date, account_id, liability_id, category)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, kind, name, amount, cadence, anchor_date, category, active`,
      [
        input.kind,
        input.name,
        input.amount,
        input.cadence,
        input.anchorDate,
        ledger?.accountId ?? null,
        ledger?.liabilityId ?? null,
        input.category ?? null,
      ],
    );
    return mapRow({
      ...rows[0],
      account_name: ledger?.kind === 'account' ? ledger.name : null,
      liability_name: ledger?.kind === 'liability' ? ledger.name : null,
    });
  },
};

const listInput = z.object({
  activeOnly: z
    .boolean()
    .optional()
    .describe('Default true. Set false to also show items that were removed.'),
});

export const listRecurring: ToolDefinition<z.infer<typeof listInput>, unknown> = {
  name: 'finance.list_recurring',
  description:
    "List recurring incomes and charges with their amount, cadence, anchor date and account. An item with a `billedTo` is billed to that card rather than paid in cash: it raises what is owed on the card on its date and never moves the cash, so it is absent from the projection and present in that card's statement forecast. Check it, together with the card's activity, when the owner asks when a charge hits. Active items only unless `activeOnly` is false.",
  tier: 'auto',
  input: listInput,
  async execute(input, ctx) {
    const activeOnly = input.activeOnly ?? true;
    const { rows } = await ctx.db.query(
      `select r.id, r.kind, r.name, r.amount, r.cadence, r.anchor_date, r.category, r.active,
              a.name as account_name, l.name as liability_name
         from finance.recurring_items r
         left join finance.accounts a on a.id = r.account_id
         left join finance.liabilities l on l.id = r.liability_id
        where ($1::boolean is false or r.active)
        order by r.kind desc, r.name`,
      [activeOnly],
    );
    const items = rows.map(mapRow);
    // The cash view: a charge billed to a card is not cash leaving this month.
    const monthlyNet =
      Math.round(
        items
          .filter((i) => i.active && i.cadence === 'monthly' && i.billedTo === null)
          .reduce(
            (s, i) => s + (i.kind === 'income' ? (i.amount as number) : -(i.amount as number)),
            0,
          ) * 100,
      ) / 100;
    return {
      items,
      count: items.length,
      /** Cash only: items billed to a card are excluded, and counted here. */
      monthlyNet,
      cardBilledCount: items.filter((i) => i.active && i.billedTo !== null).length,
    };
  },
};

const removeInput = z
  .object({
    id: z.string().uuid().optional().describe('Item id, from finance.list_recurring.'),
    name: z.string().min(1).optional().describe('Exact item name (case-insensitive).'),
  })
  .refine((v) => Boolean(v.id) !== Boolean(v.name), {
    message: 'provide exactly one of id or name',
  });

export const removeRecurring: ToolDefinition<z.infer<typeof removeInput>, unknown> = {
  name: 'finance.remove_recurring',
  description:
    'Stop a recurring item from counting toward projections. It is deactivated, not deleted, so history stays intact. Identify it by id or by exact name.',
  tier: 'auto',
  input: removeInput,
  async execute(input, ctx) {
    const { rows } = input.id
      ? await ctx.db.query(
          `update finance.recurring_items set active = false
            where id = $1 and active
            returning id, kind, name, amount, cadence, anchor_date, category, active,
                      (select name from finance.liabilities l where l.id = liability_id) as liability_name`,
          [input.id],
        )
      : await ctx.db.query(
          `update finance.recurring_items set active = false
            where lower(name) = lower($1) and active
            returning id, kind, name, amount, cadence, anchor_date, category, active,
                      (select name from finance.liabilities l where l.id = liability_id) as liability_name`,
          [input.name],
        );
    if (rows.length === 0) {
      return { removed: 0, message: 'no active recurring item matched' };
    }
    return { removed: rows.length, items: rows.map(mapRow) };
  },
};
