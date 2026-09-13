import { describe, expect, it } from 'vitest';
import { MAX_PAYOFF_MONTHS, payoff } from './amortization.js';

describe('payoff', () => {
  it('clears an interest-free debt in balance / payment months', () => {
    const r = payoff(1000, 0, 250);
    expect(r).toMatchObject({ paysOff: true, months: 4, totalInterest: 0, totalPaid: 1000 });
  });

  it('charges interest on the declining balance', () => {
    const r = payoff(1000, 12, 100); // 1% a month
    expect(r.paysOff).toBe(true);
    expect(r.months).toBe(11);
    expect(r.firstMonthInterest).toBe(10);
    expect(r.totalInterest).toBeGreaterThan(50);
    expect(r.totalInterest).toBeLessThan(70);
    expect(r.totalPaid).toBe(1000 + (r.totalInterest as number));
  });

  it('takes longer at a higher APR for the same payment', () => {
    const cheap = payoff(5000, 5, 200).months as number;
    const dear = payoff(5000, 25, 200).months as number;
    expect(dear).toBeGreaterThan(cheap);
  });

  it('refuses when the payment does not cover the first month of interest', () => {
    const r = payoff(10_000, 24, 150); // 200/month of interest
    expect(r).toMatchObject({ paysOff: false, months: null, totalInterest: null });
    expect(r.message).toMatch(/does not cover the first month of interest/);
  });

  it('refuses a zero payment and handles a cleared balance', () => {
    expect(payoff(500, 10, 0).paysOff).toBe(false);
    expect(payoff(0, 10, 100)).toMatchObject({ paysOff: true, months: 0, totalInterest: 0 });
  });

  it('never simulates past the month cap', () => {
    const r = payoff(50_000, 19.99, 834); // barely above the interest
    if (!r.paysOff) expect(r.message).toMatch(/still owing/);
    else expect(r.months).toBeLessThanOrEqual(MAX_PAYOFF_MONTHS);
  });

  it('makes the last payment the remainder, not a full instalment', () => {
    const r = payoff(1000, 0, 300);
    expect(r.months).toBe(4);
    expect(r.finalPayment).toBe(100);
  });
});
