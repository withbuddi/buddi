import { describe, expect, it } from 'vitest';
import { detectBrowser } from './brand.js';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const brands = (...names: string[]) => ({ brands: [{ brand: 'Not=A?Brand' }, { brand: 'Chromium' }, ...names.map((brand) => ({ brand }))] });

describe('detectBrowser', () => {
  it('names Edge from its brand or its user agent', () => {
    expect(detectBrowser({ userAgent: CHROME_UA, userAgentData: brands('Microsoft Edge') })).toBe('Microsoft Edge');
    expect(detectBrowser({ userAgent: `${CHROME_UA} Edg/140.0.0.0` })).toBe('Microsoft Edge');
  });
  it('names Chrome only when it says so', () => {
    expect(detectBrowser({ userAgent: CHROME_UA, userAgentData: brands('Google Chrome') })).toBe('Google Chrome');
    expect(detectBrowser({ userAgent: CHROME_UA })).toBe('Google Chrome');
  });
  it('names Brave, Opera, Vivaldi and Arc', () => {
    expect(detectBrowser({ userAgent: CHROME_UA, userAgentData: brands('Brave') })).toBe('Brave');
    expect(detectBrowser({ userAgent: CHROME_UA, userAgentData: brands(), brave: {} })).toBe('Brave');
    expect(detectBrowser({ userAgent: `${CHROME_UA} OPR/120.0.0.0`, userAgentData: brands('Opera') })).toBe('Opera');
    expect(detectBrowser({ userAgent: `${CHROME_UA} Vivaldi/7.0`, userAgentData: brands() })).toBe('Vivaldi');
    expect(detectBrowser({ userAgent: CHROME_UA, userAgentData: brands('Google Chrome'), arc: true })).toBe('Arc');
  });
  it('leaves an unknown Chromium unnamed', () => {
    expect(detectBrowser({ userAgent: CHROME_UA, userAgentData: brands() })).toBeUndefined();
    expect(detectBrowser({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' })).toBeUndefined();
    expect(detectBrowser(undefined)).toBeUndefined();
  });
});
