/**
 * Uninstalling a plugin, including the uncomfortable part.
 *
 * A plugin owns a Postgres schema. For the finance plugin that schema is every
 * account, every transaction and every card statement the owner has. So the
 * default is decided before anything else in this file: **uninstall removes the
 * code, never the data.** The record goes, the tools stop being registered,
 * everything that was waking up on this plugin's behalf is stood down — and the
 * schema is left exactly where it is, with the CLI printing its name and its row
 * count so the owner knows what is being kept and where. Re-installing the
 * plugin finds its data again. `--purge` is the separate, explicit, irreversible
 * verb, and it asks.
 *
 * The other half of the job is the half that makes a bad uninstall worse than
 * no uninstall: what is left pointing at tools that no longer exist.
 *
 *  - **Agent grants.** A `tools:` entry that resolves to nothing is a *catalog
 *    load error* — the installation refuses to boot. So an uninstall that would
 *    leave a dangling grant is refused by default, naming the agents, and
 *    `--detach-agents` rewrites those grants first. Rewriting an agent file
 *    outside an approval is safe here in exactly one direction: it only ever
 *    *removes* names, it is the owner typing the command, and the whole edit is
 *    printed before it happens.
 *  - **Missions.** Every mission registered from this plugin's suggestions is
 *    disabled, not deleted: a disabled mission is a row the owner can see and
 *    re-enable, where a deleted one is a mystery next month.
 *  - **Queued jobs.** Anything still queued for those missions is cancelled. A
 *    scheduler that keeps waking for a tool that is gone is the exact
 *    half-removed state this is written to avoid.
 *  - **Pending approvals.** An approval waiting on one of its tools can never
 *    execute, so it is rejected through the normal decision path rather than
 *    left pending for ever.
 */
import path from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import {
  cancelJob,
  decideApproval,
  listJobs,
  listMissions,
  listPendingActions,
  patchAgentSource,
  pluginsFilePath,
  readPluginsFile,
  removeInstalledPlugin,
  setMissionEnabled,
  writePluginsFile,
  type InstalledPlugin,
  type PluginManifest,
} from '@buddi/core';
import type { Pool } from 'pg';
import { agentSearchPath, loadGatewayCatalog } from '../agents/catalog.js';
import { writeFilesAtomic } from '../agents/platform-files.js';
import { loadManifest, recordFile } from './load.js';
import { packageDirOf } from './paths.js';

export class UninstallRefusal extends Error {
  override readonly name = 'UninstallRefusal';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** One agent whose grant names this plugin, and what would be left of it. */
export interface GrantDetachment {
  agentId: string;
  file: string;
  /** Exactly as written in the frontmatter. */
  declaredBefore: string[];
  declaredAfter: string[];
  /** The entries that name this plugin — what `--detach-agents` removes. */
  removed: string[];
}

export interface DataFootprint {
  schema: string;
  tables: Array<{ table: string; rows: number }>;
  totalRows: number;
}

export interface UninstallPlan {
  record: InstalledPlugin;
  /** Absent when the plugin no longer loads; the plan is then narrower and says so. */
  manifest?: PluginManifest;
  toolNames: string[];
  /** Tables and rows that will be KEPT by default, or DROPPED by `--purge`. */
  data?: DataFootprint;
  /** Why the footprint is missing, when the database could not be read. */
  dataProblem?: string;
  agents: GrantDetachment[];
  missions: Array<{ id: string; enabled: boolean }>;
  jobs: Array<{ id: string; kind: string; state: string }>;
  approvals: Array<{ id: string; tool: string }>;
  recordFile: string;
}

/** Does this declared grant entry name one of the plugin's tools? */
export function namesPlugin(declared: string, plugin: string, toolNames: readonly string[]): boolean {
  const entry = declared.trim();
  if (entry === `${plugin}.*`) return true;
  return toolNames.includes(entry);
}

/** Every table in a schema with its row count. Exact: these are small schemas. */
export async function dataFootprint(pool: Pool, schema: string): Promise<DataFootprint> {
  const { rows } = await pool.query(
    `select table_name from information_schema.tables
      where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`,
    [schema],
  );
  const tables: Array<{ table: string; rows: number }> = [];
  for (const row of rows as Array<{ table_name: string }>) {
    const counted = await pool.query(`select count(*)::int as n from "${schema}"."${row.table_name}"`);
    tables.push({ table: row.table_name, rows: (counted.rows[0] as { n: number }).n });
  }
  return { schema, tables, totalRows: tables.reduce((sum, t) => sum + t.rows, 0) };
}

/** Everything that would happen, before anything does. */
export async function planUninstall(
  name: string,
  opts: { pool?: Pool; env?: NodeJS.ProcessEnv } = {},
): Promise<UninstallPlan> {
  const env = opts.env ?? process.env;
  const file = recordFile(env);
  const contents = readPluginsFile(file);
  const record = contents.plugins.find((p) => p.name === name.trim());
  if (!record) {
    throw new UninstallRefusal(
      'not-installed',
      `"${name}" is not installed here. ${
        contents.plugins.length === 0
          ? 'Nothing is (buddi plugins list).'
          : `Installed: ${contents.plugins.map((p) => p.name).join(', ')}.`
      } Plugins compiled into this build are not uninstallable — they are part of it.`,
    );
  }
  const loaded = await loadManifest(record.entry, { name: record.name });
  const manifest = loaded.ok ? loaded.manifest : undefined;
  const toolNames = (manifest?.tools ?? []).map((t) => t.name);

  // Agents whose declared grant names this plugin. Read from the *files*, not
  // from the resolved catalog: the resolved list is what the grant expanded to,
  // and what has to be rewritten is what the owner wrote.
  const agentsDir = agentSearchPath(env).owner.dir;
  const agents: GrantDetachment[] = [];
  const catalog = loadGatewayCatalog({ env });
  for (const summary of catalog.list()) {
    const agent = catalog.get(summary.id);
    if (!agent) continue;
    // Shipped examples are the platform's; they never name a third-party plugin
    // and this may not rewrite them in any case.
    if (!path.resolve(agent.file).startsWith(`${path.resolve(agentsDir)}${path.sep}`)) continue;
    const declared = declaredTools(agent.file);
    const removed = declared.filter((entry) => namesPlugin(entry, record.name, toolNames));
    if (removed.length === 0) continue;
    agents.push({
      agentId: agent.id,
      file: agent.file,
      declaredBefore: declared,
      declaredAfter: declared.filter((entry) => !removed.includes(entry)),
      removed,
    });
  }

  let data: DataFootprint | undefined;
  let dataProblem: string | undefined;
  const missions: Array<{ id: string; enabled: boolean }> = [];
  const jobs: Array<{ id: string; kind: string; state: string }> = [];
  const approvals: Array<{ id: string; tool: string }> = [];
  if (opts.pool) {
    try {
      data = await dataFootprint(opts.pool, record.schema);
      const suggested = new Set((manifest?.missions ?? []).map((m) => m.id));
      for (const mission of await listMissions(opts.pool)) {
        if (suggested.has(mission.id)) missions.push({ id: mission.id, enabled: mission.enabled });
      }
      for (const state of ['pending', 'suspended', 'leased'] as const) {
        for (const job of await listJobs(opts.pool, { state, limit: 500 })) {
          const missionId = (job.payload as { missionId?: string } | null)?.missionId;
          if (missionId !== undefined && suggested.has(missionId)) {
            jobs.push({ id: job.id, kind: job.kind, state: job.state });
          }
        }
      }
      for (const action of await listPendingActions(opts.pool, { now: new Date() })) {
        if (toolNames.includes(action.tool)) approvals.push({ id: action.id, tool: action.tool });
      }
    } catch (err) {
      dataProblem = err instanceof Error ? err.message : String(err);
    }
  } else {
    dataProblem = 'the database was not reachable, so nothing could be counted or stood down';
  }

  return {
    record,
    ...(manifest === undefined ? {} : { manifest }),
    toolNames,
    ...(data === undefined ? {} : { data }),
    ...(dataProblem === undefined ? {} : { dataProblem }),
    agents,
    missions,
    jobs,
    approvals,
    recordFile: file,
  };
}

/** The `tools:` line of an agent file, exactly as it is written there. */
export function declaredTools(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const match = /^tools:\s*\[([^\]]*)\]\s*$/m.exec(source);
  if (!match) return [];
  return (match[1] as string)
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

export interface UninstallOptions {
  env?: NodeJS.ProcessEnv;
  pool?: Pool;
  /** Rewrite agent grants that name this plugin. Required when any would dangle. */
  detachAgents?: boolean;
  /** Drop the schema. Irreversible; the CLI asks first. */
  purge?: boolean;
  ownerId?: string;
  now?: () => Date;
}

export interface UninstallOutcome {
  /** One finished sentence per thing that happened, in the order it happened. */
  notes: string[];
  purged: boolean;
}

/** Do it. `planUninstall` must have been shown to the owner first. */
export async function applyUninstall(
  plan: UninstallPlan,
  opts: UninstallOptions = {},
): Promise<UninstallOutcome> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? ((): Date => new Date());
  const notes: string[] = [];

  if (plan.agents.length > 0 && opts.detachAgents !== true) {
    throw new UninstallRefusal(
      'dangling-grant',
      `${plan.agents.map((a) => a.agentId).join(', ')} ${plan.agents.length === 1 ? 'names' : 'name'} ` +
        `${plan.record.name} in ${plan.agents.length === 1 ? 'its' : 'their'} tool grant. Removing the plugin ` +
        'without touching those files leaves an agent granting a tool that does not exist, and the catalog ' +
        'refuses to load at all — the installation would not start. Re-run with --detach-agents to take ' +
        'those entries out of the grants first (it only ever removes names), or edit the files yourself.',
    );
  }

  for (const agent of plan.agents) {
    const source = readFileSync(agent.file, 'utf8');
    const patched = patchAgentSource(source, { tools: agent.declaredAfter }, agent.file);
    writeFilesAtomic([{ path: agent.file, content: patched.text }]);
    notes.push(
      `${agent.agentId}: removed ${agent.removed.join(', ')} from its grant (${agent.declaredAfter.length} entries left)`,
    );
  }

  if (opts.pool) {
    for (const mission of plan.missions) {
      await setMissionEnabled(opts.pool, mission.id, false);
      notes.push(`mission ${mission.id} disabled (not deleted — re-enable it if you reinstall)`);
    }
    for (const job of plan.jobs) {
      await cancelJob(opts.pool, job.id);
      notes.push(`job ${job.id} (${job.kind}) cancelled — it was queued for a mission that is now off`);
    }
    for (const approval of plan.approvals) {
      await decideApproval(opts.pool, {
        actionId: approval.id,
        decision: 'rejected',
        by: opts.ownerId ?? 'owner',
        via: 'cli',
        now: now(),
      });
      notes.push(`pending approval for ${approval.tool} rejected — the tool is going away`);
    }
  }

  const file = pluginsFilePath({ ownerRoot: agentSearchPath(env).ownerRoot, env });
  const { contents, removed } = removeInstalledPlugin(readPluginsFile(file), plan.record.name);
  writePluginsFile(file, contents);
  notes.push(
    removed
      ? `${plan.record.name} removed from ${file}: its tools are not registered on the next start`
      : `${plan.record.name} was not in ${file}`,
  );

  // The files, for a plugin whose files are ours. A directory source is the
  // developer's own build and is never deleted from under them: buddi did not
  // put it there and removing it would destroy work, not an installation.
  if (plan.record.source.kind !== 'directory') {
    const packageDir = packageDirOf(plan.record, env);
    if (existsSync(packageDir)) {
      rmSync(packageDir, { recursive: true, force: true });
      notes.push(`its package directory ${packageDir} was removed`);
    }
  } else {
    notes.push(`its source directory ${plan.record.source.path} was left where it is; buddi did not put it there`);
  }

  let purged = false;
  if (opts.purge === true) {
    if (!opts.pool) {
      throw new UninstallRefusal('no-database', 'dropping a schema needs the database, and it is not reachable');
    }
    await opts.pool.query(`drop schema if exists "${plan.record.schema}" cascade`);
    await opts.pool.query('delete from core.migrations where schema = $1', [plan.record.schema]);
    purged = true;
    notes.push(
      `schema "${plan.record.schema}" DROPPED with everything in it` +
        `${plan.data === undefined ? '' : ` (${plan.data.totalRows} rows)`}, and its migration ledger cleared. ` +
        'This is not recoverable from here — only from a backup.',
    );
  } else {
    notes.push(
      plan.data === undefined
        ? `the schema "${plan.record.schema}" was left untouched`
        : `the schema "${plan.record.schema}" was left untouched: ${plan.data.tables.length} tables, ` +
          `${plan.data.totalRows} rows, still there. Reinstalling the plugin finds them again.`,
    );
  }
  return { notes, purged };
}

/**
 * Plan and apply in one call, for the callers that are not a terminal.
 *
 * The CLI keeps the two halves apart because printing the plan and then asking
 * is the whole of its safety story. The API has already shown the page and
 * taken a confirmation, so it hands in the decision and gets the outcome.
 */
export async function uninstallPlugin(
  name: string,
  opts: UninstallOptions & { confirm?: string } = {},
): Promise<{ plan: UninstallPlan; outcome: UninstallOutcome }> {
  const plan = await planUninstall(name, {
    ...(opts.pool === undefined ? {} : { pool: opts.pool }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  if (opts.purge === true && opts.confirm !== undefined && opts.confirm !== plan.record.name) {
    throw new UninstallRefusal(
      'not-confirmed',
      `dropping ${plan.record.name}'s schema destroys every row in it. Type the plugin's name to confirm.`,
    );
  }
  const outcome = await applyUninstall(plan, opts);
  return { plan, outcome };
}
