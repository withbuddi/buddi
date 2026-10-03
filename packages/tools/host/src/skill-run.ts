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
 *    reads the bundle without changing it, and writes only in that folder:
 *    `sandbox-exec` on macOS, `bwrap` on Linux. With neither, it does not run.
 *    The network is left as host commands have it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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

/** The argv a confined run is wrapped in, before `/bin/bash -c`. `work` is a real path. */
export function confinementArgv(kind: Confinement, work: string): string[] {
  if (kind === 'macos-sandbox') {
    const q = (p: string): string => JSON.stringify(p);
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      `(allow file-write* (subpath ${q(work)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
    ].join('');
    return ['/usr/bin/sandbox-exec', '-p', profile];
  }
  const bwrap = BWRAP.find((p) => existsSync(p)) ?? 'bwrap';
  return [bwrap, '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--bind', work, work, '--chdir', work, '--die-with-parent'];
}

/** The sentence a refusal says when a run cannot be confined here. */
export const NO_CONFINEMENT =
  'This computer has no way to confine a script to its folder (macOS sandbox-exec, or bubblewrap on Linux: `apt install bubblewrap`), so bundle scripts do not run here.';
