/**
 * The fallback, which is what almost every tool result is drawn by.
 *
 * What is asserted here is what the owner complained about: twenty-six rows
 * that said "10 fields" each and a figure buried underneath them. So the tests
 * are about legibility — a table where there are rows, the figures first, a
 * reason where there was a failure, one line where there was nothing — and
 * about the inferences that produce it, which must hold for a plugin this
 * package has never heard of.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { inferShape, tableCandidate } from './infer';
import { Structured } from './views/Structured';
import { hasSubstance } from './renderables';

afterEach(cleanup);

/** The result that started this: 26 recurring items and three figures. */
const recurring = {
  items: Array.from({ length: 26 }, (_, index) => ({
    id: `8f14e45f-ceea-467a-9e4a-${index}00000000000`,
    kind: index === 1 ? 'income' : 'charge',
    name: `Item ${index}`,
    amount: 40 + index,
    cadence: 'monthly',
    anchorDate: `2026-09-${String((index % 27) + 1).padStart(2, '0')}`,
    account: index % 2 === 0 ? 'NFCU Checking' : null,
    billedTo: null,
    category: 'housing',
    active: true,
  })),
  count: 26,
  monthlyNet: -5818.7,
  cardBilledCount: 6,
};

describe('inferring a shape', () => {
  it('reads an array of consistent objects as a table', () => {
    const shape = inferShape(recurring);
    expect(shape.kind).toBe('table');
    if (shape.kind !== 'table') return;
    expect(shape.rows).toHaveLength(26);
    expect(shape.columns.map((column) => column.key)).toContain('name');
  });

  it('puts the scalar siblings above the rows as figures, not under them', () => {
    const shape = inferShape(recurring);
    if (shape.kind !== 'table') throw new Error('expected a table');
    const labels = shape.stats.map((stat) => stat.label);
    expect(labels).toContain('Count');
    expect(labels).toContain('Monthly net');
    expect(labels).toContain('Card billed count');
  });

  it('drops a column of opaque ids and lifts a column that never varies', () => {
    const shape = inferShape(recurring);
    if (shape.kind !== 'table') throw new Error('expected a table');
    expect(shape.columns.map((column) => column.key)).not.toContain('id');
    // `active` is true in every row: a fact about the set, said once.
    expect(shape.columns.map((column) => column.key)).not.toContain('active');
    expect(shape.stats.map((stat) => stat.label)).toContain('Active');
  });

  it('types each column from its values', () => {
    const shape = inferShape(recurring);
    if (shape.kind !== 'table') throw new Error('expected a table');
    const type = (key: string): string | undefined =>
      shape.columns.find((column) => column.key === key)?.type;
    expect(type('amount')).toBe('number');
    expect(type('anchorDate')).toBe('date');
    expect(type('name')).toBe('text');
  });

  it('calls a number money only when the result names a currency', () => {
    const withCurrency = inferShape({ currency: 'EUR', rows: [{ balance: 12.5 }, { balance: 4 }] });
    if (withCurrency.kind !== 'table') throw new Error('expected a table');
    expect(withCurrency.columns[0]).toMatchObject({ type: 'currency', currency: 'EUR' });

    const without = inferShape({ rows: [{ balance: 12.5 }, { balance: 4 }] });
    if (without.kind !== 'table') throw new Error('expected a table');
    expect(without.columns[0]?.type).toBe('number');
  });

  it('orders columns by how often they appear, then by first sight', () => {
    const shape = tableCandidate(
      [
        { a: 1, rare: 1, b: 1 },
        { a: 2, b: 2 },
        { a: 3, b: 3 },
        { a: 4, b: 4 },
      ],
      null,
    );
    // `a` and `b` both appear four times, so the tie goes to the one seen
    // first; `rare` appears once and sinks to the end.
    expect(shape?.columns.map((column) => column.key)).toEqual(['a', 'b', 'rare']);
  });

  it('refuses to table a list of differently shaped things', () => {
    const shape = inferShape([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }, { e: 5 }]);
    expect(shape.kind).toBe('tree');
  });

  it('reads an array of scalars as a list and one object as its facts', () => {
    expect(inferShape({ names: ['a', 'b', 'c'] }).kind).toBe('list');
    const record = inferShape({ score: 712, source: 'Experian', observedOn: '2026-09-01' });
    expect(record.kind).toBe('record');
    if (record.kind !== 'record') return;
    expect(record.pairs.map((pair) => pair.label)).toEqual(['Score', 'Source', 'Observed on']);
  });

  it('says so in one line when a tool returned nothing', () => {
    expect(inferShape({ count: 0, receipts: [] })).toMatchObject({ kind: 'empty' });
    expect(inferShape(null)).toMatchObject({ kind: 'empty' });
    expect(inferShape([])).toMatchObject({ kind: 'empty' });
  });

  it('shows a failure as its reason, not as an empty table', () => {
    const shape = inferShape({ message: 'MFA challenge expired', code: 'MFA_TIMEOUT' }, { failed: true });
    expect(shape).toMatchObject({ kind: 'error', summary: 'MFA challenge expired' });
  });
});

describe('the structured panel', () => {
  it('draws the rows as a table with the figures above it', () => {
    render(<Structured props={{ value: recurring }} />);
    expect(screen.getByText('Monthly net')).toBeDefined();
    expect(screen.getByRole('table')).toBeDefined();
    expect(screen.getAllByRole('row').length).toBeGreaterThan(20);
    // The thing that was wrong before: no collapsed "N fields" rows.
    expect(screen.queryByText(/10 fields/)).toBeNull();
  });

  it('keeps the raw JSON one click away', () => {
    render(<Structured props={{ value: recurring }} />);
    expect(screen.getByRole('button', { name: 'Raw JSON' })).toBeDefined();
  });

  it('states the reason a call failed', () => {
    render(<Structured props={{ value: { message: 'The gate refused' }, failed: true }} />);
    expect(screen.getByText('The gate refused')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('answers an empty result in one line', () => {
    render(<Structured props={{ value: { count: 0, receipts: [] } }} />);
    expect(screen.getByText(/No receipts to show\./)).toBeDefined();
  });
});

describe('what earns the canvas', () => {
  it('counts rows, points and figures as substance', () => {
    expect(hasSubstance('structured', { value: recurring })).toBe(true);
    expect(hasSubstance('timeseries', { points: [{ x: '1', y: 2 }] })).toBe(true);
    expect(hasSubstance('table', { groups: [{ label: null, rows: [[]] }] })).toBe(true);
  });

  it('does not let an empty result, an acknowledgement or a failure take the screen', () => {
    expect(hasSubstance('structured', { value: { count: 0, receipts: [] } })).toBe(false);
    expect(hasSubstance('structured', { value: { ok: true, recorded: 1 } })).toBe(false);
    expect(hasSubstance('structured', { value: { message: 'no' }, failed: true })).toBe(false);
    expect(hasSubstance('table', { groups: [{ label: null, rows: [] }] })).toBe(false);
    expect(hasSubstance('timeseries', { points: [] })).toBe(false);
  });
});
