/**
 * Agent markdown, rendered for a terminal.
 *
 * Telegram's `toPlainText` deletes markdown because Telegram would show the
 * markers literally. A terminal can do better: it has bold, it has columns, and
 * it has a width to align to. So this is the same idea with the opposite
 * conclusion — the markers are *honoured* rather than stripped.
 *
 * Pure by construction: text in, text out, no clock, no I/O, no `process`. The
 * only thing it is told about the world is a `TerminalStyle`, so the same input
 * with `{ color: false }` is exactly the plain text a pipe should receive.
 *
 * Code fences are the one thing it refuses to touch. A fenced block is the
 * owner's data — a diff, a JSON payload, a command to paste — and rewriting a
 * `*` inside one would corrupt it.
 */
import {
  bold,
  bright,
  dim,
  italic,
  padEnd,
  truncate,
  visibleWidth,
  type TerminalStyle,
} from './terminal.js';

/** A ``` fence line, with or without a language tag. */
const FENCE_RE = /^\s*```([A-Za-z0-9_+-]*)\s*$/;

/** `# Heading` — marker plus a space, at the start of a line. */
const HEADING_RE = /^(\s*)(#{1,6})[ \t]+(\S.*)$/;

/** `- item`, `* item`, `+ item` — normalized to one bullet character. */
const BULLET_RE = /^(\s*)[-*+][ \t]+(?=\S)/;

/** `1. item` — kept as a number, only the spacing is normalized. */
const ORDERED_RE = /^(\s*)(\d{1,3})[.)][ \t]+(?=\S)/;

/** `> quoted` */
const QUOTE_RE = /^(\s*)>[ \t]?(.*)$/;

/** `---`, `***`, `___` on a line of their own. */
const RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

const LINK_RE = /\[([^\]\n]*)\]\(([^()\s]*)\)/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const BOLD_STAR_RE = /\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g;
const BOLD_UNDER_RE = /(^|[^\w])__(?=\S)([^_\n]+?)(?<=\S)__(?!\w)/g;
const ITALIC_STAR_RE = /\*(?=\S)([^*\n]+?)(?<=\S)\*/g;
const ITALIC_UNDER_RE = /(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g;

/** The bullet every list marker becomes. */
export const BULLET = '•';

/** Minimum printable width a table column is ever squeezed to. */
const MIN_COLUMN = 4;

/**
 * Inline markers, honoured. The same conservative rules the Telegram net uses
 * — a marker must actually wrap a span — so `2 * 3` and `snake_case` survive.
 */
export function renderInline(line: string, color: boolean): string {
  return line
    .replace(LINK_RE, (_whole, label: string, url: string) => {
      const text = label.trim();
      if (url === '') return text;
      return text === '' ? dim(url, color) : `${text} ${dim(`(${url})`, color)}`;
    })
    .replace(INLINE_CODE_RE, (_whole, code: string) => bright(code, color))
    .replace(BOLD_STAR_RE, (_whole, inner: string) => bold(inner, color))
    .replace(BOLD_UNDER_RE, (_w, before: string, inner: string) => `${before}${bold(inner, color)}`)
    .replace(ITALIC_STAR_RE, (_whole, inner: string) => italic(inner, color))
    .replace(
      ITALIC_UNDER_RE,
      (_w, before: string, inner: string) => `${before}${italic(inner, color)}`,
    );
}

/** `| a | b |` → `['a', 'b']`, or nothing when this is not a table row. */
export function tableCells(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || trimmed.length < 2) return undefined;
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  if (!inner.includes('|') && inner.trim() === '') return undefined;
  return inner.split('|').map((cell) => cell.trim());
}

/** `|---|:--:|` carries no content: it is a rule, not a row. */
export function isTableSeparator(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * Column widths that fit `width`, shrinking the widest column first.
 *
 * A markdown table is usually two or three short columns and one long one; the
 * long one is what has to give. Every column keeps at least `MIN_COLUMN`, and
 * if even that does not fit the row is simply allowed to be wide — a squashed
 * table is less useful than one the owner can scroll.
 */
export function columnWidths(rows: readonly (readonly string[])[], width: number): number[] {
  const count = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const widths: number[] = [];
  for (let i = 0; i < count; i++) {
    widths[i] = rows.reduce((max, row) => Math.max(max, visibleWidth(row[i] ?? '')), 1);
  }
  const gaps = Math.max(0, count - 1) * 2;
  const floor = count * MIN_COLUMN + gaps;
  if (floor > width) return widths;

  let total = widths.reduce((sum, w) => sum + w, 0) + gaps;
  while (total > width) {
    let widest = 0;
    for (let i = 1; i < widths.length; i++) {
      if ((widths[i] as number) > (widths[widest] as number)) widest = i;
    }
    if ((widths[widest] as number) <= MIN_COLUMN) break;
    widths[widest] = (widths[widest] as number) - 1;
    total--;
  }
  return widths;
}

/** One aligned table: header in bold, a dim rule under it, then the rows. */
function renderTable(rows: readonly (readonly string[])[], style: TerminalStyle): string[] {
  const rendered = rows.map((row) => row.map((cell) => renderInline(cell, style.color)));
  const widths = columnWidths(rendered, style.width);
  const out: string[] = [];
  rendered.forEach((row, index) => {
    const cells = widths.map((w, i) => padEnd(truncate(row[i] ?? '', w), w));
    const line = cells.join('  ').replace(/\s+$/, '');
    out.push(index === 0 ? bold(line, style.color) : line);
    if (index === 0) {
      out.push(dim(widths.map((w) => '─'.repeat(w)).join('  '), style.color));
    }
  });
  return out;
}

/**
 * Render one agent answer for this terminal.
 *
 * Tool-name stripping is *not* done here: it is a separate rule with its own
 * helper (`stripToolNames`), applied by the caller before this, so the two
 * stay independently testable.
 */
export function renderMarkdown(text: string, style: TerminalStyle): string {
  if (text === '') return '';
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  let table: string[][] = [];

  const flushTable = (): void => {
    if (table.length === 0) return;
    out.push(...renderTable(table, style));
    table = [];
  };

  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      flushTable();
      // The fence itself is kept: it is how the owner sees where their data
      // starts and stops, and copying it back out should round-trip.
      out.push(dim(line, style.color));
      fence = fence === null ? (fenceMatch[1] ?? '') : null;
      continue;
    }
    if (fence !== null) {
      // Verbatim. Not one byte of a code block is rewritten.
      out.push(line);
      continue;
    }

    const cells = tableCells(line);
    if (cells) {
      if (!isTableSeparator(cells)) table.push(cells);
      continue;
    }
    flushTable();

    if (RULE_RE.test(line)) {
      out.push(dim('─'.repeat(Math.min(style.width, 40)), style.color));
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      out.push(`${heading[1]}${bright(renderInline(heading[3] as string, style.color), style.color)}`);
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      out.push(`${quote[1]}${dim(`│ ${renderInline(quote[2] as string, style.color)}`, style.color)}`);
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      const body = line.slice((bullet[0] as string).length);
      out.push(`${bullet[1]}${BULLET} ${renderInline(body, style.color)}`);
      continue;
    }

    const ordered = ORDERED_RE.exec(line);
    if (ordered) {
      const body = line.slice((ordered[0] as string).length);
      out.push(`${ordered[1]}${ordered[2]}. ${renderInline(body, style.color)}`);
      continue;
    }

    out.push(renderInline(line, style.color));
  }

  flushTable();
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
