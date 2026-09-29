/**
 * The `series-panel`: the chart writes the points' own values, its scale lets
 * the day fill the height, and the strip and the chart share one mark — a
 * hover, a pick, or the arrow keys — by index.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import type { Tile } from '../canvas/types';
import { SERIES_BOX, SeriesPanel, seriesGeometry, seriesScale, writeValue, type PanelSeries } from './SeriesPanel';

const TEMPS = [58, 60, 61, 62, 62, 61, 60, 59, 58, 57, 56, 56];
const RAIN = [0, 10, 20, 40, 60, 70, 50, 30, 10, 0, 0, 0];
const XS = TEMPS.map((_, i) => (i === 0 ? 'Now' : `${String(12 + i).padStart(2, '0')}:00`));
const SERIES: PanelSeries[] = [
  { id: 'temp', label: 'Temperature', unit: 'temp', kind: 'area', values: TEMPS },
  { id: 'rain', label: 'Rain', unit: 'percent', kind: 'bars', values: RAIN },
  { id: 'wind', label: 'Wind', unit: 'speed', kind: 'area', values: TEMPS.map((t) => t - 50) },
];
const TILES: Tile[] = TEMPS.map((t, i) => ({ icon: 'cloud', value: `${t}°`, label: XS[i]!, lines: [`Rain ${RAIN[i]}%`], tone: 'neutral', link: null }));

const draw = () => render(<SeriesPanel title="Today" xs={XS} series={SERIES} tiles={TILES} />);
const svg = () => screen.getByTestId('series-svg');
const printed = () => [...svg().querySelectorAll('.pg-series-value')].map((t) => [Number(t.getAttribute('data-index')), t.textContent]);

describe('seriesScale', () => {
  it('fits a temperature to its range, not from zero, in 3–4 ticks', () => {
    expect(seriesScale([56, 62], 'temp')).toEqual([56, 58, 60, 62]);
    expect(seriesScale([13, 24], 'temp')).toEqual([10, 15, 20, 25]);
    expect(seriesScale([-3, 4], 'temp')).toEqual([-5, 0, 5]);
    expect(seriesScale([20, 20], 'temp')).toEqual([19, 20, 21]);
    expect(seriesScale([70, 71], 'temp')).toEqual([70, 71, 72]);
    for (const range of [[56, 62], [13, 24], [0, 35], [-12, -2], [70, 71]]) {
      const ticks = seriesScale(range, 'temp');
      expect(ticks.length).toBeGreaterThanOrEqual(3);
      expect(ticks.length).toBeLessThanOrEqual(4);
      expect(ticks[0]).toBeLessThanOrEqual(range[0]!);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(range[1]!);
    }
  });

  it('holds a percent at 0–100 and starts a speed at zero', () => {
    expect(seriesScale([10, 40], 'percent')).toEqual([0, 50, 100]);
    expect(seriesScale([8, 30], 'speed')).toEqual([0, 10, 20, 30]);
  });
});

describe('seriesGeometry', () => {
  it('lets the day fill the height: the lowest point on the floor, the highest at the top', () => {
    const g = seriesGeometry(SERIES[0]!);
    const { top, height, bottom } = SERIES_BOX;
    const ys = g.points.map((p) => p.y!);
    expect(Math.max(...ys)).toBe(height - bottom);
    expect(Math.min(...ys)).toBe(top);
    // The evening drop 62 → 56 spans the whole height, not a sliver of it.
    expect(g.points[10]!.y! - g.points[3]!.y!).toBe(height - bottom - top);
    expect(g.ticks.map((t) => t.value)).toEqual([56, 58, 60, 62]);
    expect(g.lines).toHaveLength(1);
    expect(g.areas[0]).toMatch(/Z$/);
  });

  it('breaks the line and the area where a point has no number, and draws a bar per value', () => {
    expect(seriesGeometry({ kind: 'area', unit: 'temp', values: [1, 2, null, 4, 5] }).lines).toHaveLength(2);
    const bars = seriesGeometry({ kind: 'bars', unit: 'percent', values: [0, 50, null, 100] }).bars;
    expect(bars.map((b) => b.index)).toEqual([0, 1, 3]);
    expect(bars[2]!.y).toBe(SERIES_BOX.top);
  });
});

describe('SeriesPanel', () => {
  it('writes the points’ own values above every third point, as the strip writes them', () => {
    draw();
    expect(printed()).toEqual([[0, '58°'], [3, '62°'], [6, '60°'], [9, '57°']]);
    // Each one is what the tile of the same hour says.
    for (const [index, text] of printed()) expect(TILES[index as number]!.value).toBe(text);
    expect([...svg().querySelectorAll('.pg-series-tick')].map((t) => t.textContent)).toEqual(['56°', '58°', '60°', '62°']);
    expect([...svg().querySelectorAll('.pg-series-x')].map((t) => t.textContent)).toEqual(['Now', '15:00', '18:00', '21:00']);
    expect(screen.getByText(/^Temperature, 12 points from Now to 23:00: lowest 56°, highest 62°\.$/)).toBeInTheDocument();
  });

  it('marks the same index in the strip and on the chart, from a tile or from a point', () => {
    draw();
    const tiles = screen.getAllByRole('button', { name: /°, Rain/ });
    fireEvent.mouseEnter(tiles[4]!);
    expect(tiles[4]).toHaveAttribute('data-hover', 'true');
    expect(svg().querySelector('.pg-series-guide')).toHaveAttribute('data-index', '4');
    const dot = svg().querySelector('.pg-series-dot[data-hover="true"]')!;
    expect(dot).toHaveAttribute('data-index', '4');
    expect(dot).toHaveAttribute('r', '5');
    // The hovered point writes its value too, though 4 is not a third.
    expect(printed()).toContainEqual([4, '62°']);
    fireEvent.mouseEnter(svg().querySelector('.pg-series-hit[data-index="10"]')!);
    expect(tiles[10]).toHaveAttribute('data-hover', 'true');
    expect(tiles[4]).not.toHaveAttribute('data-hover');
    expect(svg().querySelector('.pg-series-dot[data-hover="true"]')).toHaveAttribute('data-index', '10');
    expect(printed()).toContainEqual([10, '56°']);
  });

  it('pins a pick that outlasts the hover, and moves it with the arrow keys', () => {
    draw();
    const tiles = screen.getAllByRole('button', { name: /°, Rain/ });
    fireEvent.click(svg().querySelector('.pg-series-hit[data-index="2"]')!);
    fireEvent.mouseLeave(svg().closest('.pg-series')!);
    expect(tiles[2]).toHaveAttribute('data-hover', 'true');
    expect(tiles[2]).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(tiles[2]!, { key: 'ArrowRight' });
    expect(tiles[3]).toHaveAttribute('aria-pressed', 'true');
    expect(tiles[3]).toHaveFocus();
    expect(svg().querySelector('.pg-series-guide')).toHaveAttribute('data-index', '3');
    fireEvent.keyDown(tiles[3]!, { key: 'ArrowLeft' });
    fireEvent.keyDown(tiles[2]!, { key: 'ArrowLeft' });
    expect(tiles[1]).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(tiles[1]!, { key: 'End' });
    expect(tiles[11]).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches series with its tabs: rain as bars on 0–100%, the mark kept', () => {
    draw();
    const tablist = screen.getByRole('tablist', { name: 'Series' });
    expect(within(tablist).getByRole('tab', { name: 'Temperature' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.mouseEnter(screen.getAllByRole('button', { name: /°, Rain/ })[5]!);
    fireEvent.click(within(tablist).getByRole('tab', { name: 'Rain' }));
    expect(svg().closest('figure')).toHaveAttribute('data-kind', 'bars');
    expect([...svg().querySelectorAll('.pg-series-tick')].map((t) => t.textContent)).toEqual(['0%', '50%', '100%']);
    expect(svg().querySelector('.pg-series-bar[data-hover="true"]')).toHaveAttribute('data-index', '5');
    expect(printed()).toEqual([[0, '0%'], [3, '40%'], [5, '70%'], [6, '50%'], [9, '0%']]);
    expect(writeValue(12, 'speed')).toBe('12');
  });
});
