import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { CHART_BOX, CHART_BOX_WIDE, Chart, chartGeometry, chartSummary, mixedGeometry } from './Chart';

const { top, bottom, left, right, width, height } = CHART_BOX;
const floor = height - bottom;

describe('chartGeometry', () => {
  it('turns values into a line from the left edge to the right, the highest value highest', () => {
    const g = chartGeometry({ xs: ['a', 'b', 'c'], series: [{ label: 'v', values: [0, 5, 10] }], type: 'line' });
    const points = g.lines[0]!.split(' ').map((part) => part.slice(1).split(',').map(Number));
    expect(g.lines[0]!.startsWith('M')).toBe(true);
    expect(points.map(([x]) => x)).toEqual([left, (left + width - right) / 2, width - right]);
    const ys = points.map(([, y]) => y!);
    expect(ys[0]).toBeGreaterThan(ys[1]!);
    expect(ys[1]).toBeGreaterThan(ys[2]!);
    // Padded: nothing sits on the frame.
    expect(ys[2]).toBeGreaterThan(top);
    expect(ys[0]).toBeLessThan(floor);
  });

  it('breaks the line where a row had no number', () => {
    const g = chartGeometry({ xs: ['a', 'b', 'c', 'd'], series: [{ label: 'v', values: [1, null, 3, 4] }] });
    expect(g.lines[0]!.match(/M/g)).toHaveLength(2);
    expect(g.lines[0]!.match(/L/g)).toHaveLength(1);
  });

  it('stands bars on zero, one per value, and puts the target on the same scale', () => {
    const g = chartGeometry({ xs: ['w1', 'w2'], series: [{ label: 'n', values: [2, 4] }], type: 'bar', target: 3 });
    expect(g.lines).toEqual([]);
    expect(g.bars).toHaveLength(2);
    expect(g.bars[0]!.y + g.bars[0]!.height).toBeCloseTo(floor, 0);
    expect(g.bars[1]!.height).toBeCloseTo(g.bars[0]!.height * 2, 0);
    expect(g.targetY).not.toBeNull();
    expect(g.targetY!).toBeLessThan(g.bars[0]!.y);
    expect(g.targetY!).toBeGreaterThan(g.bars[1]!.y);
  });

  it('keeps a flat series and a single point on the chart', () => {
    const g = chartGeometry({ xs: ['a'], series: [{ label: 'v', values: [7] }] });
    expect(g.lines[0]).toBe(`M${(left + width - right) / 2},${(top + floor) / 2}`);
    expect(g.xLabels).toHaveLength(1);
  });
});

describe('mixedGeometry', () => {
  const xs = ['00', '01', '02', '03'];
  const geometry = mixedGeometry({
    xs,
    series: [
      { label: 'Temperature', values: [10, 12, null, 14], type: 'line' },
      { label: 'Rain', values: [0, 50, 100, 20], type: 'bar', unit: 'percent' },
    ],
  });
  const box = CHART_BOX_WIDE;
  const slot = (box.width - box.left - box.right) / xs.length;

  it('stands each point over its bar, in the middle of the slot, and breaks the line at a gap', () => {
    const moves = geometry.lines[0]!.split(' ').map((part) => [part[0], Number(part.slice(1).split(',')[0])]);
    expect(moves).toEqual([['M', box.left + slot / 2], ['L', box.left + slot * 1.5], ['M', box.left + slot * 3.5]]);
    expect(geometry.lines[1]).toBe('');
    // Zero is no bar; 100% reaches the top of the plot.
    expect(geometry.bars.map((bar) => bar.index)).toEqual([1, 2, 3]);
    expect(geometry.bars[1]!.y).toBe(box.top);
    expect(geometry.bars[1]!.x + geometry.bars[1]!.width / 2).toBeCloseTo(box.left + slot * 2.5, 0);
  });

  it('puts the line on the left scale and 0–100% on the right', () => {
    expect(geometry.ticks.map((tick) => tick.value)).toEqual([10, 12, 14]);
    expect(geometry.rightTicks!.map((tick) => [tick.value, tick.percent])).toEqual([[0, true], [50, true], [100, true]]);
    expect(geometry.rightTicks![0]!.y).toBe(box.height - box.bottom);
  });
});

describe('Chart', () => {
  it('draws the line and a dashed target, and says it all in words for a screen reader', () => {
    render(<Chart xs={['2026-09-01', '2026-09-15']} series={[{ label: 'Weight', values: [82, 80.5] }]} target={78} label="Weight" />);
    const svg = screen.getByTestId('chart-svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg.querySelector('.ui-chart-line')).toHaveAttribute('d');
    expect(screen.getByTestId('chart-target')).toBeInTheDocument();
    expect(screen.getByText('Weight, 2 points from 2026-09-01 to 2026-09-15. Weight: latest 80.5, lowest 80.5, highest 82. Target 78.')).toHaveClass('sr-only');
  });

  it('says so when there is nothing to draw', () => {
    expect(chartSummary({ xs: [], series: [], label: 'Runs' })).toBe('Runs: nothing recorded yet.');
  });

  it('is drawn in tokens only', () => {
    const css = readFileSync(path.join(__dirname, '..', 'ui.css'), 'utf8');
    const rules = css.split('\n').filter((line) => line.startsWith('.ui-chart'));
    expect(rules.length).toBeGreaterThan(5);
    for (const rule of rules) expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    expect(css).toContain('.ui-chart-target { stroke: var(--chart-floor); stroke-width: 1.5; stroke-dasharray: 5 4; }');
  });
});
