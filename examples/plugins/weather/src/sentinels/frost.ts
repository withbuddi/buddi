/**
 * `weather.frost` — deterministic, no model, speaks to nobody.
 *
 * It returns a finding while tomorrow's low is below freezing and stops
 * returning it when the forecast changes its mind; core reads that silence as
 * "resolved". Firing at most once a day, and whether it wakes anyone at all,
 * are core's decisions (`packages/core/src/sentinels/run.ts`).
 */
import { localDateString, type Finding, type Sentinel, type SentinelContext } from '@buddi/core';
import { frostFinding } from '../frost.js';
import { loadLocation } from '../location.js';
import type { FetchForecast } from '../ports.js';

/** Four looks a day: enough for a forecast that changes, cheap enough to run. */
export const EVERY_6H = 6 * 60 * 60;

export function createFrostSentinel(fetchForecast: FetchForecast): Sentinel {
  return {
    id: 'weather.frost',
    description: "Warns when tomorrow's forecast low is below freezing.",
    every: EVERY_6H,
    async run(ctx: SentinelContext): Promise<Finding[]> {
      const location = await loadLocation(ctx.db);
      // No location configured is a valid, quiet state — not a failure.
      if (!location) return [];

      const days = await fetchForecast({
        latitude: location.latitude,
        longitude: location.longitude,
        timezone: ctx.timezone,
        days: 2,
      });
      const tomorrow = localDateString(
        new Date(ctx.now().getTime() + 86_400_000),
        ctx.timezone,
      );
      const day = days.find((d) => d.date === tomorrow);
      if (!day) return [];

      const finding = frostFinding(day, location.label);
      return finding === null ? [] : [finding];
    },
  };
}
