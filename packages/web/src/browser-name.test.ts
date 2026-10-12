import { afterEach, describe, expect, it } from 'vitest';
import { browserWord, currentBrowserWord, detectBrowser, extensionsPage, rememberBrowser, resetBrowserName, storeLabel, theBrowser, yourBrowser, YourBrowser } from './browser-name';
import { lookingLine } from './views/Browser';
import type { BrowserStatus } from './api';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const brands = (...names: string[]) => ({ brands: [{ brand: 'Not=A?Brand' }, { brand: 'Chromium' }, ...names.map((brand) => ({ brand }))] });

describe('detectBrowser', () => {
  it('names Edge, Chrome, Brave, Opera, Vivaldi and Arc', () => {
    expect(detectBrowser({ userAgent: `${CHROME_UA} Edg/140.0.0.0`, userAgentData: brands('Microsoft Edge') })).toBe('Microsoft Edge');
    expect(detectBrowser({ userAgent: `${CHROME_UA} Edg/140.0.0.0` })).toBe('Microsoft Edge');
    expect(detectBrowser({ userAgent: CHROME_UA, userAgentData: brands('Google Chrome') })).toBe('Google Chrome');
    expect(detectBrowser({ userAgent: CHROME_UA, userAgentData: brands('Brave') })).toBe('Brave');
    expect(detectBrowser({ userAgent: `${CHROME_UA} OPR/120.0.0.0` })).toBe('Opera');
    expect(detectBrowser({ userAgent: `${CHROME_UA} Vivaldi/7.0` })).toBe('Vivaldi');
    expect(detectBrowser({ userAgent: CHROME_UA, userAgentData: brands('Google Chrome'), arc: true })).toBe('Arc');
  });
  it('names nothing for Safari, Firefox, Chrome on iOS or an unknown Chromium', () => {
    expect(detectBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' })).toBeUndefined();
    expect(detectBrowser({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' })).toBeUndefined();
    expect(detectBrowser({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1' })).toBeUndefined();
    expect(detectBrowser({ userAgent: CHROME_UA, userAgentData: brands() })).toBeUndefined();
  });
});

describe('the words', () => {
  afterEach(() => resetBrowserName());

  it('says the short name, or "your browser"', () => {
    expect(browserWord('Microsoft Edge')).toBe('Edge');
    expect(browserWord('constructor')).toBeUndefined();
    expect(yourBrowser('Edge')).toBe('your Edge');
    expect(YourBrowser(undefined)).toBe('Your browser');
    expect(theBrowser(undefined)).toBe('your browser');
    expect(extensionsPage('Edge')).toBe('edge://extensions');
    expect(extensionsPage(undefined)).toBe('chrome://extensions');
  });

  it('keeps the Chrome Web Store, and says it works in Edge', () => {
    expect(storeLabel('Chrome')).toBe('Add to Chrome');
    expect(storeLabel('Edge')).toBe('Get the buddi extension (Chrome Web Store, works in Edge)');
    expect(storeLabel(undefined)).toBe('Get the buddi extension (Chrome Web Store)');
  });

  it('takes the paired browser from the gateway, and forgets it with the pairing', () => {
    expect(currentBrowserWord()).toBeUndefined(); // jsdom names no browser
    rememberBrowser({ browser: 'Microsoft Edge', pairedAt: '2026-10-01T00:00:00Z' });
    expect(currentBrowserWord()).toBe('Edge');
    const status = { route: 'chrome', page: { url: 'https://www.amazon.com/' } } as unknown as BrowserStatus;
    expect(lookingLine(status)).toBe('Looking at amazon.com · in your Edge · background tab');
    rememberBrowser({ browser: 'Microsoft Edge', pairedAt: null });
    expect(currentBrowserWord()).toBeUndefined();
    expect(lookingLine(status)).toBe('Looking at amazon.com · in your browser · background tab');
  });
});
