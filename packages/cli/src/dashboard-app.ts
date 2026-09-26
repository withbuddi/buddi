/**
 * "Buddi Dashboard" — the double-click that replaces a terminal command.
 *
 * The friction the owner actually hit was not the security model, it was
 * opening a terminal to look at a chart. This removes the terminal and nothing
 * else: what the icon runs is `buddi dashboard`, the same command, so a fresh
 * single-use five-minute ticket is minted per open and every property the
 * server enforces is untouched. Nothing is stored in the bundle — no token, no
 * ticket, no URL with a secret in it — which is why an `.app` in `~/Applications`
 * is safe to leave lying around where a saved bookmark would not be.
 *
 * Why an `.app` bundle and not the alternatives:
 *
 *   - a **`.command` file** works, but double-clicking one opens a Terminal
 *     window that then sits there — the thing being removed;
 *   - a **menu-bar login item** is a background process that runs all day to
 *     serve an action taken a few times a day, and `buddi service` is already
 *     the one process this installation asks to keep alive;
 *   - a **`buddi://` URL scheme** needs a registered handler *and* something to
 *     click that holds the URL, so it is this bundle plus an indirection;
 *   - an `.app` is what macOS itself considers a thing you open: it lands in
 *     Launchpad and Spotlight, it can be dragged to the Dock or the menu bar,
 *     and `LSUIElement` keeps it from bouncing an icon while it runs.
 *
 * It is optional, like `buddi service install`, and it is removable with one
 * command. The bundle is unsigned: it is written locally by the owner's own
 * `buddi`, never downloaded, so Gatekeeper's quarantine bit is never set on it.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI_ENTRY } from './paths.js';

/** Reverse-DNS id, distinct from the service's `com.buddi.serve`. */
export const APP_BUNDLE_ID = 'com.buddi.dashboard';
export const APP_NAME = 'Buddi Dashboard';
/** The executable inside the bundle. Not on `PATH`; only launchd/Finder run it. */
export const APP_EXECUTABLE = 'buddi-dashboard';

export interface AppSpec {
  /** Absolute path to the node binary that runs the CLI. */
  nodePath: string;
  /** Absolute path to `packages/cli/dist/main.js`. */
  cliEntry: string;
}

/** Where the bundle goes: the *user's* Applications, so no sudo and no `/`. */
export function dashboardAppPath(home: string = os.homedir()): string {
  return path.join(home, 'Applications', `${APP_NAME}.app`);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Single-quote for `/bin/sh`. Paths with an apostrophe are rare and still must run. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${escapeXml(APP_NAME)}</string>
  <key>CFBundleDisplayName</key>
  <string>${escapeXml(APP_NAME)}</string>
  <key>CFBundleIdentifier</key>
  <string>${APP_BUNDLE_ID}</string>
  <key>CFBundleExecutable</key>
  <string>${APP_EXECUTABLE}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <!-- No Dock icon and no menu bar: this opens a browser tab and exits. -->
  <key>LSUIElement</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
</dict>
</plist>
`;
}

/**
 * The whole program: run `buddi dashboard`, which mints a ticket and opens it.
 *
 * Absolute paths for both node and the CLI, because a GUI launch inherits
 * almost no `PATH` — the same reason the launchd unit pins them. Output goes to
 * a log nobody has to read; a failure is visible as "no browser tab opened",
 * and `buddi dashboard` in a terminal then says why.
 */
export function buildLauncherScript(spec: AppSpec): string {
  return `#!/bin/sh
# Written by \`buddi dashboard --install-app\`. Holds no secret: a five-minute
# ticket is minted fresh, by the command below, every time this is opened.
exec ${shellQuote(spec.nodePath)} ${shellQuote(spec.cliEntry)} dashboard
`;
}

export interface AppInstall {
  path: string;
  notes: string[];
}

/** Write (or overwrite) the bundle. Idempotent. */
export function installDashboardApp(
  opts: { home?: string; spec?: AppSpec } = {},
): AppInstall {
  const bundle = dashboardAppPath(opts.home ?? os.homedir());
  const spec = opts.spec ?? { nodePath: process.execPath, cliEntry: CLI_ENTRY };
  const notes: string[] = [];
  if (!existsSync(spec.cliEntry)) {
    throw new Error(`${spec.cliEntry} does not exist — run "pnpm -r build" first`);
  }

  const macos = path.join(bundle, 'Contents', 'MacOS');
  mkdirSync(macos, { recursive: true });
  writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), buildInfoPlist());
  const exe = path.join(macos, APP_EXECUTABLE);
  writeFileSync(exe, buildLauncherScript(spec), { mode: 0o755 });
  chmodSync(exe, 0o755);
  // Launch Services notices a bundle whose mtime moved; without this a
  // re-install can keep serving the old cached Info.plist.
  const stamp = new Date();
  utimesSync(bundle, stamp, stamp);

  notes.push(`wrote ${bundle}`);
  notes.push(`it runs: buddi dashboard — a fresh five-minute link each open, nothing stored`);
  notes.push('open it from Launchpad or Spotlight ("Buddi Dashboard"), or drag it to the Dock');
  notes.push('remove it with: buddi dashboard --uninstall-app');
  return { path: bundle, notes };
}

export function uninstallDashboardApp(opts: { home?: string } = {}): AppInstall {
  const bundle = dashboardAppPath(opts.home ?? os.homedir());
  if (!existsSync(bundle)) return { path: bundle, notes: [`no bundle at ${bundle}`] };
  rmSync(bundle, { recursive: true, force: true });
  return { path: bundle, notes: [`removed ${bundle}`] };
}

/**
 * The bundle, when it exists and runs the CLI at `cliEntry`: the one
 * `buddi uninstall` may remove. A bundle another installation wrote on the
 * same machine (a checkout beside a packaged install) is left alone.
 */
export function dashboardAppOwnedBy(cliEntry: string, home: string = os.homedir()): string | undefined {
  const bundle = dashboardAppPath(home);
  try {
    const script = readFileSync(path.join(bundle, 'Contents', 'MacOS', APP_EXECUTABLE), 'utf8');
    return script.includes(shellQuote(cliEntry)) ? bundle : undefined;
  } catch {
    return undefined;
  }
}
