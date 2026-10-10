/**
 * Which Node runs this buddi, and which npm plugin installs would run: the
 * `Runtime:` row of `buddi doctor`.
 *
 * buddi.app (`Contents/Resources/runtime`) and the Linux install
 * (`<data>/node`) ship the same runtime folder: `node`, `npm` linked beside
 * it, and a `VERSION` file naming the Node it holds (apps/mac/scripts/
 * fetch-payload.sh, scripts/release/linux-bundle.sh). A node with that file
 * beside it, naming itself, is a bundled one; anything else came from the
 * machine (npm's `npm install -g`, a checkout), and the row says so.
 *
 * Every effect is injected so the tests need no second Node.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface RuntimeFacts {
  execPath: string;
  /** `process.version`, e.g. v22.23.3. */
  version: string;
  /** The runtime folder's VERSION file, when there is one. */
  pinned?: string;
  /** npm beside node, when it is there. */
  npmBeside?: string;
  /** What `npm --version` answered, or why it could not. */
  npmVersion?: string;
  npmError?: string;
}

export interface RuntimeDeps {
  exists: (file: string) => boolean;
  read: (file: string) => string | undefined;
  npmVersion: (npm: string, runtimeDir: string) => Promise<string>;
}

const realDeps: RuntimeDeps = {
  exists: existsSync,
  read: file => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } },
  // npm's shebang is `env node`: the bundled node goes first on PATH, as the service's PATH has it.
  npmVersion: (npm, runtimeDir) => new Promise((resolve, reject) => {
    execFile(npm, ['--version'], { timeout: 15_000, env: { ...process.env, PATH: [runtimeDir, process.env.PATH ?? ''].join(path.delimiter) } }, (error, stdout) => {
      if (error) reject(error); else resolve(String(stdout).trim());
    });
  }),
};

export async function runtimeFacts(execPath = process.execPath, version = process.version, deps: RuntimeDeps = realDeps): Promise<RuntimeFacts> {
  const dir = path.dirname(execPath);
  const pinned = deps.read(path.join(dir, 'VERSION'))?.trim();
  const npm = path.join(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const facts: RuntimeFacts = { execPath, version, ...(pinned ? { pinned } : {}) };
  if (!deps.exists(npm)) return facts;
  facts.npmBeside = npm;
  try { facts.npmVersion = await deps.npmVersion(npm, dir); }
  catch (error) { facts.npmError = (error instanceof Error ? error.message : String(error)).split('\n')[0]; }
  return facts;
}

/** Is this node the one a bundle shipped (its VERSION file names it)? */
export function bundled(facts: RuntimeFacts): boolean {
  return facts.pinned !== undefined && facts.pinned.replace(/^v?/, 'v') === facts.version;
}

/** `Runtime:` and `npm:` for `buddi doctor`. */
export function runtimeLines(facts: RuntimeFacts, where: string): string[] {
  const node = bundled(facts)
    ? `Runtime: Node ${facts.version}, bundled with ${where} (${facts.execPath})`
    : facts.pinned !== undefined
      ? `Runtime: Node ${facts.version} at ${facts.execPath}, but its folder says ${facts.pinned}: the bundled runtime was changed by hand`
      : `Runtime: Node ${facts.version} at ${facts.execPath}, this machine's own (not bundled)`;
  const npm = facts.npmBeside === undefined
    ? 'npm: none beside this node; plugin installs use the npm on PATH'
    : facts.npmVersion !== undefined
      ? `npm: ${facts.npmVersion} beside it (${facts.npmBeside}); plugin installs use this one`
      : `npm: ${facts.npmBeside} is there but does not answer (${facts.npmError ?? 'no detail'}); plugin installs will fail`;
  return [node, npm];
}
