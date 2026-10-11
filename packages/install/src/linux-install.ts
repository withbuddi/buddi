/**
 * The Linux install (scripts/install.sh), as the launcher sees it: the
 * systemd unit it writes for that layout, and which `buddi` command on PATH
 * belongs to which installation. Pure functions with the disk injected, so
 * the tests need neither systemd nor a home folder.
 */
import path from 'node:path';
import { APP_LAYOUT_VAR, LINUX_INSTALL_VAR, currentLauncher } from './app-layout.js';
import { SERVICE_UNIT_VAR } from './environment.js';

/** The marker line scripts/install.sh writes into the `buddi` command it puts on PATH. */
export const LINUX_COMMAND_MARKER = '# buddi-linux-install';

/** The line scripts/install.sh puts in the desktop entries it writes (app grid, autostart). */
export const LINUX_DESKTOP_MARK = 'X-Buddi-Linux-Install=true';

/** The desktop entries scripts/install.sh writes, where they would be. */
export function desktopEntryPaths(env: NodeJS.ProcessEnv, home: string): string[] {
  const data = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [path.join(data, 'applications', 'buddi-desktop.desktop'), path.join(config, 'autostart', 'buddi-desktop.desktop')];
}

/**
 * Of the entries at `paths` (app grid, autostart), the ones `buddi uninstall`
 * removes: only those carrying the installer's mark, so an entry the owner
 * wrote or turned off stays; and an app-grid entry only when it is this
 * installation's (it names the data folder), so removing a second install
 * leaves the first one's launcher alone.
 */
export function ownDesktopEntries(paths: string[], data: string, read: (file: string) => string | undefined): string[] {
  return paths.filter((file, index) => {
    const text = read(file);
    if (text === undefined || !text.split('\n').includes(LINUX_DESKTOP_MARK)) return false;
    return index > 0 || text.includes(`${data}/`);
  });
}

/** The bundled node the Linux install runs: `<data>/node/node`, never the machine's. */
export function bundledNode(data: string): string {
  return path.join(data, 'node', 'node');
}

export interface LinuxUnitSpec {
  nodePath: string;
  serveEntry: string;
  environment: Record<string, string>;
  path: string;
}

/**
 * What the unit runs: the bundled node and `<releases>/current`'s launcher,
 * named through the link so an upgrade's switch needs no new unit. Throws
 * when the bundled node is not there: a unit on `/usr/bin/node` is the very
 * thing this install exists to avoid.
 */
export function linuxUnitSpec(opts: { data: string; releases: string; label: string; exists: (file: string) => boolean; extra?: Record<string, string> }): LinuxUnitSpec {
  const nodePath = bundledNode(opts.data);
  if (!opts.exists(nodePath)) {
    throw new Error(`the bundled Node is missing at ${nodePath}; install buddi again: curl -fsSL https://withbuddi.com/install.sh | sh`);
  }
  return {
    nodePath,
    serveEntry: currentLauncher(opts.releases),
    environment: {
      BUDDI_DATA_DIR: opts.data,
      [SERVICE_UNIT_VAR]: opts.label,
      ...(opts.extra ?? {}),
      [APP_LAYOUT_VAR]: opts.releases,
      [LINUX_INSTALL_VAR]: '1',
      npm_config_cache: path.join(opts.data, 'cache', 'npm'),
    },
    // npm's shebang is `env node`: the bundled one first.
    path: [path.dirname(nodePath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
  };
}

/** The data folder a command written by scripts/install.sh runs (its `DATA='…'` line), or undefined when it is not one. */
export function commandData(text: string): string | undefined {
  if (!text.includes(LINUX_COMMAND_MARKER)) return undefined;
  const line = text.split('\n').find(l => l.startsWith('DATA='));
  if (line === undefined) return undefined;
  const raw = line.slice('DATA='.length);
  return raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replace(/'\\''/g, "'") : raw;
}

/** Is this command the installer's, for this data folder? Both sides resolved, so a linked home still matches. */
export function commandOwnedBy(text: string | undefined, data: string, real: (file: string) => string = file => file): boolean {
  if (text === undefined) return false;
  const named = commandData(text);
  if (named === undefined) return false;
  const norm = (file: string): string => { try { return real(path.resolve(file)); } catch { return path.resolve(file); } };
  return norm(named) === norm(data);
}
