/**
 * The `series-panel` component: a day in one panel, drawn from the design
 * kit's Weather screen (`WxSeries`). Tabs across the series; the chosen one as
 * an area (or bars) with its values written above every few points; under it
 * the hourly strip of tiles drawn from the same points. Hovering a point or a
 * tile marks both — the tile, a guide and a larger dot on the chart — and a
 * click pins the mark; ←/→ (and Home/End) move the pin from the strip.
 *
 * The scale is chosen so the day fills the height: 3–4 ticks fitted to the
 * range for a temperature (never from zero), 0–100 for a percent, from zero
 * for anything else. Every colour is a token, set in `styles.css` (`pg-series-*`).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Tile } from '../canvas/types';
import { tileGlyph } from '../canvas/tileIcons';
import { Icon, Panel } from '../ui';

export type SeriesUnit = 'percent' | 'temp' | 'speed';

export interface PanelSeries {
  id: string;
  label: string;
  unit?: SeriesUnit;
  kind: 'area' | 'bars';
  /** One per point; `null` where the point had no number. */
  values: Array<number | null>;
}

/** The chart's own coordinates, as the kit's: room above for the printed values, a scale on the left. */
export const SERIES_BOX = { width: 1200, height: 200, top: 28, right: 12, bottom: 24, left: 36 } as const;

/** 3–4 ticks the values fill: 0–100 for a percent, from 0 for a speed, else fitted to the range. */
export function seriesScale(values: readonly number[], unit?: SeriesUnit): number[] {
  if (unit === 'percent') return [0, 50, 100];
  let lo = values.length > 0 ? Math.min(...values) : 0;
  let hi = values.length > 0 ? Math.max(...values) : 1;
  if (unit !== 'temp') lo = Math.min(0, lo);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const mag = 10 ** Math.floor(Math.log10(Math.max(1, (hi - lo) / 3)));
  const spans = (step: number): number => Math.ceil(hi / step) - Math.floor(lo / step);
  let step = [1, 2, 5, 10].map((m) => m * mag).find((s) => spans(s) <= 3) ?? mag * 10;
  // Two ticks are too few to read a day by: a finer step, or one more above.
  if (spans(step) < 2) {
    if (step > 1) step /= 2;
    else hi += step;
  }
  const ticks: number[] = [];
  for (let t = Math.floor(lo / step) * step; t <= Math.ceil(hi / step) * step + step / 1000; t += step) {
    ticks.push(Math.round(t * 1e6) / 1e6);
  }
  return ticks;
}

/** A value as the chart writes it: `20°`, `70%`, `26`. */
export function writeValue(value: number, unit?: SeriesUnit): string {
  return unit === 'temp' ? `${value}°` : unit === 'percent' ? `${value}%` : String(value);
}

export interface SeriesGeometry {
  ticks: Array<{ value: number; y: number }>;
  /** One `d` per run of points with a number: the line, and the area under it. */
  lines: string[];
  areas: string[];
  bars: Array<{ index: number; x: number; y: number; width: number; height: number }>;
  points: Array<{ index: number; x: number; y: number | null; value: number | null }>;
  slot: number;
  floor: number;
}

/** Values to coordinates: the part worth testing on its own. */
export function seriesGeometry(series: Pick<PanelSeries, 'values' | 'unit' | 'kind'>): SeriesGeometry {
  const box = SERIES_BOX;
  const n = series.values.length;
  const plotW = box.width - box.left - box.right;
  const plotH = box.height - box.top - box.bottom;
  const floor = box.height - box.bottom;
  const slot = n > 0 ? plotW / n : plotW;
  const xAt = (index: number): number => round(box.left + slot * (index + 0.5));
  const known = series.values.filter((v): v is number => v !== null && Number.isFinite(v));
  const scale = seriesScale(known, series.unit);
  const lo = scale[0]!;
  const hi = scale[scale.length - 1]!;
  const yAt = (value: number): number => round(box.top + plotH - ((value - lo) / (hi - lo)) * plotH);
  const points = series.values.map((value, index) => {
    const ok = value !== null && Number.isFinite(value);
    return { index, x: xAt(index), y: ok ? yAt(value) : null, value: ok ? value : null };
  });
  const lines: string[] = [];
  const areas: string[] = [];
  if (series.kind === 'area') {
    let run: typeof points = [];
    const close = (): void => {
      if (run.length === 0) return;
      const d = run.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
      lines.push(d);
      areas.push(`${d} L${run[run.length - 1]!.x},${floor} L${run[0]!.x},${floor} Z`);
      run = [];
    };
    for (const p of points) {
      if (p.y === null) close();
      else run.push(p);
    }
    close();
  }
  const bars =
    series.kind === 'bars'
      ? points.flatMap((p) =>
          p.y === null ? [] : [{ index: p.index, x: round(p.x - slot * 0.28), y: p.y, width: round(slot * 0.56), height: round(floor - p.y) }],
        )
      : [];
  return { ticks: scale.map((value) => ({ value, y: yAt(value) })), lines, areas, bars, points, slot, floor };
}

export function SeriesPanel({
  title,
  note,
  xs,
  series,
  tiles,
  labelEvery = 3,
}: {
  title?: string;
  note?: string;
  xs: readonly string[];
  series: readonly PanelSeries[];
  tiles: readonly Tile[];
  labelEvery?: number;
}): JSX.Element {
  const [tab, setTab] = useState(series[0]?.id ?? '');
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const strip = useRef<HTMLUListElement>(null);
  const n = xs.length;
  const mark = hover ?? pinned;
  const shown = series.find((s) => s.id === tab) ?? series[0]!;
  const g = seriesGeometry(shown);
  const box = SERIES_BOX;
  const printed = (index: number): boolean => index % labelEvery === 0 || index === mark;
  const known = shown.values.filter((v): v is number => v !== null && Number.isFinite(v));

  // The strip follows the chart: the marked hour scrolls into its view.
  useEffect(() => {
    const ul = strip.current;
    const li = mark === null ? null : (ul?.children[mark] as HTMLElement | undefined);
    if (!ul || !li || typeof ul.scrollTo !== 'function') return;
    if (li.offsetLeft < ul.scrollLeft) ul.scrollTo({ left: li.offsetLeft, behavior: 'smooth' });
    else if (li.offsetLeft + li.offsetWidth > ul.scrollLeft + ul.clientWidth) {
      ul.scrollTo({ left: li.offsetLeft + li.offsetWidth - ul.clientWidth, behavior: 'smooth' });
    }
  }, [mark]);

  const onKey = (event: KeyboardEvent<HTMLUListElement>): void => {
    const by = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const at =
      event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : by === 0 ? null : Math.max(0, Math.min(n - 1, (pinned ?? -by) + by));
    if (at === null) return;
    event.preventDefault();
    setPinned(at);
    strip.current?.children[at]?.querySelector('button')?.focus();
  };

  return (
    <Panel {...(title ? { title } : {})}>
      {note ? <p className="ui-panel-sub">{note}</p> : null}
      <div className="pg-series" onMouseLeave={() => setHover(null)}>
        {series.length > 1 ? (
          <div className="pg-series-tabs" role="tablist" aria-label="Series">
            {series.map((s) => (
              <button key={s.id} type="button" role="tab" className="ui-tab" aria-selected={s.id === shown.id} onClick={() => setTab(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        ) : null}
        <figure className="pg-series-chart" data-kind={shown.kind}>
          <svg viewBox={`0 0 ${box.width} ${box.height}`} aria-hidden="true" focusable="false" data-testid="series-svg">
            {g.ticks.map((tick) => (
              <g key={tick.value}>
                <line className="pg-series-grid" x1={box.left} x2={box.width - box.right} y1={tick.y} y2={tick.y} />
                <text className="pg-series-tick" x={box.left - 8} y={tick.y} textAnchor="end" dominantBaseline="middle">
                  {writeValue(tick.value, shown.unit)}
                </text>
              </g>
            ))}
            {g.areas.map((d, i) => (
              <path key={`a${i}`} className="pg-series-area" d={d} />
            ))}
            {g.lines.map((d, i) => (
              <path key={`l${i}`} className="pg-series-line" d={d} />
            ))}
            {g.bars.map((bar) => (
              <rect
                key={bar.index}
                className="pg-series-bar"
                data-index={bar.index}
                data-hover={bar.index === mark ? 'true' : undefined}
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={bar.height}
              />
            ))}
            {mark !== null && g.points[mark] ? (
              <line className="pg-series-guide" data-index={mark} x1={g.points[mark]!.x} x2={g.points[mark]!.x} y1={box.top - 4} y2={g.floor} />
            ) : null}
            {shown.kind === 'area'
              ? g.points.map((p) =>
                  p.y !== null && printed(p.index) ? (
                    <circle
                      key={p.index}
                      className="pg-series-dot"
                      data-index={p.index}
                      data-hover={p.index === mark ? 'true' : undefined}
                      cx={p.x}
                      cy={p.y}
                      r={p.index === mark ? 5 : 3}
                    />
                  ) : null,
                )
              : null}
            {g.points.map((p) =>
              p.y !== null && p.value !== null && printed(p.index) ? (
                <text
                  key={p.index}
                  className="pg-series-value"
                  data-index={p.index}
                  data-hover={p.index === mark ? 'true' : undefined}
                  x={p.x}
                  y={p.y - (shown.kind === 'area' ? 10 : 6)}
                  textAnchor="middle"
                >
                  {writeValue(p.value, shown.unit)}
                </text>
              ) : null,
            )}
            {g.points.map((p) =>
              p.index % labelEvery === 0 ? (
                <text key={p.index} className="pg-series-x" x={p.x} y={box.height - 6} textAnchor="middle">
                  {xs[p.index]}
                </text>
              ) : null,
            )}
            {g.points.map((p) => (
              <rect
                key={p.index}
                className="pg-series-hit"
                data-index={p.index}
                x={round(box.left + g.slot * p.index)}
                y={0}
                width={round(g.slot)}
                height={box.height}
                onMouseEnter={() => setHover(p.index)}
                onClick={() => setPinned(p.index)}
              />
            ))}
          </svg>
          <figcaption className="sr-only">
            {known.length === 0
              ? `${shown.label}: no values.`
              : `${shown.label}, ${n} ${n === 1 ? 'point' : 'points'} from ${xs[0]} to ${xs[n - 1]}: lowest ${writeValue(Math.min(...known), shown.unit)}, highest ${writeValue(Math.max(...known), shown.unit)}.`}
          </figcaption>
        </figure>
        <ul className="wb-tiles" data-layout="strip" ref={strip} onKeyDown={onKey}>
          {tiles.map((tile, index) => (
            <li key={index} className="wb-tile">
              <button
                type="button"
                className="ui-card"
                data-index={index}
                data-hover={index === mark ? 'true' : undefined}
                aria-pressed={index === pinned}
                aria-label={[tile.label, tile.value, ...tile.lines].filter((part) => part !== '').join(', ')}
                onMouseEnter={() => setHover(index)}
                onClick={() => setPinned(index)}
              >
                <div className="wb-tile-body" aria-hidden="true">
                  <span className="wb-tile-icon" data-icon={tile.icon ?? 'dot'}>
                    <Icon name={tileGlyph(tile.icon)} size={22} />
                  </span>
                  {tile.value !== '' ? <span className="wb-tile-value tnum">{tile.value}</span> : null}
                  <span className="wb-tile-label">{tile.label}</span>
                  {tile.lines.map((line, i) => (
                    <span key={i} className="wb-tile-line">{line}</span>
                  ))}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
