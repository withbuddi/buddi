import { describe, expect, it } from 'vitest';
import { browserBrand, browserWord, yourBrowser, YourBrowser } from './brand.js';

describe('the owner browser words', () => {
  it('keeps only the names the extension sends', () => {
    expect(browserBrand('Microsoft Edge')).toBe('Microsoft Edge');
    expect(browserBrand('Netscape')).toBeUndefined();
    expect(browserBrand(42)).toBeUndefined();
    expect(browserBrand('toString')).toBeUndefined();
  });
  it('says the short name, or "browser"', () => {
    expect(browserWord('Microsoft Edge')).toBe('Edge');
    expect(browserWord('Google Chrome')).toBe('Chrome');
    expect(yourBrowser('Microsoft Edge')).toBe('your Edge');
    expect(yourBrowser(undefined)).toBe('your browser');
    expect(YourBrowser('Brave')).toBe('Your Brave');
    expect(YourBrowser(undefined)).toBe('Your browser');
  });
});
