/**
 * Whether the agents' own browser can launch on this machine, and the way to
 * make it launch when it cannot.
 *
 * Playwright's bundled Chromium exists only after `playwright install
 * chromium`, which nothing runs for an `npm install -g buddi` install. So the
 * plugin asks before it launches: Playwright's own Chromium for the installed
 * Playwright version, else Google Chrome where it is installed, else nothing —
 * and "nothing" is a sentence the owner can act on, not a stack trace.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright';

/** `chromium` is Playwright's bundled build; `chrome` is the owner's Google Chrome. */
export type BrowserEngine = 'chromium' | 'chrome' | 'none';

export interface BrowserAvailability {
  engine: BrowserEngine;
  /** The binary found. For Chrome off its standard location, the one Playwright is pointed at. */
  executable?: string;
  /** True when Playwright's `channel: 'chrome'` finds this Chrome on its own. */
  channel?: boolean;
}

/** What detection reads, injectable so a test can say what is on disk and on PATH. */
export interface DetectDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  /** Playwright's bundled Chromium path for the installed version; undefined when unknown. */
  bundledPath?: () => string | undefined;
}

/** What the tool and the page say when no browser is installed. */
export const NO_BROWSER_STATUS = 'No browser installed for the agents yet. Install one from Settings → Computer & browser, or run `buddi browser install` (about 150 MB).';
/** What a `browser.act` call fails with, one sentence the model can relay. */
export const NO_BROWSER_ACT = 'There is no browser installed yet; the owner can install one from Settings → Computer & browser or with `buddi browser install`.';
/** Said in the status when this machine has no display and the browser runs headless. */
export const HEADLESS_NOTE = 'The agents\' browser runs headless on this machine, since it has no display. Watch it and take over from the conversation\'s Canvas.';

/** The command that installs Chromium's system libraries on Linux. Needs sudo; buddi never runs it. */
export function installDepsCommand(): string {
  const cli = playwrightCli();
  return cli ? `sudo "${process.execPath}" "${cli}" install-deps chromium` : 'sudo npx playwright install-deps chromium';
}

/** Said when a launch failed because Linux lacks the libraries Chromium needs. */
export function missingLibrariesMessage(): string {
  return `The browser is installed, but this machine lacks system libraries it needs. Run once, with sudo: ${installDepsCommand()}`;
}

/** A launch error that means missing shared libraries rather than anything buddi can fix. */
export function isMissingLibraries(message: string): boolean {
  return /missing dependencies|error while loading shared libraries|install-deps/i.test(message);
}

function bundled(): string | undefined {
  try { return chromium.executablePath(); } catch { return undefined; }
}

/** The first executable called `name` on PATH. */
function onPath(name: string, env: NodeJS.ProcessEnv, exists: (file: string) => boolean): string | undefined {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    if (exists(file)) return file;
  }
  return undefined;
}

/**
 * Which browser the agents' own browser would launch. Bundled Chromium wins
 * when present, then Google Chrome, then none.
 */
export function detectBrowser(deps: DetectDeps = {}): BrowserAvailability {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const chromiumPath = (deps.bundledPath ?? bundled)();
  if (chromiumPath && exists(chromiumPath)) return { engine: 'chromium', executable: chromiumPath };
  if (platform === 'darwin') {
    const suffix = 'Google Chrome.app/Contents/MacOS/Google Chrome';
    const system = path.join('/Applications', suffix);
    if (exists(system)) return { engine: 'chrome', executable: system, channel: true };
    const own = env.HOME ? path.join(env.HOME, 'Applications', suffix) : undefined;
    if (own && exists(own)) return { engine: 'chrome', executable: own, channel: false };
  } else if (platform === 'linux') {
    // Where Playwright's `chrome` channel looks; the PATH names are the fallback.
    if (exists('/opt/google/chrome/chrome')) return { engine: 'chrome', executable: '/opt/google/chrome/chrome', channel: true };
    for (const name of ['google-chrome', 'google-chrome-stable']) {
      const found = onPath(name, env, exists);
      if (found) return { engine: 'chrome', executable: found, channel: false };
    }
  } else if (platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      if (!base) continue;
      const file = path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
      if (exists(file)) return { engine: 'chrome', executable: file, channel: true };
    }
  }
  return { engine: 'none' };
}

/**
 * Whether the agents' browser must run headless: Linux with no display.
 * Everywhere else a desktop session is assumed, and the browser is headed.
 */
export function needsHeadless(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/** One line for a terminal: what the agents' browser will be, or how to get one. */
export function browserLine(found: BrowserAvailability = detectBrowser()): string {
  if (found.engine === 'chromium') return 'Browser for agents: Chromium, installed.';
  if (found.engine === 'chrome') return 'Browser for agents: Google Chrome.';
  return 'Browser for agents: not installed yet — buddi browser install (about 150 MB).';
}

/** Playwright's own `cli.js`, from the copy this plugin depends on. */
export function playwrightCli(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  } catch { return undefined; }
}

export interface InstallOutcome {
  ok: boolean;
  /** The last thing the installer said, or why it did not run. */
  detail: string;
  /** The installer warned that Linux lacks libraries Chromium needs. */
  missingLibraries: boolean;
}

/**
 * Playwright's installer for Chromium: `node cli.js install chromium`.
 *
 * `inherit` streams to this terminal as the installer draws it; otherwise
 * each line (progress bars redraw with `\r`) goes to `onLine`.
 */
export function installBrowser(options: { onLine?: (line: string) => void; inherit?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<InstallOutcome> {
  const cli = playwrightCli();
  if (!cli || !existsSync(cli)) return Promise.resolve({ ok: false, detail: 'Playwright is not installed with buddi, so there is no installer to run.', missingLibraries: false });
  return new Promise((resolve) => {
    let last = '';
    let all = '';
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      env: options.env ?? process.env,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    const read = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      all = (all + text).slice(-20_000);
      for (const piece of text.split(/[\r\n]+/)) {
        const line = piece.trim();
        if (!line) continue;
        last = line;
        options.onLine?.(line);
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.once('error', (error) => resolve({ ok: false, detail: error.message, missingLibraries: false }));
    child.once('close', (code) => {
      const missingLibraries = isMissingLibraries(all);
      resolve(code === 0
        ? { ok: true, detail: last || 'Chromium is installed.', missingLibraries }
        : { ok: false, detail: last || `The installer stopped with code ${code}.`, missingLibraries });
    });
  });
}
