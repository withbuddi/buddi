import { describe, expect, it } from 'vitest';
import {
  isPaymentToward,
  significantTokens,
  statementForecast,
  summarizeCardActivity,
  type CardTransaction,
} from './cards.js';
import type { RecurringItem } from './projection.js';

const charge = (name: string, amount: number, anchorDate: string): RecurringItem => ({
  name,
  kind: 'charge',
  amount,
  cadence: 'monthly',
  anchorDate,
});

describe('significantTokens', () => {
  it('drops the words that say what a line is, not which card it is', () => {
    expect(significantTokens('NFCU Mastercard minimum payment')).toEqual([
      'nfcu',
      'mastercard',
    ]);
  });

  it('keeps the digits that identify a card', () => {
    expect(significantTokens('X1 Card 1894 (Robinhood)')).toEqual([
      'x1',
      'card',
      '1894',
      'robinhood',
    ]);
  });
});

describe('isPaymentToward', () => {
  it('matches a payment named after the card', () => {
    expect(isPaymentToward('NFCU Mastercard payment', 'NFCU Mastercard Platinum 9012')).toBe(
      true,
    );
    expect(isPaymentToward('Amex Blue Cash minimum payment', 'Amex Blue Cash Everyday 92000')).toBe(
      true,
    );
  });

  it('matches on a shared last-four alone', () => {
    expect(isPaymentToward('Autopay 9012', 'NFCU Mastercard Platinum 9012')).toBe(true);
  });

  it('does not confuse two debts at the same institution', () => {
    expect(isPaymentToward('NFCU personal loan payment', 'NFCU Mastercard Platinum 9012')).toBe(
      false,
    );
  });

  it('is not fooled by a shared everyday word', () => {
    expect(isPaymentToward('Car insurance', 'Capital One Quicksilver 9972')).toBe(false);
  });

  it('allows the single-word case, where two is a bar it could never clear', () => {
    expect(isPaymentToward('X1 payment', 'X1 Card 1894 (Robinhood)')).toBe(true);
  });
});

describe('statementForecast', () => {
  it('adds the charges due before the close and subtracts the payments', () => {
    const forecast = statementForecast({
      today: '2026-09-13',
      balance: 1000,
      statementDay: 21,
      creditLimit: 5000,
      // GEICO on the 18th lands before the close; the gym on the 25th does not.
      cardItems: [charge('GEICO', 348, '2026-09-18'), charge('Gym', 40, '2026-09-25')],
      paymentItems: [charge('NFCU Mastercard payment', 200, '2026-09-15')],
    });
    expect(forecast.hasForecast).toBe(true);
    expect(forecast.closeDate).toBe('2026-09-21');
    expect(forecast.daysUntilClose).toBe(8);
    expect(forecast.chargesBeforeClose).toBe(348);
    expect(forecast.paymentsBeforeClose).toBe(200);
    expect(forecast.forecastBalance).toBe(1148);
    expect(forecast.utilization).toBe(20);
    expect(forecast.forecastUtilization).toBe(22.96);
    expect(forecast.events.map((e) => [e.date, e.name, e.amount])).toEqual([
      ['2026-09-15', 'NFCU Mastercard payment', -200],
      ['2026-09-18', 'GEICO', 348],
    ]);
  });

  it('includes a charge dated today and one dated on the closing day', () => {
    const forecast = statementForecast({
      today: '2026-09-13',
      balance: 0,
      statementDay: 21,
      cardItems: [charge('Today', 10, '2026-09-13'), charge('Close day', 5, '2026-09-21')],
    });
    expect(forecast.chargesBeforeClose).toBe(15);
    expect(forecast.forecastBalance).toBe(15);
  });

  it('rolls into next month when the closing day has already passed', () => {
    const forecast = statementForecast({
      today: '2026-09-25',
      balance: 500,
      statementDay: 21,
      cardItems: [charge('GEICO', 348, '2026-09-18')],
    });
    expect(forecast.closeDate).toBe('2026-10-21');
    // The 18 October occurrence falls inside the window; September's does not.
    expect(forecast.chargesBeforeClose).toBe(348);
    expect(forecast.forecastBalance).toBe(848);
  });

  it('treats a recurring credit on the card as a payment', () => {
    const forecast = statementForecast({
      today: '2026-09-13',
      balance: 300,
      statementDay: 21,
      cardItems: [
        { name: 'Statement credit', kind: 'income', amount: 50, cadence: 'monthly', anchorDate: '2026-09-14' },
      ],
    });
    expect(forecast.paymentsBeforeClose).toBe(50);
    expect(forecast.forecastBalance).toBe(250);
  });

  it('says plainly that there is no forecast without a statement day', () => {
    const forecast = statementForecast({
      today: '2026-09-13',
      balance: 137.6,
      statementDay: null,
      creditLimit: 1000,
      cardItems: [charge('Anything', 20, '2026-09-15')],
    });
    expect(forecast.hasForecast).toBe(false);
    expect(forecast.closeDate).toBeNull();
    expect(forecast.forecastBalance).toBe(137.6);
    expect(forecast.events).toEqual([]);
  });

  it('reports a card paid into credit at 0% used, never a negative utilization', () => {
    const forecast = statementForecast({
      today: '2026-09-13',
      balance: 100,
      statementDay: 21,
      creditLimit: 1000,
      paymentItems: [charge('Card payment', 250, '2026-09-15')],
    });
    expect(forecast.forecastBalance).toBe(-150);
    expect(forecast.forecastUtilization).toBe(0);
  });
});

describe('summarizeCardActivity', () => {
  const txns: CardTransaction[] = [
    { occurredOn: '2026-09-03', amount: -348, description: 'GEICO' },
    { occurredOn: '2026-09-05', amount: -52.4, description: 'LIDL' },
    { occurredOn: '2026-09-10', amount: 500, description: 'Payment thank you' },
    { occurredOn: '2026-09-11', amount: -31.2, description: 'Interest charge on purchases' },
    { occurredOn: '2026-08-03', amount: -348, description: 'GEICO' },
    // Outside the window: three months back from September is July.
    { occurredOn: '2026-06-01', amount: -99, description: 'Old' },
  ];

  it('splits charges, payments and interest per month, oldest first', () => {
    const activity = summarizeCardActivity(txns, { today: '2026-09-13', months: 3 });
    expect(activity.months.map((m) => m.month)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(activity.months[0]).toEqual({
      month: '2026-07',
      charges: 0,
      payments: 0,
      interest: 0,
      netBalanceChange: 0,
      count: 0,
    });
    expect(activity.months[2]).toEqual({
      month: '2026-09',
      charges: 400.4,
      payments: 500,
      interest: 31.2,
      netBalanceChange: -68.4,
      count: 4,
    });
  });

  it('totals the window and ignores what falls outside it', () => {
    const activity = summarizeCardActivity(txns, { today: '2026-09-13', months: 3 });
    expect(activity.totals).toEqual({
      charges: 748.4,
      payments: 500,
      interest: 31.2,
      netBalanceChange: 279.6,
      count: 5,
    });
  });

  it('reads interest off the category as readily as the description', () => {
    const activity = summarizeCardActivity(
      [{ occurredOn: '2026-09-02', amount: -12, description: 'ADJ', category: 'Interest' }],
      { today: '2026-09-13', months: 1 },
    );
    expect(activity.totals.interest).toBe(12);
    expect(activity.totals.charges).toBe(0);
  });
});
