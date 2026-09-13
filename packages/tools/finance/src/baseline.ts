/**
 * Spending baseline — the variable, unmodelled spend the projection used to
 * ignore. Pure: no DB, no clock, no timezone (the caller passes `today`).
 *
 * The projection knows the recurring items (rent, salary, loan payments). It
 * knew nothing about groceries, Uber, restaurants — the drip that actually
 * empties a checking account. `computeBaseline` measures that drip over whole
 * calendar months and turns it into a daily burn the projection can apply.
 *
 * Three things are deliberately kept OUT of the burn:
 *  - charges that are already a recurring item (they would be counted twice),
 *  - internal transfers between the owner's own accounts (money that never left),
 *  - person-to-person transfers (Zelle/PayPal/Ria/Lemfi/Moneygram), which are
 *    reported separately because they can be spending *or* income shuffling and
 *    only the owner knows which,
 *  - debt servicing (credit-card and loan payments), which is modelled by the
 *    liabilities and recurring items rather than by the everyday-spend burn.
 *
 * The headline number is a **median** across the monthly totals, not a mean.
 * Real ledgers contain one-off months — a debt consolidation, a deposit, a
 * move — and a three-month mean lets a single such month set the burn for the
 * next sixty days. The median ignores it. `meanMonthlyVariableOut` is always
 * reported alongside so the gap between the two is visible.
 */

import { parseDate } from './projection.js';

export interface BaselineTransaction {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Signed: negative is money out. */
  amount: number;
  description: string;
  category?: string | null;
  account?: string | null;
}

/**
 * An active recurring item, in the shape the baseline needs to recognise its
 * charges in the ledger. `amount` is the positive magnitude of the charge.
 */
export interface RecurringMatchItem {
  name: string;
  amount?: number | null;
  account?: string | null;
  category?: string | null;
}

/** How a per-month series is collapsed into one monthly number. */
export type BaselineAggregation = 'median' | 'mean';

/**
 * Which candidate months are allowed into the window.
 *
 * `'all-accounts'` (the default) only measures a month in which *every* account
 * that appears anywhere in the data has at least one transaction. A month where
 * the main spending account was not yet imported is not a frugal month — it is
 * a blind spot, and averaging it in halves the burn. `'any'` takes every month
 * with any data at all, which is the older, more naive behaviour.
 */
export type BaselineCoverage = 'any' | 'all-accounts';

/** A candidate month that was examined and left out of the window. */
export interface BaselineSkippedMonth {
  /** `YYYY-MM`. */
  month: string;
  reason: 'no-coverage';
  /** Accounts that exist in the data but posted nothing in this month. */
  missingAccounts: string[];
}

export interface BaselineOptions {
  /** Today, `YYYY-MM-DD`. Required — this module never reads the clock. */
  today: string;
  /** Complete calendar months to look back over. Default 3. */
  months?: number;
  /** Names of active recurring items; matching outflows are already modelled. */
  recurringNames?: string[];
  /**
   * Active recurring items with their amounts. An outflow is dropped when its
   * magnitude lands within ±2% of one of these, even when the description is an
   * alias the name match cannot see (a rent posting as 'The Park Hotels').
   * Names here are matched fuzzily too, so this may replace `recurringNames`.
   */
  recurringItems?: RecurringMatchItem[];
  /** Overrides the default internal-transfer patterns entirely. */
  internalTransferPatterns?: RegExp[];
  /** The owner's own account names; a description naming one is an internal move. */
  accountNames?: string[];
  /** Overrides the default person-to-person pattern. */
  p2pPattern?: RegExp;
  /**
   * How monthly totals collapse into the headline. Default `'median'`, which is
   * deliberately robust to a single anomalous month; `'mean'` is the plain
   * average and is kept for comparison.
   */
  aggregation?: BaselineAggregation;
  /**
   * Categories that are debt servicing rather than everyday spend. Defaults to
   * `DEFAULT_EXCLUDED_CATEGORIES`; pass `[]` to keep everything.
   */
  excludeCategories?: string[];
  /** Explicit anomaly months to drop from the window, `YYYY-MM`. Not defaulted. */
  excludeMonths?: string[];
  /**
   * Which months may enter the window. Default `'all-accounts'`: a month counts
   * only when every account present in `txns` posted at least one transaction in
   * it, so a month before an account's import started cannot read as a
   * zero-spend month. Skipped months are reported in `skippedMonths` and the
   * window reaches further back to make up the count, as far as the data allows.
   */
  coverage?: BaselineCoverage;
}

export interface BaselineCategory {
  category: string;
  avgMonthly: number;
}

export interface BaselineP2P {
  /** Average monthly money out through p2p rails, positive. */
  avgMonthlyOut: number;
  /** Average monthly money in through p2p rails, positive. */
  avgMonthlyIn: number;
  /** in − out: positive means p2p nets money *in*. */
  net: number;
}

export interface BaselineResult {
  /** Complete months actually covered (may be < `months` when data is short). */
  monthsUsed: number;
  /** The months that were measured, `YYYY-MM`, oldest first. */
  months: string[];
  /** Which aggregation produced `avgMonthlyVariableOut` and `byCategory`. */
  aggregation: BaselineAggregation;
  /** Which coverage rule decided `months`. */
  coverage: BaselineCoverage;
  /**
   * Candidate months that were examined and rejected, oldest first, with the
   * accounts that were missing from them. Empty under `coverage: 'any'`.
   */
  skippedMonths: BaselineSkippedMonth[];
  /** The window that was measured, or null when no complete month had data. */
  window: { from: string; to: string } | null;
  /**
   * Variable money-out per month, positive, under the chosen `aggregation`.
   * Under `'median'` this is the **sum of the per-category medians**, not the
   * median of the monthly grand totals: it keeps the headline equal to the sum
   * of the `byCategory` rows, and each category shrugs off its own bad month.
   */
  avgMonthlyVariableOut: number;
  /** The plain mean, always, whatever the aggregation — reported for contrast. */
  meanMonthlyVariableOut: number;
  /** `avgMonthlyVariableOut` spread over a day, positive. */
  dailyBurn: number;
  byCategory: BaselineCategory[];
  p2p: BaselineP2P;
  /** Transactions that landed in the burn. */
  sampleSize: number;
  /** Why the other rows in the window were left out. */
  excluded: {
    /** Outflows whose description fuzzy-matched a recurring item's name. */
    recurring: number;
    /** Outflows matched to a recurring item by amount (±2%), not by name. */
    recurringByAmount: number;
    internalTransfer: number;
    p2p: number;
    inflow: number;
    /** Outflows dropped by `excludeCategories`, with the totals per category. */
    byCategory: { category: string; count: number; total: number }[];
    /** Rows dropped because their month was listed in `excludeMonths`. */
    byMonth: number;
  };
}

/** Average days in a calendar month (365.25 / 12) — spreads a month over days. */
export const DAYS_PER_MONTH = 365.25 / 12;

/**
 * Transfers that move the owner's money between the owner's own places. Real
 * shapes from bank exports: `Online Transfer to x9145`, `Transfer To Savings
 * 4281`, `Funds Transfer from Acct 1234`, `Transfer To Credit Card 9012`.
 */
export const DEFAULT_INTERNAL_TRANSFER_PATTERNS: readonly RegExp[] = [
  /online transfer (from|to) x?\d+/i,
  /transfer (from|to) savings/i,
  /transfer (from|to) checking/i,
  /transfer (from|to) credit card/i,
  /funds transfer from acct/i,
  /\binternal transfer\b/i,
];

/**
 * Debt servicing, not everyday spend: a card payment is the *settlement* of
 * spending already counted when it happened, and a loan payment is a modelled
 * recurring item. Leaving them in double counts, and one consolidation month
 * can triple the burn.
 */
export const DEFAULT_EXCLUDED_CATEGORIES: readonly string[] = ['Credit Card Payments', 'Loans'];

/** How close an outflow must be to a recurring item's amount to be one of it. */
export const RECURRING_AMOUNT_TOLERANCE = 0.02;

/** Person-to-person rails: could be spending, could be money shuffling. */
export const DEFAULT_P2P_PATTERN = /zelle|paypal|ria\b|lemfi|moneygram|venmo|cash app/i;

/** Tokens too common to carry meaning when matching a description to a name. */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'for',
  'from',
  'in',
  'of',
  'on',
  'the',
  'to',
  'via',
  'x',
]);

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** lowercase, drop digits and punctuation, split, drop stopwords. */
export function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    // Apostrophes join, not separate: "Macy's" is one token, not "macy" + "s".
    .replace(/['\u2019]/g, '')
    .replace(/[\d]+/g, ' ')
    .replace(/[^a-z\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Token overlap, 0..1: shared tokens over the size of the *smaller* token set.
 * A short name ('xfinity') must still match a longer description ('Payment to
 * xfinity'), which a Jaccard ratio would miss.
 */
export function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normalizeTokens(a));
  const tb = new Set(normalizeTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}

export const RECURRING_MATCH_THRESHOLD = 0.6;

export function matchesRecurring(description: string, names: readonly string[]): boolean {
  return names.some((name) => tokenOverlap(description, name) >= RECURRING_MATCH_THRESHOLD);
}

/**
 * Is this outflow one of `item`'s charges, judged by amount rather than text?
 *
 * The name match is blind to aliases: a rent that posts as 'The Park Hotels'
 * one month reads as a brand-new 2,111 of variable spend. The amount is the
 * stable part of a recurring charge, so a magnitude within ±2% of the item's
 * counts as the same charge — but only when nothing contradicts it: an item
 * bound to an account must be matched on that account, and a category on both
 * sides must agree. Without those guards a 50.99 dinner would vanish into a
 * 50.99 broadband bill.
 */
export function matchesRecurringAmount(
  txn: Pick<BaselineTransaction, 'amount' | 'category' | 'account'>,
  item: RecurringMatchItem,
): boolean {
  const target = item.amount ?? 0;
  if (!(target > 0)) return false;
  const magnitude = Math.abs(txn.amount);
  if (Math.abs(magnitude - target) > target * RECURRING_AMOUNT_TOLERANCE) return false;
  // An item tied to an account only ever charges that account; an unattributed
  // row cannot be shown to be it.
  if (item.account) {
    if (!txn.account) return false;
    if (txn.account.toLowerCase() !== item.account.toLowerCase()) return false;
  }
  // Categories only ever veto: they must agree when both sides have one.
  if (item.category && txn.category && txn.category.toLowerCase() !== item.category.toLowerCase()) {
    return false;
  }
  return true;
}

/** Middle value of a series, averaging the two middles when the count is even. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** `YYYY-MM` of a `YYYY-MM-DD` date. */
function monthOf(date: string): string {
  return date.slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + delta;
  const y = year + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${String(y).padStart(4, '0')}-${String(mm + 1).padStart(2, '0')}`;
}

function lastDayOfMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const day = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

/**
 * Measure the owner's variable spending over the last `months` *complete*
 * calendar months before the month containing `today`, minus any month listed
 * in `excludeMonths`, and — under the default `coverage: 'all-accounts'` —
 * minus any month in which some account posted nothing at all, the window
 * reaching further back to replace it.
 */
export function computeBaseline(
  txns: readonly BaselineTransaction[],
  opts: BaselineOptions,
): BaselineResult {
  parseDate(opts.today); // validates the shape
  const months = Math.max(1, Math.floor(opts.months ?? 3));
  const recurringItems: RecurringMatchItem[] = opts.recurringItems ?? [];
  const recurringNames = [
    ...(opts.recurringNames ?? []),
    ...recurringItems.map((it) => it.name).filter((n) => n && n.trim().length > 0),
  ];
  const internalPatterns = opts.internalTransferPatterns ?? [
    ...DEFAULT_INTERNAL_TRANSFER_PATTERNS,
  ];
  const accountNames = (opts.accountNames ?? []).filter((n) => n.trim().length > 0);
  const p2pPattern = opts.p2pPattern ?? DEFAULT_P2P_PATTERN;
  const aggregation: BaselineAggregation = opts.aggregation ?? 'median';
  const collapse = aggregation === 'median' ? median : mean;
  const excludedCategories = new Set(
    (opts.excludeCategories ?? DEFAULT_EXCLUDED_CATEGORIES).map((c) => c.toLowerCase()),
  );
  const excludedMonths = new Set(opts.excludeMonths ?? []);
  const coverage: BaselineCoverage = opts.coverage ?? 'all-accounts';

  // Every account that appears anywhere in the data — under `account` scope the
  // caller has already narrowed `txns`, so this is that one account. Rows with
  // no account cannot vouch for one and are left out of the roll call.
  const monthsByAccount = new Map<string, Set<string>>();
  let earliestMonth: string | undefined;
  for (const t of txns) {
    const m = monthOf(t.date);
    if (earliestMonth === undefined || m < earliestMonth) earliestMonth = m;
    const name = t.account?.trim();
    if (!name) continue;
    const seen = monthsByAccount.get(name) ?? new Set<string>();
    seen.add(m);
    monthsByAccount.set(name, seen);
  }
  const accountsWithData = [...monthsByAccount.keys()].sort((a, b) => a.localeCompare(b));

  /** Accounts that exist in the data but posted nothing in `month`. */
  const missingIn = (month: string): string[] =>
    accountsWithData.filter((name) => !monthsByAccount.get(name)?.has(month));

  // The candidate window: whole months before the current one, walking back
  // until `months` of them are eligible or the data runs out. An excluded month
  // spends its slot (naming a month drops it, it does not shift the window); a
  // month that fails the coverage roll call does not — the window reaches past it.
  const currentMonth = monthOf(opts.today);
  const candidates: string[] = [];
  const dropped = new Set<string>();
  const skippedMonths: BaselineSkippedMonth[] = [];
  let wanted = months;
  for (let i = 1; wanted > 0; i += 1) {
    const m = shiftMonth(currentMonth, -i);
    // Nothing older than the first transaction can ever be measured.
    if (earliestMonth === undefined || m < earliestMonth) break;
    if (excludedMonths.has(m)) {
      dropped.add(m);
      wanted -= 1;
      continue;
    }
    if (coverage === 'all-accounts') {
      const missingAccounts = missingIn(m);
      if (missingAccounts.length > 0) {
        skippedMonths.push({ month: m, reason: 'no-coverage', missingAccounts });
        continue;
      }
    }
    candidates.push(m);
    wanted -= 1;
  }
  candidates.reverse(); // oldest first
  skippedMonths.reverse();
  const candidateSet = new Set(candidates);

  const inWindow = txns.filter((t) => candidateSet.has(monthOf(t.date)));
  // Only months that actually carry data count toward the average, so a short
  // history does not divide a real month of spending by three.
  const withData = new Set(inWindow.map((t) => monthOf(t.date)));
  const used = candidates.filter((m) => withData.has(m));
  const monthsUsed = used.length;

  // Only rows that would otherwise have been measured count as dropped.
  const byMonthExcluded = txns.filter((t) => dropped.has(monthOf(t.date))).length;

  const empty: BaselineResult = {
    monthsUsed: 0,
    months: [],
    aggregation,
    coverage,
    skippedMonths,
    window: null,
    avgMonthlyVariableOut: 0,
    meanMonthlyVariableOut: 0,
    dailyBurn: 0,
    byCategory: [],
    p2p: { avgMonthlyOut: 0, avgMonthlyIn: 0, net: 0 },
    sampleSize: 0,
    excluded: {
      recurring: 0,
      recurringByAmount: 0,
      internalTransfer: 0,
      p2p: 0,
      inflow: 0,
      byCategory: [],
      byMonth: byMonthExcluded,
    },
  };
  if (monthsUsed === 0) return empty;

  const first = used[0] as string;
  const last = used[used.length - 1] as string;

  const isInternal = (t: BaselineTransaction): boolean => {
    if (internalPatterns.some((re) => re.test(t.description))) return true;
    const lower = t.description.toLowerCase();
    return accountNames.some((name) => {
      const other = name.toLowerCase();
      // A row on account X naming account Y is a move between the owner's own places.
      if (t.account && other === t.account.toLowerCase()) return false;
      return lower.includes(other);
    });
  };

  let p2pOut = 0;
  let p2pIn = 0;
  let sampleSize = 0;
  const excluded = {
    recurring: 0,
    recurringByAmount: 0,
    internalTransfer: 0,
    p2p: 0,
    inflow: 0,
    byMonth: byMonthExcluded,
  };
  const droppedCategories = new Map<string, { count: number; total: number }>();
  // category -> month -> total out. Months without a row stay a real zero, so a
  // category that only fired once in three months medians down, not up.
  const perCategoryMonth = new Map<string, Map<string, number>>();

  for (const t of inWindow) {
    const isP2P = t.category === 'Transfers' || p2pPattern.test(t.description);

    if (isInternal(t)) {
      excluded.internalTransfer += 1;
      continue;
    }
    if (t.amount < 0) {
      if (matchesRecurring(t.description, recurringNames)) {
        excluded.recurring += 1;
        continue;
      }
      if (recurringItems.some((item) => matchesRecurringAmount(t, item))) {
        excluded.recurringByAmount += 1;
        continue;
      }
      const category = t.category ?? '';
      if (category && excludedCategories.has(category.toLowerCase())) {
        const entry = droppedCategories.get(category) ?? { count: 0, total: 0 };
        entry.count += 1;
        entry.total += -t.amount;
        droppedCategories.set(category, entry);
        continue;
      }
    }
    if (isP2P) {
      excluded.p2p += 1;
      if (t.amount < 0) p2pOut += -t.amount;
      else p2pIn += t.amount;
      continue;
    }
    if (t.amount >= 0) {
      excluded.inflow += 1;
      continue;
    }

    const out = -t.amount;
    sampleSize += 1;
    const key = t.category ?? 'uncategorized';
    const row = perCategoryMonth.get(key) ?? new Map<string, number>();
    row.set(monthOf(t.date), (row.get(monthOf(t.date)) ?? 0) + out);
    perCategoryMonth.set(key, row);
  }

  let outTotal = 0;
  const byCategory: BaselineCategory[] = [];
  for (const [category, perMonth] of perCategoryMonth) {
    const series = used.map((m) => perMonth.get(m) ?? 0);
    outTotal += series.reduce((a, b) => a + b, 0);
    byCategory.push({ category, avgMonthly: round2(collapse(series)) });
  }
  byCategory.sort((a, b) => b.avgMonthly - a.avgMonthly || a.category.localeCompare(b.category));

  // Under 'median' the headline is the sum of the category medians, so it stays
  // equal to the breakdown the owner is shown. Under 'mean' that sum is exactly
  // the plain mean anyway.
  const avgMonthlyVariableOut = round2(byCategory.reduce((sum, c) => sum + c.avgMonthly, 0));
  const meanMonthlyVariableOut = round2(outTotal / monthsUsed);
  // p2p stays a plain mean: it is a two-sided flow reported for the owner to
  // judge, not a number the projection burns.
  const avgMonthlyOut = round2(p2pOut / monthsUsed);
  const avgMonthlyIn = round2(p2pIn / monthsUsed);

  return {
    monthsUsed,
    months: used,
    aggregation,
    coverage,
    skippedMonths,
    window: { from: `${first}-01`, to: lastDayOfMonth(last) },
    avgMonthlyVariableOut,
    meanMonthlyVariableOut,
    dailyBurn: round2(avgMonthlyVariableOut / DAYS_PER_MONTH),
    byCategory,
    p2p: { avgMonthlyOut, avgMonthlyIn, net: round2(avgMonthlyIn - avgMonthlyOut) },
    sampleSize,
    excluded: {
      ...excluded,
      byCategory: [...droppedCategories.entries()]
        .map(([category, v]) => ({ category, count: v.count, total: round2(v.total) }))
        .sort((a, b) => b.total - a.total),
    },
  };
}
