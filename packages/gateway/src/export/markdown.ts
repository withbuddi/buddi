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

/** A Markdown document as blocks. */
export function parseMarkdown(markdown: string): Block[] {
  return toBlocks(marked.lexer(markdown.replace(/\r\n?/g, '\n'), { gfm: true }));
}

/** The plain text of some runs, for a title or an alt. */
export function plain(runs: readonly Run[]): string {
  return runs.map((r) => r.text).join('');
}
