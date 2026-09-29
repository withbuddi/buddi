/**
 * Disabling a plugin without removing it, and enabling it again.
 *
 * The record says `enabled: false`; nothing else about the installation moves.
 * The package stays where it is, its schema and data stay, and agents granted
 * its family keep their files. What changes happens at the next start: the
 * plugin is not imported, so nothing of it registers, and an agent's grant to
 * it is skipped with a line in its prompt instead of holding the agent back.
 *
 * The one thing done here and now is the missions it suggested: they are
 * paused with a reason ("paused: finance is disabled"), and enabling resumes
 * exactly those — a mission the owner switched off stays off.
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
import { InstallRefusal } from './refusals.js';

export interface ToggleOptions {
  env?: NodeJS.ProcessEnv;
  pool?: Pool;
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
  /** Takes effect at the next start, like an install. */
  restartNeeded: boolean;
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
  return {
    name,
    enabled,
    changed,
    missions,
    ...(missionsProblem === undefined ? {} : { missionsProblem }),
    restartNeeded: changed,
  };
}

/** What happened, one finished sentence each, for the CLI. */
export function toggleNotes(outcome: ToggleOutcome): string[] {
  const { name, enabled } = outcome;
  const notes: string[] = [];
  if (!outcome.changed) {
    notes.push(`${name} is already ${enabled ? 'enabled' : 'disabled'}.`);
  } else if (enabled) {
    notes.push(`${name} is enabled. Its tools, pages and watchers come back when buddi restarts.`);
  } else {
    notes.push(
      `${name} is disabled. Its tools, pages and watchers stop when buddi restarts; its data stays, ` +
        'and agents that use it carry on without those tools.',
    );
  }
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
