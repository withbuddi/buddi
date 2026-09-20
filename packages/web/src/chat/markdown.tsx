/**
 * Markdown, as models write it, drawn as elements.
 *
 * No HTML is ever produced from the text: every construct becomes a React
 * element with its text as a child, so nothing a model (or a page it read)
 * writes can put markup on this screen. Links are kept only for http(s) and
 * open in a new tab; raw HTML tags are shown as the characters they are.
 *
 * Covered: paragraphs, headings, bold, italic, strikethrough, inline code,
 * fenced and indented code, bullet and numbered lists (nested by indent),
 * block quotes, tables, horizontal rules, links. That is what an answer needs.
 * Anything else stays readable as text, which is the point.
 */
import { Fragment, type ReactNode } from 'react';

type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; level: number; text: string }
  | { type: 'code'; lang: string | null; text: string }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'table'; head: string[]; rows: string[][]; align: Array<'left' | 'right' | 'center' | null> }
  | { type: 'hr' };

export function Markdown({ text, className }: { text: string; className?: string }): JSX.Element {
  const blocks = parseBlocks(text.replace(/\r\n/g, '\n').split('\n'));
  return <div className={className ?? 'wb-md'}>{blocks.map((block, i) => <BlockView key={i} block={block} />)}</div>;
}

/* ------------------------------------------------------------------ *
 * blocks
 * ------------------------------------------------------------------ */

const FENCE = /^(\s*)(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBER = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') { i += 1; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i]!)) { body.push(lines[i]!); i += 1; }
      i += 1;
      out.push({ type: 'code', lang: fence[3] || null, text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) { out.push({ type: 'h', level: heading[1]!.length, text: heading[2]! }); i += 1; continue; }

    if (HR.test(line)) { out.push({ type: 'hr' }); i += 1; continue; }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) { inner.push(QUOTE.exec(lines[i]!)![1]!); i += 1; }
      out.push({ type: 'quote', blocks: parseBlocks(inner) });
      continue;
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((c) => {
        const l = c.startsWith(':'); const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) { rows.push(cells(lines[i]!)); i += 1; }
      out.push({ type: 'table', head, rows, align });
      continue;
    }

    if (BULLET.test(line) || NUMBER.test(line)) {
      const first = (NUMBER.exec(line) ?? BULLET.exec(line))!;
      const ordered = NUMBER.test(line);
      const indent = first[1]!.length;
      const start = ordered ? Number(first[2]) : 1;
      const items: Block[][] = [];
      while (i < lines.length) {
        const m = ordered ? NUMBER.exec(lines[i]!) : BULLET.exec(lines[i]!);
        if (!m || m[1]!.length !== indent) break;
        const itemLines = [m[3]!];
        i += 1;
        // Continuation: deeper-indented lines, or blank lines followed by one.
        while (i < lines.length) {
          const next = lines[i]!;
          const deeper = next.trim() !== '' && leading(next) > indent;
          const blankThenDeeper = next.trim() === '' && i + 1 < lines.length && lines[i + 1]!.trim() !== '' && leading(lines[i + 1]!) > indent;
          if (!deeper && !blankThenDeeper) break;
          itemLines.push(next.trim() === '' ? '' : next.slice(Math.min(leading(next), indent + 2)));
          i += 1;
        }
        items.push(parseBlocks(itemLines));
      }
      out.push({ type: 'list', ordered, start, items });
      continue;
    }

    // A paragraph runs until a blank line or the start of any other block.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.trim() === '' || FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || BULLET.test(l) || NUMBER.test(l)) break;
      if (TABLE_ROW.test(l) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) break;
      para.push(l.trim());
      i += 1;
    }
    if (para.length > 0) out.push({ type: 'p', text: para.join('\n') });
  }
  return out;
}

function leading(line: string): number { return line.length - line.trimStart().length; }

function cells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (ch === '\\' && trimmed[i + 1] === '|') { current += '|'; i += 1; continue; }
    if (ch === '|') { out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  out.push(current.trim());
  return out;
}

function BlockView({ block }: { block: Block }): JSX.Element {
  switch (block.type) {
    case 'p': return <p>{inline(block.text)}</p>;
    case 'h': {
      const level = Math.min(6, Math.max(1, block.level));
      const Tag = `h${Math.min(level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6';
      return <Tag className="wb-md-h" data-level={level}>{inline(block.text)}</Tag>;
    }
    case 'code': return <pre className="wb-md-code" data-lang={block.lang ?? undefined}><code>{block.text}</code></pre>;
    case 'quote': return <blockquote>{block.blocks.map((b, i) => <BlockView key={i} block={b} />)}</blockquote>;
    case 'hr': return <hr />;
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i}>{item.map((b, j) => b.type === 'p' ? <Fragment key={j}>{inline(b.text)}</Fragment> : <BlockView key={j} block={b} />)}</li>
      ));
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'table': return (
      <div className="ui-table-wrap"><table className="ui-table wb-md-table">
        <thead><tr>{block.head.map((h, i) => <th key={i} style={block.align[i] ? { textAlign: block.align[i]! } : undefined}>{inline(h)}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((c, i) => <td key={i} style={block.align[i] ? { textAlign: block.align[i]! } : undefined}>{inline(c)}</td>)}</tr>)}</tbody>
      </table></div>
    );
  }
}

/* ------------------------------------------------------------------ *
 * inline
 * ------------------------------------------------------------------ */

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|(?<![\w*])\*([^*\n]+?)\*(?![\w*])|(?<![\w_])_([^_\n]+?)_(?![\w_])|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|<?(https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?'"])>?/;

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest !== '') {
    const m = INLINE.exec(rest);
    if (!m) { out.push(...withBreaks(rest, key)); break; }
    if (m.index > 0) out.push(...withBreaks(rest.slice(0, m.index), key));
    key += 100;
    if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
    else if (m[3] !== undefined) out.push(<strong key={key}>{inline(m[3])}</strong>);
    else if (m[4] !== undefined) out.push(<strong key={key}>{inline(m[4])}</strong>);
    else if (m[5] !== undefined) out.push(<s key={key}>{inline(m[5])}</s>);
    else if (m[6] !== undefined) out.push(<em key={key}>{inline(m[6])}</em>);
    else if (m[7] !== undefined) out.push(<em key={key}>{inline(m[7])}</em>);
    else if (m[8] !== undefined && m[9] !== undefined) out.push(<a key={key} href={m[9]} target="_blank" rel="noopener noreferrer">{inline(m[8])}</a>);
    else if (m[10] !== undefined) out.push(<a key={key} href={m[10]} target="_blank" rel="noopener noreferrer">{m[10]}</a>);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** Newlines inside a paragraph stay line breaks: a model's list-like prose keeps its shape. */
function withBreaks(text: string, key: number): ReactNode[] {
  const parts = text.split('\n');
  return parts.flatMap((part, i) => i === 0 ? [part] : [<br key={`${key}-br-${i}`} />, part]);
}
