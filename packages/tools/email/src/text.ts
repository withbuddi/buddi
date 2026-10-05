/**
 * The words of a message, as agents, search, the list's previews and the
 * reading pane's text fallback read them (`messages.body_text`, `snippet`).
 *
 * An HTML-only message is turned into text here at sync. It used to be a few
 * regular expressions that decoded five entities, so a newsletter arrived as
 * `&#8202;&zwnj;&#8202;…` padding and `Q&#38;A`. Now it is parsed by `parse5`
 * (the HTML standard's own algorithm, the same parser `html.ts` sanitises
 * with), which decodes every entity, and only text nodes are kept:
 *
 *  - skipped with their content: scripts, styles, the head, templates, and
 *    elements hidden inline (`display:none`, `hidden`);
 *  - block elements and `<br>` become line breaks, table cells a space;
 *  - the invisible characters newsletters pad their preview line with —
 *    zero-width spaces and joiners, word joiners, byte-order marks, soft
 *    hyphens, the combining grapheme joiner, hair and thin spaces — are
 *    dropped, a no-break space is a space, runs of spaces collapse, and no
 *    more than one blank line is kept in a row.
 *
 * `cleanText` is the same clean-up for text that was stored before this
 * existed and has no HTML left to re-read (`text-cleanup.ts`).
 */
import { parse, parseFragment } from 'parse5';

interface P5Node {
  nodeName: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: P5Node[];
  content?: P5Node;
}

/** Elements whose content is never words a reader sees. */
const SKIP = new Set(['script', 'style', 'head', 'template', 'title', 'noscript', 'svg', 'math', 'iframe', 'object']);

/** Elements that start and end a line. */
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure',
  'footer', 'form', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'pre', 'section', 'table', 'tbody', 'thead',
  'tfoot', 'tr', 'ul', 'caption',
]);

/** Elements that stand apart by a blank line. */
const PARAGRAPH = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Invisible characters used as preview-line padding: zero-width space, non-
 * joiner and joiner, word joiner, byte-order mark, soft hyphen, combining
 * grapheme joiner, hair space and thin space.
 */
export const INVISIBLE = /[​-‍⁠﻿­͏  ]/g;

/**
 * What a stored text that still needs cleaning looks like, as Postgres
 * patterns (`text-cleanup.ts`): an entity (case-insensitive), or padding.
 */
export const ENTITY_PATTERN = '&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);';
export const PADDING_PATTERN = '[\u200B-\u200D\u2060\uFEFF\u200A\u2009]';

function hidden(node: P5Node): boolean {
  for (const { name, value } of node.attrs ?? []) {
    if (name === 'hidden') return true;
    if (name === 'style' && /display\s*:\s*none/i.test(value)) return true;
  }
  return false;
}

/** Spaces tidied, invisible padding gone, at most one blank line in a row. */
function tidy(text: string): string {
  return text
    .replace(INVISIBLE, '')
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The readable text of an HTML body. */
export function htmlToText(html: string): string {
  if (html.trim() === '') return '';
  let root: P5Node;
  try {
    root = parse(html) as unknown as P5Node;
  } catch {
    return tidy(html.replace(/<[^>]*>/g, ' '));
  }
  const out: string[] = [];
  const walk = (node: P5Node, pre: boolean): void => {
    if (node.nodeName === '#text') {
      const value = node.value ?? '';
      out.push(pre ? value : value.replace(/[ \t\n\r\f]+/g, ' '));
      return;
    }
    if (node.nodeName.startsWith('#') && node.nodeName !== '#document' && node.nodeName !== '#document-fragment') return;
    const tag = node.nodeName;
    if (SKIP.has(tag) || hidden(node)) return;
    if (tag === 'br') {
      out.push('\n');
      return;
    }
    const block = BLOCK.has(tag);
    const paragraph = PARAGRAPH.has(tag);
    if (paragraph) out.push('\n\n');
    else if (block) out.push('\n');
    else if (tag === 'td' || tag === 'th') out.push(' ');
    for (const child of node.childNodes ?? []) walk(child, pre || tag === 'pre');
    if (paragraph) out.push('\n\n');
    else if (block) out.push('\n');
    else if (tag === 'td' || tag === 'th') out.push(' ');
  };
  walk(root, false);
  return tidy(out.join(''));
}

const decoded = new Map<string, string>();

/** One `&…;` as HTML reads it in text, or itself when it names nothing. */
function decodeEntity(entity: string): string {
  const known = decoded.get(entity);
  if (known !== undefined) return known;
  let value = entity;
  try {
    const fragment = parseFragment(entity) as unknown as P5Node;
    const text = (fragment.childNodes ?? []).map((n) => n.value ?? '').join('');
    // A whole entity consumes its semicolon; `&notathing;` decodes only its
    // `&not` prefix, which is not what was written, so it is left alone.
    if (text !== '' && !text.endsWith(';')) value = text;
  } catch {
    // Left as written.
  }
  if (decoded.size < 2_000) decoded.set(entity, value);
  return value;
}

/**
 * Stored text, decoded and tidied: every `&name;`, `&#n;` and `&#xh;` an HTML
 * reader would decode (only with its semicolon, so `?a=1&copy=2` is left
 * alone), the padding dropped and the spaces collapsed.
 */
export function cleanText(text: string): string {
  return tidy(text.replace(/&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, decodeEntity));
}
