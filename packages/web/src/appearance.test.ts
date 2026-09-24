import { afterEach, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE, GROUND_KEY, WIDTH_KEY, applyAppearance, readAppearance, resetAppearanceForTests, setAppearance } from './appearance';

afterEach(() => {
  for (const name of ['data-theme', 'data-ground', 'data-width']) document.documentElement.removeAttribute(name);
  window.localStorage.clear();
  resetAppearanceForTests();
});

it('defaults to System, Blue and Wide, and when storage lies or refuses', () => {
  expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
  window.localStorage.setItem(GROUND_KEY, 'plaid');
  window.localStorage.setItem(WIDTH_KEY, 'enormous');
  expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
  expect(readAppearance({ getItem: () => { throw new Error('blocked'); } })).toEqual(DEFAULT_APPEARANCE);
});

it('writes an attribute only for a choice that is not the default', () => {
  applyAppearance({ theme: 'dark', ground: 'sand', width: 'full' });
  const root = document.documentElement;
  expect(root.getAttribute('data-theme')).toBe('dark');
  expect(root.getAttribute('data-ground')).toBe('sand');
  expect(root.getAttribute('data-width')).toBe('full');
  applyAppearance(DEFAULT_APPEARANCE);
  for (const name of ['data-theme', 'data-ground', 'data-width']) expect(root.hasAttribute(name)).toBe(false);
});

it('remembers a change and reads it back', () => {
  setAppearance({ ground: 'sand', width: 'narrow' });
  resetAppearanceForTests();
  expect(readAppearance()).toEqual({ theme: 'system', ground: 'sand', width: 'narrow' });
});
