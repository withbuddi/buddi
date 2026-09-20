/**
 * Every word on the first-run screen, read the way a stranger reads it.
 *
 * docs/onboarding.md §1: "loopback", "vault", "provider", "endpoint",
 * "handle" and "credential" appear nowhere on this screen. They are our words
 * for our machinery, and the person reading this has just installed something
 * for the first time.
 *
 * The check is on the script itself and on the strings the component holds, so
 * a sentence written straight into the thread is caught as well as one added
 * here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BANNED_WORDS, SCRIPT, OPENING_INSTRUCTION, SUGGESTED_NAMES, FACES } from './script';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THREAD = path.resolve(HERE, '..', 'Meet.tsx');

/** Every string this object holds, functions called with plain samples. */
function sentences(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'function') {
    const said = (value as (...args: string[]) => unknown)('Amen', 'America/New_York');
    return typeof said === 'string' ? [said] : [];
  }
  if (Array.isArray(value)) return value.flatMap(sentences);
  if (value && typeof value === 'object') return Object.values(value).flatMap(sentences);
  return [];
}

/** String literals in a source file: what the component renders in its own right. */
function literals(file: string): string[] {
  const source = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return (source.match(/'[^'\n]*'|"[^"\n]*"/g) ?? []).map((literal) => literal.slice(1, -1));
}

describe('the words on the screen', () => {
  const said = sentences(SCRIPT).concat(OPENING_INSTRUCTION, [...SUGGESTED_NAMES], [...FACES]);

  it('has something to say', () => {
    expect(said.length).toBeGreaterThan(30);
  });

  it('uses none of the words a person setting this up would not use', () => {
    for (const line of said) {
      for (const word of BANNED_WORDS) {
        expect(line.toLowerCase().includes(word), `"${line}" says "${word}"`).toBe(false);
      }
    }
  });

  it('keeps them out of the thread component too', () => {
    // Class names, route names and API paths are the page's own plumbing and
    // never reach a reader; only words with a space around them are prose.
    const prose = literals(THREAD).filter((literal) => /\s/.test(literal.trim()) && literal.trim().length > 3);
    for (const line of prose) {
      for (const word of BANNED_WORDS) {
        expect(line.toLowerCase().includes(word), `Meet.tsx says "${word}" in "${line}"`).toBe(false);
      }
    }
  });

  it('never mentions the terminal', () => {
    for (const line of said) {
      expect(line.toLowerCase()).not.toMatch(/terminal|command line|shell/);
    }
  });
});
