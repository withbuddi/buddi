/**
 * A cell's value as its number format shows it: `ssf` (Apache-2.0,
 * SheetJS's format engine) for `#,##0.00`, `0%`, dates, `[$€-407]`, with
 * the colour a `[Red]` section gives. The one formatter the preview and the
 * render summary share.
 */
import SSF from 'ssf';
import { isSheetError, type CellValue } from './read.js';

export interface FormattedCell {
  text: string;
  /** The colour the format's section names (`[Red]`), as `#RRGGBB`. */
  color?: string;
}

const COLORS: Record<string, string> = {
  black: '#000000', white: '#FFFFFF', red: '#C00000', green: '#008000', blue: '#0000FF', yellow: '#B8860B', magenta: '#C000C0', cyan: '#008B8B',
};

/** A format's sections, split on `;` outside quotes, brackets and escapes. */
function sections(format: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < format.length; i++) {
    const ch = format[i]!;
    if (ch === '\\' && !quoted) { current += ch + (format[i + 1] ?? ''); i++; continue; }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '[') bracket = true;
    else if (!quoted && ch === ']') bracket = false;
    if (ch === ';' && !quoted && !bracket) { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out;
}

/** The colour of the section a number falls in, when it names one. */
function sectionColor(format: string, value: number): string | undefined {
  const parts = sections(format);
  const conditional = parts.some((p) => /\[[<>=]/.test(p));
  let part: string | undefined;
  if (conditional) part = parts[0];
  else if (value > 0 || parts.length === 1) part = parts[0];
  else if (value < 0) part = parts[1] ?? parts[0];
  else part = parts[2] ?? parts[0];
  const named = /\[(Black|White|Red|Green|Blue|Yellow|Magenta|Cyan)\]/i.exec(part ?? '')?.[1];
  return named ? COLORS[named.toLowerCase()] : undefined;
}

/** A value as `numFmt` shows it. Text, booleans and errors show as they are; a format that will not parse falls back to General. */
export function formatCell(value: CellValue, numFmt = 'General', opts: { date1904?: boolean } = {}): FormattedCell {
  if (value === null) return { text: '' };
  if (isSheetError(value)) return { text: value.error };
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE' };
  const format = numFmt.trim() === '' ? 'General' : numFmt;
  if (typeof value === 'string') {
    // A text section (`@`, or a fourth section) wraps text; otherwise it shows as written.
    const parts = sections(format);
    const textPart = parts.length >= 4 ? parts[3] : parts.length === 1 && parts[0]!.includes('@') ? parts[0] : undefined;
    if (textPart === undefined) return { text: value };
    try { return { text: SSF.format(textPart, value) }; } catch { return { text: value }; }
  }
  if (!Number.isFinite(value)) return { text: String(value) };
  let text: string;
  try {
    text = SSF.format(format, value, { date1904: opts.date1904 === true });
  } catch {
    try { text = SSF.format('General', value); } catch { text = String(value); }
  }
  const color = sectionColor(format, value);
  return color ? { text, color } : { text };
}

/** Whether a number format shows a date or a time. */
export function isDateFormat(numFmt: string): boolean {
  try { return SSF.is_date(numFmt); } catch { return false; }
}
