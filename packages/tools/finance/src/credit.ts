/**
 * Credit arithmetic. Pure: no DB, no clock — every date comes in as a string.
 *
 * Two mechanics drive a score more than anything else the owner can move in a
 * month: the balance reported at statement close (utilization) and whether the
 * minimum landed on time (payment history). Everything here computes one of
 * those two; the model explains, it never computes.
 */
import { payoff, type PayoffResult } from './amortization.js';

/** Utilization thresholds the scoring models notice, as fractions. */
export const GOOD_UTILIZATION = 0.3;
export const EXCELLENT_UTILIZATION = 0.1;

/** Days before the statement closes that a payment should already be posted. */
export const PAY_BEFORE_DAYS = 3;

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface CreditCard {
  name: string;
  balance: number;
  creditLimit: number | null;
  apr: number | null;
  minimumPayment: number;
  statementDay: number | null;
}

export interface CardUtilization extends CreditCard {
  /** Percent, 0-100+. Null when no limit is recorded. */
  utilization: number | null;
  /** Amount to PAY now so the balance lands at 30% / 10% of the limit. */
  paymentFor30: number | null;
  paymentFor10: number | null;
  /** The balance that remains once that payment is made. */
  targetBalanceFor30: number | null;
  targetBalanceFor10: number | null;
}

/** Percent used of the limit; null when the limit is unknown. */
export function utilizationPercent(balance: number, creditLimit: number | null): number | null {
  if (creditLimit === null || !(creditLimit > 0)) return null;
  return round2((balance / creditLimit) * 100);
}

/** The amount to PAY to bring the balance down to `target` of the limit. */
export function payDownTo(
  balance: number,
  creditLimit: number | null,
  target: number,
): number | null {
  if (creditLimit === null || !(creditLimit > 0)) return null;
  return round2(Math.max(0, balance - creditLimit * target));
}

/** The balance left once `payDownTo` has been paid; null when the limit is unknown. */
export function targetBalanceAt(
  balance: number,
  creditLimit: number | null,
  target: number,
): number | null {
  const payment = payDownTo(balance, creditLimit, target);
  return payment === null ? null : round2(balance - payment);
}

/**
 * APR descending, cards without an APR last, ties broken by utilization then
 * name — so the order is total and the same input always plans the same way.
 */
export function byAprDesc(a: CreditCard, b: CreditCard): number {
  const aprA = a.apr ?? -1;
  const aprB = b.apr ?? -1;
  if (aprA !== aprB) return aprB - aprA;
  const uA = utilizationPercent(a.balance, a.creditLimit) ?? -1;
  const uB = utilizationPercent(b.balance, b.creditLimit) ?? -1;
  if (uA !== uB) return uB - uA;
  return a.name.localeCompare(b.name);
}

export interface UtilizationReport {
  cards: CardUtilization[];
  /** Summed across cards that have a limit. */
  totalBalance: number;
  totalLimit: number;
  overallUtilization: number | null;
  /** What it would take to put EVERY card under the threshold. */
  totalToReach30: number;
  totalToReach10: number;
}

export function utilizationReport(cards: readonly CreditCard[]): UtilizationReport {
  const sorted = [...cards].sort(byAprDesc);
  const detailed: CardUtilization[] = sorted.map((c) => ({
    ...c,
    utilization: utilizationPercent(c.balance, c.creditLimit),
    paymentFor30: payDownTo(c.balance, c.creditLimit, GOOD_UTILIZATION),
    paymentFor10: payDownTo(c.balance, c.creditLimit, EXCELLENT_UTILIZATION),
    targetBalanceFor30: targetBalanceAt(c.balance, c.creditLimit, GOOD_UTILIZATION),
    targetBalanceFor10: targetBalanceAt(c.balance, c.creditLimit, EXCELLENT_UTILIZATION),
  }));
  const withLimit = detailed.filter((c) => c.creditLimit !== null && c.creditLimit > 0);
  const totalBalance = round2(withLimit.reduce((s, c) => s + c.balance, 0));
  const totalLimit = round2(withLimit.reduce((s, c) => s + (c.creditLimit as number), 0));
  return {
    cards: detailed,
    totalBalance,
    totalLimit,
    overallUtilization: totalLimit > 0 ? round2((totalBalance / totalLimit) * 100) : null,
    totalToReach30: round2(withLimit.reduce((s, c) => s + (c.paymentFor30 ?? 0), 0)),
    totalToReach10: round2(withLimit.reduce((s, c) => s + (c.paymentFor10 ?? 0), 0)),
  };
}

export interface PlanAllocation {
  name: string;
  apr: number | null;
  balance: number;
  creditLimit: number | null;
  /** Extra payment to make on top of the minimum. */
  payment: number;
  /** The balance once that payment is made. */
  balanceAfter: number;
  utilizationBefore: number | null;
  utilizationAfter: number | null;
  /** Why this card got money: under-30 rescue, avalanche overflow, or both. */
  reason: 'under-30' | 'avalanche' | 'under-30+avalanche' | null;
}

export interface CreditPlan {
  monthlyBudget: number;
  allocations: PlanAllocation[];
  allocated: number;
  unallocated: number;
  /** True when the budget could not bring every card under 30%. */
  shortfall: number;
  allCardsUnder30: boolean;
  overallUtilizationBefore: number | null;
  overallUtilizationAfter: number | null;
  /** Highest-APR card, the one the overflow attacks. */
  focusCard: string | null;
  focusMonthlyPayment: number | null;
  focusPayoff: PayoffResult | null;
}

/**
 * Deterministic allocation of one month of extra payment across cards.
 *
 * Two passes, in this order, because they are the two levers in priority order:
 *  1. bring every card under 30% utilization, highest APR first — utilization
 *     is the lever that moves a score inside one cycle;
 *  2. whatever is left goes to the highest-APR card (avalanche), because past
 *     that point the cheapest debt to kill is the dearest one.
 *
 * A budget smaller than pass 1 needs simply runs out mid-pass: the cards it
 * did reach are under 30, the rest are reported as a shortfall. Nothing is
 * ever allocated beyond a card's balance.
 */
export function creditPlan(cards: readonly CreditCard[], monthlyBudget: number): CreditPlan {
  const sorted = [...cards].sort(byAprDesc);
  const before = utilizationReport(sorted);
  const amounts = new Map<string, number>();
  const reasons = new Map<string, PlanAllocation['reason']>();
  const remainingBalance = new Map<string, number>();
  for (const c of sorted) {
    amounts.set(c.name, 0);
    reasons.set(c.name, null);
    remainingBalance.set(c.name, c.balance);
  }

  let budget = Math.max(0, round2(monthlyBudget));
  let shortfall = 0;

  // Pass 1 — every card under 30%, dearest APR first.
  for (const card of sorted) {
    const need = payDownTo(card.balance, card.creditLimit, GOOD_UTILIZATION);
    if (need === null || need <= 0) continue;
    const capped = Math.min(need, card.balance);
    const give = round2(Math.min(capped, budget));
    if (give > 0) {
      amounts.set(card.name, give);
      reasons.set(card.name, 'under-30');
      remainingBalance.set(card.name, round2(card.balance - give));
      budget = round2(budget - give);
    }
    if (give < capped) shortfall = round2(shortfall + (capped - give));
  }

  // Pass 2 — avalanche: the rest onto the dearest card that still owes.
  const focus = sorted.find((c) => (remainingBalance.get(c.name) as number) > 0) ?? null;
  if (focus && budget > 0) {
    const left = remainingBalance.get(focus.name) as number;
    const give = round2(Math.min(left, budget));
    if (give > 0) {
      const already = amounts.get(focus.name) as number;
      amounts.set(focus.name, round2(already + give));
      reasons.set(focus.name, already > 0 ? 'under-30+avalanche' : 'avalanche');
      remainingBalance.set(focus.name, round2(left - give));
      budget = round2(budget - give);
    }
  }

  const allocations: PlanAllocation[] = sorted.map((c) => {
    const payment = amounts.get(c.name) as number;
    const balanceAfter = remainingBalance.get(c.name) as number;
    return {
      name: c.name,
      apr: c.apr,
      balance: c.balance,
      creditLimit: c.creditLimit,
      payment,
      balanceAfter,
      utilizationBefore: utilizationPercent(c.balance, c.creditLimit),
      utilizationAfter: utilizationPercent(balanceAfter, c.creditLimit),
      reason: reasons.get(c.name) ?? null,
    };
  });

  const after = utilizationReport(
    sorted.map((c) => ({ ...c, balance: remainingBalance.get(c.name) as number })),
  );
  const allocated = round2(allocations.reduce((s, a) => s + a.payment, 0));

  // Months to clear the focus card paying its minimum plus this month's extra.
  const focusMonthlyPayment =
    focus === null ? null : round2(focus.minimumPayment + (amounts.get(focus.name) as number));
  const focusPayoff =
    focus === null || focus.apr === null || focusMonthlyPayment === null
      ? null
      : payoff(focus.balance, focus.apr, focusMonthlyPayment);

  return {
    monthlyBudget: round2(monthlyBudget),
    allocations,
    allocated,
    unallocated: round2(Math.max(0, budget)),
    shortfall,
    allCardsUnder30: allocations.every(
      (a) => a.utilizationAfter === null || a.utilizationAfter <= 30.0001,
    ),
    overallUtilizationBefore: before.overallUtilization,
    overallUtilizationAfter: after.overallUtilization,
    focusCard: focus?.name ?? null,
    focusMonthlyPayment,
    focusPayoff,
  };
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * The next occurrence of `dayOfMonth` on or after `from`, clamped to the end of
 * short months (31 → Feb 28/29). UTC throughout.
 */
export function nextDayOfMonth(from: string, dayOfMonth: number): string {
  const start = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < 3; i += 1) {
    const year = start.getUTCFullYear();
    const month = start.getUTCMonth() + i;
    const y = year + Math.floor(month / 12);
    const m = ((month % 12) + 12) % 12;
    const day = Math.min(dayOfMonth, daysInMonth(y, m));
    const candidate = new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
    if (candidate >= from) return candidate;
  }
  return from;
}

/** `date` shifted by `days`, UTC. */
export function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface UpcomingStatement extends CardUtilization {
  statementDate: string;
  daysUntil: number;
  /** Pay by here for the payment to post before the statement snapshot. */
  payBefore: string;
}

/**
 * Cards whose statement closes within `days` of `from`, soonest first, each
 * with what to pay before the snapshot to land at 30% and at 10%.
 */
export function upcomingStatements(
  cards: readonly CreditCard[],
  from: string,
  days: number,
): UpcomingStatement[] {
  const horizon = shiftDays(from, days);
  const out: UpcomingStatement[] = [];
  for (const card of cards) {
    if (card.statementDay === null) continue;
    const statementDate = nextDayOfMonth(from, card.statementDay);
    if (statementDate > horizon) continue;
    const payBeforeRaw = shiftDays(statementDate, -PAY_BEFORE_DAYS);
    out.push({
      ...card,
      utilization: utilizationPercent(card.balance, card.creditLimit),
      paymentFor30: payDownTo(card.balance, card.creditLimit, GOOD_UTILIZATION),
      paymentFor10: payDownTo(card.balance, card.creditLimit, EXCELLENT_UTILIZATION),
      targetBalanceFor30: targetBalanceAt(card.balance, card.creditLimit, GOOD_UTILIZATION),
      targetBalanceFor10: targetBalanceAt(card.balance, card.creditLimit, EXCELLENT_UTILIZATION),
      statementDate,
      daysUntil: Math.round(
        (Date.parse(`${statementDate}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
      ),
      payBefore: payBeforeRaw < from ? from : payBeforeRaw,
    });
  }
  return out.sort((a, b) =>
    a.statementDate === b.statementDate
      ? byAprDesc(a, b)
      : a.statementDate < b.statementDate
        ? -1
        : 1,
  );
}
