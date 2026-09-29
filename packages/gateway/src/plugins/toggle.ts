/**
 * Disabling a plugin without removing it, and enabling it again.
 *
 * The record says `enabled: false`; nothing else about the installation moves.
 * The package stays where it is, its schema and data stay, and agents granted
 * its family keep their files. In the running gateway it takes effect at once
 * (`live.ts`): the plugin leaves the registry, so its tools leave the agents,
 * its pages leave the rail and Settings, and its sources and sentinels stop;
 * enabling loads it back the way boot does. A process with no registry (the
 * CLI when buddi is not running) only writes the record, which the next start
 * reads, so there is nothing to restart there either.
 *
 * The missions it suggested are paused with a reason ("paused: finance is
 * disabled"), and enabling resumes exactly those — a mission the owner
 * switched off stays off.
 */
import {
  pausePluginMissions,
  pluginPausedReason,
  readPluginsFile,
  resumePluginMissions,
  setInstalledPluginEnabled,
  writePluginsFile,
  type PluginManifest,
} from '@buddi/core';
import type { Pool } from 'pg';
import { adoptedPlugins, loadManifest, recordFile } from './load.js';
import { loadPluginLive, unloadPluginLive, type LiveRegistry } from './live.js';
import { InstallRefusal } from './refusals.js';

export interface ToggleOptions {
  env?: NodeJS.ProcessEnv;
  pool?: Pool;
  /**
   * The running gateway's registry: when given, the change is applied in this
   * process now. Without one the record alone changes.
   */
  registry?: LiveRegistry;
  /**
   * Without a registry: is a gateway running that will not see the change
   * until it restarts? False when nothing is running (the next start reads
   * the record). Default true, the cautious answer.
   */
  gatewayRunning?: boolean;
  log?: (line: string) => void;
}

export interface ToggleOutcome {
  name: string;
  enabled: boolean;
  /** False when the record already said so. */
  changed: boolean;
  /** Missions paused (disable) or resumed (enable), by id. */
  missions: string[];
  /** Why the missions could not be paused or resumed, when they could not. */
  missionsProblem?: string;
  /** Something is left to a restart of buddi; `restartFor` says what. */
  restartNeeded: boolean;
  restartFor?: string;
  /** Enabled, but it did not load now, and a restart would not change that. */
  loadProblem?: string;
}

/** The mission ids a plugin suggests: from this process's load, or its entry point. */
async function suggestedMissionIds(name: string, entry: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  let manifest: PluginManifest | undefined = adoptedPlugins(env)?.loaded.find((p) => p.record.name === name)?.manifest;
  if (manifest === undefined) {
    const loaded = await loadManifest(entry, { name }, env);
    if (loaded.ok) manifest = loaded.manifest;
  }
  return (manifest?.missions ?? []).map((m) => m.id);
}

export async function setPluginEnabled(
  name: string,
  enabled: boolean,
  opts: ToggleOptions = {},
): Promise<ToggleOutcome> {
  const env = opts.env ?? process.env;
  const file = recordFile(env);
  const before = readPluginsFile(file);
  const record = before.plugins.find((p) => p.name === name);
  if (record === undefined) {
    throw new InstallRefusal('not-installed', `"${name}" is not an installed plugin, so there is nothing to ${enabled ? 'enable' : 'disable'}.`);
  }
  const wasEnabled = record.enabled !== false;
  const changed = wasEnabled !== enabled;
  if (changed) writePluginsFile(file, setInstalledPluginEnabled(before, name, enabled).contents);

  let missions: string[] = [];
  let missionsProblem: string | undefined;
  if (opts.pool === undefined) {
    missionsProblem = 'the database was not reachable, so its missions were not ' + (enabled ? 'resumed' : 'paused');
  } else {
    try {
      missions = enabled
        ? await resumePluginMissions(opts.pool, name)
        : await pausePluginMissions(opts.pool, name, await suggestedMissionIds(name, record.entry, env));
    } catch (err) {
      missionsProblem = `its missions were not ${enabled ? 'resumed' : 'paused'}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // The running gateway, now: whenever a registry is here, even when the
  // record already said so, so a second click finishes what a first one left.
  let restartFor: string | undefined;
  let loadProblem: string | undefined;
  if (opts.registry !== undefined) {
    const liveDeps = { registry: opts.registry, env, pool: opts.pool, ...(opts.log ? { log: opts.log } : {}) };
    const live = enabled ? await loadPluginLive(record, liveDeps) : unloadPluginLive(record, liveDeps);
    restartFor = live.restartFor;
    loadProblem = live.problem;
  } else if (changed && opts.gatewayRunning !== false) {
    restartFor = enabled
      ? 'the running buddi loads its tools, pages and watchers when it restarts'
      : 'its tools, pages and watchers stay on in the running buddi until it restarts';
  }
  return {
    name,
    enabled,
    changed,
    missions,
    ...(missionsProblem === undefined ? {} : { missionsProblem }),
    restartNeeded: restartFor !== undefined,
    ...(restartFor === undefined ? {} : { restartFor }),
    ...(loadProblem === undefined ? {} : { loadProblem }),
  };
}

/** What happened, one finished sentence each, for the CLI and the card. */
export function toggleNotes(outcome: ToggleOutcome): string[] {
  const { name, enabled } = outcome;
  const notes: string[] = [];
  if (!outcome.changed && outcome.loadProblem === undefined && !outcome.restartNeeded) {
    notes.push(`${name} is already ${enabled ? 'enabled' : 'disabled'}.`);
  } else if (enabled) {
    notes.push(outcome.loadProblem === undefined ? 'Enabled.' : `Enabled, but it did not load: ${outcome.loadProblem}.`);
  } else {
    notes.push(
      outcome.restartNeeded
        ? 'Disabled. Its data is kept.'
        : 'Disabled. Its tools, pages and watchers are off now; its data is kept.',
    );
  }
  if (outcome.restartFor !== undefined) notes.push(`Restart buddi to finish: ${outcome.restartFor}.`);
  if (outcome.missions.length > 0) {
    notes.push(
      enabled
        ? `Resumed ${outcome.missions.length === 1 ? 'the mission' : 'the missions'} ${outcome.missions.join(', ')}.`
        : `Paused ${outcome.missions.length === 1 ? 'the mission' : 'the missions'} ${outcome.missions.join(', ')} (${pluginPausedReason(name)}).`,
    );
  }
  if (outcome.missionsProblem !== undefined) notes.push(`Note: ${outcome.missionsProblem}.`);
  return notes;
}
