/**
 * The per-platform Postgres binaries a managed cluster runs on.
 *
 * The binary package is resolved by name from a caller-supplied installation
 * root, so core gains no dependency on `@embedded-postgres/*`: whoever ships
 * those binaries says where they are.
 */
import { cp, copyFile, mkdir, readdir, writeFile, chmod, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import { hydratePostgresLinks } from './links.js';

const exec = promisify(execFile);

export const BINARY_VERSION = '18.4.0-beta.17';

/** Native utilities need OS context, not provider, vault or database credentials. */
export function nativeEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  // Windows names are case-insensitive (`Path`, `SystemRoot`), and a copy of
  // process.env is a plain object that no longer is.
  const lookup = (key: string): string | undefined => {
    const value = env[key];
    if (typeof value === 'string' || process.platform !== 'win32') return value;
    const found = Object.keys(env).find(name => name.toUpperCase() === key);
    return found === undefined ? undefined : env[found];
  };
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC', 'PATHEXT']
    .map(key => [key, lookup(key)] as const)
    .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string'));
}

/** What a Windows machine without the Visual C++ runtime is told. */
export const WINDOWS_VC_RUNTIME = 'Postgres needs the Microsoft Visual C++ Redistributable (x64), which this Windows does not have. Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe (on Windows on Arm too), then run buddi again.';

/** One of the server binaries in `bin`: `postgres.exe` on Windows, `postgres` elsewhere. */
export function pgBinary(bin: string, name: 'initdb' | 'postgres' | 'pg_ctl', platform: NodeJS.Platform | string = process.platform): string {
  return path.join(bin, platform === 'win32' ? `${name}.exe` : name);
}

/** Where the binaries come from and where a writable copy of them may live. */
export interface BinaryOptions {
  /** The installation root; `@embedded-postgres/*` is resolved from `<root>/package.json`. */
  root: string;
  /** Private, writable storage: the runtime copy lives under `<dataDir>/runtime`. */
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** Where the one line about repaired links goes; defaults to stderr. */
  log?: (line: string) => void;
  /** Windows: the folder of Visual C++ runtime DLLs to put beside the binaries; `vcruntime` beside node by default. */
  vcRuntime?: string;
  platform?: NodeJS.Platform | string;
}

/**
 * Windows: the Visual C++ runtime the binaries link against (vcruntime140,
 * vcruntime140_1, msvcp140), copied app-local beside them from the folder the
 * Windows install ships it in (`<data>\node\vcruntime`, see
 * scripts/release/windows-bundle.sh), so a fresh Windows needs no
 * administrator to install the redistributable. Only the files missing there
 * are copied, on every start: a copy made before the runtime was there (an npm
 * install moved onto the Windows install, a release an upgrade staged with
 * npm) heals itself. Elsewhere, or without that folder, nothing happens.
 */
export async function placeVcRuntime(bin: string, source: string, platform: NodeJS.Platform | string = process.platform): Promise<string[]> {
  if (platform !== 'win32') return [];
  const names = (await readdir(source).catch(() => [] as string[])).filter(name => /\.dll$/i.test(name));
  const placed: string[] = [];
  for (const name of names) {
    if (existsSync(path.join(bin, name))) continue;
    await copyFile(path.join(source, name), path.join(bin, name));
    placed.push(name);
  }
  return placed;
}

/** Where the Windows install keeps the Visual C++ runtime: `vcruntime` beside the node running this. */
export function defaultVcRuntime(execPath: string = process.execPath): string {
  return path.join(path.dirname(execPath), 'vcruntime');
}

/** Copy into writable private storage; --ignore-scripts and read-only global installs work. */
export async function prepareBinaries({ root, dataDir, env = process.env, log = line => console.error(line), vcRuntime = defaultVcRuntime(), platform = process.platform }: BinaryOptions): Promise<string> {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw new Error(`Managed Postgres startup is supported on macOS, Linux and Windows only, not ${process.platform}.`);
  // Windows ships x64 binaries only; on Windows on Arm, an x64 Node (which runs
  // emulated) installs and runs them.
  if (process.platform === 'win32' && process.arch !== 'x64') throw new Error(`Postgres binaries exist for Windows x64 only. Install the x64 build of Node.js (it runs on Windows on Arm too) and reinstall buddi with it.`);
  const pkg = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  let entry: string;
  // A per-platform package name is computed, so this is the one specifier that
  // a typed static import cannot express.
  const resolve = createRequire(path.join(root, 'package.json')).resolve;
  try { entry = resolve(pkg); }
  catch { throw new Error(`Postgres binaries missing for ${process.platform}/${process.arch}; reinstall with optional dependencies enabled.`); }
  const native = path.resolve(path.dirname(entry), '../native');
  const dest = path.join(dataDir, 'runtime', `postgres-${BINARY_VERSION}-${process.platform}-${process.arch}`);
  if (!existsSync(path.join(dest, '.ready'))) {
    await mkdir(dest, { recursive: true, mode: 0o700 });
    // Links copied verbatim: without it `cp` rewrites a relative link into an
    // absolute one back into the npm tree, which an upgrade then replaces.
    await cp(native, dest, { recursive: true, force: true, verbatimSymlinks: true });
    await hydratePostgresLinks(dest);
    await placeVcRuntime(path.join(dest, 'bin'), vcRuntime, platform);
    // This upstream binary distribution contains server tools only. Packaged
    // backup/restore is deliberately disabled until client tools are shipped.
    for (const name of ['initdb', 'postgres', 'pg_ctl'] as const) {
      const file = pgBinary(path.join(dest, 'bin'), name);
      if (process.platform !== 'win32') await chmod(file, (await stat(file)).mode | 0o500);
      try { await exec(file, ['--version'], { timeout: 10_000, env: nativeEnvironment(env), windowsHide: true }); }
      catch (error) {
        // 0xC0000135, STATUS_DLL_NOT_FOUND: the Windows binaries are built with
        // Visual C++ and need its runtime, which a fresh Windows does not have.
        const code = (error as { code?: unknown }).code;
        if (process.platform === 'win32' && (code === 3221225781 || code === -1073741515)) throw new Error(WINDOWS_VC_RUNTIME);
        throw error;
      }
    }
    await writeFile(path.join(dest, '.ready'), BINARY_VERSION, { mode: 0o600 });
  } else {
    // Every start, not only the first copy: a copy made by an older release
    // (or one whose links went missing since) heals itself here. The binary
    // runs from this copy, so this copy is the one whose links matter.
    const restored = await hydratePostgresLinks(dest);
    if (restored.length > 0) log(`postgres: restored ${restored.length} library links npm did not create`);
    const placed = await placeVcRuntime(path.join(dest, 'bin'), vcRuntime, platform);
    if (placed.length > 0) log(`postgres: placed the Visual C++ runtime beside it (${placed.join(', ')})`);
  }
  return path.join(dest, 'bin');
}
