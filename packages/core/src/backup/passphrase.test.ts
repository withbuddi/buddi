/**
 * The word list is a format, not decoration: its size is the entropy claim and
 * its pairwise rules are what make a passphrase copyable off paper. Both are
 * checked here, because both are easy to break while "just adding a word".
 */
import { describe, expect, it } from 'vitest';
import {
  BACKUP_PASSPHRASE_KEY,
  PASSPHRASE_WORDLIST,
  PASSPHRASE_WORDS,
  generatePassphrase,
  isGeneratedPassphrase,
  normalizePassphrase,
} from './passphrase.js';

/** One substitution, insertion or deletion apart. */
function oneApart(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff += 1;
    return diff === 1;
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i += 1) {
    if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  }
  return false;
}

describe('the word list', () => {
  it('is 512 distinct short words', () => {
    expect(PASSPHRASE_WORDLIST).toHaveLength(512);
    expect(new Set(PASSPHRASE_WORDLIST).size).toBe(512);
    for (const word of PASSPHRASE_WORDLIST) {
      expect(word).toMatch(/^[a-z]{3,6}$/);
    }
  });

  it('has no word that could be mistaken for another', () => {
    const words = [...PASSPHRASE_WORDLIST];
    const confusable: string[] = [];
    for (let i = 0; i < words.length; i += 1) {
      for (let j = i + 1; j < words.length; j += 1) {
        const a = words[i]!;
        const b = words[j]!;
        if (a.startsWith(b) || b.startsWith(a) || oneApart(a, b)) confusable.push(`${a}/${b}`);
      }
    }
    expect(confusable).toEqual([]);
  });
});

describe('generatePassphrase', () => {
  it('returns six words from the list', () => {
    const words = generatePassphrase().split(' ');
    expect(words).toHaveLength(PASSPHRASE_WORDS);
    for (const word of words) expect(PASSPHRASE_WORDLIST).toContain(word);
  });

  it('does not repeat itself', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) seen.add(generatePassphrase());
    expect(seen.size).toBe(20);
  });

  it('recognises what it generated', () => {
    expect(isGeneratedPassphrase(generatePassphrase())).toBe(true);
    expect(isGeneratedPassphrase('hunter2')).toBe(false);
  });
});

describe('normalizePassphrase', () => {
  it('forgives the spacing of a passphrase read off paper', () => {
    expect(normalizePassphrase('  apple   river\tcedar \n lantern ')).toBe(
      'apple river cedar lantern',
    );
  });

  it('leaves an already tidy passphrase alone', () => {
    const generated = generatePassphrase();
    expect(normalizePassphrase(generated)).toBe(generated);
  });
});

it('names the vault key the rest of the system looks for', () => {
  expect(BACKUP_PASSPHRASE_KEY).toBe('backup.passphrase');
});
