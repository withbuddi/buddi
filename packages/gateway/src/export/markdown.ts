/**
 * Markdown as blocks and runs: the one reading of a document both the PDF and
 * the Word writers draw from, so the two downloads never disagree about what
 * the file says.
 *
 * Parsing is `marked`'s lexer only — nothing is rendered to HTML, nothing is
 * fetched. An image is its alt text and a raw HTML fragment is its text: the
 * export of a file in the owner's library must never reach the network.
 */
import { marked, type Token, type Tokens } from 'marked';

/** A stretch of text with one style. */
export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  /** Only http(s) and mailto links survive; anything else is plain text. */
  link?: string;
  /** A hard line break before this run. */
  breakBefore?: boolean;
}

export interface ListItem {
  runs: Run[];
  /** `true`/`false` for a task item, absent otherwise. */
  checked?: boolean;
  /** Paragraphs after the first, and nested lists. */
  children: Block[];
}

export type Block =
  | { type: 'heading'; depth: number; runs: Run[] }
  | { type: 'paragraph'; runs: Run[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'table'; align: ('left' | 'center' | 'right' | null)[]; header: Run[][]; rows: Run[][][] }
  | { type: 'code'; text: string }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'rule' };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  return /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : undefined;
}

type Style = Omit<Run, 'text' | 'breakBefore'>;

/** Inline tokens as runs, carrying the styles of the tokens around them. */
export function inlineRuns(tokens: readonly Token[] | undefined, style: Style = {}): Run[] {
  const out: Run[] = [];
  let pendingBreak = false;
  const push = (text: string, s: Style): void => {
    if (text === '') return;
    out.push({ text, ...s, ...(pendingBreak ? { breakBefore: true } : {}) });
    pendingBreak = false;
  };
  const pushAll = (runs: Run[]): void => {
    if (runs.length === 0) return;
    if (pendingBreak) runs[0] = { ...runs[0]!, breakBefore: true };
    pendingBreak = false;
    out.push(...runs);
  };
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong':
        pushAll(inlineRuns((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        pushAll(inlineRuns((token as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case 'del':
        pushAll(inlineRuns((token as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        push(decodeEntities((token as Tokens.Codespan).text), { ...style, code: true });
        break;
      case 'link': {
        const link = token as Tokens.Link;
        const href = safeHref(link.href);
        pushAll(inlineRuns(link.tokens, href ? { ...style, link: href } : style));
        break;
      }
      case 'image': {
        const image = token as Tokens.Image;
        push(image.text ? `[${decodeEntities(image.text)}]` : '[image]', style);
        break;
      }
      case 'br':
        pendingBreak = true;
        break;
      case 'checkbox':
        break;
      case 'text': {
        const text = token as Tokens.Text;
        if (text.tokens && text.tokens.length > 0) pushAll(inlineRuns(text.tokens, style));
        else push(decodeEntities(text.text).replace(/\n/g, ' '), style);
        break;
      }
      case 'html':
        push(decodeEntities((token as Tokens.HTML).text.replace(/<[^>]*>/g, '')), style);
        break;
      default:
        if ('text' in token && typeof token.text === 'string') push(decodeEntities(token.text), style);
    }
  }
  return out;
}

function listItem(item: Tokens.ListItem): ListItem {
  const runs: Run[] = [];
  const children: Block[] = [];
  for (const token of item.tokens) {
    if (token.type === 'checkbox') continue;
    if ((token.type === 'text' || token.type === 'paragraph') && runs.length === 0 && children.length === 0) {
      runs.push(...inlineRuns((token as Tokens.Text).tokens ?? [token]));
    } else {
      children.push(...toBlocks([token]));
    }
  }
  return { runs, children, ...(item.task ? { checked: Boolean(item.checked) } : {}) };
}

function toBlocks(tokens: readonly Token[]): Block[] {
  const blocks: Block[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const h = token as Tokens.Heading;
        blocks.push({ type: 'heading', depth: Math.min(Math.max(h.depth, 1), 6), runs: inlineRuns(h.tokens) });
        break;
      }
      case 'paragraph':
        blocks.push({ type: 'paragraph', runs: inlineRuns((token as Tokens.Paragraph).tokens) });
        break;
      case 'text': {
        const t = token as Tokens.Text;
        blocks.push({ type: 'paragraph', runs: t.tokens ? inlineRuns(t.tokens) : [{ text: decodeEntities(t.text) }] });
        break;
      }
      case 'list': {
        const l = token as Tokens.List;
        blocks.push({ type: 'list', ordered: l.ordered, start: typeof l.start === 'number' ? l.start : 1, items: l.items.map(listItem) });
        break;
      }
      case 'table': {
        const t = token as Tokens.Table;
        blocks.push({
          type: 'table',
          align: t.align.map((a) => a ?? null),
          header: t.header.map((cell) => inlineRuns(cell.tokens)),
          rows: t.rows.map((row) => row.map((cell) => inlineRuns(cell.tokens))),
        });
        break;
      }
      case 'code':
        blocks.push({ type: 'code', text: (token as Tokens.Code).text });
        break;
      case 'blockquote':
        blocks.push({ type: 'quote', blocks: toBlocks((token as Tokens.Blockquote).tokens) });
        break;
      case 'hr':
        blocks.push({ type: 'rule' });
        break;
      case 'html': {
        const text = decodeEntities((token as Tokens.HTML).text.replace(/<[^>]*>/g, '')).trim();
        if (text) blocks.push({ type: 'paragraph', runs: [{ text }] });
        break;
      }
      default:
        break; // space, def: nothing to draw
    }
  }
  return blocks;
}

/**
 * A document buddi will not convert: too deep, too many parts, or written so
 * that reading it would take the gateway minutes. The message says which.
 */
export class DocumentTooComplex extends Error {
  override name = 'DocumentTooComplex';
}

/** Limits on what a conversion reads, so a short file cannot cost minutes or gigabytes. */
export const MARKDOWN_LIMITS = {
  /** Nested lists and quotes, counted from indentation and `>` markers. */
  depth: 16,
  /** Leading indentation, in columns, outside a fenced code block. */
  indent: 64,
  /** `*` and `_` in one paragraph: marked's inline reader is quadratic in unmatched ones. */
  delimitersPerParagraph: 500,
  delimitersPerDocument: 20_000,
  /** Blocks, list items, table cells and runs, all told. */
  nodes: 50_000,
  /** Cells of all tables together. */
  tableCells: 20_000,
} as const;

/**
 * The cheap read before the real one: a line scan that refuses what would
 * make the lexer itself blow up (deep nesting, runs of emphasis markers).
 */
export function checkMarkdownShape(markdown: string, limits = MARKDOWN_LIMITS): void {
  let fence: string | null = null;
  let paragraph = 0;
  let total = 0;
  let lineNo = 0;
  for (const line of markdown.split('\n')) {
    lineNo++;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1]!.startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      paragraph = 0;
      continue;
    }
    if (line.trim() === '') {
      paragraph = 0;
      continue;
    }
    let indent = 0;
    let quotes = 0;
    for (const c of line) {
      if (c === ' ') indent++;
      else if (c === '\t') indent += 4 - (indent % 4);
      else if (c === '>') quotes++;
      else break;
    }
    if (indent > limits.indent) throw new DocumentTooComplex(`line ${lineNo} is indented ${indent} columns; buddi converts at most ${limits.indent}`);
    if (quotes > limits.depth) {
      throw new DocumentTooComplex(`line ${lineNo} is nested too deep to convert (at most ${limits.depth} levels)`);
    }
    // A list item or a heading is inline text of its own; a rule has no inline text.
    const rest = line.replace(/^[\s>]*/, '');
    if (/^([*_-])(\s*\1){2,}\s*$/.test(rest)) continue;
    const marker = /^([*+-]|\d{1,9}[.)])\s+|^#{1,6}\s/.exec(rest);
    if (marker) paragraph = 0;
    let delimiters = 0;
    for (let i = (line.length - rest.length) + (marker ? marker[0].length : 0); i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c === 42 || c === 95) delimiters++; // * _
    }
    paragraph += delimiters;
    total += delimiters;
    if (paragraph > limits.delimitersPerParagraph) {
      throw new DocumentTooComplex(`the paragraph at line ${lineNo} has more than ${limits.delimitersPerParagraph} * and _ marks; too many to convert`);
    }
    if (total > limits.delimitersPerDocument) {
      throw new DocumentTooComplex(`the document has more than ${limits.delimitersPerDocument} * and _ marks; too many to convert`);
    }
  }
}

/** The read blocks, counted: refuses a document with more parts than a conversion should draw. */
export function checkBlocks(blocks: readonly Block[], limits = MARKDOWN_LIMITS): void {
  let nodes = 0;
  let cells = 0;
  const visit = (list: readonly Block[], depth: number): void => {
    if (depth > limits.depth) throw new DocumentTooComplex(`the document nests deeper than ${limits.depth} levels`);
    for (const block of list) {
      nodes++;
      switch (block.type) {
        case 'heading':
        case 'paragraph':
          nodes += block.runs.length;
          break;
        case 'list':
          for (const item of block.items) {
            nodes += 1 + item.runs.length;
            if (nodes > limits.nodes) break;
            visit(item.children, depth + 1);
          }
          break;
        case 'table': {
          const tableCells = block.header.length * (block.rows.length + 1);
          cells += tableCells;
          nodes += tableCells;
          if (cells > limits.tableCells) throw new DocumentTooComplex(`the tables have more than ${limits.tableCells} cells; too many to convert`);
          break;
        }
        case 'quote':
          visit(block.blocks, depth + 1);
          break;
        default:
          break;
      }
      if (nodes > limits.nodes) throw new DocumentTooComplex(`the document has more than ${limits.nodes} parts; too many to convert`);
    }
  };
  visit(blocks, 0);
}

/** A Markdown document as blocks, refused first if it is too deep or too large to convert. */
export function parseMarkdown(markdown: string): Block[] {
  const text = markdown.replace(/\r\n?/g, '\n');
  checkMarkdownShape(text);
  const blocks = toBlocks(marked.lexer(text, { gfm: true }));
  checkBlocks(blocks);
  return blocks;
}

/** The plain text of some runs, for a title or an alt. */
export function plain(runs: readonly Run[]): string {
  return runs.map((r) => r.text).join('');
}
