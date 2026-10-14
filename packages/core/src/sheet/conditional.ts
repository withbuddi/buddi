/**
 * A sheet's conditional formatting, resolved per cell: `cellIs` (greater
 * than, between…), `expression` (a formula written for the range's first
 * cell, its relative references moved for each cell) and the text rules
 * (`containsText`, `beginsWith`…). Rules apply in priority order, a higher
 * one winning a property and `stopIfTrue` ending the list. Colour scales,
 * data bars and icon sets are not drawn.
 */
import type { SheetEngine } from './evaluate.js';
import { isSheetError, type CellValue, type ConditionalRule, type SheetModel, type WorkbookModel } from './read.js';
import { cellKey, inRange, shiftFormula, type CellRange } from './refs.js';
import type { CellStyle } from './styles.js';

/** Whether a sheet has a rule that needs formulas worked out (an expression, or a comparison with a reference). */
export function conditionalNeedsEngine(sheet: SheetModel): boolean {
  return sheet.conditional.some((block) => block.rules.some((rule) => rule.type === 'expression'
    || (rule.type === 'cellIs' && rule.formulas.some((f) => literal(f) === undefined))));
}

/** A rule operand that is a plain number or quoted text, without the engine. */
function literal(formula: string): CellValue | undefined {
  const text = formula.trim();
  if (text !== '' && Number.isFinite(Number(text))) return Number(text);
  const quoted = /^"((?:[^"]|"")*)"$/.exec(text);
  if (quoted) return quoted[1]!.replace(/""/g, '"');
  if (/^(TRUE|FALSE)$/i.test(text)) return text.toUpperCase() === 'TRUE';
  return undefined;
}

function compare(a: CellValue, b: CellValue): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase().localeCompare(b.toLowerCase());
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  // Excel orders numbers before text before booleans; an empty cell is zero.
  if (a === null && typeof b === 'number') return -b;
  return null;
}

function truthy(value: CellValue): boolean {
  if (isSheetError(value) || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value.toUpperCase() === 'TRUE';
}

function matches(rule: ConditionalRule, value: CellValue, operand: (index: number) => CellValue): boolean {
  if (isSheetError(value)) return false;
  switch (rule.type) {
    case 'cellIs': {
      const a = operand(0);
      const c = compare(value ?? 0, a);
      if (rule.operator === 'between' || rule.operator === 'notBetween') {
        const b = operand(1);
        const lo = compare(value ?? 0, a);
        const hi = compare(value ?? 0, b);
        const inside = lo !== null && hi !== null && ((lo >= 0 && hi <= 0) || (lo <= 0 && hi >= 0));
        return rule.operator === 'between' ? inside : lo !== null && hi !== null && !inside;
      }
      if (c === null) return rule.operator === 'notEqual';
      switch (rule.operator) {
        case 'lessThan': return c < 0;
        case 'lessThanOrEqual': return c <= 0;
        case 'greaterThan': return c > 0;
        case 'greaterThanOrEqual': return c >= 0;
        case 'notEqual': return c !== 0;
        default: return c === 0;
      }
    }
    case 'containsText':
    case 'notContainsText':
    case 'beginsWith':
    case 'endsWith': {
      const text = (rule.text ?? '').toLowerCase();
      const have = value === null ? '' : String(value).toLowerCase();
      if (rule.type === 'containsText') return have.includes(text);
      if (rule.type === 'notContainsText') return !have.includes(text);
      if (rule.type === 'beginsWith') return have.startsWith(text);
      return have.endsWith(text);
    }
    case 'expression': return truthy(operand(0));
    default: return false;
  }
}

/**
 * What the conditional rules change in each cell of `window` (by
 * `cellKey`), the formats the rules name merged. `valueAt` gives a cell's
 * value (the file's or what buddi computed); `engine` works out operand
 * and expression formulas, and without one only literal operands are read.
 */
export function conditionalStyles(
  workbook: WorkbookModel,
  sheet: SheetModel,
  window: CellRange,
  valueAt: (row: number, col: number) => CellValue,
  engine: SheetEngine | null,
): Map<number, Partial<CellStyle>> {
  const out = new Map<number, Partial<CellStyle>>();
  const blocks = sheet.conditional
    .flatMap((block) => block.rules.map((rule) => ({ rule, ranges: block.ranges })))
    .sort((a, b) => a.rule.priority - b.rule.priority);
  if (blocks.length === 0) return out;
  const stopped = new Set<number>();
  for (const { rule, ranges } of blocks) {
    const dxf = rule.dxf === null ? undefined : workbook.styles.dxfs[rule.dxf];
    if (rule.type === 'other') continue;
    const origin = ranges[0]!;
    for (const range of ranges) {
      const r1 = Math.max(range.r1, window.r1);
      const r2 = Math.min(range.r2, window.r2);
      const c1 = Math.max(range.c1, window.c1);
      const c2 = Math.min(range.c2, window.c2);
      for (let row = r1; row <= r2; row++) {
        for (let col = c1; col <= c2; col++) {
          const key = cellKey(row, col);
          if (stopped.has(key) || !inRange(range, row, col)) continue;
          const operand = (index: number): CellValue => {
            const formula = rule.formulas[index] ?? '';
            const plain = literal(formula);
            if (plain !== undefined) return plain;
            return engine ? engine.formulaAt(sheet.name, row, col, shiftFormula(formula, row - origin.r1, col - origin.c1)) : null;
          };
          if (!matches(rule, valueAt(row, col), operand)) continue;
          if (dxf) {
            const have = out.get(key) ?? {};
            // A higher rule (applied first) keeps what it set.
            out.set(key, { ...dxf, ...have, ...(dxf.border || have.border ? { border: { ...dxf.border, ...have.border } } : {}) });
          }
          if (rule.stopIfTrue) stopped.add(key);
        }
      }
    }
  }
  return out;
}
