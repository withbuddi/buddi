/**
 * The one place that shells out to npm.
 *
 * It is an interface before it is an implementation, and that ordering is the
 * point: staging is the security-critical half of installing a plugin, and a
 * test that can only exercise it by reaching the public registry is a test
 * nobody runs. So every npm call a stage makes goes through `NpmRunner`, the
 * real one runs `npm`, and the tests hand in a fake that serves a tarball
 * packed from a fixture on disk. No unit test in this repository touches the
 * network.
 *
 * Three rules about the binary itself:
 *
 *  - **the npm beside the running node wins.** A packaged installation runs a
 *    node it shipped; picking up whatever `npm` a login shell happens to put on
 *    PATH would install a plugin's dependencies with a different engine than
 *    the one that will import them.
 *  - **its absence is a plain error, never a fallback.** There is no
 *    hand-rolled tarball fetcher here. If npm is not installed, the owner is
 *    told to install it.
 *  - **`--ignore-scripts` is not optional.** Dependency install scripts run
 *    before any approval exists. See `stage.ts`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** What `npm view --json` tells us that matters. Everything else is ignored. */
export interface NpmPackument {
  name: string;
  version: string;
  dist?: { integrity?: string; tarball?: string; shasum?: string };
  /** npm's `_npmUser`: who ran the publish. */
  _npmUser?: { name?: string; email?: string };
  maintainers?: Array<{ name?: string } | string>;
  buddi?: { manifest?: string; core?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  deprecated?: string;
  [key: string]: unknown;
}

export interface NpmRunner {
  /** `npm view <spec> --json`. Throws when the package or version is unknown. */
  view(spec: string, opts?: { registry?: string }): Promise<NpmPackument>;
  /**
   * `npm pack <spec> --pack-destination <dir>`. Returns the tarball's absolute
   * path. The spec is always exact by the time it gets here.
   */
  pack(spec: string, destination: string, opts?: { registry?: string }): Promise<string>;
  /** `npm install --ignore-scripts --omit=dev --no-audit --no-fund` in `dir`. */
  install(dir: string, opts?: { registry?: string }): Promise<void>;
}

export class NpmUnavailable extends Error {
  override readonly name = 'NpmUnavailable';
}

/**
 * The npm to run: the one next to this node first, then PATH.
 *
 * Returned as a bare name when only PATH has it, so `execFile` does the lookup
 * and the error message is the operating system's.
 */
export function npmBinary(execPath = process.execPath): string {
  const beside = path.join(path.dirname(execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (existsSync(beside)) return beside;
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function registryArgs(registry?: string): string[] {
  return registry === undefined || registry.trim() === '' ? [] : ['--registry', registry];
}

function npmFailed(verb: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOENT/.test(message)) {
    return new NpmUnavailable(
      `npm is not installed beside the node running buddi, and not on PATH either, so ${verb} cannot run. ` +
        'Installing a plugin from a registry needs npm; install Node.js with npm and try again.',
    );
  }
  const stderr = (err as { stderr?: string } | null)?.stderr;
  return new Error(`${verb} failed: ${(stderr ?? message).toString().trim().split('\n').slice(0, 6).join('\n')}`);
}

/** The real thing. Never used by a unit test. */
export function createNpmRunner(opts: { binary?: string; timeoutMs?: number } = {}): NpmRunner {
  const binary = opts.binary ?? npmBinary();
  const timeout = opts.timeoutMs ?? 120_000;
  // A generous buffer: `npm view --json` on a package with a long history is
  // hundreds of kilobytes, and truncating it would be a parse error blamed on
  // the registry.
  const maxBuffer = 32 * 1024 * 1024;
  return {
    async view(spec, viewOpts): Promise<NpmPackument> {
      let stdout: string;
      try {
        ({ stdout } = await run(binary, ['view', spec, '--json', ...registryArgs(viewOpts?.registry)], {
          timeout,
          maxBuffer,
        }));
      } catch (err) {
        throw npmFailed(`npm view ${spec}`, err);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error(`npm view ${spec} did not return JSON`);
      }
      // A range that matches several versions comes back as an array, newest
      // last. Staging always resolves to one version before it packs.
      const one = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
      if (typeof one !== 'object' || one === null) throw new Error(`npm view ${spec} returned nothing usable`);
      return one as NpmPackument;
    },
    async pack(spec, destination, packOpts): Promise<string> {
      let stdout: string;
      try {
        ({ stdout } = await run(
          binary,
          ['pack', spec, '--pack-destination', destination, '--json', ...registryArgs(packOpts?.registry)],
          { timeout, maxBuffer },
        ));
      } catch (err) {
        throw npmFailed(`npm pack ${spec}`, err);
      }
      let filename: string | undefined;
      try {
        const parsed = JSON.parse(stdout) as Array<{ filename?: string }>;
        filename = parsed[0]?.filename;
      } catch {
        filename = stdout.trim().split('\n').pop()?.trim();
      }
      if (filename === undefined || filename === '') throw new Error(`npm pack ${spec} named no tarball`);
      return path.resolve(destination, path.basename(filename));
    },
    async install(dir, installOpts): Promise<void> {
      try {
        await run(
          binary,
          [
            'install',
            // Not negotiable: this runs before the owner has approved anything.
            '--ignore-scripts',
            '--omit=dev',
            '--no-audit',
            '--no-fund',
            '--no-package-lock',
            ...registryArgs(installOpts?.registry),
          ],
          { cwd: dir, timeout: timeout * 5, maxBuffer },
        );
      } catch (err) {
        throw npmFailed(`npm install in ${dir}`, err);
      }
    },
  };
}
