import { describe, expect, it } from 'vitest';
import {
  autopayModeled,
  floorBreachFinding,
  minimumDueFindings,
  normalizeName,
  staleBalanceFindings,
  statementClosingFindings,
  unmatchedReceiptsFinding,
  unprocessedArtifactsFinding,
} from './helpers.js';

const TODAY = '2026-09-13';

describe('floorBreachFinding', () => {
  const base = {
    minBalance: -120.5,
    minBalanceDate: '2026-09-20',
    safetyFloor: 200,
    currency: 'EUR',
    startDate: TODAY,
    horizonDays: 30,
  };

  it('is nothing when the projection never breaches', () => {
    expect(floorBreachFinding({ ...base, firstBreachDate: null })).toBeNull();
  });

  it('is urgent inside a week and keyed by the breach date', () => {
    const finding = floorBreachFinding({ ...base, firstBreachDate: '2026-09-18' });
    expect(finding?.severity).toBe('urgent');
    expect(finding?.key).toBe('floor-breach:2026-09-18');
    expect(finding?.agentId).toBe('finance-advisor');
  });

  it('is urgent on the seventh day and info on the eighth', () => {
    expect(floorBreachFinding({ ...base, firstBreachDate: '2026-09-20' })?.severity).toBe(
      'urgent',
    );
    expect(floorBreachFinding({ ...base, firstBreachDate: '2026-09-21' })?.severity).toBe('info');
  });

  it('is info out at the far end of the horizon', () => {
    const finding = floorBreachFinding({ ...base, firstBreachDate: '2026-10-10' });
    expect(finding?.severity).toBe('info');
    expect(finding?.key).toBe('floor-breach:2026-10-10');
  });

  it('ignores a breach past the horizon or before the start', () => {
    expect(floorBreachFinding({ ...base, firstBreachDate: '2026-10-20' })).toBeNull();
    expect(floorBreachFinding({ ...base, firstBreachDate: '2026-09-01' })).toBeNull();
  });

  it('says "zero" rather than naming a floor when none is set', () => {
    const finding = floorBreachFinding({
      ...base,
      safetyFloor: 0,
      firstBreachDate: '2026-09-15',
    });
    expect(finding?.title).toContain('zero');
    expect(finding?.title).not.toContain('safety floor');
  });
});

describe('normalizeName / autopayModeled', () => {
  it('reduces a name to letters and digits', () => {
    expect(normalizeName("Amex Gold *1234")).toBe('amexgold1234');
  });

  it('matches a recurring charge that names the liability', () => {
    expect(
      autopayModeled('Amex Gold', [{ name: 'Amex Gold autopay', includedInCashflow: true }]),
    ).toBe(true);
  });

  it('matches in the other direction too', () => {
    expect(autopayModeled('Amex Gold minimum', [{ name: 'Amex Gold', includedInCashflow: true }])).toBe(
      true,
    );
  });

  it('does not count an item on an account the cash flow cannot see', () => {
    expect(autopayModeled('Amex Gold', [{ name: 'Amex Gold', includedInCashflow: false }])).toBe(
      false,
    );
  });

  it('does not match an unrelated charge', () => {
    expect(autopayModeled('Amex Gold', [{ name: 'Rent', includedInCashflow: true }])).toBe(false);
  });
});

describe('minimumDueFindings', () => {
  const card = { name: 'Amex Gold', minimumPayment: 45, dueDay: 15, balance: 1200, paid: false };

  it('reports an unpaid minimum due inside three days as urgent', () => {
    const [finding] = minimumDueFindings([card], { today: TODAY, currency: 'EUR', items: [] });
    expect(finding?.severity).toBe('urgent');
    expect(finding?.key).toBe('minimum-due:Amex Gold:2026-09-15');
    expect(finding?.agentId).toBe('credit-coach');
  });

  it('stays quiet when the due date is further out', () => {
    expect(
      minimumDueFindings([{ ...card, dueDay: 28 }], {
        today: TODAY,
        currency: 'EUR',
        items: [],
      }),
    ).toEqual([]);
  });

  it('stays quiet when the payment is already recorded', () => {
    expect(
      minimumDueFindings([{ ...card, paid: true }], { today: TODAY, currency: 'EUR', items: [] }),
    ).toEqual([]);
  });

  it('stays quiet when a modelled autopay covers it', () => {
    expect(
      minimumDueFindings([card], {
        today: TODAY,
        currency: 'EUR',
        items: [{ name: 'Amex Gold payment', includedInCashflow: true }],
      }),
    ).toEqual([]);
  });

  it('still speaks when the autopay sits on an excluded account', () => {
    expect(
      minimumDueFindings([card], {
        today: TODAY,
        currency: 'EUR',
        items: [{ name: 'Amex Gold payment', includedInCashflow: false }],
      }),
    ).toHaveLength(1);
  });

  it('ignores a liability with no minimum payment', () => {
    expect(
      minimumDueFindings([{ ...card, minimumPayment: 0 }], {
        today: TODAY,
        currency: 'EUR',
        items: [],
      }),
    ).toEqual([]);
  });
});

describe('statementClosingFindings', () => {
  const card = { name: 'Amex Gold', balance: 700, creditLimit: 1000, statementDay: 15 };

  it('reports a card over 30% closing inside three days as info', () => {
    const [finding] = statementClosingFindings([card], { today: TODAY, currency: 'EUR' });
    expect(finding?.severity).toBe('info');
    expect(finding?.key).toBe('statement:Amex Gold:2026-09-15');
    expect(finding?.agentId).toBe('credit-coach');
  });

  it('stays quiet under 30%', () => {
    expect(
      statementClosingFindings([{ ...card, balance: 200 }], { today: TODAY, currency: 'EUR' }),
    ).toEqual([]);
  });

  it('stays quiet when the close is further out', () => {
    expect(
      statementClosingFindings([{ ...card, statementDay: 25 }], { today: TODAY, currency: 'EUR' }),
    ).toEqual([]);
  });

  it('stays quiet with no limit or no statement day', () => {
    expect(
      statementClosingFindings([{ ...card, creditLimit: null }], { today: TODAY, currency: 'EUR' }),
    ).toEqual([]);
    expect(
      statementClosingFindings([{ ...card, statementDay: null }], { today: TODAY, currency: 'EUR' }),
    ).toEqual([]);
  });
});

describe('staleBalanceFindings', () => {
  it('reports one finding per account older than two weeks', () => {
    const findings = staleBalanceFindings(
      [
        { name: 'Checking', balance: 900, balanceAsOf: '2026-08-20' },
        { name: 'Savings', balance: 5000, balanceAsOf: '2026-09-10' },
      ],
      { today: TODAY, currency: 'EUR' },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.key).toBe('stale:Checking:2026-08-20');
    expect(findings[0]?.severity).toBe('info');
  });

  it('treats exactly fourteen days as still fresh', () => {
    expect(
      staleBalanceFindings([{ name: 'Checking', balance: 1, balanceAsOf: '2026-08-30' }], {
        today: TODAY,
        currency: 'EUR',
      }),
    ).toEqual([]);
  });
});

describe('unmatchedReceiptsFinding', () => {
  const receipts = [
    { id: 'a', merchant: 'Lidl', occurredOn: '2026-09-01', total: 42, currency: 'EUR' },
    { id: 'b', merchant: 'Fnac', occurredOn: '2026-08-28', total: 99, currency: 'EUR' },
    { id: 'c', merchant: 'Shell', occurredOn: '2026-09-12', total: 60, currency: 'EUR' },
  ];

  it('collapses every stale receipt into one finding', () => {
    const finding = unmatchedReceiptsFinding(receipts, { today: TODAY });
    expect(finding?.key).toBe('unmatched-receipts:2026-08-28:2');
    expect(finding?.severity).toBe('info');
    expect(finding?.detail).toContain('Lidl');
    expect(finding?.detail).toContain('Fnac');
    expect(finding?.detail).not.toContain('Shell');
  });

  it('is nothing when every receipt is recent', () => {
    expect(unmatchedReceiptsFinding([receipts[2]!], { today: TODAY })).toBeNull();
  });
});

describe('unprocessedArtifactsFinding', () => {
  it('lists them oldest first under one key', () => {
    const finding = unprocessedArtifactsFinding([
      { id: 'a', filename: 'sept.pdf', kind: 'document', mime: 'application/pdf', createdOn: '2026-09-11', ageHours: 50 },
      { id: 'b', filename: null, kind: 'image', mime: 'image/jpeg', createdOn: '2026-09-09', ageHours: 96 },
    ]);
    expect(finding?.key).toBe('unprocessed-artifacts:2026-09-09:2');
    expect(finding?.detail.indexOf('image/jpeg')).toBeLessThan(
      finding?.detail.indexOf('sept.pdf') as number,
    );
  });

  it('is nothing when there is nothing left over', () => {
    expect(unprocessedArtifactsFinding([])).toBeNull();
  });
});
