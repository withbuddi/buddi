/**
 * buddi.app's "Install Command Line Tool": a `buddi` on the owner's PATH that
 * runs the app's own copy.
 *
 * The shim is a few lines of sh at `/usr/local/bin/buddi` (an administrator
 * prompt, once), or `~/.local/bin/buddi` when that is declined or impossible,
 * with a line saying how to put that folder on PATH. It runs the bundled
 * Node with `<data>/releases/current` when buddi has updated itself, the
 * bundle's copy otherwise, and always the app's data directory — so it keeps
 * working across updates without being rewritten, and it can never point a
 * terminal at another installation.
 *
 * It refuses while a `buddi` from npm is on PATH: two commands named buddi
 * answering for two copies is how the wrong one gets run. `buddi doctor`
 * says when a shim's app has gone (moved, or deleted without uninstalling).
 *
 * Every effect is injected; the supervisor wires the real ones (osascript
 * for the administrator prompt).
 */
import path from 'node:path';

/** The line every shim carries, so ours is told from anyone else's `buddi`. */
export const SHIM_MARKER = '# buddi-shim: installed by buddi.app (Install Command Line Tool)';

export const SYSTEM_SHIM = '/usr/local/bin/buddi';

export function userShim(home: string): string {
  return path.join(home, '.local', 'bin', 'buddi');
}

/** Single quotes for sh, with any single quote inside closed and escaped. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ShimTarget {
  /** buddi.app, e.g. /Applications/buddi.app. */
  app: string;
  /** The app's data directory. */
  data: string;
}

/** The shim itself. */
export function shimScript({ app, data }: ShimTarget): string {
  return [
    '#!/bin/sh',
    SHIM_MARKER,
    `APP=${sh(app)}`,
    `DATA=${sh(data)}`,
    'NODE="$APP/Contents/Resources/runtime/node"',
    'if [ ! -x "$NODE" ]; then',
    '  echo "buddi: buddi.app is no longer at $APP. Open it and choose Install Command Line Tool again, or remove $0." >&2',
    '  exit 127',
    'fi',
    // An update buddi installed for itself, else the copy the app carries.
    'ROOT="$DATA/releases/current"',
    '[ -f "$ROOT/packages/install/dist/launcher.js" ] || ROOT="$APP/Contents/Resources/buddi/current"',
    'BUDDI_DATA_DIR="$DATA" exec "$NODE" "$ROOT/packages/install/dist/launcher.js" "$@"',
    '',
  ].join('\n');
}

/** What a shim on disk says about itself; undefined when the file is not one of ours. */
export function readShim(text: string): ShimTarget | undefined {
  if (!text.includes(SHIM_MARKER)) return undefined;
  const value = (name: string): string | undefined => {
    const line = text.split('\n').find((l) => l.startsWith(`${name}=`));
    if (line === undefined) return undefined;
    const raw = line.slice(name.length + 1);
    return raw.startsWith("'") ? raw.slice(1, -1).replace(/'\\''/g, "'") : raw;
  };
  const app = value('APP');
  const data = value('DATA');
  return app !== undefined && data !== undefined ? { app, data } : undefined;
}

/** Is this `buddi` npm's? Its real path runs through the package's folder. */
export function isNpmBuddi(realPath: string): boolean {
  return realPath.split(path.sep).join('/').includes('/node_modules/@withbuddi/buddi/');
}

export interface ShimDeps {
  home: string;
  /** The folders to look for another `buddi` in: PATH, and where npm usually puts it. */
  searchPath: string[];
  exists: (file: string) => boolean;
  /** Symlinks resolved; undefined when it cannot be. */
  realPath: (file: string) => string | undefined;
  read: (file: string) => string | undefined;
  /** Write as the owner (mode 0755), creating the folder; throws when it may not. */
  write: (file: string, text: string) => Promise<void>;
  /** Write with an administrator prompt; throws when declined or it fails. */
  writeAsAdmin: (file: string, text: string) => Promise<void>;
  remove: (file: string) => Promise<void>;
  removeAsAdmin: (file: string) => Promise<void>;
}

export type ShimOutcome =
  | { ok: true; file: string; lines: string[] }
  | { ok: false; status: number; error: string };

/** Where npm usually leaves its `buddi`, beside the folders already on PATH. */
export function npmCandidates(home: string): string[] {
  return ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.local', 'bin')];
}

/** An npm `buddi` anywhere it would be found; the path a terminal would run. */
export function findNpmBuddi(deps: Pick<ShimDeps, 'searchPath' | 'exists' | 'realPath' | 'home'>): string | undefined {
  const seen = new Set<string>();
  for (const dir of [...deps.searchPath, ...npmCandidates(deps.home)]) {
    if (dir === '' || seen.has(dir)) continue;
    seen.add(dir);
    const file = path.join(dir, 'buddi');
    if (!deps.exists(file)) continue;
    const real = deps.realPath(file);
    if (real !== undefined && isNpmBuddi(real)) return file;
  }
  return undefined;
}

/** Install (or refresh) the shim for this app and data directory. */
export async function installShim(target: ShimTarget, deps: ShimDeps): Promise<ShimOutcome> {
  const npm = findNpmBuddi(deps);
  if (npm !== undefined) {
    return { ok: false, status: 409, error: `buddi is already installed from npm at ${npm}; remove it first for the app's copy: npm rm -g @withbuddi/buddi` };
  }
  const script = shimScript(target);
  for (const file of [SYSTEM_SHIM, userShim(deps.home)]) {
    if (!deps.exists(file)) continue;
    const text = deps.read(file);
    if (text === undefined || readShim(text) === undefined) {
      return { ok: false, status: 409, error: `${file} is another program's buddi, so it was left alone. Move it aside, then try again.` };
    }
  }
  try {
    await deps.write(SYSTEM_SHIM, script);
    return { ok: true, file: SYSTEM_SHIM, lines: [`buddi is at ${SYSTEM_SHIM}. Open a new terminal and run buddi status.`] };
  } catch { /* /usr/local/bin is root's: ask once. */ }
  try {
    await deps.writeAsAdmin(SYSTEM_SHIM, script);
    return { ok: true, file: SYSTEM_SHIM, lines: [`buddi is at ${SYSTEM_SHIM}. Open a new terminal and run buddi status.`] };
  } catch { /* Declined, or no administrator: the owner's own folder. */ }
  const own = userShim(deps.home);
  await deps.write(own, script);
  const dir = path.dirname(own);
  const onPath = deps.searchPath.includes(dir);
  return {
    ok: true,
    file: own,
    lines: [
      `buddi is at ${own}.`,
      ...(onPath ? [] : [`That folder is not on your PATH yet. Add it with: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile, then open a new terminal.`]),
    ],
  };
}

/** Our shims that point at this data directory: what uninstall removes. */
export function shimsFor(data: string, deps: Pick<ShimDeps, 'exists' | 'read' | 'home'>): string[] {
  return [SYSTEM_SHIM, userShim(deps.home)].filter((file) => {
    if (!deps.exists(file)) return false;
    const target = readShim(deps.read(file) ?? '');
    return target !== undefined && path.resolve(target.data) === path.resolve(data);
  });
}

/** `buddi doctor`'s lines about the shims: a dangling one is a warning with the fix. */
export function shimDoctorLines(deps: Pick<ShimDeps, 'exists' | 'read' | 'home'>): string[] {
  const lines: string[] = [];
  for (const file of [SYSTEM_SHIM, userShim(deps.home)]) {
    if (!deps.exists(file)) continue;
    const target = readShim(deps.read(file) ?? '');
    if (target === undefined) continue;
    if (!deps.exists(path.join(target.app, 'Contents', 'Resources', 'runtime', 'node'))) {
      const fix = file === SYSTEM_SHIM ? `sudo rm ${file}` : `rm ${file}`;
      lines.push(`Warning: ${file} runs buddi.app at ${target.app}, which is not there any more. Open buddi.app and choose Install Command Line Tool again, or remove it: ${fix}`);
    } else {
      lines.push(`Command line tool: ${file} runs buddi.app at ${target.app}.`);
    }
  }
  return lines;
}
