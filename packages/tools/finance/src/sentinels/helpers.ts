/**
 * The decisions every finance sentinel makes, as pure functions.
 *
 * Each sentinel is then two things and nothing else: a query that shapes rows,
 * and a call into here. That split is what makes the rules testable without a
 * database — and it keeps the judgement ("three days is urgent, thirty is
 * not") in one readable place instead of scattered through SQL.
 *
 * No clock and no timezone: `today` always comes in as a `YYYY-MM-DD` string
 * already rendered in the owner's zone.
 */
import { nextDayOfMonth, utilizationPercent } from '../credit.js';
import { daysBetween } from '../projection.js';
import type { Finding } from './types.js';

/** A breach inside this many days is urgent rather than informational. */
export const URGENT_BREACH_DAYS = 7;
/** A minimum payment falling inside this many days is urgent. */
export const URGENT_DUE_DAYS = 3;
/** A statement closing inside this many days is worth a nudge. */
export const STATEMENT_WINDOW_DAYS = 3;
/** Utilization (percent) above which a closing statement is worth reporting. */
export const STATEMENT_UTILIZATION = 30;
/** A balance not confirmed for this many days is stale. */
export const STALE_BALANCE_DAYS = 14;
/** A receipt unmatched for this many days has stopped waiting for its charge. */
export const UNMATCHED_RECEIPT_DAYS = 7;
/** An artifact nothing referenced within this many hours was never processed. */
export const UNPROCESSED_ARTIFACT_HOURS = 24;

function money(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

/* ------------------------------------------------------------------ *
 * floor-breach
 * ------------------------------------------------------------------ */

export interface FloorBreachInput {
  /** From the projection: the first day the balance drops below the floor. */
  firstBreachDate: string | null;
  minBalance: number;
  minBalanceDate: string;
  safetyFloor: number;
  currency: string;
  /** The projection's first day, in the owner's zone. */
  startDate: string;
  horizonDays: number;
}

/**
 * One finding, or none. A breach inside a week is urgent: there is still time
 * to move something. A breach further out is information — the owner may well
 * fix it by living their month, and waking them at 3am for day 26 is noise.
 *
 * With no safety floor recorded the floor is zero, so "breach" means the
 * account actually goes negative; that is never not worth saying.
 */
export function floorBreachFinding(input: FloorBreachInput): Finding | null {
  const { firstBreachDate } = input;
  if (firstBreachDate === null) return null;
  const daysAway = daysBetween(input.startDate, firstBreachDate);
  if (daysAway < 0 || daysAway >= input.horizonDays) return null;
  const severity = daysAway <= URGENT_BREACH_DAYS ? 'urgent' : 'info';
  const floorPhrase =
    input.safetyFloor > 0
      ? `the ${money(input.safetyFloor, input.currency)} safety floor`
      : 'zero';
  return {
    key: `floor-breach:${firstBreachDate}`,
    severity,
    title:
      severity === 'urgent'
        ? `Cash drops below ${floorPhrase} on ${firstBreachDate}`
        : `Cash is projected below ${floorPhrase} on ${firstBreachDate}`,
    detail:
      `The projection crosses ${floorPhrase} on ${firstBreachDate}, ` +
      `${daysAway} day${daysAway === 1 ? '' : 's'} from ${input.startDate}. ` +
      `The low point is ${money(input.minBalance, input.currency)} on ${input.minBalanceDate}.`,
    agentId: 'finance-advisor',
    data: {
      firstBreachDate,
      daysAway,
      minBalance: input.minBalance,
      minBalanceDate: input.minBalanceDate,
      safetyFloor: input.safetyFloor,
      currency: input.currency,
      horizonDays: input.horizonDays,
    },
  };
}

/* ------------------------------------------------------------------ *
 * minimum-due
 * ------------------------------------------------------------------ */

export interface RecurringCharge {
  name: string;
  /** False for an item attached to an account the cash flow cannot see. */
  includedInCashflow: boolean;
}

export interface LiabilityDue {
  name: string;
  minimumPayment: number;
  dueDay: number;
  balance: number;
  /** True when a payment_events row already marks this due date paid. */
  paid: boolean;
}

/** Letters and digits only — 'Amex Gold *1234' and 'amex gold' meet here. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * True when a recurring charge we actually model would pay this liability.
 *
 * The point is narrow: if the owner set up autopay AND told us about it as a
 * recurring item on an account the projection can see, the money is already
 * accounted for and nothing needs saying. An item on an excluded account (a
 * 401k, a brokerage) is not a payment the cash flow believes in, so it does
 * not silence the sentinel.
 */
export function autopayModeled(
  liabilityName: string,
  items: readonly RecurringCharge[],
): boolean {
  const target = normalizeName(liabilityName);
  if (target === '') return false;
  return items.some((item) => {
    if (!item.includedInCashflow) return false;
    const name = normalizeName(item.name);
    if (name === '') return false;
    return name.includes(target) || target.includes(name);
  });
}

export interface MinimumDueOptions {
  today: string;
  currency: string;
  items: readonly RecurringCharge[];
}

/**
 * A minimum payment due within three days that nothing has paid and nothing
 * will pay on its own. This is the one condition that outranks everything
 * else in the credit coach's priority order, so it is always urgent.
 */
export function minimumDueFindings(
  liabilities: readonly LiabilityDue[],
  opts: MinimumDueOptions,
): Finding[] {
  const out: Finding[] = [];
  for (const liability of liabilities) {
    if (!(liability.minimumPayment > 0)) continue;
    const dueDate = nextDayOfMonth(opts.today, liability.dueDay);
    const daysAway = daysBetween(opts.today, dueDate);
    if (daysAway > URGENT_DUE_DAYS) continue;
    if (liability.paid) continue;
    if (autopayModeled(liability.name, opts.items)) continue;
    out.push({
      key: `minimum-due:${liability.name}:${dueDate}`,
      severity: 'urgent',
      title: `${liability.name}: ${money(liability.minimumPayment, opts.currency)} minimum due ${dueDate}`,
      detail:
        `The minimum payment on ${liability.name} is due on ${dueDate} ` +
        `(${daysAway === 0 ? 'today' : `in ${daysAway} day${daysAway === 1 ? '' : 's'}`}). ` +
        'No payment is recorded for it and no modelled autopay covers it.',
      agentId: 'credit-coach',
      data: {
        liability: liability.name,
        dueDate,
        daysAway,
        minimumPayment: liability.minimumPayment,
        balance: liability.balance,
        currency: opts.currency,
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * statement-closing
 * ------------------------------------------------------------------ */

export interface ClosingCard {
  name: string;
  balance: number;
  creditLimit: number | null;
  statementDay: number | null;
}

/**
 * Cards closing within three days while still over 30% used. Paying before the
 * closing day is the only thing that changes what the bureaus see for that
 * cycle, which is what makes the window worth a nudge — and only a nudge, so
 * it is never urgent.
 */
export function statementClosingFindings(
  cards: readonly ClosingCard[],
  opts: { today: string; currency: string },
): Finding[] {
  const out: Finding[] = [];
  for (const card of cards) {
    if (card.statementDay === null) continue;
    const utilization = utilizationPercent(card.balance, card.creditLimit);
    if (utilization === null || utilization <= STATEMENT_UTILIZATION) continue;
    const closeDate = nextDayOfMonth(opts.today, card.statementDay);
    const daysAway = daysBetween(opts.today, closeDate);
    if (daysAway > STATEMENT_WINDOW_DAYS) continue;
    out.push({
      key: `statement:${card.name}:${closeDate}`,
      severity: 'info',
      title: `${card.name} closes ${closeDate} at ${utilization.toFixed(1)}% used`,
      detail:
        `${card.name} reports its balance on ${closeDate}, ` +
        `${daysAway === 0 ? 'today' : `in ${daysAway} day${daysAway === 1 ? '' : 's'}`}, ` +
        `and is at ${utilization.toFixed(1)}% of its limit. ` +
        'Paying before that day is what changes the reported utilization for this cycle.',
      agentId: 'credit-coach',
      data: {
        card: card.name,
        closeDate,
        daysAway,
        utilization,
        balance: card.balance,
        creditLimit: card.creditLimit,
        currency: opts.currency,
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * stale-balance
 * ------------------------------------------------------------------ */

export interface StaleAccount {
  name: string;
  balance: number;
  balanceAsOf: string;
}

/**
 * A projection is only as good as the balance it starts from. Two weeks
 * without a confirmation is the point where the start balance has quietly
 * become a guess, so the finding names the account and the date, one each —
 * asking about five accounts at once gets none of them answered.
 */
export function staleBalanceFindings(
  accounts: readonly StaleAccount[],
  opts: { today: string; currency: string; maxAgeDays?: number },
): Finding[] {
  const maxAge = opts.maxAgeDays ?? STALE_BALANCE_DAYS;
  const out: Finding[] = [];
  for (const account of accounts) {
    const age = daysBetween(account.balanceAsOf, opts.today);
    if (age <= maxAge) continue;
    out.push({
      key: `stale:${account.name}:${account.balanceAsOf}`,
      severity: 'info',
      title: `${account.name} balance is ${age} days old`,
      detail:
        `${account.name} was last confirmed at ${money(account.balance, opts.currency)} ` +
        `on ${account.balanceAsOf}, ${age} days ago. Every projection starts from that number.`,
      agentId: 'finance-advisor',
      data: {
        account: account.name,
        balance: account.balance,
        balanceAsOf: account.balanceAsOf,
        ageDays: age,
        currency: opts.currency,
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * unmatched-receipts
 * ------------------------------------------------------------------ */

export interface UnmatchedReceipt {
  id: string;
  merchant: string;
  occurredOn: string;
  total: number;
  currency: string;
}

/**
 * One finding for the whole set, never one per receipt: a receipt that never
 * found its charge is a bookkeeping loose end, and five separate nudges about
 * loose ends is how an owner learns to ignore the sentinel entirely.
 */
export function unmatchedReceiptsFinding(
  receipts: readonly UnmatchedReceipt[],
  opts: { today: string; maxAgeDays?: number },
): Finding | null {
  const maxAge = opts.maxAgeDays ?? UNMATCHED_RECEIPT_DAYS;
  const stale = receipts
    .filter((r) => daysBetween(r.occurredOn, opts.today) > maxAge)
    .sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : 0));
  const oldest = stale[0];
  if (oldest === undefined) return null;
  const lines = stale.map(
    (r) => `- ${r.occurredOn} ${r.merchant} ${money(r.total, r.currency)}`,
  );
  return {
    key: `unmatched-receipts:${oldest.occurredOn}:${stale.length}`,
    severity: 'info',
    title: `${stale.length} receipt${stale.length === 1 ? '' : 's'} still unmatched after ${maxAge} days`,
    detail: [
      `These receipts have no transaction behind them, the oldest from ${oldest.occurredOn}:`,
      ...lines,
      'Either the charge never posted, or the ledger is missing it.',
    ].join('\n'),
    agentId: 'finance-advisor',
    data: { count: stale.length, maxAgeDays: maxAge, receipts: stale },
  };
}

/* ------------------------------------------------------------------ *
 * unprocessed-artifacts
 * ------------------------------------------------------------------ */

export interface UnprocessedArtifact {
  id: string;
  filename: string | null;
  kind: string;
  mime: string;
  /** `YYYY-MM-DD`, rendered in the owner's zone. */
  createdOn: string;
  ageHours: number;
}

/**
 * Documents the owner handed in that nothing ever read. A statement that was
 * sent, acknowledged and then never staged is the most expensive kind of
 * silence: the owner believes the ledger has it.
 */
export function unprocessedArtifactsFinding(
  artifacts: readonly UnprocessedArtifact[],
): Finding | null {
  if (artifacts.length === 0) return null;
  const sorted = [...artifacts].sort((a, b) => b.ageHours - a.ageHours);
  const oldest = sorted[0] as UnprocessedArtifact;
  const lines = sorted.map(
    (a) => `- ${a.createdOn} ${a.filename ?? `(${a.kind}, ${a.mime})`}`,
  );
  return {
    key: `unprocessed-artifacts:${oldest.createdOn}:${sorted.length}`,
    severity: 'info',
    title: `${sorted.length} file${sorted.length === 1 ? '' : 's'} handed in and never used`,
    detail: [
      `Nothing in the ledger references these, the oldest from ${oldest.createdOn}:`,
      ...lines,
      'They were received but no transaction, receipt or staged import came out of them.',
    ].join('\n'),
    agentId: 'finance-advisor',
    data: { count: sorted.length, artifacts: sorted },
  };
}
