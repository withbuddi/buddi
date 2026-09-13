import { describe, expect, it } from 'vitest';
import { dedupHash, occurrenceIndexes } from './shared.js';

describe('dedupHash', () => {
  const zelle = (occurrence?: number): string =>
    occurrence === undefined
      ? dedupHash('Checking', '2026-08-31', 1000, 'Transfer from Zelle')
      : dedupHash('Checking', '2026-08-31', 1000, 'Transfer from Zelle', occurrence);

  it('is stable for the same transaction', () => {
    expect(zelle()).toBe(zelle());
  });

  it('ignores account case and surrounding whitespace', () => {
    expect(dedupHash(' checking ', '2026-08-31', 1000, ' Transfer from Zelle ')).toBe(
      zelle(),
    );
  });

  it('normalises the amount to two decimals', () => {
    expect(dedupHash('Checking', '2026-08-31', 1000.0, 'Transfer from Zelle')).toBe(
      zelle(),
    );
    expect(dedupHash('Checking', '2026-08-31', 1000.01, 'Transfer from Zelle')).not.toBe(
      zelle(),
    );
  });

  it('defaults to occurrence 0', () => {
    expect(zelle()).toBe(zelle(0));
  });

  it('keeps legitimate same-day duplicates apart', () => {
    const hashes = [0, 1, 2].map((n) => zelle(n));
    expect(new Set(hashes).size).toBe(3);
  });

  it('still separates different accounts, dates, amounts and descriptions', () => {
    expect(dedupHash('Savings', '2026-08-31', 1000, 'Transfer from Zelle')).not.toBe(
      zelle(),
    );
    expect(dedupHash('Checking', '2026-09-01', 1000, 'Transfer from Zelle')).not.toBe(
      zelle(),
    );
    expect(dedupHash('Checking', '2026-08-31', 1000, 'Transfer from Wise')).not.toBe(
      zelle(),
    );
  });
});

describe('occurrenceIndexes', () => {
  const row = (date: string, amount: number, description: string) => ({
    date,
    amount,
    description,
  });

  it('gives every distinct row occurrence 0', () => {
    expect(
      occurrenceIndexes([
        row('2026-07-08', -10.46, 'Cloudflare'),
        row('2026-07-08', -20.0, 'Cloudflare'),
        row('2026-07-09', -10.46, 'Cloudflare'),
        row('2026-07-08', -10.46, 'HostGator'),
      ]),
    ).toEqual([0, 0, 0, 0]);
  });

  it('numbers identical rows in file order', () => {
    expect(
      occurrenceIndexes([
        row('2026-08-31', 1000, 'Transfer from Zelle'),
        row('2026-08-31', 1000, 'Transfer from Zelle'),
        row('2026-08-31', 1000, 'Transfer from Zelle'),
      ]),
    ).toEqual([0, 1, 2]);
  });

  it('counts each group independently, however interleaved', () => {
    expect(
      occurrenceIndexes([
        row('2026-07-08', -10.46, 'Cloudflare'),
        row('2026-07-20', -10.46, 'Cloudflare'),
        row('2026-07-08', -10.46, 'Cloudflare'),
        row('2026-07-20', -10.46, 'Cloudflare'),
      ]),
    ).toEqual([0, 0, 1, 1]);
  });

  it('is prefix-stable, so re-importing a grown file only adds the extra row', () => {
    const rows = [
      row('2026-08-31', 1000, 'Transfer from Zelle'),
      row('2026-08-31', 1000, 'Transfer from Zelle'),
    ];
    const grown = [...rows, row('2026-08-31', 1000, 'Transfer from Zelle')];
    expect(occurrenceIndexes(grown).slice(0, rows.length)).toEqual(occurrenceIndexes(rows));
    expect(occurrenceIndexes(grown).at(-1)).toBe(2);
  });

  it('matches on the same normalisation the hash uses', () => {
    expect(
      occurrenceIndexes([
        row('2026-08-31', 1000, 'Transfer from Zelle'),
        row('2026-08-31', 1000.0, ' Transfer from Zelle '),
      ]),
    ).toEqual([0, 1]);
  });

  it('returns nothing for no rows', () => {
    expect(occurrenceIndexes([])).toEqual([]);
  });
});
