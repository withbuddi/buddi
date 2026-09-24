/**
 * `@buddi/tool-weather` — the smallest plugin that contributes every kind of
 * thing a plugin can: a read tool, a sentinel, a suggested mission, a view
 * descriptor saying how the forecast should be drawn on the canvas, and an
 * agent it proposes (with its own skill) for the owner to accept or ignore.
 *
 * It also declares two things an owner reads *before* installing it: one line
 * on what it is, and the one host it talks to. `buddi plugins install <dir>`
 * with no `--yes` prints all of that and installs nothing.
 *
 * It owns the `weather` schema (one row: where the owner is) and ships its own
 * migration. Core never references these tables; deleting this directory leaves
 * core booting, with one schema to drop and one registration line to remove.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@buddi/core/plugin';
import { weatherAgents } from './agents.js';
import { weatherMissions } from './missions.js';
import { openMeteo } from './open-meteo.js';
import type { FetchForecast } from './ports.js';
import { createFrostSentinel } from './sentinels/frost.js';
import { createForecastTool } from './tools/forecast.js';
import { weatherViews } from './views.js';

/** Absolute path to this plugin's migrations, resolved from the *built* file. */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/** The manifest, with the forecast service as a parameter. */
export function createWeatherManifest(
  fetchForecast: FetchForecast = openMeteo,
): PluginManifest {
  return {
    name: 'weather',
    version: '0.1.0',
    description: 'The local forecast, a frost watcher, and an agent that reads them.',
    schema: 'weather',
    migrationsDir: MIGRATIONS_DIR,
    uses: ['http'],
    tools: [createForecastTool(fetchForecast)],
    sentinels: [createFrostSentinel(fetchForecast)],
    missions: weatherMissions,
    views: weatherViews,
    agents: weatherAgents,
    // Declared so the owner reads one line per destination before installing.
    // Nothing enforces it at runtime, and saying so is the point: an undeclared
    // host means the author did not write one down.
    network: [
      {
        host: 'api.open-meteo.com',
        why: 'the forecast itself. It sends a latitude and a longitude and no key; nothing else leaves.',
      },
    ],
  };
}

/** The installed manifest: the real forecast service. */
export const manifest: PluginManifest = createWeatherManifest();

export default manifest;

export { createForecastTool, DEFAULT_DAYS } from './tools/forecast.js';
export { createFrostSentinel, EVERY_6H } from './sentinels/frost.js';
export { frostFinding, FREEZING_C } from './frost.js';
export { loadLocation, NO_LOCATION, type Location } from './location.js';
export { describeCode, openMeteo, toDays, OPEN_METEO_URL } from './open-meteo.js';
export { weatherMissions, MORNING_WEATHER_CRON, MORNING_WEATHER_ID } from './missions.js';
export { weatherAgents } from './agents.js';
export { weatherViews } from './views.js';
export type { DailyForecast, FetchForecast, ForecastQuery } from './ports.js';
