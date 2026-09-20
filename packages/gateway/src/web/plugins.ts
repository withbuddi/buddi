/**
 * The dashboard's plugin routes.
 *
 * Installing a plugin is running somebody else's code inside this process, so
 * the shape of this module is the shape of that decision rather than of a CRUD
 * resource. Staging is a job, because fetching a package and installing its
 * dependencies takes as long as it takes; approval is a separate call that
 * carries back the integrity hash the owner was shown, so an approval can only
 * mean "the thing I read about" and never "whatever is staged under that id
 * now"; and a second approval exists for exactly one reason, which is that the
 * plan found the package's own prose and its manifest disagreeing.
 *
 * The work itself is `../plugins/`. These routes are the gate and the
 * projection: they decide nothing the engine decides, and they put on the wire
 * only what the page needs — never a staging path, because a path on a page is
 * a path somebody sends back.
 *
 * Nothing here decides authorization: every write sits behind the same session,
 * Origin and CSRF gate as the rest of `server.ts`.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Pool } from 'pg';
import {
  contributionOf,
  pluginsFilePath,
  readPluginsFile,
  type InstalledPlugin,
  type PluginManifest,
} from '@buddi/core';
import { agentSearchPath, AGENTS_DIR, installedManifests } from '../agents/catalog.js';
import * as engine from '../plugins/index.js';
import { driftFor, type Drift } from '../plugins/provenance.js';
import type { StagedPlugin, StagePhase } from '../plugins/index.js';

/** A refusal in the shape the router sends. Same contract as `backups.ts`. */
export interface RouteReply {
  status: number;
  body: unknown;
}

/**
 * The engine, as these routes use it.
 *
 * Named rather than imported wholesale so a test can hand in a fake with every
 * one of these functions and no npm, no registry and no disk anywhere near it.
 */
export type PluginsEngine = Pick<
  typeof engine,
  | 'TRUST_SENTENCE'
  | 'parsePluginSpec'
  | 'stagePlugin'
  | 'listStaged'
  | 'approveStaged'
  | 'rejectStaged'
  | 'updatePlugin'
  | 'uninstallPlugin'
  | 'pluginLoadReport'
  | 'verifyInstalledHash'
>;

export interface PluginsDeps {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /**
   * The database, for the two things that need one: applying a newly installed
   * plugin's own migrations, and dropping its schema on a purge.
   */
  pool?: Pool | undefined;
  /** Injected only by tests. A running gateway uses the real engine. */
  engine?: PluginsEngine | undefined;
}

function engineOf(deps: PluginsDeps): PluginsEngine {
  return deps.engine ?? engine;
}

/**
 * A refusal the engine raised, as a status.
 *
 * Every one of these is the owner being told no about something they asked
 * for: the request was well formed and this installation declined it, with a
 * sentence to read. That is a 409, not a 500.
 */
const REFUSALS = new Set([
  'InstallRefusal',
  'StageRefusal',
  'UninstallRefusal',
  'BadPluginSpec',
  'PluginsFileError',
]);

function refusalReply(err: unknown): RouteReply {
  const message = err instanceof Error ? err.message : String(err);
  const refused = err instanceof Error && REFUSALS.has(err.name);
  return { status: refused ? 409 : 500, body: { error: message } };
}

/* ------------------------------------------------------------------ *
 * What a staged package looks like on the wire
 * ------------------------------------------------------------------ */

/**
 * The staged record, minus the disk.
 *
 * `dir` and `packageDir` are where this installation put the package, and the
 * page has no use for either. They stay here.
 */
function stagedView(staged: StagedPlugin): Record<string, unknown> {
  return {
    id: staged.id,
    name: staged.name,
    version: staged.version,
    source: staged.source,
    ...(staged.publisher === undefined ? {} : { publisher: staged.publisher }),
    integrity: staged.integrity,
    dependencies: staged.dependencies,
    claims: {
      ...(staged.claims.schema === undefined ? {} : { schema: staged.claims.schema }),
      hosts: staged.claims.hosts,
      text: staged.claims.text,
      missing: staged.claims.missing,
    },
    /** The package's own lifecycle scripts, which also run as somebody else. */
    scripts: staged.scripts,
    ...(staged.previous === undefined ? {} : { previous: staged.previous }),
    ...(staged.plan === undefined ? {} : { plan: staged.plan }),
    state: staged.state,
  };
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

export interface StageJob {
  id: string;
  kind: 'stage' | 'update';
  phase: StagePhase;
  error?: string;
  stagedId?: string;
  startedAt: string;
  finishedAt?: string;
}

/** Last twenty, in memory. A restart forgets them; the staging dirs remain. */
const JOBS = new Map<string, StageJob>();

function startJob(kind: StageJob['kind']): StageJob {
  const job: StageJob = {
    id: randomUUID(),
    kind,
    phase: 'fetching',
    startedAt: new Date().toISOString(),
  };
  JOBS.set(job.id, job);
  while (JOBS.size > 20) {
    const oldest = JOBS.keys().next();
    if (oldest.done) break;
    JOBS.delete(oldest.value);
  }
  return job;
}

/** Run a staging call as a job, so the page can watch it without holding a socket. */
function runStaging(
  deps: PluginsDeps,
  kind: StageJob['kind'],
  work: (onPhase: (phase: StagePhase) => void) => Promise<StagedPlugin>,
): RouteReply {
  const job = startJob(kind);
  void work((phase) => {
    if (job.finishedAt === undefined) job.phase = phase;
  })
    .then((staged) => {
      job.phase = 'done';
      job.stagedId = staged.id;
      job.finishedAt = new Date().toISOString();
    })
    .catch((err: unknown) => {
      job.phase = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
      deps.log(`web: staging a plugin failed: ${job.error}`);
    });
  return { status: 202, body: { job } };
}

export function pluginJobRoute(_deps: PluginsDeps, id: string): RouteReply {
  const job = JOBS.get(id);
  return job ? { status: 200, body: job } : { status: 404, body: { error: 'no such job' } };
}

/* ------------------------------------------------------------------ *
 * The installed list
 * ------------------------------------------------------------------ */

/** What one installed plugin brings, in the four numbers the page shows. */
function contributionSummary(manifest: PluginManifest | undefined): {
  tools: number;
  sentinels: number;
  views: number;
  agents: number;
} {
  if (!manifest) return { tools: 0, sentinels: 0, views: 0, agents: 0 };
  const c = contributionOf(manifest);
  return {
    tools: c.tools.length,
    sentinels: c.sentinels.length + c.sources.length,
    views: c.views,
    agents: c.agents.length,
  };
}

/**
 * The agents a plugin proposes, and where the owner's copy stands.
 *
 * The same `driftFor` the install plan uses, so "you have not accepted this
 * one" means the same thing on this page as it does in the CLI.
 */
function unlocksOf(
  manifest: PluginManifest | undefined,
  env: NodeJS.ProcessEnv,
): Array<{ id: string; handle: string; drift: Drift }> {
  if (!manifest) return [];
  const agentsDir = agentSearchPath(env).owner.dir ?? AGENTS_DIR;
  return (manifest.agents ?? []).map((suggestion) => {
    const agentDir = path.join(agentsDir, suggestion.id);
    return {
      id: suggestion.id,
      handle: suggestion.handle,
      drift: driftFor({
        agentDir,
        agentFile: path.join(agentDir, 'agent.md'),
        suggestion,
        pluginVersion: manifest.version,
      }),
    };
  });
}

/** The record, or an empty list when there is no record file yet. */
function installedRecord(env: NodeJS.ProcessEnv): InstalledPlugin[] {
  try {
    const file = pluginsFilePath({ ownerRoot: agentSearchPath(env).ownerRoot, env });
    return readPluginsFile(file).plugins;
  } catch {
    // An unreadable record is `buddi plugins`' problem; the page still draws.
    return [];
  }
}

/**
 * Is this a developer checkout?
 *
 * The same question the backup page asks, answered the same way: a packaged
 * installation has a supervisor on a control socket and a checkout does not,
 * which is what decides whether "Restart to load it" is a button or a command.
 */
function isCheckout(env: NodeJS.ProcessEnv): boolean {
  const socket = env.BUDDI_SUPERVISOR_SOCKET?.trim();
  return socket === undefined || socket === '';
}

/** Everything the Plugins section draws, in one read. */
export async function listPlugins(deps: PluginsDeps): Promise<RouteReply> {
  const env = deps.env;
  const api = engineOf(deps);
  const manifests = new Map<string, PluginManifest>();
  try {
    for (const manifest of installedManifests(env)) manifests.set(manifest.name, manifest);
  } catch (err) {
    deps.log(`web: reading installed manifests failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const failures = new Map<string, string>();
  try {
    for (const row of api.pluginLoadReport(env)) failures.set(row.name, row.error);
  } catch {
    // A load report that cannot be produced is not a reason to hide the list.
  }

  const record = installedRecord(env);
  const installed = record.map((entry) => {
    const manifest = manifests.get(entry.name);
    const error = failures.get(entry.name);
    return {
      name: entry.name,
      version: entry.version,
      source: entry.source,
      ...(entry.provenance?.publisher === undefined ? {} : { publisher: entry.provenance.publisher }),
      ...(entry.provenance?.integrity === undefined ? {} : { integrity: entry.provenance.integrity }),
      installedAt: entry.installedAt,
      contribution: contributionSummary(manifest),
      unlocks: unlocksOf(manifest, env),
      loaded: manifest !== undefined && error === undefined,
      ...(error === undefined ? {} : { error }),
    };
  });

  let staged: Array<Record<string, unknown>> = [];
  try {
    staged = api.listStaged(env).map(stagedView);
  } catch (err) {
    deps.log(`web: listing staged plugins failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  /*
   * A restart is needed exactly when the record names something this process
   * has not imported: approving writes the record, and the registry was built
   * at start.
   */
  const restartNeeded = record.some((entry) => !manifests.has(entry.name));

  return {
    status: 200,
    body: {
      trust: api.TRUST_SENTENCE,
      installed,
      staged,
      restartNeeded,
      checkout: isCheckout(env),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Staging, approving, rejecting
 * ------------------------------------------------------------------ */

export function stageRoute(deps: PluginsDeps, body: Record<string, unknown>): RouteReply {
  const api = engineOf(deps);
  const spec = typeof body.spec === 'string' ? body.spec.trim() : '';
  if (spec === '') {
    return {
      status: 400,
      body: { error: 'Name a package, a name@version, a path to a .tgz, or a directory you built.' },
    };
  }
  /*
   * Parsed here as well as inside `stagePlugin`, so text that is not a spec at
   * all is a 400 answered on the spot rather than a job that fails a second
   * later. The parse reads the disk and nothing else.
   */
  try {
    api.parsePluginSpec(spec);
  } catch (err) {
    return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
  }
  return runStaging(deps, 'stage', (onPhase) => api.stagePlugin(spec, { env: deps.env, onPhase }));
}

/**
 * Approve a staged package.
 *
 * Two things make this more than a button. The integrity the caller sends is
 * the one it was *shown*, and the engine refuses when it is not the one on
 * disk — so a stage that changed under the page cannot be approved by a click
 * aimed at something else. And `acknowledgeDrift` comes from the second card,
 * the one that lists what the package's prose claims against what its manifest
 * does; the first approval never carries it.
 */
export async function approveRoute(
  deps: PluginsDeps,
  id: string,
  body: Record<string, unknown>,
): Promise<RouteReply> {
  const api = engineOf(deps);
  if (body.acknowledgeDrift !== undefined && typeof body.acknowledgeDrift !== 'boolean') {
    return { status: 400, body: { error: '"acknowledgeDrift" must be true or false.' } };
  }
  if (typeof body.integrity !== 'string') {
    return { status: 400, body: { error: 'Send back the integrity you were shown.' } };
  }
  try {
    const outcome = await api.approveStaged(id, {
      integrity: body.integrity,
      ...(body.acknowledgeDrift === true ? { acknowledgeDrift: true } : {}),
      env: deps.env,
      ...(deps.pool === undefined ? {} : { pool: deps.pool }),
    });
    if (outcome.kind === 'drift') {
      return { status: 200, body: { plan: outcome.plan, staged: stagedView(outcome.staged) } };
    }
    return {
      status: 200,
      body: {
        installed: outcome.record,
        restartNeeded: true,
        migrations: outcome.migrations,
        ...(outcome.migrationProblem === undefined ? {} : { migrationProblem: outcome.migrationProblem }),
      },
    };
  } catch (err) {
    return refusalReply(err);
  }
}

export function rejectRoute(deps: PluginsDeps, id: string): RouteReply {
  try {
    const gone = engineOf(deps).rejectStaged(id, deps.env);
    return { status: 200, body: { rejected: id, existed: gone } };
  } catch (err) {
    return refusalReply(err);
  }
}

/* ------------------------------------------------------------------ *
 * Update and uninstall
 * ------------------------------------------------------------------ */

export function updateRoute(
  deps: PluginsDeps,
  name: string,
  body: Record<string, unknown>,
): RouteReply {
  const api = engineOf(deps);
  if (body.version !== undefined && typeof body.version !== 'string') {
    return { status: 400, body: { error: '"version" must be a version.' } };
  }
  const version = typeof body.version === 'string' ? body.version.trim() : '';
  return runStaging(deps, 'update', (onPhase) =>
    api.updatePlugin(name, {
      ...(version === '' ? {} : { version }),
      env: deps.env,
      onPhase,
    }),
  );
}

/**
 * Remove a plugin, and decide what happens to its data.
 *
 * Uninstalling stops the code loading and keeps the schema, which is what
 * makes it reversible. Dropping the schema is the irreversible half, so it is
 * a separate flag and the plugin's own name has to be typed back — checked
 * here as well as in the engine, because a guard only a browser applies is not
 * a guard.
 */
export async function uninstallRoute(
  deps: PluginsDeps,
  name: string,
  body: Record<string, unknown>,
): Promise<RouteReply> {
  const api = engineOf(deps);
  const purge = body.purge === true;
  if (purge && body.confirm !== name) {
    return {
      status: 409,
      body: {
        error: `Type ${name} to confirm dropping its data. Its tables are not recoverable afterwards.`,
      },
    };
  }
  try {
    const result = await api.uninstallPlugin(name, {
      purge,
      ...(purge ? { confirm: String(body.confirm) } : {}),
      /*
       * A grant that names one of this plugin's tools has to be rewritten, or
       * the agent holding it will not load afterwards. The page has shown what
       * is going, so the detach is part of the same yes.
       */
      detachAgents: true,
      env: deps.env,
      ...(deps.pool === undefined ? {} : { pool: deps.pool }),
    });
    return {
      status: 200,
      body: {
        name,
        purged: result.outcome.purged,
        notes: result.outcome.notes,
        restartNeeded: true,
      },
    };
  } catch (err) {
    return refusalReply(err);
  }
}
