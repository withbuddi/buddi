/**
 * Plugin readiness and requirements in the running gateway (docs/plugins.md
 * §2.9, §2.10; host API 1.18).
 *
 * Readiness is a plugin's own answer to "can you do anything yet?", asked
 * through the registry on the read-only pool and kept for half a minute, so
 * the Plugins page, Home's tips and the requirement check share one answer.
 * A setup that throws or times out is logged and counts as no answer: the
 * plugin is shown as loaded, never held back by a bug in its own check.
 *
 * Requirements: at a start the record alone decides what is missing,
 * disabled, failed or out of range (`holdBack` in load.ts). Whether a
 * requirement is set up needs the registry, so `reconcileRequirements` runs
 * once the gateway is up, every minute after, and after the owner changes
 * something on the Plugins page: a plugin whose needs are now met is loaded
 * the way enabling loads one; one whose requirement stopped being met (it was
 * disabled, or its setup was undone) leaves the registry. Its data stays.
 */
import { rangeWords, type CoreToolContext, type InstalledPlugin, type PluginReadiness } from '@buddi/core';
import type { Pool } from 'pg';
import { adoptedPlugins, adoptPlugins, staticNeeds, type LoadedPlugins, type PluginNeed } from './load.js';
import { adoptChange, loadPluginLive, type LiveRegistry } from './live.js';

/** How long one readiness answer is kept. */
export const READINESS_TTL_MS = 30_000;

/** What of the registry readiness needs: core's `ToolRegistry`. */
export interface ReadinessRegistry {
  readiness(plugin: string, ctx: CoreToolContext): Promise<PluginReadiness | undefined>;
  manifests(): ReadonlyArray<{ name: string }>;
}

export interface ReadinessService {
  /** The plugin's answer, kept for `READINESS_TTL_MS`; undefined when it has no setup or the check failed. */
  of(plugin: string, opts?: { fresh?: boolean }): Promise<PluginReadiness | undefined>;
  /** Forget what was kept: after the owner changed something. */
  forget(plugin?: string): void;
}

export function createReadiness(deps: {
  registry: ReadinessRegistry;
  ctx: CoreToolContext;
  now: () => Date;
  log: (line: string) => void;
}): ReadinessService {
  const cache = new Map<string, { at: number; answer: Promise<PluginReadiness | undefined> }>();
  const failed = new Set<string>();
  return {
    of(plugin, opts = {}) {
      const now = deps.now().getTime();
      const hit = cache.get(plugin);
      if (hit && !opts.fresh && now - hit.at < READINESS_TTL_MS) return hit.answer;
      const answer = deps.registry.readiness(plugin, deps.ctx).then(
        (value) => {
          failed.delete(plugin);
          return value;
        },
        (err: unknown) => {
          // Said once until it recovers: a broken check asked every minute is noise.
          if (!failed.has(plugin)) deps.log(`plugins: ${plugin}'s setup check failed: ${err instanceof Error ? err.message : String(err)}`);
          failed.add(plugin);
          return undefined;
        },
      );
      cache.set(plugin, { at: now, answer });
      return answer;
    },
    forget(plugin) {
      if (plugin === undefined) cache.clear();
      else cache.delete(plugin);
    },
  };
}

export interface ReconcileDeps {
  registry: LiveRegistry;
  readiness: ReadinessService;
  env: NodeJS.ProcessEnv;
  pool?: Pool | undefined;
  log: (line: string) => void;
}

/** What one pass changed, by plugin name. */
export interface ReconcileOutcome {
  loaded: string[];
  held: string[];
}

/** Every need, the record's and the setup ones, for one manifest now. */
async function needsOf(
  manifest: { requires?: Record<string, string> },
  plugins: LoadedPlugins,
  deps: ReconcileDeps,
): Promise<PluginNeed[]> {
  const needs = staticNeeds(manifest as never, plugins, deps.env);
  const registered = new Set(deps.registry.manifests().map((m) => m.name));
  for (const [name, range] of Object.entries(manifest.requires ?? {})) {
    if (needs.some((n) => n.plugin === name) || !registered.has(name)) continue;
    const ready = await deps.readiness.of(name);
    if (ready !== undefined && !ready.ready) {
      const version = plugins.loaded.find((p) => p.record.name === name)?.manifest.version;
      needs.push({
        plugin: name,
        range,
        state: 'setup',
        ...(version === undefined ? {} : { installed: version }),
        ...(ready.note === undefined ? {} : { note: ready.note }),
        ...(ready.page === undefined ? {} : { page: ready.page }),
      });
    }
  }
  return needs;
}

const same = (a: PluginNeed[], b: PluginNeed[]): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Let in what is now met, hold back what is not, until nothing moves (a
 * chain of requirements settles in a few passes). Never throws.
 */
export async function reconcileRequirements(deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const outcome: ReconcileOutcome = { loaded: [], held: [] };
  for (let pass = 0; pass < 6; pass += 1) {
    const plugins = adoptedPlugins(deps.env);
    if (plugins === undefined) return outcome;
    let moved = false;
    for (const p of plugins.loaded) {
      if (Object.keys(p.manifest.requires ?? {}).length === 0) continue;
      const needs = await needsOf(p.manifest, adoptedPlugins(deps.env) ?? plugins, deps);
      if (needs.length === 0) continue;
      deps.registry.unregister(p.record.name);
      adoptChange(deps.env, p.record, p.manifest, needs);
      deps.log(`plugins: ${p.record.name} is held back: ${needs.map(needWords).join('; ')}`);
      outcome.held.push(p.record.name);
      moved = true;
    }
    for (const w of adoptedPlugins(deps.env)?.waiting ?? []) {
      const needs = await needsOf(w.manifest, adoptedPlugins(deps.env) ?? plugins, deps);
      if (needs.length > 0) {
        if (!same(needs, w.needs)) {
          updateNeeds(deps.env, w.record, needs);
          moved = true;
        }
        continue;
      }
      const live = await loadPluginLive(w.record, { registry: deps.registry, env: deps.env, pool: deps.pool, log: deps.log }, { ignoreNeeds: true });
      if (live.applied && live.waiting === undefined) {
        deps.log(`plugins: ${w.record.name} has what it requires and is loaded`);
        outcome.loaded.push(w.record.name);
        moved = true;
      } else if (live.problem !== undefined) {
        failWaiting(deps.env, w.record, live.problem);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return outcome;
}

function updateNeeds(env: NodeJS.ProcessEnv, record: InstalledPlugin, needs: PluginNeed[]): void {
  const plugins = adoptedPlugins(env);
  if (plugins === undefined) return;
  adoptPlugins(env, { ...plugins, waiting: (plugins.waiting ?? []).map((w) => (w.record.name === record.name ? { ...w, needs } : w)) });
}

function failWaiting(env: NodeJS.ProcessEnv, record: InstalledPlugin, message: string): void {
  const plugins = adoptedPlugins(env);
  if (plugins === undefined) return;
  const waiting = (plugins.waiting ?? []).filter((w) => w.record.name !== record.name);
  const { waiting: _old, ...rest } = plugins;
  adoptPlugins(env, {
    ...rest,
    problems: [...plugins.problems, { name: record.name, entry: record.entry, message, record }],
    ...(waiting.length === 0 ? {} : { waiting }),
  });
}

/** One need, in the row's words: "Needs weather", "Needs setup in weather". */
export function needWords(need: PluginNeed): string {
  switch (need.state) {
    case 'setup':
      return `Needs setup in ${need.plugin}`;
    case 'range':
      return `Needs ${need.plugin} ${rangeWords(need.range, { installed: need.installed })}${need.installed ? ` (${need.installed} is installed)` : ''}`;
    case 'disabled':
      return `Needs ${need.plugin}, which is disabled`;
    case 'failed':
      return `Needs ${need.plugin}, which did not load`;
    case 'waiting':
      return `Needs ${need.plugin}, which is waiting itself`;
    default:
      return `Needs ${need.plugin}`;
  }
}

/** Readiness and the requirement pass, made once per process and shared. */
export interface Requirements {
  readiness: ReadinessService;
  /** One pass at a time: a call while one runs waits for it. */
  reconcile(): Promise<ReconcileOutcome>;
}

export function createRequirements(deps: {
  registry: LiveRegistry & ReadinessRegistry;
  ctx: CoreToolContext;
  env: NodeJS.ProcessEnv;
  pool?: Pool | undefined;
  now: () => Date;
  log: (line: string) => void;
}): Requirements {
  const readiness = createReadiness({ registry: deps.registry, ctx: deps.ctx, now: deps.now, log: deps.log });
  let running: Promise<ReconcileOutcome> | undefined;
  return {
    readiness,
    reconcile() {
      running ??= reconcileRequirements({ registry: deps.registry, readiness, env: deps.env, pool: deps.pool, log: deps.log })
        .catch((err: unknown) => {
          deps.log(`plugins: the requirement check failed: ${err instanceof Error ? err.message : String(err)}`);
          return { loaded: [], held: [] };
        })
        .finally(() => {
          running = undefined;
        });
      return running;
    },
  };
}
