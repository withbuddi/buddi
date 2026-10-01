/**
 * Does the Postgres binary an upgrade just installed actually start?
 *
 * Asked by the old supervisor after `npm install` and before it hands over,
 * because the hand-over is the point of no return: a new supervisor whose
 * Postgres dies in the dynamic loader loops "Postgres failed to start" with
 * the old one already gone. Running `postgres --version` loads every library
 * the server links against, which is the failure that has actually happened
 * (`dyld: Library not loaded: @loader_path/../lib/libicuuc.77.dylib`, the
 * links npm never created because install scripts were off).
 *
 * Value imports from `@buddi/*` are limited to leaf modules here, for the
 * reason at the top of `upgrade.ts`; `@buddi/core/postgres-links` is one.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { hydratePostgresLinks } from '@buddi/core/postgres-links';

const run = promisify(execFile);

export type PostgresCheck = (root: string) => Promise<{ ok: true } | { ok: false; error: string }>;

/** The last few lines of what the binary said, or why it could not say anything. */
function tail(err: unknown): string {
  const e = err as { stderr?: string | Buffer; killed?: boolean; signal?: string; message?: string };
  const text = String(e.stderr ?? '').trim();
  if (text) return text.split('\n').slice(-4).join('\n').slice(-600);
  if (e.killed) return 'it did not answer within the time allowed';
  return e.message ?? String(err);
}

/**
 * Hydrate the new install's library links, then run `postgres --version`
 * from it with a short timeout. The environment is the OS context only,
 * restated from `nativeEnvironment` in `@buddi/core` (not a leaf module).
 */
export function createPostgresCheck(opts: { platform?: string; arch?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): PostgresCheck {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const timeout = opts.timeoutMs ?? 10_000;
  const source = opts.env ?? process.env;
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME']
    .filter(key => typeof source[key] === 'string').map(key => [key, source[key] as string]));
  return async root => {
    // The managed cluster runs on macOS and Linux only; nothing to verify elsewhere.
    if (platform !== 'darwin' && platform !== 'linux') return { ok: true };
    const pkg = `@embedded-postgres/${platform}-${arch}`;
    let dir: string;
    try { dir = path.resolve(path.dirname(createRequire(path.join(root, 'package.json')).resolve(pkg)), '..'); }
    catch { return { ok: false, error: `The new version has no Postgres binaries for ${platform}/${arch} (${pkg} is missing).` }; }
    // A tree this process cannot write is still worth running: the links may be there.
    await hydratePostgresLinks(dir).catch(() => []);
    try {
      await run(path.join(dir, 'native/bin/postgres'), ['--version'], { timeout, env });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `The new version's Postgres binary does not start: ${tail(err)}` };
    }
  };
}
