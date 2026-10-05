import { describe, expect, it } from 'vitest';
import { citationSignals, citesUnread } from './grounding.js';

/** The answer that started this: a headline, at length, every citation invented. */
const FABRICATED = `Here's what's happening with the Supreme Court case today.

The justices heard arguments on Monday, CBS News reported, and legal scholars at Columbia Law say the ruling could reshape agency power. According to the Associated Press, a decision is expected by June. NBC News notes that three justices appeared skeptical, while the dissent drew attention (NPR, Oct 5). PBS NewsHour has a full segment.`;

describe('citesUnread', () => {
  it('catches the fabricated news answer', () => {
    expect(citesUnread(FABRICATED)).toBe(true);
    expect(citationSignals(FABRICATED).sources).toEqual(expect.arrayContaining(['cbs', 'associated press', 'nbc', 'npr']));
  });
  it('catches domains and links, numbered markers and a Sources line', () => {
    expect(citesUnread('Rates rose 0.25 points (reuters.com), and markets fell (bloomberg.com).')).toBe(true);
    expect(citesUnread('The vote passed [1]. Turnout was 61% [2].\n\nSources: [1] lemonde.fr')).toBe(true);
    expect(citesUnread("Le texte a été adopté, selon Le Monde. D'après Le Figaro, le Sénat suivra.")).toBe(true);
    expect(citesUnread('See [the report](https://www.bbc.com/news/x) and [this one](https://apnews.com/y).')).toBe(true);
  });
  it('stays silent on plain conversation', () => {
    for (const text of [
      'Hello! How can I help you today?',
      'Paris is the capital of France, with about 2.1 million people.',
      'The BBC is a British public broadcaster founded in 1922; CNN started in 1980.',
      'Sure — I moved your dinner to 8 PM on your Home calendar.',
      'You can write to me at amen@example.com or open github.com.',
      'Run `curl https://example.com/api` and check `package.json` and `loop.ts`.',
      '```\nconst url = "https://reuters.com"; // according to Reuters, per AP\n```',
      'According to your calendar you are free at 3.',
      'That costs about €20, roughly $22.',
      '1. Buy milk\n2. Call the bank [done]\n3. Book the flight',
    ]) expect(citesUnread(text), text).toBe(false);
  });
  it('does not count bare navigation links as sources', () => {
    expect(citesUnread('You can open https://github.com or https://gitlab.com to host it.')).toBe(false);
    expect(citesUnread('The docs are at https://docs.python.org and https://nodejs.org.')).toBe(false);
    // A bare link still backs up numbered markers or a Sources line.
    expect(citesUnread('The vote passed [1].\n\nSources: https://lemonde.fr/x')).toBe(true);
  });
  it('counts an outlet and its own domain as one source', () => {
    const reply = 'According to [Reuters](https://www.reuters.com/markets/ecb), the ECB held rates.';
    expect(citationSignals(reply).sources).toEqual(['reuters']);
    expect(citesUnread(reply)).toBe(false);
    expect(citationSignals('The vote passed, CBS News reported (cbsnews.com).').sources).toEqual(['cbs']);
  });
  it('lets one attribution alone through: precision first', () => {
    expect(citesUnread('According to Reuters, the ECB held rates.')).toBe(false);
  });
  it('does not count a source the conversation already held', () => {
    const known = 'owner: Reuters and AP both say the ECB held rates. Is that right?';
    const reply = 'Yes — according to Reuters, and as AP reported, the ECB held rates.';
    expect(citesUnread(reply, known)).toBe(false);
    expect(citesUnread(reply)).toBe(true);
  });
});
