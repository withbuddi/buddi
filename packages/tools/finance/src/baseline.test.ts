import { describe, expect, it } from 'vitest';
import type { BaselineTransaction } from './baseline.js';
import { computeBaseline, normalizeTokens, tokenOverlap } from './baseline.js';

const TODAY = '2026-09-13';

const txn = (over: Partial<BaselineTransaction>): BaselineTransaction => ({
  date: '2026-08-10',
  amount: -30,
  description: 'Bakery',
  category: 'Groceries',
  account: 'Checking',
  ...over,
});

describe('normalizeTokens / tokenOverlap', () => {
  it('lowercases and strips digits and punctuation', () => {
    expect(normalizeTokens("Payment to Macy's #4281")).toEqual(['payment', 'macys']);
  });

  it('matches a short recurring name inside a longer description', () => {
    expect(tokenOverlap('Payment to xfinity', 'xfinity')).toBe(1);
    expect(tokenOverlap('ACH Debit The Park At Franklin Web Pmts', 'Rent - The Park at Franklin'))
      .toBeGreaterThanOrEqual(0.6);
  });

  it('does not match unrelated descriptions', () => {
    expect(tokenOverlap('Payment to Capital One', 'NFCU Mastercard minimum payment'))
      .toBeLessThan(0.6);
    expect(tokenOverlap('Uber Eats', 'HostGator')).toBe(0);
  });
});

describe('computeBaseline window', () => {
  it('uses only complete months before the current one', () => {
    const txns = [
      txn({ date: '2026-09-02', amount: -900 }), // current month: ignored
      txn({ date: '2026-08-02', amount: -100 }),
      txn({ date: '2026-07-02', amount: -200 }),
      txn({ date: '2026-06-02', amount: -300 }),
      txn({ date: '2026-05-02', amount: -999 }), // outside a 3-month window
    ];
    const b = computeBaseline(txns, { today: TODAY, months: 3 });
    expect(b.monthsUsed).toBe(3);
    expect(b.window).toEqual({ from: '2026-06-01', to: '2026-08-31' });
    expect(b.avgMonthlyVariableOut).toBe(200);
    expect(b.sampleSize).toBe(3);
    expect(b.dailyBurn).toBeCloseTo(200 / (365.25 / 12), 2);
  });

  it('reports monthsUsed when less history exists than asked for', () => {
    const b = computeBaseline([txn({ date: '2026-08-02', amount: -150 })], {
      today: TODAY,
      months: 3,
    });
    expect(b.monthsUsed).toBe(1);
    expect(b.avgMonthlyVariableOut).toBe(150);
  });

  it('returns an empty baseline when no complete month has data', () => {
    const b = computeBaseline([txn({ date: '2026-09-05', amount: -80 })], { today: TODAY });
    expect(b).toMatchObject({ monthsUsed: 0, dailyBurn: 0, window: null, sampleSize: 0 });
  });
});

describe('computeBaseline exclusions', () => {
  it('drops outflows that fuzzy-match an active recurring item', () => {
    const txns = [
      txn({ date: '2026-08-03', amount: -50.99, description: 'Payment to xfinity' }),
      txn({ date: '2026-08-04', amount: -40, description: 'Stop & Shop' }),
    ];
    const b = computeBaseline(txns, {
      today: TODAY,
      months: 1,
      recurringNames: ['xfinity', 'New York Times'],
    });
    expect(b.avgMonthlyVariableOut).toBe(40);
    expect(b.excluded.recurring).toBe(1);
  });

  it('drops internal transfers, by pattern and by account name', () => {
    const txns = [
      txn({ date: '2026-08-05', amount: -500, description: 'Online Transfer to x9145' }),
      txn({ date: '2026-08-06', amount: -300, description: 'Transfer To Savings 4281' }),
      txn({ date: '2026-08-07', amount: -200, description: 'Funds Transfer from Acct 1234' }),
      txn({
        date: '2026-08-08',
        amount: -100,
        description: 'Move to PNC Reserve',
        account: 'PNC Spend',
      }),
      txn({ date: '2026-08-09', amount: -25, description: 'Dunkin Donuts' }),
    ];
    const b = computeBaseline(txns, {
      today: TODAY,
      months: 1,
      accountNames: ['PNC Spend', 'PNC Reserve'],
    });
    expect(b.excluded.internalTransfer).toBe(4);
    expect(b.avgMonthlyVariableOut).toBe(25);
  });

  it('accepts an override of the internal-transfer patterns', () => {
    const txns = [txn({ date: '2026-08-05', amount: -500, description: 'Online Transfer to x9145' })];
    const b = computeBaseline(txns, {
      today: TODAY,
      months: 1,
      internalTransferPatterns: [/never matches/],
    });
    expect(b.excluded.internalTransfer).toBe(0);
    expect(b.avgMonthlyVariableOut).toBe(500);
  });

  it('reports p2p separately instead of burning it', () => {
    const txns = [
      txn({ date: '2026-08-02', amount: -200, description: 'Transfer to Zelle', category: null }),
      txn({ date: '2026-08-03', amount: -100, description: 'Transfer to Lemfi', category: null }),
      txn({ date: '2026-08-04', amount: 150, description: 'Transfer via Zelle', category: null }),
      txn({ date: '2026-08-05', amount: -60, description: 'Anything', category: 'Transfers' }),
      txn({ date: '2026-08-06', amount: -40, description: 'Costco' }),
    ];
    const b = computeBaseline(txns, { today: TODAY, months: 1 });
    expect(b.avgMonthlyVariableOut).toBe(40);
    expect(b.p2p).toEqual({ avgMonthlyOut: 360, avgMonthlyIn: 150, net: -210 });
    expect(b.excluded.p2p).toBe(4);
  });

  it('ignores ordinary inflows and breaks the burn down by category', () => {
    const txns = [
      txn({ date: '2026-08-02', amount: 3000, description: 'Payroll', category: 'Paychecks' }),
      txn({ date: '2026-08-03', amount: -60, category: 'Groceries' }),
      txn({ date: '2026-08-04', amount: -40, category: 'Groceries' }),
      txn({ date: '2026-08-05', amount: -90, description: 'Uber', category: 'Travel' }),
      txn({ date: '2026-08-06', amount: -10, description: 'Odd', category: null }),
    ];
    const b = computeBaseline(txns, { today: TODAY, months: 1 });
    expect(b.excluded.inflow).toBe(1);
    expect(b.avgMonthlyVariableOut).toBe(200);
    expect(b.byCategory).toEqual([
      { category: 'Groceries', avgMonthly: 100 },
      { category: 'Travel', avgMonthly: 90 },
      { category: 'uncategorized', avgMonthly: 10 },
    ]);
  });
});

describe('computeBaseline aggregation', () => {
  // June quiet, July blown out by a one-off, August normal — the shape of the
  // real ledger that produced this option.
  const threeMonths = [
    txn({ date: '2026-06-05', amount: -400, category: 'Groceries' }),
    txn({ date: '2026-07-05', amount: -400, category: 'Groceries' }),
    txn({ date: '2026-07-06', amount: -18000, category: 'General Merchandise' }),
    txn({ date: '2026-08-05', amount: -500, category: 'Groceries' }),
  ];

  it('defaults to a median that shrugs off the one-off month', () => {
    const b = computeBaseline(threeMonths, { today: TODAY, months: 3 });
    expect(b.aggregation).toBe('median');
    expect(b.months).toEqual(['2026-06', '2026-07', '2026-08']);
    // Groceries median of [400, 400, 500] = 400; the lone 18k medians to 0.
    expect(b.byCategory).toEqual([
      { category: 'Groceries', avgMonthly: 400 },
      { category: 'General Merchandise', avgMonthly: 0 },
    ]);
    expect(b.avgMonthlyVariableOut).toBe(400);
    expect(b.dailyBurn).toBeCloseTo(400 / (365.25 / 12), 2);
  });

  it('reports the mean alongside the median so the gap is visible', () => {
    const b = computeBaseline(threeMonths, { today: TODAY, months: 3 });
    expect(b.meanMonthlyVariableOut).toBe(6433.33);
    expect(b.avgMonthlyVariableOut).toBeLessThan(b.meanMonthlyVariableOut);
  });

  it("aggregation 'mean' reproduces the old plain average", () => {
    const b = computeBaseline(threeMonths, { today: TODAY, months: 3, aggregation: 'mean' });
    expect(b.aggregation).toBe('mean');
    expect(b.avgMonthlyVariableOut).toBe(6433.33);
    expect(b.avgMonthlyVariableOut).toBe(b.meanMonthlyVariableOut);
  });

  it('takes the middle pair when an even number of months is measured', () => {
    const b = computeBaseline(
      [
        txn({ date: '2026-05-05', amount: -100 }),
        txn({ date: '2026-06-05', amount: -200 }),
        txn({ date: '2026-07-05', amount: -300 }),
        txn({ date: '2026-08-05', amount: -1000 }),
      ],
      { today: TODAY, months: 4 },
    );
    expect(b.monthsUsed).toBe(4);
    expect(b.avgMonthlyVariableOut).toBe(250);
  });

  it('counts a month with no rows in that category as a real zero', () => {
    const b = computeBaseline(
      [
        txn({ date: '2026-06-05', amount: -90, category: 'Travel' }),
        txn({ date: '2026-07-05', amount: -60, category: 'Groceries' }),
        txn({ date: '2026-08-05', amount: -60, category: 'Groceries' }),
      ],
      { today: TODAY, months: 3 },
    );
    // Travel fired once in three months: [90, 0, 0] medians to 0, not 90.
    expect(b.byCategory).toEqual([
      { category: 'Groceries', avgMonthly: 60 },
      { category: 'Travel', avgMonthly: 0 },
    ]);
  });
});

describe('computeBaseline recurring match by amount', () => {
  const rent = {
    name: 'Rent - The Park at Franklin',
    amount: 2111,
    account: 'NFCU Easy Checking',
    category: 'Rent',
  };

  it('catches a recurring charge posting under an alias description', () => {
    const b = computeBaseline(
      [
        txn({
          date: '2026-08-01',
          amount: -2111,
          description: 'The Park Hotels',
          category: 'Rent',
          account: 'NFCU Easy Checking',
        }),
        txn({ date: '2026-08-04', amount: -40, description: 'Stop & Shop' }),
      ],
      { today: TODAY, months: 1, recurringItems: [rent] },
    );
    expect(b.excluded.recurringByAmount).toBe(1);
    expect(b.excluded.recurring).toBe(0);
    expect(b.avgMonthlyVariableOut).toBe(40);
  });

  it('still prefers the name match, and counts it separately', () => {
    const b = computeBaseline(
      [
        txn({
          date: '2026-08-01',
          amount: -2111,
          description: 'ACH The Park At Franklin Web Pmts',
          category: 'Rent',
          account: 'NFCU Easy Checking',
        }),
      ],
      { today: TODAY, months: 1, recurringItems: [rent] },
    );
    expect(b.excluded.recurring).toBe(1);
    expect(b.excluded.recurringByAmount).toBe(0);
  });

  it('accepts an amount within 2% but not one outside it', () => {
    const item = { name: 'xfinity', amount: 100 };
    const near = computeBaseline([txn({ date: '2026-08-02', amount: -102, description: 'Odd' })], {
      today: TODAY,
      months: 1,
      recurringItems: [item],
    });
    expect(near.excluded.recurringByAmount).toBe(1);
    const far = computeBaseline([txn({ date: '2026-08-02', amount: -103, description: 'Odd' })], {
      today: TODAY,
      months: 1,
      recurringItems: [item],
    });
    expect(far.excluded.recurringByAmount).toBe(0);
    expect(far.avgMonthlyVariableOut).toBe(103);
  });

  it('will not swallow a same-amount charge on another account', () => {
    const b = computeBaseline(
      [
        txn({
          date: '2026-08-01',
          amount: -2111,
          description: 'Some Hotel',
          category: 'Rent',
          account: 'PNC Spend',
        }),
      ],
      { today: TODAY, months: 1, recurringItems: [rent] },
    );
    expect(b.excluded.recurringByAmount).toBe(0);
    expect(b.avgMonthlyVariableOut).toBe(2111);
  });

  it('will not swallow a same-amount charge in a contradicting category', () => {
    const b = computeBaseline(
      [
        txn({
          date: '2026-08-01',
          amount: -2111,
          description: 'Big TV',
          category: 'Electronics',
          account: 'NFCU Easy Checking',
        }),
      ],
      { today: TODAY, months: 1, recurringItems: [rent] },
    );
    expect(b.excluded.recurringByAmount).toBe(0);
    expect(b.avgMonthlyVariableOut).toBe(2111);
  });

  it('matches on amount alone when the item names no account or category', () => {
    const b = computeBaseline(
      [txn({ date: '2026-08-01', amount: -63.98, description: 'Web Host Co', category: 'Utilities' })],
      { today: TODAY, months: 1, recurringItems: [{ name: 'HostGator', amount: 63.98 }] },
    );
    expect(b.excluded.recurringByAmount).toBe(1);
  });

  it('leaves inflows of the same magnitude alone', () => {
    const b = computeBaseline(
      [txn({ date: '2026-08-01', amount: 2111, description: 'Refund', category: 'Rent', account: 'NFCU Easy Checking' })],
      { today: TODAY, months: 1, recurringItems: [rent] },
    );
    expect(b.excluded.recurringByAmount).toBe(0);
    expect(b.excluded.inflow).toBe(1);
  });
});

describe('computeBaseline excludeCategories', () => {
  const debt = [
    txn({ date: '2026-08-02', amount: -18000, description: 'Card Payoff', category: 'Credit Card Payments' }),
    txn({ date: '2026-08-03', amount: -295.15, description: 'Loan svc', category: 'Loans' }),
    txn({ date: '2026-08-04', amount: -40, description: 'Stop & Shop', category: 'Groceries' }),
  ];

  it('drops debt servicing by default and reports what it dropped', () => {
    const b = computeBaseline(debt, { today: TODAY, months: 1 });
    expect(b.avgMonthlyVariableOut).toBe(40);
    expect(b.excluded.byCategory).toEqual([
      { category: 'Credit Card Payments', count: 1, total: 18000 },
      { category: 'Loans', count: 1, total: 295.15 },
    ]);
  });

  it('honours an explicit override, including an empty list', () => {
    const all = computeBaseline(debt, { today: TODAY, months: 1, excludeCategories: [] });
    expect(all.excluded.byCategory).toEqual([]);
    expect(all.avgMonthlyVariableOut).toBe(18335.15);
    const custom = computeBaseline(debt, { today: TODAY, months: 1, excludeCategories: ['Groceries'] });
    expect(custom.excluded.byCategory).toEqual([
      { category: 'Groceries', count: 1, total: 40 },
    ]);
    expect(custom.avgMonthlyVariableOut).toBe(18295.15);
  });
});

describe('computeBaseline excludeMonths', () => {
  it('drops a named anomaly month from the window entirely', () => {
    const txns = [
      txn({ date: '2026-06-05', amount: -300 }),
      txn({ date: '2026-07-05', amount: -9000 }),
      txn({ date: '2026-07-06', amount: -50 }),
      txn({ date: '2026-08-05', amount: -500 }),
    ];
    const b = computeBaseline(txns, {
      today: TODAY,
      months: 3,
      aggregation: 'mean',
      excludeMonths: ['2026-07'],
    });
    expect(b.monthsUsed).toBe(2);
    expect(b.months).toEqual(['2026-06', '2026-08']);
    expect(b.window).toEqual({ from: '2026-06-01', to: '2026-08-31' });
    expect(b.avgMonthlyVariableOut).toBe(400);
    expect(b.excluded.byMonth).toBe(2);
  });

  it('is not defaulted', () => {
    const b = computeBaseline([txn({ date: '2026-08-05', amount: -500 })], {
      today: TODAY,
      months: 3,
    });
    expect(b.excluded.byMonth).toBe(0);
  });
});

describe('computeBaseline coverage', () => {
  // The real shape: the main spending account's import starts on 2026-07-01, so
  // June looks like a month of almost no spending when it is really a blind spot.
  const partialImport = [
    txn({ date: '2026-05-04', amount: -220, account: 'NFCU Easy Checking' }),
    txn({ date: '2026-06-04', amount: -200, account: 'NFCU Easy Checking' }),
    txn({ date: '2026-07-04', amount: -240, account: 'NFCU Easy Checking' }),
    txn({ date: '2026-07-05', amount: -2000, account: 'PNC Spend' }),
    txn({ date: '2026-08-04', amount: -260, account: 'NFCU Easy Checking' }),
    txn({ date: '2026-08-05', amount: -2200, account: 'PNC Spend' }),
  ];

  it('skips a month an account has no data in, and says which account', () => {
    const b = computeBaseline(partialImport, { today: TODAY, months: 3 });
    expect(b.coverage).toBe('all-accounts');
    expect(b.months).toEqual(['2026-07', '2026-08']);
    expect(b.monthsUsed).toBe(2);
    expect(b.skippedMonths).toEqual([
      { month: '2026-05', reason: 'no-coverage', missingAccounts: ['PNC Spend'] },
      { month: '2026-06', reason: 'no-coverage', missingAccounts: ['PNC Spend'] },
    ]);
    // Only the two covered months are averaged: 2240 and 2460 median to 2350.
    expect(b.avgMonthlyVariableOut).toBe(2350);
    expect(b.window).toEqual({ from: '2026-07-01', to: '2026-08-31' });
  });

  it("coverage 'any' keeps the old, diluted behaviour", () => {
    const b = computeBaseline(partialImport, { today: TODAY, months: 3, coverage: 'any' });
    expect(b.coverage).toBe('any');
    expect(b.months).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(b.skippedMonths).toEqual([]);
    // June's lonely 200 drags the median of [200, 2240, 2460] down to 2240.
    expect(b.avgMonthlyVariableOut).toBe(2240);
  });

  it('reaches further back to fill the window when an older month is covered', () => {
    const b = computeBaseline(
      [
        txn({ date: '2026-05-04', amount: -100, account: 'A' }),
        txn({ date: '2026-05-05', amount: -100, account: 'B' }),
        txn({ date: '2026-06-04', amount: -100, account: 'A' }), // B silent: skipped
        txn({ date: '2026-07-04', amount: -100, account: 'A' }),
        txn({ date: '2026-07-05', amount: -100, account: 'B' }),
        txn({ date: '2026-08-04', amount: -100, account: 'A' }),
        txn({ date: '2026-08-05', amount: -100, account: 'B' }),
      ],
      { today: TODAY, months: 3 },
    );
    expect(b.months).toEqual(['2026-05', '2026-07', '2026-08']);
    expect(b.monthsUsed).toBe(3);
    expect(b.skippedMonths).toEqual([
      { month: '2026-06', reason: 'no-coverage', missingAccounts: ['B'] },
    ]);
  });

  it('stops at the oldest month with data rather than inventing months', () => {
    const b = computeBaseline(
      [
        txn({ date: '2026-07-04', amount: -100, account: 'A' }),
        txn({ date: '2026-08-04', amount: -100, account: 'A' }),
        txn({ date: '2026-08-05', amount: -100, account: 'B' }),
      ],
      { today: TODAY, months: 6 },
    );
    expect(b.months).toEqual(['2026-08']);
    expect(b.monthsUsed).toBe(1);
    expect(b.skippedMonths).toEqual([
      { month: '2026-07', reason: 'no-coverage', missingAccounts: ['B'] },
    ]);
  });

  it('still honours excludeMonths, which spends its slot instead of extending', () => {
    const b = computeBaseline(partialImport, {
      today: TODAY,
      months: 3,
      excludeMonths: ['2026-08'],
    });
    expect(b.months).toEqual(['2026-07']);
    expect(b.excluded.byMonth).toBe(2);
    expect(b.skippedMonths.map((s) => s.month)).toEqual(['2026-05', '2026-06']);
  });

  it('ignores rows with no account when taking the roll call', () => {
    const b = computeBaseline(
      [
        txn({ date: '2026-07-04', amount: -100, account: 'A' }),
        txn({ date: '2026-08-04', amount: -100, account: 'A' }),
        txn({ date: '2026-08-05', amount: -50, account: null }),
      ],
      { today: TODAY, months: 2 },
    );
    expect(b.months).toEqual(['2026-07', '2026-08']);
    expect(b.skippedMonths).toEqual([]);
  });
});
