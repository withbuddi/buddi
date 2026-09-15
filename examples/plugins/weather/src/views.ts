/**
 * How `weather.forecast` should be drawn on the dashboard canvas.
 *
 * This is the fifth kind of contribution a plugin makes, and the only one that
 * crosses into the browser — so it is **data**, not code. The dashboard owns a
 * handful of generic renderers (`timeseries`, `table`, `bars`, …) and knows
 * nothing about weather; this file knows about weather and nothing about SVG.
 * Neither has to change when the other does.
 */
import type { ViewDescriptor } from '@buddi/core';

export const weatherViews: ViewDescriptor[] = [
  {
    tool: 'weather.forecast',
    renderer: 'timeseries',
    title: 'Forecast',
    map: {
      points: 'days',
      x: 'date',
      y: 'highC',
      unit: 'number',
      label: { path: 'place' },
      // Freezing is the line that changes what you do about the day, so it is
      // drawn, and the coldest day is marked rather than left to be found.
      referenceLines: [{ value: { const: 0 }, label: 'Freezing', tone: 'critical' }],
      shadeBelow: { const: 0 },
      mark: 'min',
      events: { path: 'days', at: 'date', label: 'summary' },
    },
  },
];
