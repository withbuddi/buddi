/**
 * A skill bundle's script, run through `host.exec`'s `skill` form
 * (specs/skills-zone.md, part 2).
 *
 * The rules, all enforced here or by the confinement:
 *
 *  - only a bundle the calling agent holds, and only a file under its
 *    `scripts/`;
 *  - never while the bundle is untrusted (uploaded and not marked as the
 *    owner's): the call is refused before anyone is asked;
 *  - every run asks (the envelope carries `skillRun`, which core reads as
 *    "asks each time": no standing permission answers for it, and its card
 *    offers no Always);
 *  - the script works in its own folder inside the bundle's run directory,
 *    writes only there, reads only the system, its interpreter, the bundle
 *    and that folder, and has no network unless the bundle declares
 *    `network: true`: `sandbox-exec` on macOS, `bwrap` on Linux. With
 *    neither, it does not run (see `confinementArgv` for exactly what holds).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** A bundle as the host tool needs it, resolved by the gateway from the agent's skills. */
export interface SkillBundleView {
  name: string;
  title: string;
  /** The bundle's folder (holds SKILL.md). */
  dir: string;
  /** Uploaded and not marked as the owner's: its scripts cannot run. */
  untrusted: boolean;
  /** Every file's path inside the bundle, SKILL.md included. */
  files: string[];
  /** The paths under `scripts/`. */
  scripts: string[];
  /** SKILL.md says `network: true`: its scripts run with the network. */
  network?: boolean;
}

export interface SkillBundles {
  /** The bundle called `name` that `agentId` holds, or null when it holds none of that name. */
  held(agentId: string, name: string): SkillBundleView | null;
  /** The skills folder: a plain command reaching into it is refused. */
  root(): string;
}

export type Confinement = 'macos-sandbox' | 'bwrap';

/** The confinement this computer offers, or null. */
export function detectConfinement(platform: NodeJS.Platform = process.platform): Confinement | null {
  if (platform === 'darwin') return existsSync('/usr/bin/sandbox-exec') ? 'macos-sandbox' : null;
  if (platform === 'linux') return BWRAP.find((p) => existsSync(p)) ? 'bwrap' : null;
  return null;
}
const BWRAP = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];

/** The interpreter a script runs under, by its extension. */
const INTERPRETERS: Record<string, string> = {
  '.py': 'python3', '.sh': 'sh', '.bash': 'bash', '.js': 'node', '.mjs': 'node', '.cjs': 'node', '.rb': 'ruby', '.pl': 'perl',
};
export function interpreterFor(script: string): string | null {
  return INTERPRETERS[path.extname(script).toLowerCase()] ?? null;
}
export const RUNNABLE_EXTENSIONS = Object.keys(INTERPRETERS);

/** One argument, quoted for bash. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Programs that hand work to another app outside the sandbox: never started from a bundle script. */
const MACOS_DENIED_EXEC = ['/usr/bin/open', '/usr/bin/osascript', '/usr/bin/automator', '/usr/bin/shortcuts'];
/** LaunchServices and Apple Events: how a process asks another app to act for it. */
const MACOS_DENIED_LOOKUP = [
  'com.apple.coreservices.launchservicesd', 'com.apple.coreservices.quarantine-resolver',
  'com.apple.lsd.mapdb', 'com.apple.lsd.modifydb', 'com.apple.coreservices.appleevents',
];
/** What a confined macOS run may read: the system and the usual interpreter homes, nothing of the user's. */
const MACOS_READABLE = [
  '/usr', '/bin', '/sbin', '/System', '/Library/Developer/CommandLineTools', '/Library/Frameworks', '/Library/Apple',
  '/Library/Preferences', '/Applications/Xcode.app/Contents', '/private/var/select', '/private/etc',
  '/private/var/db/timezone', '/private/var/db/dyld', '/opt/homebrew', '/opt/local', '/dev',
];
/** What a confined Linux run sees of the system, read-only; everything else is absent. */
const LINUX_SYSTEM = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/opt'];

export interface ConfineOptions {
  /** The bundle's folder: readable, never writable. */
  bundle?: string;
  /** The interpreter the script runs under (`python3`, `node`): its install is made readable wherever it lives. */
  interpreter?: string;
  /** The bundle declared `network: true`; otherwise the script has no network. */
  network?: boolean;
}

/** Where an interpreter on PATH is installed (two levels above its real binary), or null. */
export function interpreterHome(name: string, envPath = process.env.PATH ?? ''): string | null {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (!existsSync(candidate)) continue;
    let home: string;
    try { home = path.dirname(path.dirname(realpathSync(candidate))); } catch { return null; }
    // `/bin/sh` lives two levels below `/`: never open the whole disk for it.
    return home.split('/').filter(Boolean).length >= 2 ? home : null;
  }
  return null;
}

const covered = (dir: string, roots: readonly string[]): boolean =>
  roots.some((r) => dir === r || dir.startsWith(`${r}/`));

/**
 * The argv a confined run is wrapped in, before `/bin/bash -c`. `work` is a
 * real path.
 *
 * What it holds: writes go only to `work` (and the null and tty devices);
 * reads only the system folders, the interpreter's install, the bundle and
 * `work` — nothing else of the user's (home, keys, other projects); no network
 * unless the bundle declared `network: true`. On macOS it also cannot start
 * `open`, `osascript`, `automator` or `shortcuts` or reach LaunchServices, so
 * it cannot ask another app to act outside the sandbox. On Linux it runs in its
 * own namespaces (bubblewrap `--unshare-all`).
 */
export function confinementArgv(kind: Confinement, work: string, opts: ConfineOptions = {}): string[] {
  const home = opts.interpreter ? interpreterHome(opts.interpreter) : null;
  // The interpreter buddi itself runs under, too: a script's node may be this one.
  const ownHome = path.dirname(path.dirname(process.execPath));
  const own = ownHome.split('/').filter(Boolean).length >= 2 ? ownHome : null;
  if (kind === 'macos-sandbox') {
    const q = (p: string): string => JSON.stringify(p);
    const readable = [...MACOS_READABLE];
    for (const extra of [home, own, opts.bundle]) if (extra && !covered(extra, readable)) readable.push(extra);
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny file-read*)',
      // Seeing that a path exists (stat) is needed to walk to anything; reading it is not allowed.
      '(allow file-read-metadata)',
      `(allow file-read* (literal "/") ${readable.map((p) => `(subpath ${q(p)})`).join(' ')} (subpath ${q(work)}))`,
      '(deny file-write*)',
      `(allow file-write* (subpath ${q(work)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
      `(deny process-exec ${MACOS_DENIED_EXEC.map((p) => `(literal ${q(p)})`).join(' ')})`,
      `(deny mach-lookup ${MACOS_DENIED_LOOKUP.map((n) => `(global-name ${q(n)})`).join(' ')})`,
      ...(opts.network ? [] : ['(deny network*)']),
    ].join('');
    return ['/usr/bin/sandbox-exec', '-p', profile];
  }
  const bwrap = BWRAP.find((p) => existsSync(p)) ?? 'bwrap';
  const system = [...LINUX_SYSTEM, ...(opts.network ? ['/run/systemd/resolve'] : [])].flatMap((p) => ['--ro-bind-try', p, p]);
  const extra = [home, own].filter((d): d is string => !!d && !covered(d, LINUX_SYSTEM)).flatMap((d) => ['--ro-bind-try', d, d]);
  return [bwrap, '--unshare-all', ...(opts.network ? ['--share-net'] : []), '--die-with-parent',
    ...system, ...extra,
    ...(opts.bundle ? ['--ro-bind', opts.bundle, opts.bundle] : []),
    '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--bind', work, work, '--chdir', work];
}

/** The sentence a refusal says when a run cannot be confined here. */
export const NO_CONFINEMENT =
  'This computer has no way to confine a script to its folder (macOS sandbox-exec, or bubblewrap on Linux: `apt install bubblewrap`), so bundle scripts do not run here.';
