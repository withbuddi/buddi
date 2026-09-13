/**
 * Debt payoff arithmetic. Pure: no DB, no clock.
 *
 * Standard monthly-compounding amortization — interest accrues on the balance
 * at apr/12, the payment covers it, the rest reduces the principal. A payment
 * that does not cover one month of interest never pays the debt off; say so
 * rather than looping forever.
 */

/** Refuse to simulate past this many months (50 years). */
export const MAX_PAYOFF_MONTHS = 600;

export interface PayoffResult {
  paysOff: boolean;
  /** Months until the balance reaches zero; null when it never does. */
  months: number | null;
  /** Total interest paid over the life of the debt; null when it never pays off. */
  totalInterest: number | null;
  /** Principal + interest; null when it never pays off. */
  totalPaid: number | null;
  /** The final, usually smaller, payment; null when it never pays off. */
  finalPayment: number | null;
  /** Interest charged in the first month — what the payment has to beat. */
  firstMonthInterest: number;
  message?: string;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Months to clear `balance` paying `monthlyPayment` at `apr` percent per year.
 */
export function payoff(balance: number, apr: number, monthlyPayment: number): PayoffResult {
  if (!(balance > 0)) {
    return {
      paysOff: true,
      months: 0,
      totalInterest: 0,
      totalPaid: 0,
      finalPayment: 0,
      firstMonthInterest: 0,
      message: 'nothing owed',
    };
  }
  if (!(monthlyPayment > 0)) {
    return {
      paysOff: false,
      months: null,
      totalInterest: null,
      totalPaid: null,
      finalPayment: null,
      firstMonthInterest: 0,
      message: 'a payment of zero never pays anything off',
    };
  }

  const monthlyRate = apr / 100 / 12;
  const firstMonthInterest = round2(balance * monthlyRate);

  if (monthlyPayment <= firstMonthInterest) {
    return {
      paysOff: false,
      months: null,
      totalInterest: null,
      totalPaid: null,
      finalPayment: null,
      firstMonthInterest,
      message: `a payment of ${monthlyPayment.toFixed(2)} does not cover the first month of interest (${firstMonthInterest.toFixed(2)}); the balance grows`,
    };
  }

  let remaining = balance;
  let totalInterest = 0;
  let months = 0;
  let finalPayment = monthlyPayment;

  while (remaining > 0 && months < MAX_PAYOFF_MONTHS) {
    const interest = round2(remaining * monthlyRate);
    const due = round2(remaining + interest);
    const payment = Math.min(monthlyPayment, due);
    totalInterest = round2(totalInterest + interest);
    remaining = round2(due - payment);
    finalPayment = payment;
    months += 1;
  }

  if (remaining > 0) {
    return {
      paysOff: false,
      months: null,
      totalInterest: null,
      totalPaid: null,
      finalPayment: null,
      firstMonthInterest,
      message: `still owing after ${MAX_PAYOFF_MONTHS} months`,
    };
  }

  return {
    paysOff: true,
    months,
    totalInterest,
    totalPaid: round2(balance + totalInterest),
    finalPayment: round2(finalPayment),
    firstMonthInterest,
  };
}
