/**
 * `@buddi/tool-weather` — the smallest plugin that contributes three of the
 * four kinds of thing: a read tool, a sentinel, and a suggested mission.
 *
 * It owns the `weather` schema (one row: where the owner is) and ships its own
 * migration. Core never references these tables; deleting this directory leaves
 * core booting, with one schema to drop and one registration line to remove.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@buddi/core';
import { weatherMissions } from './missions.js';
import { openMeteo } from './open-meteo.js';
import type { FetchForecast } from './ports.js';
import { createFrostSentinel } from './sentinels/frost.js';
import { createForecastTool } from './tools/forecast.js';

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
    schema: 'weather',
    migrationsDir: MIGRATIONS_DIR,
    tools: [createForecastTool(fetchForecast)],
    sentinels: [createFrostSentinel(fetchForecast)],
    missions: weatherMissions,
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
export type { DailyForecast, FetchForecast, ForecastQuery } from './ports.js';
