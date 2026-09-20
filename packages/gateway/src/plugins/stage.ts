/**
 * Staging: everything that happens *before* a plugin's code has ever run.
 *
 * Importing a module executes it. That is the whole reason this file exists:
 * the existing plan (`install.ts`) is honest that describing a plugin means
 * loading it, and for a package the owner typed the name of five seconds ago
 * that is too late. So installing splits in two, and staging is the half with
 * no import in it.
 *
 * What a stage does:
 *
 *  - asks the registry what the package *is* (`npm view`): name, exact version,
 *    integrity hash, publisher, its `buddi` field, its scripts;
 *  - fetches it (`npm pack`) and extracts it into a staging directory;
 *  - installs its dependencies with `--ignore-scripts`, because a dependency's
 *    `postinstall` is arbitrary code and no approval exists yet;
 *  - points the staged tree's `@buddi/core` at the core this gateway is
 *    running, because a plugin holding a second copy of core would register
 *    tools into a registry nobody reads and talk to a pool nobody owns;
 *  - reads static metadata only — `package.json`, the integrity hash, and the
 *    `buddi.md` the package ships — and writes it all to `staged.json`.
 *
 * Nothing is imported, nothing is registered, no schema is touched. The first
 * import happens in `approve.ts`, after the owner has typed back the hash.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PluginSource } from '@buddi/core';
import { InstallRefusal } from './refusals.js';
import { parseBuddiMd, type PluginClaims } from './claims.js';
import { createNpmRunner, type NpmPackument, type NpmRunner } from './npm.js';
import { npmSpecText, parsePluginSpec, type PluginSpec } from './spec.js';
import { stagingRoot } from './paths.js';
import { assertRegularTree, treeHash, TreeRefusal } from './tree.js';

const run = promisify(execFile);

/** The sentence the CLI and the Plugins page both print, verbatim. */
export const TRUST_SENTENCE =
  // A straight apostrophe, deliberately: the CLI, the dashboard, `docs/plugins.md`
  // and the release smoke all carry this sentence, and a curly one turns a grep
  // for it into a silent miss.
  'A plugin runs inside buddi\'s process with everything buddi can do; it is not sandboxed, and a ' +
  'plugin that wants to can bypass tool approvals and the network allowlist. Install only what you ' +
  'would run as yourself.';

/** How long an abandoned stage is kept before the sweep removes it. */
export const STAGE_TTL_MS = 24 * 60 * 60 * 1000;

export const STAGED_FILE = 'staged.json';

export interface StagedDependencies {
  /** Packages in the installed tree, the plugin itself excluded. */
  count: number;
  /**
   * Those that want to run code when they are installed: a declared
   * `preinstall`/`install`/`postinstall`, or a `binding.gyp`, which is npm's
   * implicit "build native code with node-gyp" and runs a compiler without any
   * script being written down anywhere.
   */
  withScripts: string[];
}

export interface StagedPlan {
  contribution: unknown;
  drift: string[];
  agents: Array<{ id: string; handle: string; drift: unknown }>;
}

export interface StagedPlugin {
  id: string;
  /** `<data>/plugins/staging/<id>`. */
  dir: string;
  /** The extracted package: `<dir>/package`, or the directory source itself. */
  packageDir: string;
  createdAt: string;
  source: PluginSource;
  name: string;
  version: string;
  publisher?: string;
  /** `sha512-…`, as npm reports it. Empty for a directory source. */
  integrity: string;
  /**
   * `sha256-…` over the bytes that will run: the extracted package, its
   * dependencies, and the targets of the links npm wrote among them.
   *
   * The integrity hash above is the tarball's, which says what was fetched;
   * this one says what is on disk now, after unpacking and after `npm
   * install`. Approval re-computes it immediately before the first import, so
   * a stage that changed while it waited cannot be approved by a decision made
   * about what it used to be. Empty for a directory source, whose files are
   * the developer's own and change every time they build.
   */
  stagedHash: string;
  /** The name its manifest must answer to: `buddi.name`, or the package name. */
  declaredName: string;
  /** The `buddi` field of package.json, if any. */
  buddi?: { manifest?: string; core?: string };
  /** The peer range it wants on `@buddi/core`. */
  coreRange?: string;
  /** Lifecycle scripts the package itself declares. */
  scripts: string[];
  dependencies: StagedDependencies;
  claims: PluginClaims;
  /** The installed record this would replace, when this stage came from `update`. */
  previous?: { name: string; version: string };
  state: 'staged' | 'approved' | 'planned';
  approvedAt?: string;
  approvedIntegrity?: string;
  plan?: StagedPlan;
}

export class StageRefusal extends Error {
  override readonly name = 'StageRefusal';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type StagePhase =
  | 'fetching'
  | 'installing-dependencies'
  | 'reading'
  | 'done'
  | 'failed';

export interface StageOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected in every test; the real one shells out to npm. */
  npm?: NpmRunner;
  cwd?: string;
  registry?: string;
  onPhase?: (phase: StagePhase) => void;
  /** Set by `updatePlugin`, so approval knows what it replaces. */
  previous?: { name: string; version: string };
  now?: () => Date;
  /** Skip the dependency install. Only the fixtures that have none use it. */
  skipDependencies?: boolean;
}

/* ------------------------------------------------------------------ *
 * Reading the staging directory
 * ------------------------------------------------------------------ */

function stageDir(id: string, env: NodeJS.ProcessEnv): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new StageRefusal('bad-id', `"${id}" is not a staging id`);
  return path.join(stagingRoot(env), id);
}

export function readStaged(id: string, env: NodeJS.ProcessEnv = process.env): StagedPlugin {
  const file = path.join(stageDir(id, env), STAGED_FILE);
  if (!existsSync(file)) {
    throw new StageRefusal('no-such-stage', `there is no staged plugin "${id}" any more; stage it again`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as StagedPlugin;
}

export function writeStaged(staged: StagedPlugin): void {
  mkdirSync(staged.dir, { recursive: true });
  writeFileSync(path.join(staged.dir, STAGED_FILE), `${JSON.stringify(staged, null, 2)}\n`, 'utf8');
}

/** Every stage waiting for a decision, newest first. Never throws on one bad file. */
export function listStaged(env: NodeJS.ProcessEnv = process.env): StagedPlugin[] {
  const root = stagingRoot(env);
  if (!existsSync(root)) return [];
  const staged: StagedPlugin[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      staged.push(readStaged(entry.name, env));
    } catch {
      // A half-written stage is not worth failing the page that lists them.
    }
  }
  return staged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Delete a stage. Rejecting is the same act as abandoning; both just remove it. */
export function rejectStaged(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = stageDir(id, env);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Remove stages nobody decided on. Called once at gateway start.
 *
 * A stage holds an unpacked package and its dependencies; leaving them for ever
 * means the data directory grows by every plugin the owner looked at and did
 * not install, and each one is unapproved third-party code sitting on disk.
 */
export function sweepStages(
  env: NodeJS.ProcessEnv = process.env,
  opts: { olderThanMs?: number; now?: Date } = {},
): string[] {
  const ttl = opts.olderThanMs ?? STAGE_TTL_MS;
  const now = (opts.now ?? new Date()).getTime();
  const swept: string[] = [];
  for (const staged of listStaged(env)) {
    const age = now - Date.parse(staged.createdAt);
    if (Number.isFinite(age) && age > ttl) {
      rejectStaged(staged.id, env);
      swept.push(staged.id);
    }
  }
  return swept;
}

/* ------------------------------------------------------------------ *
 * Staging
 * ------------------------------------------------------------------ */

/** `sha512-<base64>`: the same SRI form npm publishes, for a tarball we hold. */
export function integrityOfFile(file: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
}

/** Extract an npm tarball. `tar` is the one tool every platform buddi runs on has. */
export async function extractTarball(tgz: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true });
  try {
    /*
     * `--no-same-owner --no-same-permissions`: the archive is a stranger's and
     * its mode and ownership bits are its author's opinion, not something this
     * installation should adopt. Extracted as this user, with this user's
     * umask, every time.
     */
    await run('tar', ['-xzf', tgz, '-C', into, '--no-same-owner', '--no-same-permissions'], {
      timeout: 120_000,
    });
  } catch (err) {
    throw new StageRefusal(
      'bad-tarball',
      `${tgz} could not be extracted: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // npm tarballs put everything under `package/`. Anything else is not one.
  if (!existsSync(path.join(into, 'package', 'package.json'))) {
    const roots = existsSync(into) ? readdirSync(into) : [];
    throw new StageRefusal(
      'bad-tarball',
      `${tgz} is not an npm package tarball: it has no package/package.json (found ${roots.join(', ') || 'nothing'})`,
    );
  }
  /*
   * Before anything walks, links or deletes inside this directory: it is
   * files and directories, or it is refused. A member called
   * `node_modules/@buddi` pointing somewhere else would turn the peer link
   * that comes next into a write outside the stage.
   */
  try {
    assertRegularTree(path.join(into, 'package'));
  } catch (err) {
    if (err instanceof TreeRefusal) {
      throw new StageRefusal(
        'unsafe-tarball',
        `${tgz} was not unpacked: ${err.message} Nothing of it is kept.`,
      );
    }
    throw err;
  }
}

/** Whoever npm says published this version. A name, not an identity. */
export function publisherOf(packument: NpmPackument): string | undefined {
  const user = packument._npmUser?.name;
  if (typeof user === 'string' && user.trim() !== '') return user;
  const first = packument.maintainers?.[0];
  if (typeof first === 'string') return first;
  if (first && typeof first.name === 'string') return first.name;
  return undefined;
}

const LIFECYCLE = ['preinstall', 'install', 'postinstall'] as const;

/** The lifecycle scripts a package.json declares. */
export function lifecycleScripts(pkg: { scripts?: Record<string, string> }): string[] {
  return LIFECYCLE.filter((name) => typeof pkg.scripts?.[name] === 'string' && pkg.scripts[name].trim() !== '');
}

/**
 * The installed dependency tree, and which of it wants to run code on install.
 *
 * Counted from what npm actually wrote rather than from the declared
 * `dependencies`, because the transitive ones are the interesting ones: a
 * plugin with two honest dependencies can still pull in forty, one of which
 * has a `postinstall`. They were installed with `--ignore-scripts`, so none of
 * them has run; the owner is told which ones *wanted* to.
 */
export function scanDependencies(packageDir: string): StagedDependencies {
  const root = path.join(packageDir, 'node_modules');
  if (!existsSync(root)) return { count: 0, withScripts: [] };
  const withScripts: string[] = [];
  let count = 0;
  const visit = (dir: string, name: string): void => {
    const file = path.join(dir, 'package.json');
    if (!existsSync(file)) return;
    count += 1;
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string> };
      const scripts = lifecycleScripts(pkg);
      // A `binding.gyp` is npm's implicit install script: no `postinstall` is
      // written anywhere and node-gyp compiles C++ as this user all the same.
      // Saying "none of which declares an install script" about a package with
      // one would be true and misleading, which is worse than wrong.
      const wants = [...scripts];
      if (existsSync(path.join(dir, 'binding.gyp'))) wants.push('binding.gyp: wants to build native code');
      if (wants.length > 0) withScripts.push(`${name} (${wants.join(', ')})`);
    } catch {
      // An unreadable package.json in the tree is not the owner's problem here.
    }
    const nested = path.join(dir, 'node_modules');
    if (existsSync(nested)) walk(nested);
  };
  const walk = (modules: string): void => {
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(modules, entry.name);
      if (entry.name.startsWith('@')) {
        if (!entry.isDirectory()) continue;
        for (const scoped of readdirSync(full, { withFileTypes: true })) {
          if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue;
          visit(path.join(full, scoped.name), `${entry.name}/${scoped.name}`);
        }
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      visit(full, entry.name);
    }
  };
  walk(root);
  return { count, withScripts: withScripts.sort() };
}

/**
 * Point the staged package's `@buddi/core` at the one this process is running.
 *
 * Without this the plugin gets its own copy from the registry: a second
 * registry, a second pool, a second set of module-level singletons, and tools
 * that register into nothing. Core is a peer dependency for exactly this
 * reason and the symlink is what makes the peer real.
 */
export function linkCore(packageDir: string, coreDir?: string): string | undefined {
  const resolved = coreDir ?? resolveCoreDir();
  if (resolved === undefined) return undefined;
  const modules = path.join(packageDir, 'node_modules', '@buddi');
  mkdirSync(modules, { recursive: true });
  const link = path.join(modules, 'core');
  rmSync(link, { recursive: true, force: true });
  symlinkSync(resolved, link, 'junction');
  return resolved;
}

/** `lstat`, or nothing. Never follows what it is asked about. */
function lstatOrUndefined(file: string): Stats | undefined {
  try {
    return lstatSync(file);
  } catch {
    return undefined;
  }
}

/** The core package directory this gateway is running, or nothing in a bundle. */
export function resolveCoreDir(): string | undefined {
  const require_ = createRequire(import.meta.url);
  try {
    return path.dirname(require_.resolve('@buddi/core/package.json'));
  } catch {
    // An older `exports` map may not publish `./package.json`. Walk up from
    // the entry point instead, which is the same directory by another road.
    try {
      let dir = path.dirname(require_.resolve('@buddi/core'));
      for (let i = 0; i < 5; i += 1) {
        if (existsSync(path.join(dir, 'package.json'))) return dir;
        dir = path.dirname(dir);
      }
    } catch {
      // Nothing resolves: a bundle, or a core that is not installed here.
    }
    return undefined;
  }
}

function readPackageJson(dir: string): Record<string, any> {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) {
    throw new StageRefusal('not-a-package', `${dir} has no package.json, so it is not a plugin package`);
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  } catch (err) {
    throw new StageRefusal('bad-package', `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The package's own prose, when it ships any. */
export function readClaims(packageDir: string): PluginClaims {
  for (const name of ['buddi.md', 'BUDDI.md']) {
    const file = path.join(packageDir, name);
    if (existsSync(file)) return parseBuddiMd(readFileSync(file, 'utf8'));
  }
  return parseBuddiMd(undefined);
}

/**
 * Fetch a package, unpack it, install its dependencies, and read what it says
 * about itself. Imports nothing.
 */
export async function stagePlugin(
  spec: string | PluginSpec,
  opts: StageOptions = {},
): Promise<StagedPlugin> {
  const env = opts.env ?? process.env;
  const npm = opts.npm ?? createNpmRunner();
  const phase = opts.onPhase ?? ((): void => {});
  const now = opts.now ?? ((): Date => new Date());
  const parsed =
    typeof spec === 'string'
      ? parsePluginSpec(spec, {
          ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
          ...(opts.registry === undefined ? {} : { registry: opts.registry }),
        })
      : spec;

  const id = randomUUID().replace(/-/g, '').slice(0, 16);
  const dir = path.join(stagingRoot(env), id);

  try {
    phase('fetching');
    let packageDir: string;
    let source: PluginSource;
    let integrity = '';
    let publisher: string | undefined;
    let registryPackument: { name: string; version: string } | undefined;

    if (parsed.kind === 'directory') {
      // The developer path: their own build, in place, nothing copied and
      // nothing fetched. There is no publisher and no registry hash because
      // nothing was published.
      packageDir = parsed.path;
      source = { kind: 'directory', path: parsed.path };
      mkdirSync(dir, { recursive: true });
    } else if (parsed.kind === 'tarball') {
      mkdirSync(dir, { recursive: true });
      const copied = path.join(dir, path.basename(parsed.path));
      copyFileSync(parsed.path, copied);
      integrity = integrityOfFile(copied);
      await extractTarball(copied, dir);
      packageDir = path.join(dir, 'package');
      source = { kind: 'tarball', path: parsed.path };
    } else {
      const packument = await npm.view(npmSpecText(parsed), {
        ...(parsed.registry === undefined ? {} : { registry: parsed.registry }),
      });
      if (typeof packument.version !== 'string' || packument.version.trim() === '') {
        throw new StageRefusal('no-version', `npm resolved ${parsed.name}@${parsed.range} to no version`);
      }
      integrity = packument.dist?.integrity ?? '';
      publisher = publisherOf(packument);
      mkdirSync(dir, { recursive: true });
      const tgz = await npm.pack(`${packument.name}@${packument.version}`, dir, {
        ...(parsed.registry === undefined ? {} : { registry: parsed.registry }),
      });
      const packed = integrityOfFile(tgz);
      /*
       * The registry said one hash and the file on disk is another: refuse,
       * and do not pick a winner. npm checks integrity on download, so this
       * should be impossible — which is exactly why a disagreement means
       * something about this fetch is not what it appears to be, and the owner
       * is about to be shown a hash that describes neither.
       */
      if (integrity !== '' && packed !== integrity) {
        throw new StageRefusal(
          'integrity-mismatch',
          `the registry says ${packument.name}@${packument.version} is ${integrity}, and the tarball ` +
            `that arrived is ${packed}. Nothing was unpacked and nothing is kept.`,
        );
      }
      if (integrity === '') integrity = packed;
      await extractTarball(tgz, dir);
      packageDir = path.join(dir, 'package');
      registryPackument = { name: packument.name, version: packument.version };
      source = {
        kind: 'registry',
        name: packument.name,
        version: packument.version,
        ...(parsed.registry === undefined ? {} : { registry: parsed.registry }),
      };
    }

    const pkg = readPackageJson(packageDir);
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
      throw new StageRefusal('bad-package', `${packageDir}/package.json names no name and version`);
    }
    /*
     * What the registry answered about, and what arrived, are the same package.
     * Without this the card can say one name and version while the tarball
     * holds another, and every later check — the record, the directory it is
     * moved into — follows the tarball.
     */
    if (registryPackument !== undefined) {
      if (pkg.name !== registryPackument.name || pkg.version !== registryPackument.version) {
        throw new StageRefusal(
          'not-what-was-asked-for',
          `npm resolved ${registryPackument.name}@${registryPackument.version}, and the tarball that ` +
            `arrived calls itself ${String(pkg.name)}@${String(pkg.version)}. Nothing of it is kept.`,
        );
      }
    }
    // The name its manifest has to answer to. A published package is usually
    // `buddi-plugin-weather` while its manifest is `weather`, so the package
    // may say which name is its own; if it does not, the two must match.
    const declaredName =
      typeof pkg.buddi?.name === 'string' && pkg.buddi.name.trim() !== ''
        ? (pkg.buddi.name as string).trim()
        : (pkg.name as string);

    if (parsed.kind !== 'directory' && opts.skipDependencies !== true) {
      phase('installing-dependencies');
      const registry = parsed.kind === 'registry' ? parsed.registry : undefined;
      const declared = Object.keys(pkg.dependencies ?? {}).filter((d) => d !== '@buddi/core');
      if (declared.length > 0) {
        await npm.install(packageDir, { ...(registry === undefined ? {} : { registry }) });
      }
    }
    if (parsed.kind !== 'directory') linkCore(packageDir);

    phase('reading');
    /*
     * The hash of what will run, taken once the tree is final: the package, the
     * dependencies npm wrote beside it, and the targets of the links among
     * them. A directory source has none — it is a developer's own build and
     * changes every time they rebuild it.
     */
    let stagedHash = '';
    if (parsed.kind !== 'directory') {
      try {
        stagedHash = treeHash(packageDir, { includeModules: true, linksAllowedUnder: 'node_modules' });
      } catch (err) {
        if (err instanceof TreeRefusal) throw new StageRefusal('unsafe-tree', err.message);
        throw err;
      }
    }
    const staged: StagedPlugin = {
      id,
      dir,
      packageDir,
      createdAt: now().toISOString(),
      source,
      name: pkg.name as string,
      version: pkg.version as string,
      ...(publisher === undefined ? {} : { publisher }),
      integrity,
      stagedHash,
      declaredName,
      ...(pkg.buddi === undefined ? {} : { buddi: { manifest: pkg.buddi.manifest, core: pkg.buddi.core } }),
      ...(typeof pkg.peerDependencies?.['@buddi/core'] === 'string'
        ? { coreRange: pkg.peerDependencies['@buddi/core'] as string }
        : {}),
      scripts: lifecycleScripts(pkg as { scripts?: Record<string, string> }),
      dependencies: scanDependencies(packageDir),
      claims: readClaims(packageDir),
      ...(opts.previous === undefined ? {} : { previous: opts.previous }),
      state: 'staged',
    };
    writeStaged(staged);
    phase('done');
    return staged;
  } catch (err) {
    phase('failed');
    // A stage that failed leaves nothing behind: whatever was fetched is
    // unapproved third-party code, and keeping it would be keeping exactly the
    // thing the owner did not agree to.
    rmSync(dir, { recursive: true, force: true });
    if (err instanceof StageRefusal || err instanceof InstallRefusal) throw err;
    throw err;
  }
}

/** Does this package directory still look like the one that was staged? */
export function stagedPackageExists(staged: StagedPlugin): boolean {
  try {
    return statSync(staged.packageDir).isDirectory();
  } catch {
    return false;
  }
}
