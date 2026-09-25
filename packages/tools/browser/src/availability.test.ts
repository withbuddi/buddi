import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserLine, detectBrowser, NO_BROWSER_ACT, needsHeadless } from './availability.js';
import { PlaywrightHost } from './host.js';

/** A filesystem that holds exactly these files. */
const disk = (...files: string[]) => (file: string) => files.includes(file);
const BUNDLED = '/cache/ms-playwright/chromium-1243/chrome-linux/chrome';

describe('detectBrowser', () => {
  it('prefers Playwright\'s bundled Chromium when it is on disk', () => {
    expect(detectBrowser({ platform: 'darwin', env: {}, bundledPath: () => BUNDLED, exists: disk(BUNDLED, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') }))
      .toEqual({ engine: 'chromium', executable: BUNDLED });
  });
  it('falls back to Google Chrome on macOS', () => {
    expect(detectBrowser({ platform: 'darwin', env: {}, bundledPath: () => BUNDLED, exists: disk('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') }))
      .toMatchObject({ engine: 'chrome', channel: true });
    expect(detectBrowser({ platform: 'darwin', env: { HOME: '/Users/ada' }, bundledPath: () => undefined, exists: disk('/Users/ada/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') }))
      .toMatchObject({ engine: 'chrome', channel: false, executable: '/Users/ada/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  });
  it('finds Chrome on Linux at its standard place or on PATH', () => {
    expect(detectBrowser({ platform: 'linux', env: { PATH: '/usr/bin' }, bundledPath: () => BUNDLED, exists: disk('/opt/google/chrome/chrome') }))
      .toMatchObject({ engine: 'chrome', channel: true });
    expect(detectBrowser({ platform: 'linux', env: { PATH: ['/usr/local/bin', '/snap/bin'].join(path.delimiter) }, bundledPath: () => BUNDLED, exists: disk('/snap/bin/google-chrome-stable') }))
      .toEqual({ engine: 'chrome', executable: '/snap/bin/google-chrome-stable', channel: false });
  });
  it('says none when nothing is installed', () => {
    const found = detectBrowser({ platform: 'linux', env: { PATH: '/usr/bin' }, bundledPath: () => BUNDLED, exists: disk() });
    expect(found).toEqual({ engine: 'none' });
    expect(browserLine(found)).toContain('buddi browser install');
  });
});

describe('needsHeadless', () => {
  it('runs headless only on Linux with no display', () => {
    expect(needsHeadless('linux', {})).toBe(true);
    expect(needsHeadless('linux', { DISPLAY: ':0' })).toBe(false);
    expect(needsHeadless('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(false);
    expect(needsHeadless('darwin', {})).toBe(false);
  });
});

describe('launching with no browser', () => {
  it('fails with one sentence instead of a Playwright stack trace', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-nobrowser-'));
    try {
      const host = new PlaywrightHost({ profileDir: path.join(dir, 'profile'), detect: () => ({ engine: 'none' }) });
      await expect(host.open({ adopt: () => {} }, () => true)).rejects.toThrow(NO_BROWSER_ACT);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
