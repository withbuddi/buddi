/**
 * The rule, as a pure function.
 *
 * Every judgement the sentinel makes lives here, so it is tested with three
 * numbers and no database — the same split the finance sentinels use
 * (`packages/tools/finance/src/sentinels/helpers.ts`).
 */
import type { Finding } from '@buddi/core';
import type { DailyForecast } from './ports.js';

/** Below this, tomorrow's low is worth saying out loud tonight. */
export const FREEZING_C = 0;

/**
 * One finding, or none.
 *
 * The key is anchored to the date the forecast is *about*, never to "tomorrow":
 * a watch that runs every six hours must produce the same key all four times,
 * and a different day must produce a different one.
 */
export function frostFinding(day: DailyForecast, place: string): Finding | null {
  if (day.lowC >= FREEZING_C) return null;
  return {
    key: `weather.frost:${day.date}`,
    severity: 'urgent',
    title: `Frost in ${place} on ${day.date}`,
    detail:
      `The forecast low for ${day.date} is ${day.lowC.toFixed(1)}°C in ${place} ` +
      `(high ${day.highC.toFixed(1)}°C, ${day.summary}). Anything outside that ` +
      'minds the cold needs covering tonight.',
    data: { date: day.date, lowC: day.lowC, highC: day.highC, place },
  };
}
