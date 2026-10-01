/**
 * The per-platform Postgres binaries a managed cluster runs on.
 *
 * The binary package is resolved by name from a caller-supplied installation
 * root, so core gains no dependency on `@embedded-postgres/*`: whoever ships
 * those binaries says where they are.
 */
import { cp, mkdir, writeFile, chmod, stat } from 'node:fs/promises';
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
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']
    .filter(key => typeof env[key] === 'string').map(key => [key, env[key] as string]));
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
}

/** Copy into writable private storage; --ignore-scripts and read-only global installs work. */
export async function prepareBinaries({ root, dataDir, env = process.env, log = line => console.error(line) }: BinaryOptions): Promise<string> {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Managed Postgres startup is currently supported on macOS and Linux only. Windows process management is not implemented yet.');
  const pkg = `@embedded-postgres/${process.platform}-${process.arch}`;
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
    // This upstream binary distribution contains server tools only. Packaged
    // backup/restore is deliberately disabled until client tools are shipped.
    for (const name of ['initdb', 'postgres', 'pg_ctl']) {
      const file = path.join(dest, 'bin', name);
      await chmod(file, (await stat(file)).mode | 0o500);
      await exec(file, ['--version'], { timeout: 10_000, env: nativeEnvironment(env) });
    }
    await writeFile(path.join(dest, '.ready'), BINARY_VERSION, { mode: 0o600 });
  } else {
    // Every start, not only the first copy: a copy made by an older release
    // (or one whose links went missing since) heals itself here. The binary
    // runs from this copy, so this copy is the one whose links matter.
    const restored = await hydratePostgresLinks(dest);
    if (restored.length > 0) log(`postgres: restored ${restored.length} library links npm did not create`);
  }
  return path.join(dest, 'bin');
}
