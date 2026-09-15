/**
 * The chart, from data to the marks on the page.
 *
 * The things asserted are the things a chart can quietly get wrong: an axis
 * labelled with values the series never reaches, a rule drawn off its own
 * scale, a minimum you have to hunt for, a breach that is only mentioned in
 * prose.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Timeseries, breachBands, markIndex, xTicks } from './views/Timeseries';
import { niceTicks } from './format';
import { resolveTimeseries } from './resolve';
import type { TimeseriesProps } from './types';

afterEach(cleanup);

const projection: TimeseriesProps = {
  points: [
    { x: '2026-09-14', y: 4210 },
    { x: '2026-09-20', y: 3910 },
    { x: '2026-09-26', y: 120 },
    { x: '2026-09-30', y: 1400 },
  ],
  unit: 'currency',
  currency: 'USD',
  label: 'Next 30 days',
  referenceLines: [{ value: 500, label: 'Floor', tone: 'critical' }],
  mark: 'min',
  shadeBelow: 500,
  events: [{ at: '2026-09-20', label: 'Rent', amount: -300 }],
};

describe('the timeseries chart', () => {
  it('labels the axis only with values the series reaches', () => {
    render(<Timeseries props={projection} />);
    const labels = screen.getAllByText(/^\$[\d,]+$/).map((node) => node.textContent);
    // Every axis label sits inside the data's own range…
    for (const label of labels) {
      const value = Number(label!.replace(/[$,]/g, ''));
      expect(value).toBeGreaterThanOrEqual(120);
      expect(value).toBeLessThanOrEqual(4210);
    }
    // …and there is more than one of them, so it is a real axis.
    expect(labels.length).toBeGreaterThan(1);
  });

  it('draws the floor as a rule, labelled with its own value', () => {
    const { container } = render(<Timeseries props={projection} />);
    expect(screen.getByText(/Floor\s+\$500/)).toBeDefined();
    const rule = container.querySelector('.wb-chart-floor');
    expect(rule).toBeTruthy();
    // On the same scale as the series: the rule's y must fall inside the plot,
    // wherever the plot's own floor happens to be in this build.
    const axes = [...container.querySelectorAll('.wb-chart-axis')];
    const baseline = Math.max(...axes.map((axis) => Number(axis.getAttribute('y1'))));
    const y = Number(rule!.getAttribute('y1'));
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(baseline);
  });

  it('marks the minimum and prints what it is', () => {
    const { container } = render(<Timeseries props={projection} />);
    expect(container.querySelector('.wb-chart-min')).toBeTruthy();
    expect(screen.getByText('$120')).toBeDefined();
  });

  it('shades the days that break the floor', () => {
    const { container } = render(<Timeseries props={projection} />);
    const bands = container.querySelectorAll('.wb-chart-breach');
    expect(bands.length).toBe(1);
    expect(Number(bands[0]!.getAttribute('width'))).toBeGreaterThan(0);
  });

  it('lists the event days beside the chart', () => {
    const { container } = render(<Timeseries props={projection} />);
    expect(screen.getByText('Rent')).toBeDefined();
    // Scoped to the list: the axis is a scale and may label the same day.
    const list = container.querySelector('.wb-chart-events')!;
    // The short month is whatever the runtime's ICU calls it (`Sep` / `Sept`).
    expect(within(list as HTMLElement).getByText(/^20 Sept?$/)).toBeDefined();
  });

  it('labels the x axis at an even interval rather than at the marks', () => {
    // Evenly spaced across the domain: no two ticks bunched together because
    // one of them happens to be the minimum.
    expect(xTicks(45)).toEqual([0, 11, 22, 33, 44]);
    expect(xTicks(3)).toEqual([0, 1, 2]);
    expect(xTicks(1)).toEqual([0]);
  });

  it('describes itself for anyone who cannot see it', () => {
    render(<Timeseries props={projection} />);
    const chart = screen.getByRole('img');
    expect(chart.getAttribute('aria-label')).toContain('low $120');
    expect(chart.getAttribute('aria-label')).toContain('Floor at $500');
  });

  it('says so rather than drawing an empty axis', () => {
    render(<Timeseries props={{ ...projection, points: [] }} />);
    expect(screen.getByText(/no points to plot/i)).toBeDefined();
  });
});

describe('the pieces the chart is made of', () => {
  it('finds the marked extreme', () => {
    expect(markIndex([4, 1, 7], 'min')).toBe(1);
    expect(markIndex([4, 1, 7], 'max')).toBe(2);
    expect(markIndex([4, 1, 7], null)).toBeNull();
  });

  it('groups contiguous breaches into bands', () => {
    expect(breachBands([5, 1, 1, 6, 0], 3)).toEqual([
      { from: 1, to: 3 },
      { from: 4, to: 4 },
    ]);
  });

  it('never proposes a tick outside the data', () => {
    for (const tick of niceTicks(120, 4210)) {
      expect(tick).toBeGreaterThanOrEqual(120);
      expect(tick).toBeLessThanOrEqual(4210);
    }
    expect(niceTicks(5, 5)).toEqual([5]);
  });

  it('drops points a descriptor pointed at the wrong field', () => {
    const props = resolveTimeseries({ days: [{ date: 'a', high: 'not a number' }] }, {
      points: 'days',
      x: 'date',
      y: 'high',
    });
    expect(props.points).toEqual([]);
  });
});
