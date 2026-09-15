/**
 * `timeseries` — points over a horizon, with the rules that matter drawn on
 * them and the extreme marked.
 *
 * Written as plain SVG on one scale. Every colour comes from a token class in
 * `styles.css`, so the chart is theme-aware without reading the theme, and the
 * axis only ever labels values the series actually reaches.
 */
import type { TimeseriesProps } from '../types';
import { fmtDay, fmtValue, niceTicks } from '../format';

const W = 760;
const H = 280;
const PAD = { top: 16, right: 18, bottom: 30, left: 66 };

export function Timeseries({ props }: { props: TimeseriesProps }): JSX.Element {
  const { points, referenceLines, unit, currency } = props;
  if (points.length === 0) {
    return <p className="wb-empty">This result carried no points to plot.</p>;
  }

  // One scale for everything on the chart, rules included — a floor drawn off
  // the bottom of its own chart would be worse than not drawing it.
  const values = [...points.map((p) => p.y), ...referenceLines.map((line) => line.value)];
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = rawMax - rawMin || Math.abs(rawMax) || 1;
  const min = rawMin - span * 0.08;
  const max = rawMax + span * 0.08;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (index: number): number =>
    PAD.left + (points.length === 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
  const y = (value: number): number => PAD.top + plotH - ((value - min) / (max - min)) * plotH;

  const ticks = niceTicks(rawMin, rawMax, 4);
  const extremeIndex = markIndex(points.map((p) => p.y), props.mark);
  const bands = props.shadeBelow === null ? [] : breachBands(points.map((p) => p.y), props.shadeBelow);

  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(point.y)}`).join(' ');
  const labelOf = (value: number): string => fmtValue(value, unit, currency);

  return (
    <div>
      {props.label ? <p className="wb-panel-sub">{props.label}</p> : null}
      <div className="flex flex-wrap gap-5 items-start">
        <div className="flex-1 min-w-[280px]">
          <svg
            className="wb-chart"
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={chartSummary(props, labelOf)}
            preserveAspectRatio="xMidYMid meet"
          >
            {/* Days that break the rule, shaded rather than annotated. */}
            {bands.map((band) => (
              <rect
                key={`band-${band.from}`}
                className="wb-chart-breach"
                x={x(band.from)}
                width={Math.max(2, x(band.to) - x(band.from))}
                y={PAD.top}
                height={plotH}
              />
            ))}

            {ticks.map((tick) => (
              <g key={`tick-${tick}`}>
                <line className="wb-chart-grid" x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} />
                <text x={PAD.left - 8} y={y(tick) + 4} textAnchor="end">
                  {labelOf(tick)}
                </text>
              </g>
            ))}

            {referenceLines.map((line) => (
              <g key={`rule-${line.label}`}>
                <line
                  className="wb-chart-floor"
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={y(line.value)}
                  y2={y(line.value)}
                />
                <text x={W - PAD.right} y={y(line.value) - 6} textAnchor="end">
                  {line.label} {labelOf(line.value)}
                </text>
              </g>
            ))}

            <line className="wb-chart-axis" x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} />
            <line
              className="wb-chart-axis"
              x1={PAD.left}
              x2={W - PAD.right}
              y1={PAD.top + plotH}
              y2={PAD.top + plotH}
            />

            <path className="wb-chart-series" d={path} />

            {extremeIndex !== null ? (
              <g>
                <circle className="wb-chart-min" cx={x(extremeIndex)} cy={y(points[extremeIndex]!.y)} r={4.5} />
                <text x={x(extremeIndex)} y={y(points[extremeIndex]!.y) + 20} textAnchor="middle">
                  {labelOf(points[extremeIndex]!.y)}
                </text>
              </g>
            ) : null}

            {xLabels(points.length, extremeIndex).map((index) => (
              <text key={`x-${index}`} x={x(index)} y={H - 10} textAnchor="middle">
                {fmtDay(points[index]!.x)}
              </text>
            ))}
          </svg>
        </div>

        {props.events.length > 0 ? (
          <aside className="min-w-[180px] max-w-[280px] flex-1">
            <h4 className="wb-stat-k m-0 mb-2">What happens</h4>
            <ul className="m-0 p-0 list-none flex flex-col gap-1">
              {props.events.map((event, index) => (
                <li key={`${event.at}-${event.label}-${index}`} className="flex justify-between gap-3 text-[13px]">
                  <span>
                    <span className="tnum text-muted mr-2">{fmtDay(event.at)}</span>
                    {event.label}
                  </span>
                  {event.amount === null ? null : (
                    <span className="tnum" style={{ color: event.amount < 0 ? 'var(--critical)' : 'var(--good)' }}>
                      {fmtValue(event.amount, unit, currency)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/** The sentence a screen reader gets instead of the picture. */
function chartSummary(props: TimeseriesProps, label: (value: number) => string): string {
  const values = props.points.map((point) => point.y);
  const first = props.points[0];
  const last = props.points[props.points.length - 1];
  const rules = props.referenceLines.map((line) => `${line.label} at ${label(line.value)}`).join(', ');
  return [
    `${props.points.length} points from ${first?.x} to ${last?.x}`,
    `low ${label(Math.min(...values))}, high ${label(Math.max(...values))}`,
    rules,
  ]
    .filter(Boolean)
    .join('; ');
}

export function markIndex(values: number[], mark: 'min' | 'max' | null): number | null {
  if (!mark || values.length === 0) return null;
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    const better = mark === 'min' ? values[index]! < values[best]! : values[index]! > values[best]!;
    if (better) best = index;
  }
  return best;
}

/** Contiguous runs of points under the rule, as index ranges. */
export function breachBands(values: number[], floor: number): Array<{ from: number; to: number }> {
  const bands: Array<{ from: number; to: number }> = [];
  let start: number | null = null;
  values.forEach((value, index) => {
    if (value < floor) {
      if (start === null) start = index;
    } else if (start !== null) {
      bands.push({ from: start, to: index });
      start = null;
    }
  });
  if (start !== null) bands.push({ from: start, to: values.length - 1 });
  return bands;
}

/** First, last, and the marked point — enough to read the axis, no more. */
function xLabels(count: number, extreme: number | null): number[] {
  const wanted = new Set<number>([0, count - 1]);
  if (extreme !== null) wanted.add(extreme);
  if (count > 4) wanted.add(Math.floor((count - 1) / 2));
  return [...wanted].filter((index) => index >= 0 && index < count).sort((a, b) => a - b);
}
