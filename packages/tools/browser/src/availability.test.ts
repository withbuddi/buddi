import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserLine, detectBrowser, InstallProgressReader, NO_BROWSER_ACT, NO_BROWSER_STATUS, NO_SANDBOX_SENTENCE, needsHeadless, probeLaunch, SANDBOX_COMMAND } from './availability.js';
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
  it('says where the browser lives', () => {
    expect(browserLine({ engine: 'chromium', executable: '/data/browser/engines/chromium-1187/chrome-linux/chrome' }))
      .toBe('Browser for agents: Chromium, installed in /data/browser/engines.');
    expect(browserLine({ engine: 'chrome', executable: '/opt/google/chrome/chrome', channel: true }))
      .toBe('Browser for agents: Google Chrome, at /opt/google/chrome/chrome.');
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

/*
 * What Playwright 1.63's installer prints when its output is piped: one
 * "Downloading" line per package, a progress line per tenth, one "downloaded
 * to" line when the package is in place. A retry repeats its "Downloading".
 */
const INSTALLER = [
  'Downloading Chrome for Testing 140.0.7339.16 (playwright chromium v1187) from https://cdn.playwright.dev/builds/cft/140.0.7339.16/linux64/chrome-linux64.zip',
  '|■■■■■■■■                                                                        |  10% of 170.4 MiB',
  '|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■                                            |  45% of 170.4 MiB',
  '|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■| 100% of 170.4 MiB',
  'Chrome for Testing 140.0.7339.16 (playwright chromium v1187) downloaded to /root/.cache/ms-playwright/chromium-1187',
  'Downloading Chrome Headless Shell 140.0.7339.16 (playwright chromium-headless-shell v1187) from https://cdn.playwright.dev/builds/cft/140.0.7339.16/linux64/chrome-headless-shell-linux64.zip',
  '|■■■■■■■■■■■■■■■■                                                                |  20% of 104.3 MiB',
];

describe('InstallProgressReader', () => {
  it('reads the installer into numbers, package by package', () => {
    const reader = new InstallProgressReader();
    const seen = INSTALLER.map((line) => reader.read(line));
    expect(seen[0]).toEqual({ phase: 'downloading', percent: 0, what: 'Chromium', download: 1 });
    expect(seen[2]).toEqual({ phase: 'downloading', percent: 45, what: 'Chromium', download: 1 });
    expect(seen[4]).toEqual({ phase: 'installing', percent: 100, what: 'Chromium', download: 1 });
    // The switch to the next package starts it at zero and counts it.
    expect(seen[5]).toEqual({ phase: 'downloading', percent: 0, what: 'Chromium headless shell', download: 2 });
    expect(seen[6]).toEqual({ phase: 'downloading', percent: 20, what: 'Chromium headless shell', download: 2 });
  });

  it('reads the older titles, a retry, FFmpeg, and a completed run', () => {
    const reader = new InstallProgressReader();
    reader.read('Downloading Chromium 131.0.6778.33 (playwright build v1148) from https://playwright.azureedge.net/builds/chromium/1148/chromium-linux.zip');
    expect(reader.read('|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■                                        |  50% of 164.8 MiB')).toMatchObject({ what: 'Chromium', percent: 50, download: 1 });
    // A retry of the same package is not a new one.
    expect(reader.read('Downloading Chromium 131.0.6778.33 (playwright build v1148) from https://playwright-akamai.azureedge.net/builds/chromium/1148/chromium-linux.zip')).toEqual({ phase: 'downloading', percent: 0, what: 'Chromium', download: 1 });
    reader.read('Chromium 131.0.6778.33 (playwright build v1148) downloaded to /home/me/.cache/ms-playwright/chromium-1148');
    expect(reader.read('Downloading FFMPEG playwright build v1010 from https://playwright.azureedge.net/builds/ffmpeg/1010/ffmpeg-linux.zip')).toMatchObject({ what: 'FFmpeg', download: 2 });
    expect(reader.read('Downloading FFmpeg (playwright ffmpeg v1011) from https://cdn.playwright.dev/builds/ffmpeg/1011/ffmpeg-linux.zip')).toMatchObject({ what: 'FFmpeg', download: 3 });
    // Lines it does not know change nothing.
    expect(reader.read('BEWARE: your OS is not officially supported by Playwright')).toMatchObject({ what: 'FFmpeg', percent: 0, download: 3 });
    expect(reader.finish(true)).toEqual({ phase: 'done', percent: 100, what: 'Chromium', download: 3 });
  });

  it('says failed where it stopped', () => {
    const reader = new InstallProgressReader();
    reader.read(INSTALLER[0]!);
    reader.read(INSTALLER[2]!);
    expect(reader.finish(false)).toEqual({ phase: 'failed', percent: 45, what: 'Chromium', download: 1 });
  });
});

describe('probeLaunch', () => {
  it('says there is nothing to launch before anything is installed', async () => {
    expect(await probeLaunch({ headless: true, detect: () => ({ engine: 'none' }) })).toEqual({
      ok: false, message: NO_BROWSER_STATUS, problem: 'no-browser',
    });
  });

  it('launches the Chrome it found by path when Playwright cannot find it by channel', async () => {
    const seen: unknown[] = [];
    const answer = await probeLaunch({
      headless: false,
      detect: () => ({ engine: 'chrome', executable: '/usr/bin/google-chrome', channel: false }),
      launch: async (options) => { seen.push(options); },
    });
    expect(answer).toEqual({ ok: true });
    expect(seen).toEqual([{ headless: false, executablePath: '/usr/bin/google-chrome', chromiumSandbox: true }]);
  });

  it('names missing libraries only on Linux', async () => {
    const launch = async (): Promise<void> => { throw new Error('error while loading shared libraries: libnss3.so'); };
    const detect = () => ({ engine: 'chromium' as const, executable: '/x/chrome' });
    expect(await probeLaunch({ headless: true, detect, launch, platform: 'linux' })).toMatchObject({ problem: 'missing-libraries' });
    expect(await probeLaunch({ headless: true, detect, launch, platform: 'darwin' })).toMatchObject({
      ok: false, message: expect.stringContaining('would not start: error while loading shared libraries'),
    });
  });

  it('launches with the sandbox on, as a real session does', async () => {
    const seen: unknown[] = [];
    await probeLaunch({ headless: true, detect: () => ({ engine: 'chromium', executable: '/x/chrome' }), launch: async (options) => { seen.push(options); } });
    expect(seen).toEqual([{ headless: true, chromiumSandbox: true }]);
  });

  it('says a system that will not let Chromium start its sandbox, with the command to copy', async () => {
    const launch = async (): Promise<void> => {
      throw new Error('browserType.launchPersistentContext: Target page, context or browser has been closed\n[pid=12][err] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md');
    };
    const detect = () => ({ engine: 'chromium' as const, executable: '/x/chrome' });
    expect(await probeLaunch({ headless: true, detect, launch, platform: 'linux' })).toEqual({
      ok: false, message: NO_SANDBOX_SENTENCE, command: SANDBOX_COMMAND, problem: 'no-sandbox',
    });
    expect(NO_SANDBOX_SENTENCE).not.toMatch(/userns|seccomp/);
    expect(SANDBOX_COMMAND).toBe('sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0');
  });
});
