/**
 * Which plugin pages sit in the rail (Settings → Appearance → In the rail).
 *
 * Every plugin page whose place is `rail` is shown there unless the owner hid
 * it. The hidden ones are kept by the installation, not the browser, in
 * `core.web_settings` under `rail` as `{ hidden: ["<plugin>:<page>", …] }`, so
 * a page hidden on the laptop is hidden on the phone too. A hidden page is
 * still a page: Settings → Plugins opens it.
 */
import { readWebSetting, writeWebSetting, type ToolRegistry } from '@buddi/core';

/** The `core.web_settings` key. */
export const RAIL_SETTINGS_KEY = 'rail';

/** Anything that answers a query: the pool, or a map in tests. */
type Db = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

interface RailSettings {
  /** `<plugin>:<page>`, one per rail page the owner hid. */
  hidden?: string[];
}

export const railKey = (plugin: string, page: string): string => `${plugin}:${page}`;

async function readRailSettings(pool: Db): Promise<RailSettings> {
  try {
    const value = await readWebSetting<RailSettings>(pool as never, RAIL_SETTINGS_KEY);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function hiddenOf(settings: RailSettings): Set<string> {
  const list = settings.hidden;
  return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []);
}

/** The rail pages the owner hid, as `<plugin>:<page>`. */
export async function readRail(pool: Db): Promise<{ hidden: string[] }> {
  return { hidden: [...hiddenOf(await readRailSettings(pool))].sort() };
}

/** Hide one rail page, or show it again. It must be a rail page an installed plugin contributes. */
export async function setRailPageHidden(
  deps: { pool: Db; registry: ToolRegistry },
  plugin: string,
  page: string,
  hide: boolean,
): Promise<{ status: number; body: unknown }> {
  const known = deps.registry.pages().some((p) => p.plugin === plugin && p.id === page && p.place === 'rail');
  if (!known) return { status: 404, body: { error: `no rail page ${page} is installed for the plugin ${plugin}` } };
  const settings = await readRailSettings(deps.pool);
  const hidden = hiddenOf(settings);
  if (hide) hidden.add(railKey(plugin, page));
  else hidden.delete(railKey(plugin, page));
  await writeWebSetting(deps.pool as never, RAIL_SETTINGS_KEY, { ...settings, hidden: [...hidden].sort() });
  return { status: 200, body: { plugin, page, hidden: hide } };
}
