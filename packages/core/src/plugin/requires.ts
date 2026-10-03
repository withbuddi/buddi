/**
 * What one plugin needs of another, whether it is set up, and the narrow road
 * between them (docs/plugins.md §2.9, §2.10; host API 1.18).
 *
 *  - **setup**: one read-only answer, `{ ready, note?, page? }`. A plugin that
 *    is installed but cannot do anything yet ("Pick a place", "Link a
 *    calendar") says so, and the Plugins row shows "Needs setup" instead of
 *    "loaded". A plugin without it is simply loaded.
 *  - **requires**: `{ "<plugin>": "<semver range>" }`, declared twice like
 *    `uses` (the manifest, and `package.json`'s `buddi.requires` for the
 *    install card). A plugin whose requirement is missing, disabled, outside
 *    the range or not set up does not load its tools or widgets; its data
 *    stays.
 *  - **exports**: named read-only queries another plugin may call through
 *    `ctx.buddi.plugins.call`, and only one that requires this plugin.
 *
 * Pure: shapes, the parse, the comparison. No state and no I/O.
 */
import type { ZodTypeAny } from 'zod';
import { isSemverRange } from '../semver.js';
import type { ToolContext } from '../tools.js';

/** A plugin's answer to "can you do anything yet?". */
export interface PluginReadiness {
  ready: boolean;
  /** What to do first, one short sentence: "Pick a place for the forecast." */
  note?: string;
  /** One of the plugin's own pages, by id, where that is done. */
  page?: string;
}

/**
 * `setup`: read-only, like a page query — `produce` runs on the read-only
 * pool, bounded in time, and an answer that throws counts as no answer (the
 * plugin is shown as loaded, and the failure is logged).
 */
export interface PluginSetup {
  produce(ctx: ToolContext): Promise<PluginReadiness>;
}

/**
 * One export: a named read-only query another plugin may call. `params`
 * validates what the caller sends; `produce` runs with this plugin's own
 * `ctx.buddi` over the read-only pool.
 */
export interface PluginExport {
  description?: string;
  params: ZodTypeAny;
  produce(params: any, ctx: ToolContext): Promise<unknown>;
}

/** A call another plugin made that core refused, with the sentence why. */
export class PluginCallRefusal extends Error {
  override readonly name = 'PluginCallRefusal';
}

/** At most this many requirements; a name is a plugin name. */
export const REQUIRES_MAX = 8;
const PLUGIN_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const EXPORT_NAME = /^[a-z][a-zA-Z0-9_]{0,63}$/;
export const READINESS_NOTE_MAX = 120;

/**
 * Read a declared `requires`: the manifest's or `package.json`'s
 * `buddi.requires`. Absent is none. Names sorted, so two that say the same
 * thing compare equal however they were written.
 */
export function parsePluginRequires(
  value: unknown,
  where: string,
  self?: string,
): { ok: true; requires: Record<string, string> } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, requires: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: `${where} is not a map of plugin names to version ranges (expected e.g. { "weather": "^0.2.0" })` };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > REQUIRES_MAX) return { ok: false, message: `${where} names ${entries.length} plugins; at most ${REQUIRES_MAX}` };
  const out: Record<string, string> = {};
  for (const [name, range] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!PLUGIN_NAME.test(name)) return { ok: false, message: `${where} names ${JSON.stringify(name)}, which is not a plugin name` };
    if (name === self) return { ok: false, message: `${where} names the plugin itself` };
    if (typeof range !== 'string' || !isSemverRange(range)) {
      return { ok: false, message: `${where} asks for ${name} ${JSON.stringify(range)}, which is not a version range (write e.g. "^0.2.0")` };
    }
    out[name] = range.trim() === '' ? '*' : range.trim();
  }
  return { ok: true, requires: out };
}

/** The sentence a plugin whose two `requires` disagree is refused with, or undefined. */
export function pluginRequiresMismatch(
  plugin: string,
  manifest: Readonly<Record<string, string>>,
  pkg: Readonly<Record<string, string>>,
  /** `optional` (1.27) is compared the same way. */
  field: 'requires' | 'optional' = 'requires',
): string | undefined {
  const words = (r: Readonly<Record<string, string>>): string =>
    Object.keys(r).length === 0 ? 'nothing' : Object.entries(r).map(([n, v]) => `${n} ${v}`).join(', ');
  if (words(manifest) === words(pkg)) return undefined;
  return (
    `plugin "${plugin}" ${field === 'requires' ? 'requires' : 'can use'} ${words(manifest)} in its manifest, and ${words(pkg)} in package.json's ` +
    `buddi.${field}; the install card was drawn from the second, so the two must match`
  );
}

/** Why a manifest's `exports` cannot register, or undefined. */
export function exportsProblem(plugin: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `plugin ${plugin}: exports is not a map of names to queries`;
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!EXPORT_NAME.test(name)) return `plugin ${plugin}: export ${JSON.stringify(name)} is not a name (letters, digits and _, starting with a letter)`;
    const e = entry as Partial<PluginExport> | null;
    if (!e || typeof e.produce !== 'function' || typeof (e.params as { safeParse?: unknown } | undefined)?.safeParse !== 'function') {
      return `plugin ${plugin}: export ${name} needs a zod \`params\` and a \`produce\``;
    }
  }
  return undefined;
}

/**
 * A readiness answer made sound: `ready` a boolean, the note one short line,
 * the page one of the plugin's own. Undefined when it is not an answer.
 */
export function readinessOf(raw: unknown, pages: readonly string[]): PluginReadiness | undefined {
  const r = raw as Partial<PluginReadiness> | null;
  if (!r || typeof r !== 'object' || typeof r.ready !== 'boolean') return undefined;
  const note = typeof r.note === 'string' ? r.note.replace(/\s+/g, ' ').trim() : '';
  return {
    ready: r.ready,
    ...(note === '' ? {} : { note: note.length > READINESS_NOTE_MAX ? `${note.slice(0, READINESS_NOTE_MAX - 1)}…` : note }),
    ...(typeof r.page === 'string' && pages.includes(r.page) ? { page: r.page } : {}),
  };
}
