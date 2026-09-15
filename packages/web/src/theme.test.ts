/**
 * The theme, in all three of its states.
 *
 * Two halves: the attribute this module writes, and the tokens the stylesheet
 * declares against it. The CSS is read as text rather than through jsdom's
 * computed styles — jsdom does not resolve `var()` or evaluate
 * `prefers-color-scheme`, so asking it would test the environment's gaps
 * instead of the token file. Reading the file asserts exactly the property
 * that matters: three blocks, the same names in each, and the guard that makes
 * an explicit choice beat the operating system.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  THEME_KEY,
  applyTheme,
  effectiveTheme,
  nextTheme,
  readTheme,
  storeTheme,
  themeLabel,
} from './theme';

/**
 * The stylesheet with its comments removed — the file explains the three-state
 * pattern in prose at the top, and a test that matched that prose would pass
 * whether or not the rules below it existed.
 */
const TOKENS = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'tokens.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.clear();
});

/** Every `--name: value` inside one brace-delimited block. */
function tokensIn(block: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    found[match[1]!] = match[2]!.trim();
  }
  return found;
}

function blockAfter(marker: string): string {
  const start = TOKENS.indexOf(marker);
  expect(start, `${marker} is missing from tokens.css`).toBeGreaterThan(-1);
  const open = TOKENS.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < TOKENS.length; index += 1) {
    if (TOKENS[index] === '{') depth += 1;
    if (TOKENS[index] === '}') {
      depth -= 1;
      if (depth === 0) return TOKENS.slice(open + 1, index);
    }
  }
  throw new Error(`unbalanced block for ${marker}`);
}

describe('the token file', () => {
  const light = tokensIn(blockAfter('\n:root {'));
  const systemDark = tokensIn(blockAfter('@media (prefers-color-scheme: dark)'));
  const explicitDark = tokensIn(blockAfter(":root[data-theme='dark']"));

  it('declares the light palette on bare :root, so a colour always resolves', () => {
    expect(Object.keys(light).length).toBeGreaterThan(20);
    for (const name of ['--bg', '--surface', '--text', '--accent', '--good', '--warning', '--critical']) {
      expect(light[name], `${name} must be defined in the light state`).toBeTruthy();
    }
  });

  it('guards the system-dark block so an explicit light choice wins on a dark machine', () => {
    expect(TOKENS).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)/);
  });

  it('defines the same tokens in both dark states, with the same values', () => {
    expect(Object.keys(systemDark).sort()).toEqual(Object.keys(explicitDark).sort());
    for (const [name, value] of Object.entries(systemDark)) {
      expect(explicitDark[name], `${name} differs between the two dark states`).toBe(value);
    }
  });

  it('overrides only tokens the light state already named', () => {
    for (const name of Object.keys(explicitDark)) {
      expect(light[name], `${name} is dark-only; every token needs a light value`).toBeTruthy();
    }
  });

  it('keeps semantic state separate from the accent', () => {
    for (const state of ['--good', '--warning', '--critical']) {
      expect(light[state]).not.toBe(light['--accent']);
      expect(explicitDark[state]).not.toBe(explicitDark['--accent']);
    }
  });

  it('fetches no font and imports nothing remote', () => {
    expect(TOKENS).not.toMatch(/@import/);
    expect(TOKENS).not.toMatch(/https?:/);
    expect(TOKENS).toMatch(/--font-sans:[^;]*-apple-system/);
  });
});

describe('the toggle', () => {
  it('cycles light → dark → system → light', () => {
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
    expect(nextTheme('system')).toBe('light');
  });

  it('writes the attribute for an explicit choice and removes it for system', () => {
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    // "system" is the *absence* of an opinion, not an opinion called system.
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('persists the choice and reads it back', () => {
    storeTheme('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(readTheme()).toBe('dark');
  });

  it('defaults to system when nothing is stored, or when storage lies', () => {
    expect(readTheme()).toBe('system');
    window.localStorage.setItem(THEME_KEY, 'chartreuse');
    expect(readTheme()).toBe('system');
    expect(
      readTheme({
        getItem: () => {
          throw new Error('storage is blocked');
        },
      }),
    ).toBe('system');
  });

  it('reports what the owner will actually see', () => {
    expect(effectiveTheme('dark')).toBe('dark');
    expect(effectiveTheme('light')).toBe('light');
    // jsdom's matchMedia reports no preference, which reads as light.
    expect(effectiveTheme('system')).toBe('light');
    expect(themeLabel('system')).toBe('System theme');
  });
});
