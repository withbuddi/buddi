/**
 * Card ledgers: what a credit card will report at close, and what it did last
 * month. Pure — no DB, no clock, no timezone; every date arrives as a
 * `YYYY-MM-DD` string already rendered in the owner's zone.
 *
 * A card is a ledger in its own right. Charges live on it (negative: money
 * spent, which raises what is owed), payments and credits live on it too
 * (positive: what is owed goes down), and none of it is cash moving — the cash
 * moves once, later, when the card is paid. That single fact is why card
 * spending is kept out of the cash-flow projection and out of the spending
 * baseline by default: the payment is already modelled, and counting the
 * purchases as well would spend the same money twice.
 *
 * What the card ledger DOES give, and cash never could, is the question the
 * owner actually asks — "when does the GEICO premium hit, and what will the
 * statement say?" — which is `statementForecast` below.
 */
import { nextDayOfMonth, round2, utilizationPercent } from './credit.js';
import { daysBetween, occurrencesBetween, type RecurringItem } from './projection.js';

/* ------------------------------------------------------------------ *
 * Matching a cash-side payment to the card it pays
 * ------------------------------------------------------------------ */

/**
 * Words that say what a line IS rather than which card it belongs to. They are
 * dropped before comparing, so 'NFCU Mastercard payment' and 'NFCU Mastercard
 * Platinum 9012' are compared on 'nfcu mastercard' against
 * 'nfcu mastercard platinum 9012'.
 */
export const PAYMENT_STOPWORDS = new Set([
  'payment',
  'payments',
  'pay',
  'paying',
  'minimum',
  'min',
  'monthly',
  'autopay',
  'bill',
  'billing',
  'the',
  'and',
  'for',
  'due',
  'to',
  'of',
]);

/** Lowercased alphanumeric tokens, stopwords dropped, one-character noise gone. */
export function significantTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !PAYMENT_STOPWORDS.has(t));
}

/**
 * Does this recurring item look like the payment of that liability?
 *
 * A last-four (three digits or more) shared by both names identifies a card on
 * its own — that is what the digits are for. Otherwise two shared words are
 * needed ('nfcu' + 'mastercard'), so 'NFCU personal loan payment' does not get
 * read as a payment on the NFCU Mastercard. The one-token case is allowed only
 * when the item has a single distinguishing word to give ('X1 card payment'
 * → 'x1'), because then two is not a bar it could ever clear.
 *
 * Deliberately a heuristic over names the owner chose, never a link the owner
 * cannot see: the forecast reports the items it matched, by name.
 */
export function isPaymentToward(itemName: string, liabilityName: string): boolean {
  const item = significantTokens(itemName);
  const liability = new Set(significantTokens(liabilityName));
  const shared = item.filter((t) => liability.has(t));
  if (shared.length === 0) return false;
  if (shared.some((t) => /^\d{3,}$/.test(t))) return true;
  if (shared.length >= 2) return true;
  return item.length === 1;
}

/* ------------------------------------------------------------------ *
 * Statement forecast
 * ------------------------------------------------------------------ */

/** One dated movement between today and the statement close. */
export interface ForecastEvent {
  name: string;
  date: string;
  /** Signed effect on what is OWED: positive raises the balance, negative lowers it. */
  amount: number;
  source: 'card-charge' | 'card-credit' | 'payment';
}

export interface StatementForecastInput {
  /** Today, `YYYY-MM-DD`, in the owner's zone. */
  today: string;
  /** What is owed right now, positive. */
  balance: number;
  /** Day of month the issuer snapshots the balance. Null: no forecast is possible. */
  statementDay: number | null;
  creditLimit?: number | null;
  /** Active recurring items billed TO the card. */
  cardItems?: readonly RecurringItem[];
  /** Active recurring items on cash that pay this card. */
  paymentItems?: readonly RecurringItem[];
}

export interface StatementForecast {
  /** False when the card has no statement day recorded; every figure is then the balance as it stands. */
  hasForecast: boolean;
  closeDate: string | null;
  daysUntilClose: number | null;
  currentBalance: number;
  /** Recurring charges billed to the card and due on or before the close, positive. */
  chargesBeforeClose: number;
  /** Scheduled payments and card credits landing on or before the close, positive. */
  paymentsBeforeClose: number;
  /** balance + charges − payments. The balance the issuer is expected to report. */
  forecastBalance: number;
  utilization: number | null;
  forecastUtilization: number | null;
  /** Everything that moved the figure, by date — so the answer can name it. */
  events: ForecastEvent[];
}

/**
 * The balance the card is expected to report at its next close.
 *
 *   forecastBalance = balance today
 *                   + recurring charges billed to the card, due on or before the close
 *                   − scheduled payments that land on or before the close
 *
 * The window is `[today, closeDate]` inclusive: a charge dated today has hit
 * the card, and a payment dated on the closing day still posts into that
 * cycle. Utilization is computed off a balance floored at zero — a card in
 * credit reports 0% used, never a negative one.
 */
export function statementForecast(input: StatementForecastInput): StatementForecast {
  const balance = round2(input.balance);
  const creditLimit = input.creditLimit ?? null;
  const utilization = utilizationPercent(balance, creditLimit);

  if (input.statementDay === null || input.statementDay === undefined) {
    return {
      hasForecast: false,
      closeDate: null,
      daysUntilClose: null,
      currentBalance: balance,
      chargesBeforeClose: 0,
      paymentsBeforeClose: 0,
      forecastBalance: balance,
      utilization,
      forecastUtilization: utilization,
      events: [],
    };
  }

  const closeDate = nextDayOfMonth(input.today, input.statementDay);
  const events: ForecastEvent[] = [];
  let charges = 0;
  let payments = 0;

  for (const item of input.cardItems ?? []) {
    for (const date of occurrencesBetween(item, input.today, closeDate)) {
      const magnitude = round2(Math.abs(item.amount));
      if (item.kind === 'charge') {
        charges = round2(charges + magnitude);
        events.push({ name: item.name, date, amount: magnitude, source: 'card-charge' });
      } else {
        // A recurring credit on the card (a refund, a statement credit) is a
        // payment as far as what is owed is concerned.
        payments = round2(payments + magnitude);
        events.push({ name: item.name, date, amount: -magnitude, source: 'card-credit' });
      }
    }
  }

  for (const item of input.paymentItems ?? []) {
    for (const date of occurrencesBetween(item, input.today, closeDate)) {
      const magnitude = round2(Math.abs(item.amount));
      payments = round2(payments + magnitude);
      events.push({ name: item.name, date, amount: -magnitude, source: 'payment' });
    }
  }

  const forecastBalance = round2(balance + charges - payments);
  events.sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : a.date < b.date ? -1 : 1));

  return {
    hasForecast: true,
    closeDate,
    daysUntilClose: daysBetween(input.today, closeDate),
    currentBalance: balance,
    chargesBeforeClose: charges,
    paymentsBeforeClose: payments,
    forecastBalance,
    utilization,
    forecastUtilization: utilizationPercent(Math.max(0, forecastBalance), creditLimit),
    events,
  };
}

/* ------------------------------------------------------------------ *
 * Card activity
 * ------------------------------------------------------------------ */

/** Interest is a charge, but not a purchase; it is reported on its own line. */
export const INTEREST_PATTERN =
  /\b(interest|finance charge|finance charges|apr charge)\b/i;

export interface CardTransaction {
  occurredOn: string;
  /** Signed: negative is a charge, positive is a payment or credit. */
  amount: number;
  description: string;
  category?: string | null;
}

export function isInterestRow(txn: CardTransaction): boolean {
  const category = txn.category ?? '';
  return INTEREST_PATTERN.test(category) || INTEREST_PATTERN.test(txn.description);
}

export interface CardMonth {
  /** `YYYY-MM`. */
  month: string;
  /** Purchases, positive. Interest is NOT included here. */
  charges: number;
  /** Payments and credits, positive. */
  payments: number;
  /** Interest and finance charges, positive. */
  interest: number;
  /** charges + interest − payments: how much the balance owed grew this month. */
  netBalanceChange: number;
  count: number;
}

export interface CardActivity {
  months: CardMonth[];
  totals: Omit<CardMonth, 'month'>;
}

/** `YYYY-MM` of a date string, and the month `n` months before a given month. */
function monthOf(date: string): string {
  return date.slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + delta;
  const y = year + Math.floor(index / 12);
  const m = ((index % 12) + 12) % 12;
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * Charges, payments and interest per month for one card, oldest month first.
 *
 * The window is the current month and the `months - 1` before it; a month with
 * no activity is still listed, as a row of zeros, because "nothing happened on
 * that card in July" is an answer and a missing row is not. Transactions
 * outside the window are ignored.
 */
export function summarizeCardActivity(
  txns: readonly CardTransaction[],
  opts: { today: string; months: number },
): CardActivity {
  const months = Math.max(1, Math.floor(opts.months));
  const last = monthOf(opts.today);
  const first = shiftMonth(last, -(months - 1));

  const buckets = new Map<string, CardMonth>();
  for (let i = 0; i < months; i += 1) {
    const month = shiftMonth(first, i);
    buckets.set(month, {
      month,
      charges: 0,
      payments: 0,
      interest: 0,
      netBalanceChange: 0,
      count: 0,
    });
  }

  for (const txn of txns) {
    const bucket = buckets.get(monthOf(txn.occurredOn));
    if (!bucket) continue;
    const magnitude = round2(Math.abs(txn.amount));
    if (txn.amount > 0) {
      bucket.payments = round2(bucket.payments + magnitude);
    } else if (isInterestRow(txn)) {
      bucket.interest = round2(bucket.interest + magnitude);
    } else {
      bucket.charges = round2(bucket.charges + magnitude);
    }
    bucket.count += 1;
  }

  const rows = [...buckets.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
  for (const row of rows) {
    row.netBalanceChange = round2(row.charges + row.interest - row.payments);
  }

  const totals = rows.reduce(
    (sum, row) => ({
      charges: round2(sum.charges + row.charges),
      payments: round2(sum.payments + row.payments),
      interest: round2(sum.interest + row.interest),
      netBalanceChange: round2(sum.netBalanceChange + row.netBalanceChange),
      count: sum.count + row.count,
    }),
    { charges: 0, payments: 0, interest: 0, netBalanceChange: 0, count: 0 },
  );

  return { months: rows, totals };
}
