/**
 * `weather.forecast` — a read over the world plus one stored row. Tier `auto`:
 * it changes nothing, so no approval gates it.
 */
import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import { loadLocation, NO_LOCATION } from '../location.js';
import type { DailyForecast, FetchForecast } from '../ports.js';

const forecastInput = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(7)
    .optional()
    .describe('How many days ahead, starting today. Defaults to 3, at most 7.'),
});

export type ForecastInput = z.infer<typeof forecastInput>;

export interface ForecastOutput {
  place: string;
  days: DailyForecast[];
}

export const DEFAULT_DAYS = 3;

export function createForecastTool(
  fetchForecast: FetchForecast,
): ToolDefinition<ForecastInput, ForecastOutput> {
  return {
    name: 'weather.forecast',
    description:
      "The forecast for where the owner lives, day by day: low, high and a one-word sky. Use it when the owner asks about the weather, and before suggesting anything that happens outdoors.",
    tier: 'auto',
    input: forecastInput,
    async execute(input, ctx) {
      const location = await loadLocation(ctx.db);
      // Fail closed and say the line that fixes it; never guess a city.
      if (!location) throw new Error(NO_LOCATION);
      const days = await fetchForecast({
        latitude: location.latitude,
        longitude: location.longitude,
        // The owner's zone, from the context — a forecast rendered in UTC is a
        // forecast for the wrong day after 8 PM in New York.
        timezone: ctx.timezone,
        days: input.days ?? DEFAULT_DAYS,
      });
      return { place: location.label, days };
    },
  };
}
