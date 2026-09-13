import { describe, expect, it } from 'vitest';
import type { AccountBalance } from './accounts.js';
import { defaultIncludeInCashflow, splitTotals } from './accounts.js';

const account = (
  name: string,
  balance: number,
  kind: AccountBalance['kind'],
  includeInCashflow = defaultIncludeInCashflow(kind),
): AccountBalance => ({ name, balance, kind, includeInCashflow });

describe('defaultIncludeInCashflow', () => {
  it('keeps cash and savings spendable', () => {
    expect(defaultIncludeInCashflow('cash')).toBe(true);
    expect(defaultIncludeInCashflow('savings')).toBe(true);
    expect(defaultIncludeInCashflow('other')).toBe(true);
  });

  it('locks retirement, investment and HSA money away', () => {
    expect(defaultIncludeInCashflow('retirement')).toBe(false);
    expect(defaultIncludeInCashflow('investment')).toBe(false);
    expect(defaultIncludeInCashflow('hsa')).toBe(false);
  });
});

describe('splitTotals', () => {
  it('sums nothing to zero', () => {
    expect(splitTotals([])).toEqual({
      cashTotal: 0,
      excludedTotal: 0,
      excludedByKind: [],
      netWorth: 0,
    });
  });

  it('keeps retirement money out of cash but inside net worth', () => {
    const split = splitTotals(
      [
        account('Checking', 542.31, 'cash'),
        account('Savings', 3.16, 'savings'),
        account('Fidelity 401k', 12_000, 'retirement'),
      ],
      1_000,
    );
    expect(split.cashTotal).toBe(545.47);
    expect(split.excludedTotal).toBe(12_000);
    expect(split.excludedByKind).toEqual([
      { kind: 'retirement', balance: 12_000, accounts: ['Fidelity 401k'] },
    ]);
    expect(split.netWorth).toBe(11_545.47);
  });

  it('groups several excluded accounts per kind, largest kind first', () => {
    const split = splitTotals([
      account('Checking', 100, 'cash'),
      account('401k', 12_000, 'retirement'),
      account('Rollover IRA', 3_000, 'retirement'),
      account('Brokerage', 4_000, 'investment'),
      account('HSA', 900, 'hsa'),
    ]);
    expect(split.excludedByKind).toEqual([
      { kind: 'retirement', balance: 15_000, accounts: ['401k', 'Rollover IRA'] },
      { kind: 'investment', balance: 4_000, accounts: ['Brokerage'] },
      { kind: 'hsa', balance: 900, accounts: ['HSA'] },
    ]);
    expect(split.excludedTotal).toBe(19_900);
    expect(split.netWorth).toBe(20_000);
  });

  it('lets an explicit flag override the kind in both directions', () => {
    const split = splitTotals([
      // A brokerage the owner really does spend from.
      account('Brokerage', 500, 'investment', true),
      // A savings pot ring-fenced for a deposit.
      account('House fund', 9_000, 'savings', false),
    ]);
    expect(split.cashTotal).toBe(500);
    expect(split.excludedByKind).toEqual([
      { kind: 'savings', balance: 9_000, accounts: ['House fund'] },
    ]);
  });

  it('rounds money, never accumulating float dust', () => {
    const split = splitTotals(
      [account('A', 0.1, 'cash'), account('B', 0.2, 'cash'), account('C', 0.1, 'hsa')],
      0.1,
    );
    expect(split.cashTotal).toBe(0.3);
    expect(split.excludedTotal).toBe(0.1);
    expect(split.netWorth).toBe(0.3);
  });
});
