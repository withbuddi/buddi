import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import type { Hypothetical, ProjectionDay, RecurringItem } from '../projection.js';
import { DAYS_PER_MONTH } from '../baseline.js';
import { project } from '../projection.js';
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
    .describe('Limit the projection to one account. Default: all accounts summed.'),
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
    'Simulate the balance day by day over the coming weeks from the recorded balances, the active recurring items AND the owner\'s typical variable spending, and report the end balance, the minimum balance and the date it happens, and whether it drops below the safety floor. By default the projection includes a daily burn measured from the last 3 complete months of transactions — the MEDIAN monthly total, so one freak month cannot set it, and with credit-card/loan payments left out as debt servicing (see the `baseline` field of the response for what it is and how it was measured, and `baselineOptions` to change it); pass includeBaseline: false to project the recurring items alone. Person-to-person transfers are excluded unless includeP2P is \'net\'. Add `hypotheticals` to test a purchase before making it. This is the only source of truth for "will I be short?" — never compute a projection yourself.',
  tier: 'auto',
  input,
  async execute(args, ctx) {
    const horizonDays = args.horizonDays ?? 60;
    const prefs = await loadPreferences(ctx.db);

    let startBalance = 0;
    let accountId: string | undefined;
    let scope: string;
    if (args.account) {
      const account = await findAccount(ctx.db, args.account);
      if (!account) throw new Error(`unknown account: ${args.account}`);
      startBalance = account.balance;
      accountId = account.id;
      scope = account.name;
    } else {
      const { rows } = await ctx.db.query(
        `select coalesce(sum(balance), 0) as total, count(*)::int as n from finance.accounts`,
      );
      startBalance = num(rows[0]?.total);
      scope = `all accounts (${rows[0]?.n ?? 0})`;
    }

    const { rows: itemRows } = accountId
      ? await ctx.db.query(
          `select kind, name, amount, cadence, anchor_date from finance.recurring_items
            where active and account_id = $1 order by anchor_date`,
          [accountId],
        )
      : await ctx.db.query(
          `select kind, name, amount, cadence, anchor_date from finance.recurring_items
            where active order by anchor_date`,
        );

    const items: RecurringItem[] = itemRows.map((r) => ({
      name: r.name as string,
      kind: r.kind as RecurringItem['kind'],
      amount: num(r.amount),
      cadence: r.cadence as RecurringItem['cadence'],
      anchorDate: toDateString(r.anchor_date),
    }));

    const startDate = today(ctx.now);
    const hypotheticals: Hypothetical[] = args.hypotheticals ?? [];

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
      hypotheticals,
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
      includeBaseline,
      baseline,
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
