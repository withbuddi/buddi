import type { ToolDefinition, ToolContext } from '@buddi/core';
import { z } from 'zod';
import type {
  BaselineAggregation,
  BaselineCoverage,
  BaselineResult,
  BaselineTransaction,
  RecurringMatchItem,
} from '../baseline.js';
import { DEFAULT_EXCLUDED_CATEGORIES, computeBaseline } from '../baseline.js';
import { findAccount, loadPreferences, num, today, toDateString } from './shared.js';

/** The tunables a caller may hand down to `computeBaseline`. */
export interface BaselineToolOptions {
  aggregation?: BaselineAggregation;
  excludeCategories?: string[];
  excludeMonths?: string[];
  coverage?: BaselineCoverage;
}

/**
 * How much further back than `months` the query reaches so the coverage rule
 * has months to reach *into*. A month rejected for missing an account has to be
 * replaced by an older one, and an older one can only be measured if its rows
 * were loaded. Twelve is generous enough for a mid-year import (the case this
 * exists for) and still bounded.
 */
export const COVERAGE_LOOKBACK_SLACK = 12;

/** Load everything `computeBaseline` needs and run it. Shared with the projection. */
export async function loadBaseline(
  ctx: ToolContext,
  opts: { months?: number; account?: string } & BaselineToolOptions = {},
): Promise<{ baseline: BaselineResult; scope: string; months: number }> {
  const months = opts.months ?? 3;
  const coverage: BaselineCoverage = opts.coverage ?? 'all-accounts';
  // computeBaseline decides the window; the query only has to be wide enough to
  // contain it, and wide enough for it to see which accounts have data at all.
  const lookbackMonths = coverage === 'any' ? months : months + COVERAGE_LOOKBACK_SLACK;
  const start = today(ctx.now);

  let accountId: string | undefined;
  let scope = 'all cashflow accounts';
  if (opts.account) {
    const account = await findAccount(ctx.db, opts.account);
    if (!account) throw new Error(`unknown account: ${opts.account}`);
    accountId = account.id;
    scope = account.name;
  }

  // Only the window matters; pulling the whole ledger would grow without bound.
  const from = `${start.slice(0, 7)}-01`;
  // Non-cashflow accounts are invisible here: a 401k contribution is not
  // variable spending, and a retirement account that only sees one transaction
  // a quarter must never sit in the coverage roll call and veto whole months.
  const { rows } = accountId
    ? await ctx.db.query(
        `select t.occurred_on, t.amount, t.description, t.category, a.name as account_name
           from finance.transactions t
           left join finance.accounts a on a.id = t.account_id
          where t.occurred_on < $1::date
            and t.occurred_on >= ($1::date - make_interval(months => $2::int))
            and t.account_id = $3
          order by t.occurred_on`,
        [from, lookbackMonths, accountId],
      )
    : await ctx.db.query(
        `select t.occurred_on, t.amount, t.description, t.category, a.name as account_name
           from finance.transactions t
           left join finance.accounts a on a.id = t.account_id
          where t.occurred_on < $1::date
            and t.occurred_on >= ($1::date - make_interval(months => $2::int))
            and (a.id is null or a.include_in_cashflow)
          order by t.occurred_on`,
        [from, lookbackMonths],
      );

  const txns: BaselineTransaction[] = rows.map((r) => ({
    date: toDateString(r.occurred_on),
    amount: num(r.amount),
    description: r.description as string,
    category: (r.category as string | null) ?? null,
    account: (r.account_name as string | null) ?? null,
  }));

  // Amount, account and category come along so an alias description ('The Park
  // Hotels' for the rent) is still recognised as the modelled charge.
  const { rows: itemRows } = await ctx.db.query(
    `select r.name, r.amount, r.category, a.name as account_name
       from finance.recurring_items r
       left join finance.accounts a on a.id = r.account_id
      where r.active`,
  );
  const { rows: accountRows } = await ctx.db.query(
    `select name from finance.accounts where include_in_cashflow`,
  );

  const recurringItems: RecurringMatchItem[] = itemRows.map((r) => ({
    name: r.name as string,
    amount: num(r.amount),
    account: (r.account_name as string | null) ?? null,
    category: (r.category as string | null) ?? null,
  }));

  const baseline = computeBaseline(txns, {
    today: start,
    months,
    recurringItems,
    accountNames: accountRows.map((r) => r.name as string),
    aggregation: opts.aggregation,
    excludeCategories: opts.excludeCategories,
    excludeMonths: opts.excludeMonths,
    coverage,
  });

  return { baseline, scope, months };
}

const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected a YYYY-MM month');

/** Shared by this tool and finance.project_cashflow. */
export const baselineOptionsSchema = z
  .object({
    aggregation: z
      .enum(['median', 'mean'])
      .optional()
      .describe(
        "How the monthly totals collapse into one number. Default 'median', which is deliberately robust: one anomalous month (a debt consolidation, a deposit, a move) cannot drag the burn up. 'mean' is the plain average — useful to compare against, but it is the number that gets distorted.",
      ),
    excludeCategories: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe(
        `Categories to leave out of the burn as debt servicing rather than everyday spend. Default ${JSON.stringify(
          DEFAULT_EXCLUDED_CATEGORIES,
        )} — card and loan payments settle spending already counted, and are modelled by the liabilities and recurring items. Pass [] to include everything.`,
      ),
    excludeMonths: z
      .array(MONTH)
      .max(24)
      .optional()
      .describe(
        "Months to drop from the window entirely, YYYY-MM, for known one-offs the owner has named. Not defaulted — only use it when you know what happened in that month, and say so in the answer.",
      ),
    coverage: z
      .enum(['any', 'all-accounts'])
      .optional()
      .describe(
        "Which months are allowed to count. Default 'all-accounts': a month is measured only if EVERY account with transactions in the data posted at least one that month, so a month before an account's import began cannot masquerade as a frugal month and halve the burn. Skipped months are listed in `skippedMonths` with the accounts that were missing, and the window reaches further back to replace them (as far as the data allows, so `monthsUsed` may still come up short). 'any' measures every month that has any data at all — only use it when the owner explicitly wants the thin months included, and say that the number is diluted.",
      ),
  })
  .describe('Tunables for how the variable-spending baseline is measured.');

const input = z.object({
  months: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe('Complete calendar months to look back over. Default 3.'),
  account: z
    .string()
    .min(1)
    .optional()
    .describe('Limit to one account. Default: every spendable account; retirement, investment and HSA accounts are never measured.'),
  baselineOptions: baselineOptionsSchema.optional(),
});

export const spendingBaseline: ToolDefinition<z.infer<typeof input>, unknown> = {
  name: 'finance.spending_baseline',
  description:
    "Measure typical variable spending — everything that is not already a recurring item, not an internal transfer between the owner's own accounts, and not a person-to-person transfer — over the last whole calendar months, and express it as a typical month, a daily burn and a per-category breakdown. The headline `avgMonthlyVariableOut` is by default the MEDIAN of the monthly totals (summed per category), not the mean, so a single freak month cannot set the burn; `meanMonthlyVariableOut` is reported alongside and a large gap between the two is itself the finding. Credit-card and loan payments are excluded as debt servicing (see `excluded.byCategory`) because they settle spending already counted and are modelled by the liabilities and recurring items. Person-to-person rails (Zelle, PayPal, Ria, Lemfi, Moneygram) are reported separately under `p2p` because they can be either spending or money being moved around; never fold them into spending without asking. finance.project_cashflow already applies this daily burn, so use this tool to explain *what* the burn is made of, not to add it on top. Accounts that are not spendable (retirement, investment, HSA) are invisible to this measurement: neither their transactions nor their presence in the coverage roll call count.",
  tier: 'auto',
  input,
  async execute(args, ctx) {
    const prefs = await loadPreferences(ctx.db);
    const { baseline, scope, months } = await loadBaseline(ctx, {
      months: args.months ?? 3,
      account: args.account,
      ...(args.baselineOptions ?? {}),
    });
    return {
      asOf: today(ctx.now),
      scope,
      monthsRequested: months,
      currency: prefs.currency,
      ...baseline,
    };
  },
};
