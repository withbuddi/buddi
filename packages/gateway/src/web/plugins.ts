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
import { canRestartGateway } from './service.js';
import { InstallRefusal } from '../plugins/refusals.js';
import { randomUUID } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Pool } from 'pg';
import {
  authorOfPackageJson,
  contributionOf,
  OWNER_AGENT_ID,
  isPluginUse,
  PLUGIN_USE_WORDS,
  pluginUsesChange,
  pluginsFilePath,
  rangeWords,
  readPluginsFile,
  type InstalledPlugin,
  type PluginAuthor,
  type PluginManifest,
  RUNTIMES_PLUGIN,
} from '@buddi/core';
import { agentSearchPath, AGENTS_DIR, builtInManifests, installedManifests } from '../agents/catalog.js';
import { CANVAS_PLUGIN } from '../agents/canvas.js';
import { AGENT_PLUGIN } from '../agents/delegation.js';
import { OWNER_PLUGIN } from '../agents/owner-tools.js';
import { PLATFORM_PLUGIN, pluginAgentProposals } from '../agents/platform.js';
import { REMINDER_PLUGIN, SCHEDULE_PLUGIN } from '../missions/reminders.js';
import { SYSTEM_PLUGIN } from '../system-context.js';
import * as engine from '../plugins/index.js';
import { announcePluginsChanged } from './attention.js';
import { acceptAgentSteps } from '../plugins/install.js';
import { driftFor, type Drift } from '../plugins/provenance.js';
import { adoptedPlugins, RECORD_ITSELF, staticNeeds, type PluginNeed } from '../plugins/load.js';
import { needWords, type ReadinessService } from '../plugins/requires.js';
import { incomingRoot, installedPackageDir, versionOf } from '../plugins/paths.js';
import type { StagedPlugin, StagePhase } from '../plugins/index.js';
import type { LiveRegistry } from '../plugins/live.js';
import type { PagesDeps } from './pages.js';
import type { DecideResult, WriteResult } from './write.js';

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
> &
  Partial<Pick<typeof engine, 'setPluginEnabled' | 'sweepStages' | 'markStagedOpened'>>;

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
  /**
   * The live registry, for the hosts a built-in plugin declared while buddi
   * runs (`ctx.buddi.network`): Connections' services. Without one, the
   * manifest's `network` is all there is.
   */
  registry?:
    | ({
        networkOf(plugin: string): Array<{ host: string; why: string; runtime: boolean }> | undefined;
        pages?(): ReadonlyArray<{ plugin: string; id: string; place: 'rail' | 'settings' }>;
      } & Partial<LiveRegistry>)
    | undefined;
  /**
   * Readiness and requirements (docs/plugins.md §2.9, §2.10): each plugin's
   * setup answer, and the pass that lets in or holds back what requires
   * another. Absent in a test that does not exercise them.
   */
  requirements?: {
    readiness: ReadinessService;
    reconcile(): Promise<unknown>;
  };
}

/** The registry as disabling and enabling need it, when this one has all of it. */
function liveRegistryOf(registry: PluginsDeps['registry']): LiveRegistry | undefined {
  if (registry?.register === undefined || registry.unregister === undefined || registry.manifests === undefined) return undefined;
  return registry as LiveRegistry;
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
/**
 * The words the staged card uses for each area a plugin reaches, from a list
 * that may come from somewhere else (a market entry): anything not an area
 * buddi knows is left out rather than guessed at.
 */
export function usesWords(uses: readonly unknown[]): Array<{ use: string; words: string }> {
  return uses.filter(isPluginUse).map((use) => ({ use, words: PLUGIN_USE_WORDS[use] }));
}

function stagedUses(staged: StagedPlugin): {
  areas: Array<{ use: string; words: string; added: boolean }>;
  dropped: Array<{ use: string; words: string }>;
} {
  const uses = staged.uses ?? [];
  const change =
    staged.previous === undefined
      ? { added: [], removed: [] }
      : pluginUsesChange(staged.previousUses ?? [], uses);
  return {
    areas: uses.map((use) => ({ use, words: PLUGIN_USE_WORDS[use], added: change.added.includes(use) })),
    dropped: change.removed.map((use) => ({ use, words: PLUGIN_USE_WORDS[use] })),
  };
}

/**
 * Where each requirement of a staged package stands here, read from this
 * process's load: `ok`, or what is lacking (docs/plugins.md §2.10).
 */
export function requirementStates(
  requires: Readonly<Record<string, string>> | undefined,
  env: NodeJS.ProcessEnv,
): Array<{ plugin: string; range: string; rangeWords: string; state: 'ok' | PluginNeed['state']; installed?: string; words: string }> {
  const entries = Object.entries(requires ?? {});
  if (entries.length === 0) return [];
  const plugins = adoptedPlugins(env) ?? { file: '', loaded: [], problems: [] };
  const needs = staticNeeds({ requires } as never, plugins, env);
  return entries.map(([plugin, range]) => {
    const need = needs.find((n) => n.plugin === plugin);
    if (need) return { ...need, rangeWords: rangeWords(range), words: needWords(need) };
    const version = plugins.loaded.find((p) => p.record.name === plugin)?.manifest.version;
    return { plugin, range, rangeWords: rangeWords(range), state: 'ok' as const, ...(version === undefined ? {} : { installed: version }), words: `${plugin} ${version ?? ''} is here`.replace('  ', ' ') };
  });
}

function stagedView(staged: StagedPlugin, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  // A pure date sum, never the injected engine's: it reads no disk.
  const expiresAt = engine.stageExpiresAt(staged);
  return {
    id: staged.id,
    name: staged.name,
    version: staged.version,
    // When it was read and whether the owner has looked at it: the page opens
    // only the newest as a card, and the sweep keeps an opened one longer.
    createdAt: staged.createdAt,
    ...(staged.openedAt === undefined ? {} : { openedAt: staged.openedAt }),
    ...(expiresAt === undefined ? {} : { expiresAt: expiresAt.toISOString() }),
    source: staged.source,
    ...(staged.publisher === undefined ? {} : { publisher: staged.publisher }),
    ...(staged.author === undefined ? {} : { author: staged.author }),
    integrity: staged.integrity,
    /** The hash of the unpacked tree, which is what approval re-checks. */
    stagedHash: staged.stagedHash,
    dependencies: staged.dependencies,
    /**
     * The name it installs under: `buddi.name`, or absent when the package
     * declares none and the manifest's name is read at approval.
     */
    ...(staged.nameFromManifest === true ? {} : { installsAs: staged.declaredName }),
    /** It lists @buddi/core as a dependency; npm was not asked for it. */
    ...(staged.coreAsDependency === true ? { coreAsDependency: true } : {}),
    claims: {
      ...(staged.claims.schema === undefined ? {} : { schema: staged.claims.schema }),
      hosts: staged.claims.hosts,
      text: staged.claims.text,
      missing: staged.claims.missing,
    },
    /** The package's own lifecycle scripts, which also run as somebody else. */
    scripts: staged.scripts,
    ...(staged.previous === undefined ? {} : { previous: staged.previous }),
    ...(staged.previousSource === undefined ? {} : { previousSource: staged.previousSource }),
    /**
     * What it reaches in buddi beyond itself, one plain line each, from its
     * package.json. On an upgrade `added` marks what the installed version did
     * not declare, and `dropped` lists what it no longer does.
     */
    uses: stagedUses(staged),
    /** The plugins it needs, each with where it stands here. */
    ...(staged.requires === undefined ? {} : { requires: requirementStates(staged.requires, env) }),
    /** What the file was called on the owner's machine, for an upload. */
    ...(staged.uploadedName === undefined ? {} : { uploadedName: staged.uploadedName }),
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
  upToDate?: string;
  startedAt: string;
  finishedAt?: string;
}

/** Last twenty, in memory. A restart forgets them; the staging dirs remain. */
const JOBS = new Map<string, StageJob>();

/**
 * A new job in the list the page watches (`GET /api/plugins/jobs/<id>`).
 * Exported for first run's chapter 3, whose installs are jobs like any other.
 */
export function startJob(kind: StageJob['kind']): StageJob {
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
      if (err instanceof InstallRefusal && err.code === 'up-to-date') {
        job.phase = 'done';
        job.upToDate = err.message;
        job.finishedAt = new Date().toISOString();
        return;
      }
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
 * The families that are buddi itself rather than plugins.
 *
 * Every one of these is registered by the same `buildRegistry` as the plugins
 * beside them, which is what keeps the collision guards honest, but none of
 * them is a thing an owner installed or could uninstall: `platform` is the
 * dashboard's own tools, `owner` is the first-run questions, `system` is the
 * clock and the machine, `canvas` is what a run may draw, `agent` is
 * delegation, and `reminder`/`schedule` are the clock's two halves. Listing
 * them on the Plugins page would be listing the program.
 */
const INTERNAL_FAMILIES: ReadonlySet<string> = new Set([
  SYSTEM_PLUGIN,
  PLATFORM_PLUGIN,
  OWNER_PLUGIN,
  CANVAS_PLUGIN,
  AGENT_PLUGIN,
  REMINDER_PLUGIN,
  SCHEDULE_PLUGIN,
  // The local-model download card's tool: buddi's engine, not a plugin.
  RUNTIMES_PLUGIN,
]);

/**
 * The plugins compiled into this gateway.
 *
 * They have no record, no source and no version of their own to update: they
 * are what this build ships. The page shows them so that "what can this buddi
 * do" is one list rather than two, and so an owner about to install something
 * called `web` can see why it will be refused.
 */
function builtInView(env: NodeJS.ProcessEnv, registry?: PluginsDeps['registry']): Array<Record<string, unknown>> {
  return builtInManifests(env)
    .filter((manifest) => !INTERNAL_FAMILIES.has(manifest.name))
    .map((manifest) => ({
      name: manifest.name,
      version: manifest.version,
      contribution: contributionSummary(manifest),
      // What leaves the machine: the manifest's hosts, and the live
      // registry's runtime ones (a connection made this afternoon).
      network: (registry?.networkOf(manifest.name) ?? manifest.network ?? []).map(({ host, why }) => ({ host, why })),
      ...(manifest.description === undefined || manifest.description.trim() === ''
        ? {}
        : { description: manifest.description }),
      ...(manifest.author === undefined ? {} : { author: manifest.author }),
    }));
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

/**
 * The record, or the reason there is none.
 *
 * A record that cannot be parsed is not "nothing installed": everything the
 * owner installed is still on disk and still in their agents' grants, and a
 * page that drew an empty list would be saying the opposite of what happened.
 * So the sentence comes back with it and the page shows that instead.
 */
export function installedRecord(env: NodeJS.ProcessEnv): {
  plugins: InstalledPlugin[];
  unavailable?: string;
} {
  try {
    const file = pluginsFilePath({ ownerRoot: agentSearchPath(env).ownerRoot, env });
    return { plugins: readPluginsFile(file).plugins };
  } catch (err) {
    return {
      plugins: [],
      unavailable:
        `The record of what is installed could not be read, so this list is not what is installed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Who made an installed plugin whose manifest names nobody (or did not load):
 * its package.json's `author`, the same fallback the install card used.
 */
function installedPackageAuthor(entry: InstalledPlugin, env: NodeJS.ProcessEnv): PluginAuthor | undefined {
  try {
    const dir = entry.source.kind === 'directory' ? entry.source.path : installedPackageDir(entry.name, env);
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { author?: unknown };
    return authorOfPackageJson(pkg.author);
  } catch {
    return undefined;
  }
}

/**
 * Is this a developer checkout?
 *
 * The same question the backup page asks, answered the same way: a packaged
 * installation has a supervisor on a control socket and a checkout does not,
 * kept for install-mode consumers. Restart capability is reported separately.
 */
function isCheckout(env: NodeJS.ProcessEnv): boolean {
  const socket = env.BUDDI_SUPERVISOR_SOCKET?.trim();
  return socket === undefined || socket === '';
}

/** Everything the Plugins section draws, in one read. */
export async function listPlugins(deps: PluginsDeps): Promise<RouteReply> {
  const env = deps.env;
  const api = engineOf(deps);
  // Let in what is now met and hold back what is not, before the list is drawn.
  await deps.requirements?.reconcile().catch((err: unknown) => deps.log(`web: checking plugin requirements failed: ${err instanceof Error ? err.message : String(err)}`));
  const waitingNeeds = new Map<string, PluginNeed[]>((adoptedPlugins(env)?.waiting ?? []).map((w) => [w.record.name, w.needs]));
  const pageOf = (plugin: string, id: string | undefined): { id: string; place: 'rail' | 'settings' } | undefined => {
    if (id === undefined) return undefined;
    const page = deps.registry?.pages?.().find((p) => p.plugin === plugin && p.id === id);
    return page ? { id: page.id, place: page.place } : undefined;
  };
  const manifests = new Map<string, PluginManifest>();
  try {
    for (const manifest of installedManifests(env)) manifests.set(manifest.name, manifest);
  } catch (err) {
    deps.log(`web: reading installed manifests failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let builtIn: Array<Record<string, unknown>> = [];
  try {
    builtIn = builtInView(env, deps.registry);
  } catch (err) {
    deps.log(`web: reading the built-in manifests failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const failures = new Map<string, string>();
  try {
    for (const row of api.pluginLoadReport(env)) failures.set(row.name, row.error);
  } catch {
    // A load report that cannot be produced is not a reason to hide the list.
  }

  const { plugins: record, unavailable: recordProblem } = installedRecord(env);
  // Each loaded plugin's own answer to "can you do anything yet?", asked together.
  const readiness = new Map<string, Awaited<ReturnType<ReadinessService['of']>>>();
  if (deps.requirements) {
    await Promise.all(
      [...manifests.values()]
        .filter((m) => m.setup !== undefined && record.some((r) => r.name === m.name))
        .map(async (m) => readiness.set(m.name, await deps.requirements!.readiness.of(m.name))),
    );
  }
  const waitingManifests = new Map((adoptedPlugins(env)?.waiting ?? []).map((w) => [w.record.name, w.manifest]));
  /*
   * What this process imported, as the record said then. A record entry that
   * moved on since (an update, a reinstall) is running its old copy until the
   * next start, and an entry it never imported at all is new: both load at
   * the next restart, unless they failed to load or wait on a requirement.
   */
  const running = new Map((adoptedPlugins(env)?.loaded ?? []).map((p) => [p.record.name, p.record]));
  const loadsAtRestart = (entry: InstalledPlugin): boolean => {
    if (entry.enabled === false || failures.has(entry.name) || waitingNeeds.has(entry.name)) return false;
    if (!manifests.has(entry.name)) return true;
    const was = running.get(entry.name);
    return was !== undefined && (was.version !== entry.version || was.installedAt !== entry.installedAt);
  };
  const installed = record.map((entry) => {
    // A plugin held back still says what it is and what it would bring.
    const manifest = manifests.get(entry.name) ?? waitingManifests.get(entry.name);
    const needs = waitingNeeds.get(entry.name);
    const ready = readiness.get(entry.name);
    const setupPage = ready && !ready.ready ? pageOf(entry.name, ready.page) : undefined;
    const error = failures.get(entry.name);
    const author = manifest?.author ?? installedPackageAuthor(entry, env);
    // A folder install shows its folder's version now; the record's is "installed as".
    const { version, installedAs } = versionOf(entry);
    return {
      name: entry.name,
      version,
      ...(installedAs === undefined ? {} : { installedAs }),
      source: entry.source,
      ...(entry.provenance?.publisher === undefined ? {} : { publisher: entry.provenance.publisher }),
      ...(entry.provenance?.integrity === undefined ? {} : { integrity: entry.provenance.integrity }),
      ...(author === undefined ? {} : { author }),
      ...(manifest?.description === undefined || manifest.description.trim() === ''
        ? {}
        : { description: manifest.description }),
      // What it reaches, from the manifest it loaded with: the hosts it talks
      // to (the live registry's, a connection made since included) and the
      // areas of buddi beyond its own, in the staged card's words.
      ...(manifest === undefined
        ? {}
        : {
            network: (deps.registry?.networkOf(manifest.name) ?? manifest.network ?? []).map(({ host, why }) => ({ host, why })),
            uses: usesWords(manifest.uses ?? []),
          }),
      installedAt: entry.installedAt,
      contribution: contributionSummary(manifest),
      unlocks: unlocksOf(manifest, env),
      loaded: manifests.has(entry.name) && error === undefined,
      ...(loadsAtRestart(entry) ? { loadsAtRestart: true } : {}),
      ...(entry.enabled === false ? { enabled: false } : {}),
      ...(error === undefined ? {} : { error }),
      // Not set up yet: the row says "Needs setup" and opens the page.
      ...(ready && !ready.ready
        ? { setup: { ready: false, ...(ready.note === undefined ? {} : { note: ready.note }), ...(setupPage ? { page: setupPage } : {}) } }
        : {}),
      // Held back by a requirement: what it needs, each in the row's words.
      ...(needs === undefined || entry.enabled === false
        ? {}
        : {
            needs: needs.map((need) => {
              const page = need.state === 'setup' ? pageOf(need.plugin, need.page) : undefined;
              return { ...need, rangeWords: rangeWords(need.range), words: needWords(need), ...(page ? { page } : {}) };
            }),
          }),
    };
  });

  let staged: Array<Record<string, unknown>> = [];
  try {
    // What has expired goes before it is listed: a stage nobody opened lasts
    // two hours, and the gateway may have been up far longer than that.
    api.sweepStages?.(env);
    staged = api.listStaged(env).map((entry) => stagedView(entry, env));
  } catch (err) {
    deps.log(`web: listing staged plugins failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  /*
   * A restart is needed exactly when the record names something this process
   * has not imported *and could*: approving writes the record, and the
   * registry was built at start. A plugin that failed to load is excluded —
   * restarting will not make it load, and a banner that never goes away is a
   * banner nobody reads.
   */
  const restartNeeded = record.some((entry) =>
    // Disabled in the record, still loaded here: the restart is what stops it.
    entry.enabled === false ? manifests.has(entry.name) : loadsAtRestart(entry),
  );

  // A record-level problem is reported as itself, not as a plugin that failed.
  const reportProblem = failures.get(RECORD_ITSELF);
  const unavailable = recordProblem ?? (reportProblem === undefined ? undefined : reportProblem);

  return {
    status: 200,
    body: {
      trust: api.TRUST_SENTENCE,
      builtIn,
      installed,
      staged,
      restartNeeded,
      checkout: isCheckout(env),
      canRestart: await canRestartGateway(env),
      ...(unavailable === undefined ? {} : { unavailable }),
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

/* ------------------------------------------------------------------ *
 * Uploading a tarball
 * ------------------------------------------------------------------ */

/**
 * The largest plugin tarball the dashboard will accept.
 *
 * A published plugin is a few hundred kilobytes; this is the size at which the
 * answer is "that is not a plugin" rather than "wait a little longer".
 */
export const MAX_PLUGIN_TARBALL_BYTES = 64 * 1024 * 1024;

/**
 * The name an upload is stored under: ours, with the owner's inside it.
 *
 * The browser's filename is never a path — it is reduced to a basename, then
 * to a conservative charset, and it has to end in `.tgz` or there is nothing
 * here worth writing to disk. The random prefix is what makes the result
 * unique, so two uploads of `weather-1.0.0.tgz` are two files.
 */
export function incomingTarballName(claimed: string | undefined): { stored: string; label: string } | undefined {
  const base = path.basename((claimed ?? '').trim()).replace(/[^A-Za-z0-9._@+-]/g, '-');
  if (base.startsWith('.') || base.length > 128) return undefined;
  if (!/\.tgz$/i.test(base)) return undefined;
  return { stored: `${randomUUID().replace(/-/g, '').slice(0, 16)}-${base}`, label: base };
}

/**
 * Stream an uploaded tarball into `<data>/plugins/incoming/`, 0600.
 *
 * The same shape as the backup upload in `backups.ts`, and for the same
 * reasons: the bytes are written before anything reads them, the file is only
 * readable by the user buddi runs as, and the size cap is enforced as the
 * stream arrives rather than after a request has already filled the disk.
 * Nothing the page sent becomes a path.
 */
export async function receivePluginUpload(
  deps: PluginsDeps,
  req: IncomingMessage,
  claimedName: string | undefined,
): Promise<{ path: string; uploadedName: string } | RouteReply> {
  const named = incomingTarballName(claimedName);
  if (!named) {
    return {
      status: 400,
      body: { error: 'Send the packed plugin as a .tgz, with its filename in the X-Filename header.' },
    };
  }
  const dir = incomingRoot(deps.env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, named.stored);
  let bytes = 0;
  let tooBig = false;
  req.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_PLUGIN_TARBALL_BYTES && !tooBig) {
      tooBig = true;
      req.destroy(new Error('that file is larger than buddi accepts'));
    }
  });
  try {
    await pipeline(req, createWriteStream(target, { mode: 0o600 }));
  } catch (err) {
    await rm(target, { force: true }).catch(() => {});
    return {
      status: tooBig ? 413 : 400,
      body: {
        error: tooBig
          ? 'That file is too large.'
          : `The upload did not finish: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  if (bytes === 0) {
    await rm(target, { force: true }).catch(() => {});
    return { status: 400, body: { error: 'That upload was empty.' } };
  }
  return { path: target, uploadedName: named.label };
}

/**
 * Stage an uploaded tarball, exactly as a path the owner typed is staged.
 *
 * The only difference is what happens to the file afterwards: staging copies
 * the tarball into the stage, so the upload itself has no reason to exist once
 * the job has finished either way, and a tarball sitting in the data directory
 * is a package nobody approved. The name it had on the owner's machine travels
 * on the staged card instead, because `source.path` is a path of buddi's own
 * choosing that will be gone by the time they read it.
 */
export function uploadRoute(
  deps: PluginsDeps,
  upload: { path: string; uploadedName: string },
): RouteReply {
  const api = engineOf(deps);
  return runStaging(deps, 'stage', async (onPhase) => {
    try {
      return await api.stagePlugin(
        { kind: 'tarball', path: upload.path },
        { env: deps.env, onPhase, uploadedName: upload.uploadedName },
      );
    } finally {
      await rm(upload.path, { force: true }).catch(() => {});
    }
  });
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
      return { status: 200, body: { plan: outcome.plan, staged: stagedView(outcome.staged, deps.env) } };
    }
    return {
      status: 200,
      body: {
        installed: outcome.record,
        restartNeeded: true,
        migrations: outcome.migrations,
        // The same lines the CLI prints: what was proposed, and who to ask.
        nextSteps: acceptAgentSteps(outcome.record.name, outcome.plan.contribution?.agents ?? []),
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

/**
 * The owner looked at a stage: its full card was shown, or they pressed
 * Review. Recorded once; it keeps the stage a day instead of two hours.
 */
export function openedRoute(deps: PluginsDeps, id: string): RouteReply {
  const api = engineOf(deps);
  if (api.markStagedOpened === undefined) return { status: 200, body: { opened: id } };
  try {
    const staged = api.markStagedOpened(id, deps.env);
    return { status: 200, body: { opened: id, staged: stagedView(staged, deps.env) } };
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
  if (body.from !== undefined && typeof body.from !== 'string') {
    return { status: 400, body: { error: '"from" must be an npm package name.' } };
  }
  const from = typeof body.from === 'string' ? body.from.trim() : '';
  return runStaging(deps, 'update', (onPhase) =>
    api.updatePlugin(name, {
      ...(version === '' ? {} : { version }),
      ...(from === '' ? {} : { from }),
      env: deps.env,
      onPhase,
    }),
  );
}

/**
 * Disable or enable an installed plugin, in this running gateway at once: its
 * tools, pages, glances and watchers leave (or come back) with the registry,
 * and the rail drops the entry on its next read of `GET /api/pages`.
 */
export async function toggleRoute(deps: PluginsDeps, name: string, enabled: boolean): Promise<RouteReply> {
  const setEnabled = deps.engine?.setPluginEnabled ?? engine.setPluginEnabled;
  const registry = liveRegistryOf(deps.registry);
  try {
    const outcome = await setEnabled(name, enabled, {
      env: deps.env,
      log: deps.log,
      ...(deps.pool === undefined ? {} : { pool: deps.pool }),
      ...(registry === undefined ? {} : { registry }),
    });
    // What requires this plugin follows it in or out at once.
    deps.requirements?.readiness.forget();
    await deps.requirements?.reconcile().catch(() => undefined);
    // Every other open page (another tab, buddi.app) reads the rail again too.
    if (registry !== undefined && deps.pool !== undefined && !outcome.restartNeeded) await announcePluginsChanged(deps.pool, [name]);
    return { status: 200, body: { ...outcome, notes: engine.toggleNotes(outcome) } };
  } catch (err) {
    return refusalReply(err);
  }
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


/* ------------------------------------------------------------------ *
 * Accepting an agent a plugin proposes
 * ------------------------------------------------------------------ */

/** What the accept route needs beyond a page: the roster, and the owner's yes. */
export interface AcceptAgentDeps extends PagesDeps {
  /** The agents the roster holds right now. Read again after the approval ran. */
  agents: () => ReadonlyArray<{ id: string; handle: string; name: string }>;
  /**
   * Decide an approval `approved` as the owner — the very function the card's
   * Approve button runs (`decideApprovalFromWeb`), so the record and the
   * execution are the same ones a card decision makes.
   */
  approve: (actionId: string) => Promise<WriteResult<DecideResult>>;
  /**
   * The accept already waiting for this proposal, when the gateway raised one
   * (`raiseAgentOffers`): the click decides that card rather than a second.
   */
  pendingAccept?: (plugin: string, agentId: string) => Promise<string | null>;
}

/**
 * `POST /api/plugins/<name>/agents/<id>/accept` — the owner accepting a
 * proposal from the page that told them it exists.
 *
 * The owner's click on "Create @mail" is the approval. Owners who were shown a
 * second card after pressing the button read it as a failure, not a step. So
 * this route still invokes the gated `platform.accept_plugin_agent` as the
 * owner — which records the same immutable action an agent's call would, with
 * the whole grant in its preview — and then decides that action `approved`
 * through the dashboard's own decide, in the same request. The card exists as
 * the record; the owner session is who approved it.
 *
 * Only the dashboard calls this route, and only behind the owner's session and
 * CSRF token. An agent or an MCP client accepting a proposal calls the tool
 * itself and gets the card, as before.
 *
 * An agent the roster already holds is answered as "already there", never as a
 * second agent or a refusal.
 */
export async function acceptAgentRoute(
  deps: AcceptAgentDeps,
  plugin: string,
  agentId: string,
): Promise<RouteReply> {
  const proposal = pluginAgentProposals(deps.registry).find(
    (p) => p.plugin === plugin && p.agent.id.toLowerCase() === agentId.toLowerCase(),
  );
  if (!proposal) {
    return { status: 404, body: { error: `No installed plugin proposes an agent "${agentId}" under "${plugin}".` } };
  }
  const present = (): { id: string; handle: string; name: string } | undefined => {
    const found = deps.agents().find((a) => a.id.toLowerCase() === proposal.agent.id.toLowerCase());
    return found ? { id: found.id, handle: found.handle, name: found.name } : undefined;
  };
  const already = present();
  if (already) return { status: 200, body: { already: true, agent: already } };

  const waiting = (await deps.pendingAccept?.(proposal.plugin, proposal.agent.id)) ?? null;
  let approvalId: string | null = waiting;
  if (waiting === null) {
    const result = await deps.registry.invoke(
      'platform.accept_plugin_agent',
      { plugin: proposal.plugin, agent: proposal.agent.id },
      { ...deps.ctx, agentId: OWNER_AGENT_ID, now: deps.now },
    );
    if (!result.ok && result.reason !== 'approval-required') {
      return { status: result.reason === 'unknown-tool' ? 404 : 400, body: { error: result.message } };
    }
    approvalId = result.ok ? null : result.actionId;
  }
  if (approvalId !== null) {
    const decided = await deps.approve(approvalId);
    if (!decided.ok) return { status: decided.status, body: { error: decided.body.error, approvalId } };
    const execution = decided.body.execution;
    if (execution && execution.state !== 'succeeded') {
      return {
        status: 409,
        body: { error: execution.message ?? `Creating @${proposal.agent.handle} did not finish (${execution.state}).`, approvalId },
      };
    }
  }
  const agent = present() ?? {
    id: proposal.agent.id,
    handle: proposal.agent.handle,
    name: proposal.agent.name,
  };
  return { status: 200, body: { approvalId, agent } };
}
