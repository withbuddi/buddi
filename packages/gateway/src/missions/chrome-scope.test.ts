/** A mission and the owner's Chrome: the words the cards use, and what a package update keeps. */
import { describe, expect, it } from 'vitest';
import { chromeWords, keptBrowser, missionSettingsWords } from '../agents/platform-catalogue.js';
import { chromeLine, signInSiteIn, siteLabel, useChromeAsk } from './chrome-scope.js';

describe("the owner's Chrome on a card", () => {
  it('names a site the way the owner says it', () => {
    expect(siteLabel('pnc.com')).toBe('PNC');
    expect(siteLabel('www.onlinebanking.chase.com')).toBe('Chase');
    expect(siteLabel('barclays.co.uk')).toBe('Barclays');
    expect(siteLabel(undefined)).toBeUndefined();
  });

  it('says it in one line: when it runs, and that it uses your Chrome', () => {
    expect(chromeLine('every day at 07:00 America/New_York', 'pnc.com')).toBe('Runs every day at 07:00 America/New_York, using your Chrome for PNC.');
    expect(chromeLine(null)).toBe('It runs while you are away, using your Chrome.');
    expect(useChromeAsk('PNC pull')).toBe('Let the PNC pull use your Chrome?');
    expect(useChromeAsk('Morning balances')).toBe('Let the morning balances use your Chrome?');
  });

  it("finds the sign-in site a plan names, by address or by name, and nothing else", () => {
    const sites = ['pnc.com', 'amazon.com'];
    expect(signInSiteIn('Open https://www.pnc.com/accounts and read the balances', sites)).toBe('pnc.com');
    expect(signInSiteIn('Pull the PNC balances', sites)).toBe('pnc.com');
    expect(signInSiteIn('Check smile.amazon.com orders', sites)).toBe('amazon.com');
    expect(signInSiteIn('Check the weather', sites)).toBeUndefined();
  });

  it("an agent package's mission card says when it uses your Chrome", () => {
    expect(chromeWords('pnc.com')).toMatch(/^using your Chrome for PNC while you are away/);
    expect(missionSettingsWords({ id: 'm', name: 'PNC pull', context: null, reportMax: null, browser: 'owner', browserFor: 'pnc.com' })).toContain('using your Chrome for PNC');
  });

  it("a package update that still says `own` keeps the owner's grant of his Chrome; anything else follows the package", () => {
    expect(keptBrowser('owner', 'own')).toBe('owner');
    expect(keptBrowser('owner', null)).toBeNull();
    expect(keptBrowser('own', 'owner')).toBe('owner');
    expect(keptBrowser(null, 'own')).toBe('own');
  });
});
