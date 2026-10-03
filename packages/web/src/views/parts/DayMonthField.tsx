/**
 * A yearly date as the owner writes it: day, month, and the year only when
 * they want it (a birthday, an anniversary). The same three controls on
 * Settings → Profile and in a person's sheet (docs/memory.md, "People").
 */
import type { DayMonthView } from '../../api';
import { Field } from '../../ui';

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** What the three controls hold while being typed: a date needs day and month; the year may be blank. */
export interface DayMonthDraft {
  day: string;
  month: string;
  year: string;
}

export const draftOf = (date: DayMonthView | null | undefined): DayMonthDraft =>
  date ? { day: String(date.day), month: String(date.month), year: date.year ? String(date.year) : '' } : { day: '', month: '', year: '' };

/** The date the draft says, null when it is blank, `'incomplete'` while half typed. */
export function dateOf(draft: DayMonthDraft): DayMonthView | null | 'incomplete' {
  const blank = draft.day === '' && draft.month === '' && draft.year.trim() === '';
  if (blank) return null;
  if (draft.day === '' || draft.month === '') return 'incomplete';
  const year = draft.year.trim();
  if (year !== '' && !/^\d{4}$/.test(year)) return 'incomplete';
  return { day: Number(draft.day), month: Number(draft.month), year: year === '' ? null : Number(year) };
}

export const sameDate = (a: DayMonthView | null | undefined, b: DayMonthView | null | undefined): boolean =>
  (a ?? null) === (b ?? null) || (!!a && !!b && a.day === b.day && a.month === b.month && (a.year ?? null) === (b.year ?? null));

/** "14 March", "14 March 1991". */
export const dateWords = (date: DayMonthView, withYear = true): string =>
  `${date.day} ${MONTHS[date.month - 1]}${withYear && date.year ? ` ${date.year}` : ''}`;

export function DayMonthField({ label, hint, value, onChange }: {
  label: string;
  hint?: string;
  value: DayMonthDraft;
  onChange: (next: DayMonthDraft) => void;
}): JSX.Element {
  const half = dateOf(value) === 'incomplete';
  return (
    <Field group label={label} hint={half ? 'A day and a month; the year is optional, four digits.' : hint}>
      <div className="day-month">
        <select aria-label={`${label}: day`} value={value.day} onChange={(e) => onChange({ ...value, day: e.target.value })}>
          <option value="">Day</option>
          {Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={String(i + 1)}>{i + 1}</option>)}
        </select>
        <select aria-label={`${label}: month`} value={value.month} onChange={(e) => onChange({ ...value, month: e.target.value })}>
          <option value="">Month</option>
          {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
        </select>
        <input aria-label={`${label}: year (optional)`} inputMode="numeric" placeholder="Year" maxLength={4} value={value.year} onChange={(e) => onChange({ ...value, year: e.target.value.replace(/\D/g, '') })} />
      </div>
    </Field>
  );
}
