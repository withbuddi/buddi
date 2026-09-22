/**
 * The date parser, as a table (docs/specs/email.md §7, `email.date-stated`).
 *
 * No database and no clock: the reference instant is a parameter, so every row
 * below is a sentence in and a day out. What is being pinned down is not only
 * what the parser finds but what it refuses to find — the false-positive side
 * is the whole reason this watcher can be `info` and quiet rather than noisy.
 */
import { describe, expect, it } from 'vitest';
import {
  BASE_CONFIDENCE,
  DEFAULT_DATE_CONFIDENCE,
  KEYWORD_BOOST,
  MAX_CONFIDENCE,
  clampConfidence,
  findDates,
  isConfident,
  sentencesOf,
  withoutQuotedLines,
} from './dates.js';

/** A Monday, 12:00 UTC. Every expectation below is relative to it. */
const AT = new Date('2026-09-21T12:00:00Z');

function days(text: string): string[] {
  return findDates(text, { at: AT, timezone: 'UTC' }).map((hit) => hit.date);
}

function one(text: string) {
  const hits = findDates(text, { at: AT, timezone: 'UTC' });
  expect(hits.length, `expected exactly one hit in ${JSON.stringify(text)}`).toBe(1);
  return hits[0]!;
}

describe('absolute dates, English', () => {
  const table: Array<[string, string]> = [
    ['The report is out on 22 September.', '2026-09-22'],
    ['Due Sep 22 at the latest.', '2026-09-22'],
    ['September 22 is the day.', '2026-09-22'],
    ['Filing is 22nd September this year.', '2026-09-22'],
    ['Everything closes 2026-09-30.', '2026-09-30'],
    ['Sept. 25 works for me.', '2026-09-25'],
    ['We meet October 2, 2026.', '2026-10-02'],
  ];
  for (const [text, expected] of table) {
    it(`reads ${JSON.stringify(text)} as ${expected}`, () => {
      expect(days(text)).toContain(expected);
    });
  }
});

describe('absolute dates, French', () => {
  const table: Array<[string, string]> = [
    ['La réunion est le 22 septembre.', '2026-09-22'],
    ['Rendez-vous mardi 22 septembre à 10h.', '2026-09-22'],
    ['Échéance le 1 octobre.', '2026-10-01'],
    ['À renvoyer avant le 30 septembre 2026.', '2026-09-30'],
    ['Le 25 sept. au plus tard.', '2026-09-25'],
  ];
  for (const [text, expected] of table) {
    it(`reads ${JSON.stringify(text)} as ${expected}`, () => {
      expect(days(text)).toContain(expected);
    });
  }
});

describe('slashed numbers and their ambiguity', () => {
  it('reads 22/09 day-first when the first number can only be a day', () => {
    const hit = one('Deadline 22/09 please.');
    expect(hit.date).toBe('2026-09-22');
    expect(hit.confidence).toBeCloseTo(BASE_CONFIDENCE.numeric + KEYWORD_BOOST, 5);
  });

  it('reads 9/22 month-first when the second number can only be a day', () => {
    expect(days('The appointment is 9/22.')).toEqual(['2026-09-22']);
  });

  it('keeps an ambiguous 10/2 day-first, below the default threshold', () => {
    const hit = one('Anyway, 10/2 then.');
    expect(hit.date).toBe('2026-10-02');
    expect(hit.confidence).toBe(BASE_CONFIDENCE.numericAmbiguous);
    expect(isConfident(hit, DEFAULT_DATE_CONFIDENCE)).toBe(false);
  });

  it('a keyword lifts an ambiguous reading over the line', () => {
    const hit = one('Payment is due 10/2.');
    expect(hit.confidence).toBeCloseTo(BASE_CONFIDENCE.numericAmbiguous + KEYWORD_BOOST, 5);
    expect(isConfident(hit, DEFAULT_DATE_CONFIDENCE)).toBe(true);
  });

  it('does not read dotted numbers as dates', () => {
    expect(days('Version 22.09 shipped, the total was 25.09 euros.')).toEqual([]);
  });

  it('does not read a number pair with a third part as a date', () => {
    // A ratio or a score, not 22 September.
    expect(days('We scored 22/09/12/4 across the board.')).toEqual([]);
  });
});

describe('weekday plus a time', () => {
  it('resolves an English weekday against the message instant', () => {
    // AT is a Monday; Thursday is three days later.
    expect(days('Can we do Thursday at 3pm?')).toEqual(['2026-09-24']);
  });

  it('resolves a French weekday with an h-time', () => {
    expect(days('On se voit jeudi à 15h.')).toEqual(['2026-09-24']);
  });

  it('reads a 24-hour time', () => {
    expect(days('Wednesday 15:00 works.')).toEqual(['2026-09-23']);
  });

  it('takes the same weekday as the message as today', () => {
    expect(days('Monday at 9am, as agreed.')).toEqual(['2026-09-21']);
  });

  it('ignores a weekday with no time at all', () => {
    expect(days('See you Thursday, then.')).toEqual([]);
  });

  it('ignores a weekday beside a bare number', () => {
    expect(days('Thursday 15 people confirmed.')).toEqual([]);
  });

  it('scores a weekday-and-time below a spelled-out date', () => {
    const weekday = one('Can we do Thursday at 3pm?');
    const absolute = one('Can we do 24 September?');
    expect(weekday.confidence).toBeLessThan(absolute.confidence);
  });
});

describe('the window', () => {
  it('skips a date that has already gone by', () => {
    expect(days('The invoice was due 15 September.')).toEqual([]);
    expect(days('It expired on 2026-09-01.')).toEqual([]);
  });

  it('skips a date beyond the fortnight', () => {
    expect(days('The deadline is 20 October.')).toEqual([]);
  });

  it('keeps the far edge of the window', () => {
    expect(days('The deadline is 5 October.')).toEqual(['2026-10-05']);
  });

  it('takes the following year when the day has gone by this one', () => {
    // From September, "2 January" is next January — and out of the window.
    expect(days('Renewal on 2 January.')).toEqual([]);
    expect(findDates('Renewal on 2 January.', { at: AT, timezone: 'UTC', windowDays: 200 })).toEqual([
      { date: '2027-01-02', phrase: '2 January', confidence: BASE_CONFIDENCE.monthName + KEYWORD_BOOST },
    ]);
  });

  it('honours the reference instant rather than any clock', () => {
    const later = new Date('2026-09-28T09:00:00Z');
    expect(findDates('Thursday at 3pm.', { at: later, timezone: 'UTC' }).map((h) => h.date)).toEqual([
      '2026-10-01',
    ]);
  });

  it('refuses a day that does not exist', () => {
    expect(days('Due 31 September.')).toEqual([]);
  });
});

describe('quoted history', () => {
  it('skips dates on quoted lines', () => {
    const text = [
      'Nothing new from me.',
      '',
      '> On 14 September you wrote:',
      '> The deadline is 22 September, do not forget.',
      '>> and before that, 25 September',
    ].join('\n');
    expect(days(text)).toEqual([]);
  });

  it('still reads the lines the sender actually wrote', () => {
    const text = ['Confirming 24 September, deadline noted.', '> The deadline is 30 September.'].join('\n');
    expect(days(text)).toEqual(['2026-09-24']);
  });

  it('strips quoted lines and nothing else', () => {
    expect(withoutQuotedLines('a\n> b\n  > c\nd')).toBe('a\nd');
  });
});

describe('confidence', () => {
  it('a keyword in the same sentence raises it', () => {
    const bare = one('Filing on 22 September.');
    const withKeyword = one('The deadline for filing is 22 September.');
    expect(bare.confidence).toBe(BASE_CONFIDENCE.monthName);
    expect(withKeyword.confidence).toBeCloseTo(BASE_CONFIDENCE.monthName + KEYWORD_BOOST, 5);
  });

  it('a keyword in a different sentence does not', () => {
    const hit = one('Filing on 22 September. The deadline was last month.');
    expect(hit.confidence).toBe(BASE_CONFIDENCE.monthName);
  });

  it('recognises the French keywords', () => {
    const hit = one("L'échéance est le 22 septembre.");
    expect(hit.confidence).toBeCloseTo(BASE_CONFIDENCE.monthName + KEYWORD_BOOST, 5);
  });

  it('never reaches certainty', () => {
    const hit = one('Deadline: the appointment expires 2026-09-22, due then.');
    expect(hit.confidence).toBeLessThanOrEqual(MAX_CONFIDENCE);
  });

  it('keeps the surest reading when a day is stated twice', () => {
    const hits = findDates('22/09, that is to say the deadline of 22 September.', {
      at: AT,
      timezone: 'UTC',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.date).toBe('2026-09-22');
    expect(hits[0]!.phrase).toBe('22 September');
  });

  it('sorts the surest first', () => {
    const hits = findDates('Deadline 2026-09-23. And maybe 10/2 as well.', { at: AT, timezone: 'UTC' });
    expect(hits.map((h) => h.date)).toEqual(['2026-09-23', '2026-10-02']);
  });

  it('clamps a setting into the range the parser can mean something in', () => {
    expect(clampConfidence(0)).toBe(0.1);
    expect(clampConfidence(5)).toBe(0.99);
    expect(clampConfidence(0.755)).toBe(0.76);
    expect(clampConfidence(Number.NaN)).toBe(DEFAULT_DATE_CONFIDENCE);
  });
});

describe('the edges of the scan', () => {
  it('finds nothing in an empty body', () => {
    expect(days('')).toEqual([]);
    expect(findDates('   ', { at: AT })).toEqual([]);
  });

  it('survives an invalid reference instant', () => {
    expect(findDates('22 September', { at: new Date('nonsense') })).toEqual([]);
  });

  it('splits sentences on newlines as well as full stops', () => {
    expect(sentencesOf('one.\ntwo. three')).toEqual(['one.', 'two.', 'three']);
  });

  it('does not cut an abbreviated month in half', () => {
    expect(days('Sep. 22 is the date.')).toEqual(['2026-09-22']);
  });

  it('reads the subject line it is handed with the body', () => {
    expect(days('Invoice due 22/09\n\nSee attached.')).toEqual(['2026-09-22']);
  });
});
