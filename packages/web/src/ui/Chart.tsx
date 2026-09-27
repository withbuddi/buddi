/**
 * A small chart, inline: a line or bars over a few dozen points, an optional
 * dashed target across it, and two or three ticks a side — enough to read a
 * trend, not a plotting library.
 *
 * Plain SVG on one scale. Every colour is a token (`--chart-*`), set in
 * `ui.css` by class, so it follows the theme without reading it. The drawing
 * is hidden from screen readers; what they hear is the summary under it,
 * which says the same thing in words: how many points, from when to when, the
 * latest, the range and the target.
 */
import { niceTicks } from '../canvas/format';

export interface ChartSeries {
  label: string;
  /** One per x; `null` where the row had no number, which breaks the line. */
  values: Array<number | null>;
}

export interface ChartInput {
  xs: readonly string[];
  series: readonly ChartSeries[];
  type?: 'line' | 'bar';
  target?: number | null;
}

/** The chart's own coordinates; it scales to its box. */
export const CHART_BOX = { width: 480, height: 160, top: 10, right: 10, bottom: 22, left: 40 } as const;

export interface ChartGeometry {
  /** One `d` per series, for a line chart. */
  lines: string[];
  bars: Array<{ series: number; index: number; x: number; y: number; width: number; height: number }>;
  targetY: number | null;
  ticks: Array<{ value: number; y: number }>;
  /** The first and the last x, and the middle one when there are enough. */
  xLabels: Array<{ index: number; x: number }>;
}

/** Values to coordinates: the part worth testing on its own. */
export function chartGeometry({ xs, series, type = 'line', target = null }: ChartInput): ChartGeometry {
  const box = CHART_BOX;
  const plotW = box.width - box.left - box.right;
  const plotH = box.height - box.top - box.bottom;
  const numbers = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
  if (target !== null && Number.isFinite(target)) numbers.push(target);
  // Bars stand on zero; a line is free to use the height it has.
  if (type === 'bar') numbers.push(0);
  let min = numbers.length > 0 ? Math.min(...numbers) : 0;
  let max = numbers.length > 0 ? Math.max(...numbers) : 1;
  if (min === max) {
    min -= 1;
    max += 1;
  } else if (type === 'line') {
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;
  }
  const y = (value: number): number => round(box.top + plotH - ((value - min) / (max - min)) * plotH);
  const n = xs.length;
  const slot = n > 0 ? plotW / n : plotW;
  const xAt = (index: number): number =>
    type === 'bar' ? round(box.left + slot * (index + 0.5)) : round(box.left + (n <= 1 ? plotW / 2 : (index / (n - 1)) * plotW));

  const lines =
    type === 'line'
      ? series.map((s) => {
          let pen = 'M';
          const parts: string[] = [];
          s.values.forEach((value, index) => {
            if (value === null || !Number.isFinite(value)) {
              pen = 'M';
              return;
            }
            parts.push(`${pen}${xAt(index)},${y(value)}`);
            pen = 'L';
          });
          return parts.join(' ');
        })
      : [];

  const bars: ChartGeometry['bars'] = [];
  if (type === 'bar' && n > 0) {
    const group = slot * 0.7;
    const width = group / Math.max(1, series.length);
    const zero = y(0);
    series.forEach((s, si) => {
      s.values.forEach((value, index) => {
        if (value === null || !Number.isFinite(value)) return;
        const top = y(value);
        bars.push({
          series: si,
          index,
          x: round(box.left + slot * index + (slot - group) / 2 + width * si),
          y: Math.min(top, zero),
          width: round(width),
          height: round(Math.abs(zero - top)),
        });
      });
    });
  }

  const shown = numbers.length > 0 ? niceTicks(Math.min(...numbers), Math.max(...numbers), 2) : [];
  const ticks = shown.map((value) => ({ value, y: y(value) }));
  const picks = n === 0 ? [] : n === 1 ? [0] : n < 5 ? [0, n - 1] : [0, Math.floor((n - 1) / 2), n - 1];
  return {
    lines,
    bars,
    targetY: target !== null && Number.isFinite(target) ? y(target) : null,
    ticks,
    xLabels: picks.map((index) => ({ index, x: xAt(index) })),
  };
}

/** What a screen reader hears in place of the drawing. */
export function chartSummary(input: ChartInput & { label?: string; formatX?: (x: string) => string; formatY?: (y: number) => string }): string {
  const fx = input.formatX ?? ((x: string) => x);
  const fy = input.formatY ?? ((v: number) => String(v));
  const n = input.xs.length;
  if (n === 0) return `${input.label ?? 'Chart'}: nothing recorded yet.`;
  const span = n === 1 ? `on ${fx(input.xs[0]!)}` : `from ${fx(input.xs[0]!)} to ${fx(input.xs[n - 1]!)}`;
  const parts = input.series.map((s) => {
    const known = s.values.filter((v): v is number => v !== null && Number.isFinite(v));
    if (known.length === 0) return `${s.label}: no values`;
    const latest = known[known.length - 1]!;
    return `${s.label}: latest ${fy(latest)}, lowest ${fy(Math.min(...known))}, highest ${fy(Math.max(...known))}`;
  });
  const target = input.target !== null && input.target !== undefined && Number.isFinite(input.target) ? ` Target ${fy(input.target)}.` : '';
  return `${input.label ?? 'Chart'}, ${n} ${n === 1 ? 'point' : 'points'} ${span}. ${parts.join('; ')}.${target}`;
}

export function Chart({
  xs,
  series,
  type = 'line',
  target = null,
  label,
  formatX = (x) => x,
  formatY = (v) => String(v),
}: ChartInput & { label?: string; formatX?: (x: string) => string; formatY?: (y: number) => string }): JSX.Element {
  const box = CHART_BOX;
  const geometry = chartGeometry({ xs, series, type, target });
  const summary = chartSummary({ xs, series, type, target, ...(label ? { label } : {}), formatX, formatY });
  return (
    <figure className="ui-chart" data-type={type}>
      <svg viewBox={`0 0 ${box.width} ${box.height}`} aria-hidden="true" focusable="false" data-testid="chart-svg">
        {geometry.ticks.map((tick) => (
          <g key={tick.value}>
            <line className="ui-chart-grid" x1={box.left} x2={box.width - box.right} y1={tick.y} y2={tick.y} />
            <text x={box.left - 6} y={tick.y} textAnchor="end" dominantBaseline="middle">{formatY(tick.value)}</text>
          </g>
        ))}
        <line className="ui-chart-axis" x1={box.left} x2={box.width - box.right} y1={box.height - box.bottom} y2={box.height - box.bottom} />
        {geometry.bars.map((bar) => (
          <rect key={`${bar.series}-${bar.index}`} className="ui-chart-bar" data-series={bar.series} x={bar.x} y={bar.y} width={bar.width} height={bar.height} />
        ))}
        {geometry.lines.map((d, index) => (d ? <path key={index} className="ui-chart-line" data-series={index} d={d} /> : null))}
        {geometry.targetY !== null ? (
          <line className="ui-chart-target" data-testid="chart-target" x1={box.left} x2={box.width - box.right} y1={geometry.targetY} y2={geometry.targetY} />
        ) : null}
        {geometry.xLabels.map((label) => (
          <text
            key={label.index}
            x={label.x}
            y={box.height - 6}
            textAnchor={geometry.xLabels.length > 1 && label.index === 0 ? 'start' : label.index === xs.length - 1 && xs.length > 1 ? 'end' : 'middle'}
          >
            {formatX(xs[label.index]!)}
          </text>
        ))}
      </svg>
      <figcaption className="sr-only">{summary}</figcaption>
      {series.length > 1 ? (
        <ul className="ui-chart-legend" aria-hidden="true">
          {series.map((s, index) => (
            <li key={s.label} data-series={index}>{s.label}</li>
          ))}
        </ul>
      ) : null}
    </figure>
  );
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
