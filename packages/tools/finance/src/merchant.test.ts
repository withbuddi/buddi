import { describe, expect, it } from 'vitest';
import {
  RECEIPT_WINDOW,
  SUPERSESSION_WINDOW,
  amountMatches,
  bestMatch,
  dayDelta,
  merchantMatches,
  merchantTokens,
  normalizeMerchant,
  merchantOverlap,
} from './merchant.js';

describe('normalizeMerchant', () => {
  it('lowercases and strips punctuation and digits', () => {
    expect(normalizeMerchant('LIDL #883, PARIS 11')).toBe('lidl paris');
  });

  it('drops a card number however it is glued on', () => {
    expect(normalizeMerchant('POS PURCHASE CARD1234 LIDL')).toBe('lidl');
    expect(normalizeMerchant('CARTE 4412 MONOPRIX')).toBe('monoprix');
  });

  it('drops the transport noise words', () => {
    expect(normalizeMerchant('ACH DEBIT PIN PURCHASE TRADER JOES')).toBe('trader joes');
    expect(normalizeMerchant('PAYMENT REF XXXX AMAZON')).toBe('amazon');
  });

  it('strips accents so the same merchant meets itself', () => {
    expect(normalizeMerchant('Café Crème')).toBe(normalizeMerchant('CAFE CREME'));
  });

  it('brings a pending line and its posted twin onto the same string', () => {
    expect(normalizeMerchant('POS DEBIT CARD1234 LIDL #883')).toBe('lidl');
    expect(normalizeMerchant('LIDL')).toBe('lidl');
  });

  it("keeps a possessive together: Trader Joe's meets TRADER JOES", () => {
    expect(normalizeMerchant("Trader Joe's")).toBe('trader joes');
    expect(merchantMatches(normalizeMerchant("Trader Joe's"), normalizeMerchant('TRADER JOES #22'))).toBe(
      true,
    );
  });

  it('returns empty for a description with nothing but noise', () => {
    expect(normalizeMerchant('1234 ### 99')).toBe('');
  });
});

describe('merchantTokens / merchantOverlap', () => {
  it('dedupes and drops single letters', () => {
    expect(merchantTokens('a lidl lidl paris')).toEqual(['lidl', 'paris']);
  });

  it('scores a subset as a full overlap', () => {
    expect(merchantOverlap('lidl', 'lidl sarl paris')).toBe(1);
  });

  it('scores disjoint merchants at zero', () => {
    expect(merchantOverlap('lidl', 'monoprix')).toBe(0);
  });

  it('scores a partial overlap against the smaller set', () => {
    expect(merchantOverlap('trader joes', 'trader joes market street')).toBe(1);
    expect(merchantOverlap('whole foods market', 'whole paycheck store')).toBeCloseTo(1 / 3, 5);
  });

  it('is empty-safe', () => {
    expect(merchantOverlap('', 'lidl')).toBe(0);
    expect(merchantOverlap('', '')).toBe(0);
  });
});

describe('merchantMatches', () => {
  it('matches identical normalized text', () => {
    expect(merchantMatches('lidl', 'lidl')).toBe(true);
  });

  it('never matches two empty merchants', () => {
    expect(merchantMatches('', '')).toBe(false);
  });

  it('matches a bank suffix against a bare name', () => {
    expect(merchantMatches('lidl', 'lidl paris')).toBe(true);
  });

  it('refuses unrelated merchants', () => {
    expect(merchantMatches('lidl paris', 'monoprix lyon')).toBe(false);
  });
});

describe('amountMatches', () => {
  it('accepts a one-cent difference and refuses two', () => {
    expect(amountMatches(-42.5, -42.51)).toBe(true);
    expect(amountMatches(-42.5, -42.52)).toBe(false);
  });

  it('refuses opposite directions of the same magnitude', () => {
    expect(amountMatches(-42.5, 42.5)).toBe(false);
  });
});

describe('dayDelta', () => {
  it('counts whole days in both directions', () => {
    expect(dayDelta('2026-09-10', '2026-09-13')).toBe(3);
    expect(dayDelta('2026-09-13', '2026-09-10')).toBe(-3);
    expect(dayDelta('2026-02-26', '2026-03-01')).toBe(3);
  });
});

describe('bestMatch', () => {
  const pending = { occurredOn: '2026-09-10', amount: -42.5, merchantNorm: 'lidl' };

  it('finds the posted twin inside the five-day window', () => {
    const match = bestMatch(
      pending,
      [{ id: 'a', occurredOn: '2026-09-12', amount: -42.5, merchantNorm: 'lidl paris' }],
      SUPERSESSION_WINDOW,
    );
    expect(match?.candidate.id).toBe('a');
    expect(match?.dayDelta).toBe(2);
    expect(match?.exactMerchant).toBe(false);
  });

  it('refuses a posted row six days later', () => {
    expect(
      bestMatch(
        pending,
        [{ id: 'a', occurredOn: '2026-09-16', amount: -42.5, merchantNorm: 'lidl' }],
        SUPERSESSION_WINDOW,
      ),
    ).toBeUndefined();
  });

  it('refuses a posted row BEFORE the pending date', () => {
    expect(
      bestMatch(
        pending,
        [{ id: 'a', occurredOn: '2026-09-09', amount: -42.5, merchantNorm: 'lidl' }],
        SUPERSESSION_WINDOW,
      ),
    ).toBeUndefined();
  });

  it('refuses a different amount and a different merchant', () => {
    expect(
      bestMatch(
        pending,
        [
          { id: 'a', occurredOn: '2026-09-11', amount: -43.9, merchantNorm: 'lidl' },
          { id: 'b', occurredOn: '2026-09-11', amount: -42.5, merchantNorm: 'monoprix' },
        ],
        SUPERSESSION_WINDOW,
      ),
    ).toBeUndefined();
  });

  it('prefers an exact merchant over a nearer fuzzy one', () => {
    const match = bestMatch(
      pending,
      [
        { id: 'fuzzy', occurredOn: '2026-09-11', amount: -42.5, merchantNorm: 'lidl paris eleven' },
        { id: 'exact', occurredOn: '2026-09-13', amount: -42.5, merchantNorm: 'lidl' },
      ],
      SUPERSESSION_WINDOW,
    );
    expect(match?.candidate.id).toBe('exact');
  });

  it('prefers the nearest date among equally exact merchants', () => {
    const match = bestMatch(
      pending,
      [
        { id: 'far', occurredOn: '2026-09-14', amount: -42.5, merchantNorm: 'lidl' },
        { id: 'near', occurredOn: '2026-09-11', amount: -42.5, merchantNorm: 'lidl' },
      ],
      SUPERSESSION_WINDOW,
    );
    expect(match?.candidate.id).toBe('near');
  });

  it('lets a receipt look three days either side', () => {
    const receipt = { occurredOn: '2026-09-10', amount: -20, merchantNorm: 'lidl' };
    const before = bestMatch(
      receipt,
      [{ id: 'a', occurredOn: '2026-09-07', amount: -20, merchantNorm: 'lidl' }],
      RECEIPT_WINDOW,
    );
    expect(before?.candidate.id).toBe('a');
    const tooEarly = bestMatch(
      receipt,
      [{ id: 'a', occurredOn: '2026-09-06', amount: -20, merchantNorm: 'lidl' }],
      RECEIPT_WINDOW,
    );
    expect(tooEarly).toBeUndefined();
  });
});
