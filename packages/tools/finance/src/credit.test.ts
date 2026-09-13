import { describe, expect, it } from 'vitest';
import {
  byAprDesc,
  creditPlan,
  nextDayOfMonth,
  payDownTo,
  shiftDays,
  upcomingStatements,
  utilizationPercent,
  utilizationReport,
  type CreditCard,
} from './credit.js';

const card = (over: Partial<CreditCard> & { name: string }): CreditCard => ({
  balance: 0,
  creditLimit: null,
  apr: null,
  minimumPayment: 0,
  statementDay: null,
  ...over,
});

describe('utilizationPercent', () => {
  it('is the balance over the limit, in percent', () => {
    expect(utilizationPercent(3500, 10_000)).toBe(35);
    expect(utilizationPercent(0, 10_000)).toBe(0);
  });

  it('reports over 100 rather than clamping — an over-limit card is a real state', () => {
    expect(utilizationPercent(1100, 1000)).toBe(110);
  });

  it('is null without a usable limit', () => {
    expect(utilizationPercent(500, null)).toBeNull();
    expect(utilizationPercent(500, 0)).toBeNull();
  });
});

describe('payDownTo', () => {
  it('returns what must be paid to land on the threshold', () => {
    expect(payDownTo(3500, 10_000, 0.3)).toBe(500);
    expect(payDownTo(3500, 10_000, 0.1)).toBe(2500);
  });

  it('is zero when the card is already under it — never negative', () => {
    expect(payDownTo(1000, 10_000, 0.3)).toBe(0);
    expect(payDownTo(0, 10_000, 0.1)).toBe(0);
  });

  it('is null without a limit', () => {
    expect(payDownTo(3500, null, 0.3)).toBeNull();
  });
});

describe('byAprDesc', () => {
  it('sorts dearest first and puts cards without an APR last', () => {
    const cards = [
      card({ name: 'B', apr: 12 }),
      card({ name: 'A', apr: 24.99 }),
      card({ name: 'C', apr: null }),
      card({ name: 'D', apr: 19 }),
    ];
    expect([...cards].sort(byAprDesc).map((c) => c.name)).toEqual(['A', 'D', 'B', 'C']);
  });

  it('breaks APR ties by utilization, then by name — the order is total', () => {
    const cards = [
      card({ name: 'Z', apr: 20, balance: 100, creditLimit: 1000 }),
      card({ name: 'Y', apr: 20, balance: 900, creditLimit: 1000 }),
      card({ name: 'A', apr: 20, balance: 100, creditLimit: 1000 }),
    ];
    expect([...cards].sort(byAprDesc).map((c) => c.name)).toEqual(['Y', 'A', 'Z']);
  });
});

describe('utilizationReport', () => {
  const cards = [
    card({ name: 'Visa', balance: 900, creditLimit: 1000, apr: 26 }),
    card({ name: 'Amex', balance: 1000, creditLimit: 10_000, apr: 15 }),
    card({ name: 'Store', balance: 200, creditLimit: null, apr: 30 }),
  ];

  it('sorts by APR desc and computes per-card figures', () => {
    const report = utilizationReport(cards);
    expect(report.cards.map((c) => c.name)).toEqual(['Store', 'Visa', 'Amex']);
    const visa = report.cards.find((c) => c.name === 'Visa');
    expect(visa).toMatchObject({
      utilization: 90,
      paymentFor30: 600,
      targetBalanceFor30: 300,
      paymentFor10: 800,
      targetBalanceFor10: 100,
    });
  });

  it('leaves limitless cards out of the overall figure but keeps them listed', () => {
    const report = utilizationReport(cards);
    expect(report.totalBalance).toBe(1900);
    expect(report.totalLimit).toBe(11_000);
    expect(report.overallUtilization).toBe(17.27);
    expect(report.cards.find((c) => c.name === 'Store')).toMatchObject({
      utilization: null,
      paymentFor30: null,
      targetBalanceFor30: null,
      paymentFor10: null,
      targetBalanceFor10: null,
    });
    expect(report.totalToReach30).toBe(600);
    expect(report.totalToReach10).toBe(800);
  });

  it('has no overall utilization when nothing has a limit', () => {
    expect(utilizationReport([card({ name: 'X', balance: 5 })].map((c) => c)).overallUtilization)
      .toBeNull();
  });
});

describe('creditPlan', () => {
  const cards = [
    card({ name: 'Visa', balance: 900, creditLimit: 1000, apr: 26, minimumPayment: 40 }),
    card({ name: 'Amex', balance: 5000, creditLimit: 10_000, apr: 15, minimumPayment: 120 }),
  ];

  it('brings every card under 30% first, dearest APR first', () => {
    const plan = creditPlan(cards, 2600);
    const visa = plan.allocations.find((a) => a.name === 'Visa');
    const amex = plan.allocations.find((a) => a.name === 'Amex');
    // Visa needs 600 to reach 30%, Amex needs 2000.
    expect(visa?.payment).toBe(600);
    expect(amex?.payment).toBe(2000);
    expect(visa?.utilizationAfter).toBe(30);
    expect(amex?.utilizationAfter).toBe(30);
    expect(plan.allCardsUnder30).toBe(true);
    expect(plan.shortfall).toBe(0);
  });

  it('sends the leftover to the highest-APR card — avalanche', () => {
    const plan = creditPlan(cards, 3000);
    const visa = plan.allocations.find((a) => a.name === 'Visa');
    // 600 brings it to 30%, the 400 left over would clear it — capped at the
    // 300 still owed, so 100 of the budget is simply not needed.
    expect(visa?.payment).toBe(900);
    expect(visa?.balanceAfter).toBe(0);
    expect(visa?.reason).toBe('under-30+avalanche');
    expect(plan.focusCard).toBe('Visa');
    expect(plan.unallocated).toBe(100);
    expect(plan.overallUtilizationBefore).toBe(53.64);
    expect(plan.overallUtilizationAfter).toBe(27.27);
  });

  it('never allocates more than a card owes, and reports the unspent remainder', () => {
    const plan = creditPlan([cards[0] as CreditCard], 5000);
    expect(plan.allocations[0]?.payment).toBe(900);
    expect(plan.allocations[0]?.balanceAfter).toBe(0);
    expect(plan.unallocated).toBe(4100);
  });

  it('runs out mid-pass when the budget is too small, and says by how much', () => {
    const plan = creditPlan(cards, 1000);
    const visa = plan.allocations.find((a) => a.name === 'Visa');
    const amex = plan.allocations.find((a) => a.name === 'Amex');
    expect(visa?.payment).toBe(600); // dearest APR served in full first
    expect(amex?.payment).toBe(400); // partial
    expect(plan.allCardsUnder30).toBe(false);
    expect(plan.shortfall).toBe(1600);
    expect(plan.unallocated).toBe(0);
  });

  it('allocates nothing on a zero budget but still reports the gap', () => {
    const plan = creditPlan(cards, 0);
    expect(plan.allocated).toBe(0);
    expect(plan.shortfall).toBe(2600);
    expect(plan.overallUtilizationAfter).toBe(plan.overallUtilizationBefore);
  });

  it('prices the focus card off its minimum plus the extra', () => {
    const plan = creditPlan(cards, 3000);
    expect(plan.focusMonthlyPayment).toBe(940); // 40 minimum + 900 extra
    expect(plan.focusPayoff?.paysOff).toBe(true);
    expect(plan.focusPayoff?.months).toBe(1);
  });

  it('leaves the payoff null when the focus card has no APR', () => {
    const plan = creditPlan([card({ name: 'X', balance: 500, creditLimit: 1000 })], 100);
    expect(plan.focusCard).toBe('X');
    expect(plan.focusPayoff).toBeNull();
  });

  it('is deterministic — the same input plans the same way', () => {
    expect(creditPlan(cards, 1234)).toEqual(creditPlan([...cards].reverse(), 1234));
  });
});

describe('nextDayOfMonth', () => {
  it('is this month when the day is still ahead, including today', () => {
    expect(nextDayOfMonth('2026-09-13', 20)).toBe('2026-09-20');
    expect(nextDayOfMonth('2026-09-13', 13)).toBe('2026-09-13');
  });

  it('rolls to next month once the day has passed', () => {
    expect(nextDayOfMonth('2026-09-13', 5)).toBe('2026-10-05');
    expect(nextDayOfMonth('2026-12-20', 5)).toBe('2027-01-05');
  });

  it('clamps to the end of a short month', () => {
    expect(nextDayOfMonth('2026-02-01', 31)).toBe('2026-02-28');
    expect(nextDayOfMonth('2028-02-01', 31)).toBe('2028-02-29');
  });
});

describe('upcomingStatements', () => {
  const cards = [
    card({ name: 'Visa', balance: 900, creditLimit: 1000, apr: 26, statementDay: 18 }),
    card({ name: 'Amex', balance: 5000, creditLimit: 10_000, apr: 15, statementDay: 2 }),
    card({ name: 'NoDay', balance: 100, creditLimit: 1000, apr: 30 }),
  ];

  it('lists the cards closing inside the window, soonest first', () => {
    const rows = upcomingStatements(cards, '2026-09-13', 30);
    expect(rows.map((r) => r.name)).toEqual(['Visa', 'Amex']);
    expect(rows[0]).toMatchObject({
      statementDate: '2026-09-18',
      daysUntil: 5,
      payBefore: '2026-09-15',
      paymentFor30: 600,
      targetBalanceFor30: 300,
      paymentFor10: 800,
      targetBalanceFor10: 100,
    });
    expect(rows[1]?.statementDate).toBe('2026-10-02');
  });

  it('skips cards with no statement day and anything past the window', () => {
    const rows = upcomingStatements(cards, '2026-09-13', 7);
    expect(rows.map((r) => r.name)).toEqual(['Visa']);
  });

  it('never suggests paying in the past', () => {
    const rows = upcomingStatements(cards, '2026-09-17', 30);
    expect(rows[0]).toMatchObject({ statementDate: '2026-09-18', payBefore: '2026-09-17' });
  });
});

describe('shiftDays', () => {
  it('crosses month and year boundaries', () => {
    expect(shiftDays('2026-09-01', -3)).toBe('2026-08-29');
    expect(shiftDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
