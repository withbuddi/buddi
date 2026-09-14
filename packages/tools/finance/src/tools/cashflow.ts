import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import type { Hypothetical, ProjectionDay, RecurringItem } from '../projection.js';
import { DAYS_PER_MONTH } from '../baseline.js';
import { addDays, project } from '../projection.js';
import { baselineOptionsSchema, loadBaseline } from './baseline.js';
import { findAccount, loadPreferences, num, today, toDateString } from './shared.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');

const hypothetical = z.object({
  name: z.string().min(1).describe("What it is, e.g. 'new laptop'."),
  amount: z
    .number()
    .describe('Signed: negative for a spend being considered, positive for extra money in.'),
  date: DATE.describe('When it would happen, YYYY-MM-DD.'),
});

const input = z.object({
  horizonDays: z
    .number()
    .int()
    .min(1)
    .max(366)
    .optional()
    .describe('How many days ahead to simulate. Default 60, maximum 366.'),
  hypotheticals: z
    .array(hypothetical)
    .max(20)
    .optional()
    .describe(
      "One-off what-ifs to add on top of the known items — this is how 'can I afford X on date Y?' is answered.",
    ),
  account: z
    .string()
    .min(1)
    .optional()
    .describe('Limit the projection to one account. Default: every spendable account summed (retirement, investment and HSA accounts are always left out).'),
  includeBaseline: z
    .boolean()
    .optional()
    .describe(
      'Default true: apply the measured typical variable spending (groceries, transport, eating out, …) on top of the recurring items. Set false only to see the recurring items alone — that view is optimistic and should be labelled as such.',
    ),
  baselineMonths: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe('Complete months of history the baseline is measured over. Default 3.'),
  baselineOptions: baselineOptionsSchema
    .optional()
    .describe(
      'How the variable-spending baseline is measured — aggregation, excluded categories, excluded months, month coverage. Same options as finance.spending_baseline; the defaults are the sane ones and only need overriding when the owner has told you something about a specific month.',
    ),
  includePending: z
    .boolean()
    .optional()
    .describe(
      'Default true: pending transactions dated inside the horizon are applied as one-off events, because a pending charge is money already committed — the card was swiped, the bank has simply not settled it. Set false only to see the settled picture alone.',
    ),
  includeP2P: z
    .enum(['none', 'net'])
    .optional()
    .describe(
      "How to treat person-to-person transfers (Zelle, PayPal, Ria, Lemfi, Moneygram). Default 'none': left out, because they may be money being moved rather than spent. 'net' spreads their average monthly net over the horizon.",
    ),
});

/** Keep the response small: only days that move, plus the low point. */
function compressDays(days: ProjectionDay[], minBalanceDate: string): ProjectionDay[] {
  const keep = days.filter((d) => d.events.length > 0 || d.date === minBalanceDate);
  const last = days[days.length - 1];
  if (last && !keep.some((d) => d.date === last.date)) keep.push(last);
  return keep.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export const projectCashflow: ToolDefinition<z.infer<typeof input>, unknown> = {
  name: 'finance.project_cashflow',
  description:
    'Simulate the balance day by day over the coming weeks from the recorded balances, the active recurring items AND the owner\'s typical variable spending, and report the end balance, the minimum balance and the date it happens, and whether it drops below the safety floor. By default the projection includes a daily burn measured from the last 3 complete months of transactions — the MEDIAN monthly total, so one freak month cannot set it, and with credit-card/loan payments left out as debt servicing (see the `baseline` field of the response for what it is and how it was measured, and `baselineOptions` to change it); pass includeBaseline: false to project the recurring items alone. Person-to-person transfers are excluded unless includeP2P is \'net\'. Pending transactions dated inside the horizon are applied too — a pending charge is money already committed — and listed under `pendingEvents`; pass includePending: false to leave them out. Add `hypotheticals` to test a purchase before making it. Accounts that are not spendable (retirement, investment, HSA) are left out of the start balance entirely and listed under `startBalanceExcludes`, along with any recurring item attached to one. Charges billed to a credit card are left out too — they move no cash on their date; the cash moves when the card is paid, and that payment is already a recurring item here. Use finance.statement_forecast for what a card will report, and finance.card_activity for what it has been doing. This is the only source of truth for "will I be short?" — never compute a projection yourself.',
  tier: 'auto',
  input,
  async execute(args, ctx) {
    const horizonDays = args.horizonDays ?? 60;
    const prefs = await loadPreferences(ctx.db);

    let startBalance = 0;
    let accountId: string | undefined;
    let scope: string;
    // Money that is real but not spendable — a 401k, a brokerage, an HSA —
    // never enters a projection. Reported back so the answer can say so out
    // loud instead of silently looking poorer than the balance sheet.
    const { rows: excludedRows } = await ctx.db.query(
      `select name, kind, balance from finance.accounts
        where not include_in_cashflow order by balance desc, name`,
    );
    const startBalanceExcludes = excludedRows.map((r) => ({
      account: r.name as string,
      kind: r.kind as string,
      balance: num(r.balance),
    }));

    if (args.account) {
      const account = await findAccount(ctx.db, args.account);
      if (!account) throw new Error(`unknown account: ${args.account}`);
      startBalance = account.balance;
      accountId = account.id;
      scope = account.name;
    } else {
      const { rows } = await ctx.db.query(
        `select coalesce(sum(balance), 0) as total, count(*)::int as n from finance.accounts
          where include_in_cashflow`,
      );
      startBalance = num(rows[0]?.total);
      scope = `all cashflow accounts (${rows[0]?.n ?? 0})`;
    }

    // An item attached to an excluded account (a 401k contribution booked as a
    // recurring income) is excluded with it; an item with no account at all is
    // assumed to hit the cash. An item billed to a CARD is excluded too, and for
    // a different reason: it never moves cash on its date at all. It raises what
    // is owed on the card, and the cash leaves once, later, as the card payment
    // — which is its own recurring item and already in this projection. Counting
    // both would spend the same money twice.
    const { rows: itemRows } = accountId
      ? await ctx.db.query(
          `select kind, name, amount, cadence, anchor_date from finance.recurring_items
            where active and account_id = $1 and liability_id is null
            order by anchor_date`,
          [accountId],
        )
      : await ctx.db.query(
          `select r.kind, r.name, r.amount, r.cadence, r.anchor_date
             from finance.recurring_items r
             left join finance.accounts a on a.id = r.account_id
            where r.active and r.liability_id is null
              and (a.id is null or a.include_in_cashflow)
            order by r.anchor_date`,
        );

    const items: RecurringItem[] = itemRows.map((r) => ({
      name: r.name as string,
      kind: r.kind as RecurringItem['kind'],
      amount: num(r.amount),
      cadence: r.cadence as RecurringItem['cadence'],
      anchorDate: toDateString(r.anchor_date),
    }));

    const startDate = today(ctx);
    const hypotheticals: Hypothetical[] = args.hypotheticals ?? [];

    // Pending money is committed money: the charge exists, the bank has just
    // not settled it. It is applied as a one-off event on its date, alongside
    // the hypotheticals, and reported separately so the answer can name it.
    // A pending row that has already been superseded by its posted twin is
    // invisible here as everywhere else.
    const includePending = args.includePending ?? true;
    const endDate = addDays(startDate, horizonDays - 1);
    let pendingEvents: Hypothetical[] = [];
    if (includePending) {
      const { rows: pendingRows } = accountId
        ? await ctx.db.query(
            `select t.occurred_on, t.amount, t.description
               from finance.transactions t
              where t.status = 'pending' and t.superseded_by is null
                and t.account_id = $3
                and t.occurred_on >= $1::date and t.occurred_on <= $2::date
              order by t.occurred_on`,
            [startDate, endDate, accountId],
          )
        : await ctx.db.query(
            `select t.occurred_on, t.amount, t.description
               from finance.transactions t
               left join finance.accounts a on a.id = t.account_id
              where t.status = 'pending' and t.superseded_by is null
                and t.liability_id is null
                and (a.id is null or a.include_in_cashflow)
                and t.occurred_on >= $1::date and t.occurred_on <= $2::date
              order by t.occurred_on`,
            [startDate, endDate],
          );
      pendingEvents = pendingRows.map((r) => ({
        name: `${r.description as string} (pending)`,
        amount: num(r.amount),
        date: toDateString(r.occurred_on),
      }));
    }

    const includeBaseline = args.includeBaseline ?? true;
    const includeP2P = args.includeP2P ?? 'none';
    const baselineMonths = args.baselineMonths ?? 3;

    let dailyBurn = 0;
    let baseline: Record<string, unknown> | null = null;
    if (includeBaseline) {
      const loaded = await loadBaseline(ctx, {
        months: baselineMonths,
        account: args.account,
        ...(args.baselineOptions ?? {}),
      });
      const b = loaded.baseline;
      // p2p.net is signed money *in*; as a burn it flips sign.
      const p2pDaily = includeP2P === 'net' ? -b.p2p.net / DAYS_PER_MONTH : 0;
      dailyBurn = Math.round((b.dailyBurn + p2pDaily) * 100) / 100;
      baseline = {
        dailyBurn,
        variableDailyBurn: b.dailyBurn,
        avgMonthlyVariableOut: b.avgMonthlyVariableOut,
        meanMonthlyVariableOut: b.meanMonthlyVariableOut,
        aggregation: b.aggregation,
        monthsUsed: b.monthsUsed,
        months: b.months,
        coverage: b.coverage,
        skippedMonths: b.skippedMonths,
        window: b.window,
        excluded: b.excluded,
        p2pNetMonthly: b.p2p.net,
        includeP2P,
        sampleSize: b.sampleSize,
        note:
          'Applied every day and folded into the balances, not listed as a per-day event.',
      };
    }

    const result = project({
      startDate,
      startBalance,
      horizonDays,
      items,
      hypotheticals: [...pendingEvents, ...hypotheticals],
      safetyFloor: prefs.safetyFloor,
      dailyBurn,
    });

    return {
      startDate,
      startBalance,
      horizonDays,
      scope,
      currency: prefs.currency,
      safetyFloor: prefs.safetyFloor,
      itemCount: items.length,
      /**
       * Balances deliberately left out of `startBalance`: retirement,
       * investment and HSA money. Mention it when it is material, and never as
       * money that could cover the purchase being tested.
       */
      startBalanceExcludes,
      includeBaseline,
      baseline,
      includePending,
      /** Committed-but-unsettled charges applied inside the horizon. */
      pendingEvents,
      hypotheticals,
      endBalance: result.endBalance,
      minBalance: result.minBalance,
      minBalanceDate: result.minBalanceDate,
      breachesFloor: result.breachesFloor,
      firstBreachDate: result.firstBreachDate ?? null,
      nextIncome: result.nextIncome ?? null,
      /** Only days with events, plus the minimum-balance day and the last day. */
      days: compressDays(result.days, result.minBalanceDate),
    };
  },
};
