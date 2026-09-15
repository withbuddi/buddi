/**
 * The real forecast adapter. Nothing else in the plugin talks to the network.
 *
 * It is the default argument, never a hard dependency: `createWeatherManifest`
 * takes a `FetchForecast`, so the installed plugin uses this and the tests use
 * a stub.
 */
import { defaultHttpTransport } from '@buddi/runtime';
import type { DailyForecast, FetchForecast } from './ports.js';

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

/** How long one forecast call may take before it is a failure, not a wait. */
export const FETCH_TIMEOUT_MS = 10_000;

interface OpenMeteoDaily {
  daily?: {
    time?: string[];
    temperature_2m_min?: number[];
    temperature_2m_max?: number[];
    weather_code?: number[];
  };
}

/** WMO codes, collapsed to the handful of words a person actually wants. */
export function describeCode(code: number | undefined): string {
  if (code === undefined) return 'unknown';
  if (code === 0) return 'clear';
  if (code <= 3) return 'cloudy';
  if (code <= 48) return 'fog';
  if (code <= 67) return 'rain';
  if (code <= 77) return 'snow';
  if (code <= 82) return 'showers';
  return 'storms';
}

/** Shape the payload into days. Pure, so the parsing is testable on its own. */
export function toDays(payload: unknown): DailyForecast[] {
  const daily = (payload as OpenMeteoDaily).daily;
  const times = daily?.time ?? [];
  return times.map((date, i) => ({
    date,
    lowC: daily?.temperature_2m_min?.[i] ?? Number.NaN,
    highC: daily?.temperature_2m_max?.[i] ?? Number.NaN,
    summary: describeCode(daily?.weather_code?.[i]),
  }));
}

export const openMeteo: FetchForecast = async (query) => {
  const url = new URL(OPEN_METEO_URL);
  url.searchParams.set('latitude', String(query.latitude));
  url.searchParams.set('longitude', String(query.longitude));
  url.searchParams.set('timezone', query.timezone);
  url.searchParams.set('forecast_days', String(query.days));
  url.searchParams.set('daily', 'temperature_2m_min,temperature_2m_max,weather_code');

  // Not the global `fetch`: undici pools a connection per origin, and a pooled
  // connection the far end has already closed is handed back for ever — which
  // is what wedged the provider path for hours. A sentinel runs inside
  // `buddi serve` for weeks, so it has exactly that hazard. The shared
  // transport opens one connection per request and keeps nothing.
  // See packages/runtime/src/transport.ts.
  const response = await defaultHttpTransport(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    idleTimeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw new Error(`weather: forecast service answered ${response.status}`);
  }
  return toDays(await response.json());
};
