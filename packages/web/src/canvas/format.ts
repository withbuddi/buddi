/** Turning a resolved value into the string the canvas prints. */
import { fmtMoney, fmtNumber } from '../format';
import type { ColumnType, Unit } from './types';

/**
 * One number, formatted by the unit the descriptor claimed — and gracefully
 * when it lied. Currency keeps cents when the amount is small enough for cents
 * to matter, because a staged import that rounds $4.99 to $5 is wrong in a way
 * the owner has to go and check.
 */
export function fmtValue(value: unknown, unit: Unit | ColumnType, currency: string | null): string {
  if (value === null || value === undefined) return '—';
  switch (unit) {
    case 'currency': {
      const amount = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(amount)) return String(value);
      return fmtMoneyPrecise(amount, currency);
    }
    case 'percent': {
      const amount = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(amount)) return String(value);
      return `${trim(amount)}%`;
    }
    case 'number': {
      const amount = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(amount)) return String(value);
      return Number.isInteger(amount) ? fmtNumber(amount) : trim(amount);
    }
    case 'date':
      return fmtDate(String(value));
    default:
      if (typeof value === 'string') return value;
      if (typeof value === 'number') return fmtNumber(value);
      if (typeof value === 'boolean') return value ? 'yes' : 'no';
      return JSON.stringify(value) ?? String(value);
  }
}

export function fmtMoneyPrecise(amount: number, currency: string | null): string {
  const cents = Math.abs(amount) < 1000 && !Number.isInteger(amount);
  if (!cents) return fmtMoney(amount, currency);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency ?? 'USD',
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return amount.toFixed(2);
  }
}

/** A table cell: `2026-09-20` → `20 Sep 2026`, so two years in one column never read alike. */
export function fmtDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const date = new Date(`${match[0]}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

/** A short axis label: `2026-09-20` → `20 Sep`. Anything else is left alone. */
export function fmtDay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const date = new Date(`${match[0]}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(date);
}

function trim(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Axis ticks that land on round numbers, and only ones the chart actually
 * reaches — a label at 5,000 on a chart whose ceiling is 4,210 is a label for a
 * value that never happened.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const raw = (max - min) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + step / 1000; tick += step) {
    ticks.push(Math.round(tick * 1e6) / 1e6);
  }
  return ticks.filter((tick) => tick >= min && tick <= max);
}
