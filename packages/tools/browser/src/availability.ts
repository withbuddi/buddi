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

/** The sentence before the command, for a page that shows the command on its own to copy. */
export const MISSING_LIBRARIES_SENTENCE = 'The browser is installed, but this machine lacks system libraries it needs. Run once, with sudo:';

/** Said when a launch failed because Linux lacks the libraries Chromium needs. */
export function missingLibrariesMessage(): string {
  return `${MISSING_LIBRARIES_SENTENCE} ${installDepsCommand()}`;
}

/** A launch error that means missing shared libraries rather than anything buddi can fix. */
export function isMissingLibraries(message: string): boolean {
  return /missing dependencies|error while loading shared libraries|install-deps/i.test(message);
}

/**
 * The command that lets Chromium start its sandbox on Ubuntu 23.10 or newer,
 * where AppArmor stops programs from making the private space the sandbox
 * needs. Needs sudo; buddi never runs it.
 */
export const SANDBOX_COMMAND = 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0';

/** The sentence before the sandbox command, for a page that shows the command on its own to copy. */
export const NO_SANDBOX_SENTENCE = 'The browser is installed, but this system does not let it start its sandbox. On Ubuntu 23.10 or newer, run once, with sudo:';

/** Said when a launch failed because the system would not let Chromium start its sandbox. */
export function noSandboxMessage(): string {
  return `${NO_SANDBOX_SENTENCE} ${SANDBOX_COMMAND}`;
}

/**
 * A launch error that means Chromium could not start its sandbox: AppArmor on
 * newer Ubuntu, or a container's default seccomp profile. buddi never turns
 * the sandbox off; the owner changes the system instead.
 */
export function isSandboxUnavailable(message: string): boolean {
  return /No usable sandbox|apparmor_restrict_unprivileged_userns|apparmor-userns-restrictions|SUID sandbox/i.test(message);
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

/**
 * The folder Playwright keeps its browsers in, read off the Chromium binary:
 * the parent of its `chromium-<build>` folder. The data directory's
 * `browser/engines` when buddi fetched it, else Playwright's own cache.
 */
export function browsersFolder(executable: string): string {
  let dir = path.dirname(executable);
  while (path.dirname(dir) !== dir) {
    if (/^chromium-\d+$/.test(path.basename(dir))) return path.dirname(dir);
    dir = path.dirname(dir);
  }
  return path.dirname(executable);
}

/** One line for a terminal: what the agents' browser will be and where it lives, or how to get one. */
export function browserLine(found: BrowserAvailability = detectBrowser()): string {
  if (found.engine === 'chromium') return found.executable ? `Browser for agents: Chromium, installed in ${browsersFolder(found.executable)}.` : 'Browser for agents: Chromium, installed.';
  if (found.engine === 'chrome') return found.executable ? `Browser for agents: Google Chrome, at ${found.executable}.` : 'Browser for agents: Google Chrome.';
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

/* ------------------------------------------------------------------ *
 * Install progress, read off the installer's lines
 * ------------------------------------------------------------------ */

/**
 * Where an install stands, in numbers the page can draw — never the
 * installer's own text. `download` counts the packages fetched so far,
 * one-based: Playwright's Chromium is three (the browser, its headless shell,
 * FFmpeg), each with a progress line of its own.
 */
export interface InstallProgress {
  phase: 'downloading' | 'installing' | 'done' | 'failed';
  /** Percent of the current download, 0–100. */
  percent: number;
  /** What is being fetched, in the owner's words: `Chromium`. */
  what: string;
  /** Which download it is on, from 1. 0 before the first has started. */
  download: number;
}

/** A package's name in plain words: `chromium-headless-shell` is "Chromium headless shell". */
function packageWords(name: string): string {
  const known: Record<string, string> = {
    chromium: 'Chromium',
    'chromium-headless-shell': 'Chromium headless shell',
    ffmpeg: 'FFmpeg',
    winldd: 'a Windows helper',
  };
  if (known[name]) return known[name] as string;
  const words = name.split(/[-\s]+/).filter(Boolean);
  if (words.length === 0) return 'Chromium';
  return [words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1), ...words.slice(1).map((w) => w.toLowerCase())].join(' ');
}

/**
 * What a `Downloading …` line is fetching. Newer Playwright titles name the
 * package — `Chrome for Testing 140.0.7339.16 (playwright chromium v1187)` —
 * and older ones only the product and its version — `Chromium 131.0.6778.33
 * (playwright build v1148)`; either way the words before the version.
 */
function downloadWhat(title: string): string {
  const named = /\(playwright ([a-z][a-z0-9-]*) v\d+\)/i.exec(title);
  if (named && named[1] !== 'build') return packageWords(named[1]!.toLowerCase());
  const product = title.split(/\s+/).filter(Boolean);
  const version = product.findIndex((word) => /^\d/.test(word) || word.startsWith('(') || word.toLowerCase() === 'playwright');
  return packageWords((version === -1 ? product : product.slice(0, version)).join(' ').toLowerCase());
}

/**
 * Reads Playwright's installer, line by line, into `InstallProgress`.
 *
 * The lines it knows: `Downloading <title> from <url>` starts a package (a
 * retry names the same title again and is not a new one), `|■■■■   |  45% of
 * 164.8 MiB` is progress on it, and `<title> downloaded to <dir>` ends it —
 * the install is then `installing` until the next package or the end.
 * Anything else is ignored: the numbers never go backwards on a line this
 * does not understand.
 */
export class InstallProgressReader {
  #title: string | undefined;
  #progress: InstallProgress = { phase: 'downloading', percent: 0, what: 'Chromium', download: 0 };

  get progress(): InstallProgress {
    return { ...this.#progress };
  }

  read(raw: string): InstallProgress {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trim();
    const starting = /^Downloading (.+?)(?:\s+from\s+\S+)?$/.exec(line);
    if (starting) {
      const title = starting[1]!.trim();
      if (title !== this.#title) {
        this.#title = title;
        this.#progress = { phase: 'downloading', percent: 0, what: downloadWhat(title), download: this.#progress.download + 1 };
      } else {
        this.#progress = { ...this.#progress, phase: 'downloading', percent: 0 };
      }
      return this.progress;
    }
    const bar = /(\d{1,3})% of /.exec(line);
    if (bar) {
      const percent = Math.max(0, Math.min(100, Number(bar[1])));
      this.#progress = { ...this.#progress, phase: 'downloading', percent: Math.max(percent, this.#progress.phase === 'downloading' ? this.#progress.percent : 0) };
      return this.progress;
    }
    if (/ downloaded to /.test(line)) {
      this.#progress = { ...this.#progress, phase: 'installing', percent: 100 };
      return this.progress;
    }
    return this.progress;
  }

  /** The installer has exited. */
  finish(ok: boolean): InstallProgress {
    this.#progress = ok
      ? { phase: 'done', percent: 100, what: 'Chromium', download: this.#progress.download }
      : { ...this.#progress, phase: 'failed' };
    return this.progress;
  }
}

/* ------------------------------------------------------------------ *
 * Does it launch?
 * ------------------------------------------------------------------ */

/** Whether the agents' browser opened and closed once, and what to do when it did not. */
export type LaunchCheck =
  | { ok: true }
  | {
      ok: false;
      /**
       * One sentence for the owner — the same words the status and
       * `browser.act` say. With a `command`, the sentence leads into it and
       * the command is not repeated inside it.
       */
      message: string;
      /** A command the owner can copy, when there is one to run. */
      command?: string;
      problem?: 'missing-libraries' | 'no-sandbox' | 'no-browser';
    };

/** What the probe launches with. Injectable, so a test never opens a browser. */
export interface ProbeDeps {
  headless: boolean;
  detect?: () => BrowserAvailability;
  platform?: NodeJS.Platform;
  /** Launch, open about:blank, close. Throws with the launch's own error. */
  launch?: (options: LaunchOptions) => Promise<void>;
}

/** What the probe hands to `launch`. The sandbox is on, as in a real session. */
export interface LaunchOptions { headless: boolean; executablePath?: string; channel?: string; chromiumSandbox: true }

async function launchOnce(options: LaunchOptions): Promise<void> {
  const browser = await chromium.launch({ ...options, timeout: 20_000 });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Launch the agents' browser once — headed or headless as this machine
 * dictates — open about:blank, and close it. Not the agents' profile and not
 * their proxy: this asks only whether the binary starts here.
 *
 * A failure is said in the words the rest of the plugin already uses: no
 * browser is `NO_BROWSER_STATUS`, missing Linux libraries is
 * `missingLibrariesMessage()` with its `install-deps` command beside it to
 * copy, a system that will not let Chromium start its sandbox is
 * `noSandboxMessage()` with its `sysctl` command, and anything else is the launch's own first line.
 */
export async function probeLaunch(deps: ProbeDeps): Promise<LaunchCheck> {
  const found = (deps.detect ?? detectBrowser)();
  if (found.engine === 'none') return { ok: false, message: NO_BROWSER_STATUS, problem: 'no-browser' };
  const engine = found.engine === 'chrome'
    ? (!found.channel && found.executable ? { executablePath: found.executable } : { channel: 'chrome' })
    : {};
  try {
    // The same sandbox setting as a real session, or the probe says "installed" for a browser that cannot run.
    await (deps.launch ?? launchOnce)({ headless: deps.headless, ...engine, chromiumSandbox: true });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((deps.platform ?? process.platform) === 'linux' && isMissingLibraries(message)) {
      return { ok: false, message: MISSING_LIBRARIES_SENTENCE, command: installDepsCommand(), problem: 'missing-libraries' };
    }
    if ((deps.platform ?? process.platform) === 'linux' && isSandboxUnavailable(message)) {
      return { ok: false, message: NO_SANDBOX_SENTENCE, command: SANDBOX_COMMAND, problem: 'no-sandbox' };
    }
    const first = message.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? 'no reason given';
    return { ok: false, message: `The browser is installed but would not start: ${first.slice(0, 300)}` };
  }
}
