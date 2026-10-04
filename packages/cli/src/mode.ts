/**
 * Which installation a run of this CLI is about, before it touches anything.
 *
 * `installKind` (commands.ts) reads one variable: the launcher writes
 * `BUDDI_INSTALL_ROOT`, so a run without it was taken to be a source
 * checkout. That is true for `pnpm buddi` and `buddi-dev`, and dangerously
 * false for the packaged code run without its launcher:
 *
 *     <app>/Resources/runtime/node <app>/Resources/buddi/current/packages/cli/dist/main.js uninstall
 *
 * There is no workspace manifest above a packaged tree, so the checkout's
 * paths fell back to a made-up repo root, and its keychain namespace to the
 * checkout's `buddi` — which is the developer instance's on a Mac that has
 * both. On 2026-10-04 that command purged the wrong keychain.
 *
 * So the mode is decided here from what is on disk, and the commands that
 * remove or stop something refuse when it is not clear:
 *
 *  - code inside an app bundle (`/Contents/Resources/buddi/`, `.app/Contents/`),
 *    inside a data directory's `releases/`, or anywhere without the workspace
 *    manifest above it is a packaged release run without its launcher. With
 *    `BUDDI_DATA_DIR` naming an installation it is handed to that release's
 *    launcher, which knows the installation's keychain namespace; without it
 *    the run is ambiguous.
 *  - a checkout whose data directory holds `installation.json` points at a
 *    packaged installation's folder: ambiguous as well.
 *
 * Nothing here imports a `@buddi/*` package: it runs first in `main`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The one line an ambiguous run prints. */
export const AMBIGUOUS_LINE = "Run this from the app's menu, or set BUDDI_DATA_DIR to the installation you mean.";

/** Commands that stop or remove something: refused when the mode is ambiguous. */
export function isGuarded(argv: readonly string[]): boolean {
  const [head, action] = argv;
  if (head === 'uninstall') return true;
  return head === 'service' && (action === 'install' || action === 'stop' || action === 'uninstall');
}

export type Mode =
  | { kind: 'packaged' }
  | { kind: 'checkout' }
  /** Packaged code run without its launcher, pointed at an installation: run that launcher. */
  | { kind: 'delegate'; launcher: string; data: string }
  /** `launcher`: the packaged launcher beside this code, when it is packaged code run without it. */
  | { kind: 'ambiguous'; why: string; launcher?: string };

export interface ModeFacts {
  env: NodeJS.ProcessEnv;
  /** This module's directory (`packages/cli/dist`), symlinks resolved. */
  moduleDir: string;
  /** Was a workspace manifest found above it, or is `repoRoot` the three-up fallback? */
  repoFound: boolean;
  repoRoot: string;
  /** The data directory a checkout run would use. */
  dataDir: string;
  exists?: (file: string) => boolean;
  read?: (file: string) => string | undefined;
}

function posix(p: string): string {
  return p.split(path.sep).join('/') + '/';
}

/** Inside a macOS app bundle: buddi.app's own copy of the release. */
export function insideAppBundle(dir: string): boolean {
  const p = posix(dir);
  return p.includes('/Contents/Resources/buddi/') || /\.app\/Contents\//.test(p);
}

/** Inside a data directory's `releases/`: a release buddi.app installed for itself. */
export function insideReleases(dir: string): boolean {
  return /\/releases\/(buddi-[^/]+|current|previous)\//.test(posix(dir));
}

function readText(file: string): string | undefined {
  try { return readFileSync(file, 'utf8'); } catch { return undefined; }
}

/** `installation.json` in that folder, when it is one: only a packaged installation writes it. */
export function packagedState(data: string, read: (file: string) => string | undefined = readText): Record<string, unknown> | undefined {
  const text = read(path.join(data, 'installation.json'));
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function detectMode(facts: ModeFacts): Mode {
  const { env } = facts;
  const exists = facts.exists ?? existsSync;
  const read = facts.read ?? readText;
  if (env.BUDDI_INSTALL_ROOT?.trim()) return { kind: 'packaged' };
  const bundled = insideAppBundle(facts.moduleDir) || insideReleases(facts.moduleDir) || !facts.repoFound;
  if (bundled) {
    const candidate = path.join(facts.repoRoot, 'packages', 'install', 'dist', 'launcher.js');
    const launcher = exists(candidate) ? candidate : undefined;
    const beside = launcher === undefined ? {} : { launcher };
    const named = env.BUDDI_DATA_DIR?.trim();
    if (!named) {
      return { kind: 'ambiguous', why: `This is buddi's packaged code (${facts.repoRoot}) run without its launcher, and no BUDDI_DATA_DIR says which installation it is for.`, ...beside };
    }
    const data = path.resolve(named);
    if (packagedState(data, read) === undefined) {
      return { kind: 'ambiguous', why: `${data} is not a buddi installation (it has no installation.json).`, ...beside };
    }
    if (launcher === undefined) {
      return { kind: 'ambiguous', why: `This copy of buddi has no launcher at ${candidate}.` };
    }
    return { kind: 'delegate', launcher, data };
  }
  if (packagedState(facts.dataDir, read) !== undefined) {
    return { kind: 'ambiguous', why: `The data directory ${facts.dataDir} belongs to a packaged installation (it has installation.json), not to this checkout.` };
  }
  return { kind: 'checkout' };
}
