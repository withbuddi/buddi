/**
 * An HTML body, sanitised at the door (docs/email.md, "Reading mail").
 *
 * The sync already downloads a message's text part; when the message has an
 * HTML part it downloads that too (capped like the text), and this is what is
 * kept of it: the body re-written from an allow-list, so the stored string can
 * hold nothing that runs, posts, frames or styles the page.
 *
 *  - Parsed by `parse5` — the HTML standard's own parsing algorithm, so the
 *    tree here is the tree a browser would build, mis-nested tags and all —
 *    and serialised again from scratch: nothing of the original markup is
 *    copied through, only tags and attributes this file names, with every
 *    text and attribute value escaped on the way out.
 *  - Dropped with their content: scripts, styles, forms and their controls,
 *    frames, objects, media, SVG and MathML. An unknown tag is unwrapped.
 *  - Kept attributes: a link's `href` when http(s) or mailto, an image's
 *    `src` when http(s), `cid:` or a small inline picture, cell spans,
 *    presentation attributes (`align`, `bgcolor`, `width`…), `class` only for
 *    the marks of a quoted reply (`gmail_quote`…), and a safe subset of
 *    `style` with every `url(…)`, `expression` and escape refused.
 *  - Remote pictures are kept as addresses and never fetched: not here, and
 *    not by the dashboard until the owner says so for that sender.
 *
 * The dashboard sanitises again before drawing (packages/web, `sanitize.ts`):
 * this copy is what is stored, that one is what is trusted.
 */
import { parse } from 'parse5';

/** The most of a downloaded HTML part that is parsed at all. */
export const MAX_HTML_INPUT_BYTES = 512 * 1024;
/** The most that is stored; a body over it is not stored as HTML, and the text is read instead. */
export const MAX_STORED_HTML_BYTES = 256 * 1024;
/** Elements past this many are not kept. */
export const MAX_HTML_NODES = 5_000;
/** Deeper than this, an element keeps only its text. */
export const MAX_HTML_DEPTH = 32;
/** An inline `data:` picture longer than this is dropped. */
const MAX_DATA_IMAGE_CHARS = 256 * 1024;

const DROP = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button',
  'select', 'option', 'textarea', 'noscript', 'template', 'svg', 'math', 'head', 'title', 'meta', 'link',
  'base', 'audio', 'video', 'source', 'track', 'canvas', 'map', 'area', 'dialog', 'portal', 'slot', 'xml',
]);

const KEEP = new Set([
  'p', 'div', 'span', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small',
  'big', 'sub', 'sup', 'code', 'pre', 'kbd', 'tt', 'samp', 'q', 'cite', 'abbr', 'blockquote', 'center', 'font',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'wbr', 'address', 'section', 'article', 'header', 'footer',
  'main', 'aside', 'figure', 'figcaption', 'a', 'img',
]);

const VOID = new Set(['br', 'hr', 'wbr', 'col', 'img']);

/** Attributes kept on any kept tag (values checked below). */
const GLOBAL_ATTRS = new Set(['style', 'title', 'dir', 'align', 'valign', 'bgcolor', 'width', 'height', 'class']);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href']),
  img: new Set(['src', 'alt']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
  table: new Set(['cellpadding', 'cellspacing', 'border']),
  font: new Set(['color', 'face']),
  ol: new Set(['start', 'type']),
  blockquote: new Set(['type']),
};

const STYLE_ALLOWED = new Set([
  'color', 'background-color', 'font-weight', 'font-style', 'font-size', 'font-family', 'font-variant',
  'text-decoration', 'text-decoration-line', 'text-align', 'text-transform', 'text-indent', 'vertical-align',
  'line-height', 'letter-spacing', 'word-spacing', 'white-space', 'word-break', 'overflow-wrap',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-style',
  'border-width', 'border-radius', 'border-collapse', 'border-spacing',
  'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height',
  'display', 'list-style-type', 'table-layout', 'float', 'clear', 'visibility',
]);
const STYLE_REFUSED = /url\s*\(|expression|javascript:|vbscript:|@import|\\|behavior|binding|attr\s*\(|var\s*\(|[<>]/i;

/** The marks of a quoted earlier message, the only classes kept. */
const QUOTE_CLASSES = new Set(['gmail_quote', 'gmail_attr', 'yahoo_quoted', 'protonmail_quote', 'moz-cite-prefix']);

const SAFE_DATA_IMAGE = /^data:image\/(png|gif|jpeg|jpg|webp);base64,[a-z0-9+/=\s]+$/i;

interface P5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: P5Node[];
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

/** The safe part of a `style` attribute, or '' when nothing survives. */
export function cleanStyle(raw: string): string {
  const kept: string[] = [];
  for (const declaration of raw.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!STYLE_ALLOWED.has(name) || value === '' || value.length > 200 || STYLE_REFUSED.test(value)) continue;
    kept.push(`${name}: ${value}`);
  }
  return kept.join('; ');
}

/** A link worth keeping: http(s) or mailto. */
function cleanHref(raw: string): string | null {
  const value = raw.trim();
  if (/^https?:\/\/[^\s<>"]+$/i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
    } catch {
      return null;
    }
  }
  return /^mailto:[^\s<>"]+$/i.test(value) ? value : null;
}

/** An image source worth keeping: http(s), cid:, or a small inline picture. */
function cleanSrc(raw: string): string | null {
  const value = raw.trim();
  if (/^https?:\/\/[^\s<>"]+$/i.test(value)) return cleanHref(value);
  if (/^cid:[^\s<>"]{1,200}$/i.test(value)) return value;
  if (SAFE_DATA_IMAGE.test(value) && value.length <= MAX_DATA_IMAGE_CHARS) return value.replace(/\s+/g, '');
  return null;
}

function cleanAttr(tag: string, name: string, value: string): string | null {
  switch (name) {
    case 'style': {
      const style = cleanStyle(value);
      return style === '' ? null : style;
    }
    case 'href':
      return cleanHref(value);
    case 'src':
      return cleanSrc(value);
    case 'class': {
      const marks = value.split(/\s+/).filter((c) => QUOTE_CLASSES.has(c));
      return marks.length > 0 ? marks.join(' ') : null;
    }
    case 'type':
      return tag === 'blockquote' ? (value.toLowerCase() === 'cite' ? 'cite' : null) : /^[1aAiI]$/.test(value) ? value : null;
    case 'width':
    case 'height':
    case 'border':
    case 'cellpadding':
    case 'cellspacing':
      return /^\d{1,4}%?$/.test(value.trim()) ? value.trim() : null;
    case 'colspan':
    case 'rowspan':
    case 'start':
      return /^\d{1,3}$/.test(value.trim()) ? value.trim() : null;
    case 'align':
    case 'valign':
      return /^(left|right|center|justify|top|middle|bottom|baseline)$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
    case 'bgcolor':
    case 'color':
      return /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(value.trim()) ? value.trim() : null;
    case 'dir':
      return /^(ltr|rtl|auto)$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
    case 'face':
      return /^[\w\s,'"-]{1,80}$/.test(value) ? value : null;
    case 'title':
    case 'alt':
      return value.slice(0, 200);
    default:
      return null;
  }
}

function findBody(node: P5Node): P5Node | null {
  if (node.nodeName === 'body') return node;
  for (const child of node.childNodes ?? []) {
    const found = findBody(child);
    if (found) return found;
  }
  return null;
}

function textOf(node: P5Node): string {
  if (node.nodeName === '#text') return node.value ?? '';
  if (DROP.has(node.nodeName)) return '';
  return (node.childNodes ?? []).map(textOf).join('');
}

/**
 * The stored form of an HTML body, or null when there is nothing worth
 * keeping or it is over the cap (the text is then what is read).
 */
export function sanitizeEmailHtml(html: string | null | undefined): string | null {
  if (typeof html !== 'string' || html.trim() === '') return null;
  const input = Buffer.byteLength(html, 'utf8') > MAX_HTML_INPUT_BYTES ? html.slice(0, MAX_HTML_INPUT_BYTES) : html;
  let body: P5Node | null;
  try {
    body = findBody(parse(input) as unknown as P5Node);
  } catch {
    return null;
  }
  if (!body) return null;
  let nodes = 0;
  const out: string[] = [];
  const walk = (node: P5Node, depth: number): void => {
    if (node.nodeName === '#text') {
      out.push(escapeText(node.value ?? ''));
      return;
    }
    if (node.nodeName.startsWith('#')) return; // comments, doctypes
    const tag = node.nodeName;
    if (DROP.has(tag)) return;
    if (nodes >= MAX_HTML_NODES) return;
    if (depth > MAX_HTML_DEPTH) {
      out.push(escapeText(textOf(node)));
      return;
    }
    nodes += 1;
    if (!KEEP.has(tag)) {
      for (const child of node.childNodes ?? []) walk(child, depth + 1);
      return;
    }
    const attrs: string[] = [];
    const allowed = TAG_ATTRS[tag];
    let src: string | null = null;
    for (const { name, value } of node.attrs ?? []) {
      const key = name.toLowerCase();
      if (key === 'id' && value === 'divRplyFwdMsg') {
        // Outlook's reply header: everything from here down is the earlier message.
        attrs.push('class="reply-head"');
        continue;
      }
      if (!GLOBAL_ATTRS.has(key) && !(allowed?.has(key) ?? false)) continue;
      const clean = cleanAttr(tag, key, value);
      if (clean === null) continue;
      if (key === 'src') src = clean;
      attrs.push(`${key}="${escapeAttr(clean)}"`);
    }
    if (tag === 'img' && src === null) {
      // An image with nowhere safe to come from is its words, if it has any.
      const alt = (node.attrs ?? []).find((a) => a.name === 'alt')?.value ?? '';
      if (alt !== '') out.push(escapeText(alt.slice(0, 200)));
      return;
    }
    if (tag === 'a' && !attrs.some((a) => a.startsWith('href='))) {
      for (const child of node.childNodes ?? []) walk(child, depth + 1);
      return;
    }
    out.push(`<${tag}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>`);
    if (VOID.has(tag)) return;
    for (const child of node.childNodes ?? []) walk(child, depth + 1);
    out.push(`</${tag}>`);
  };
  for (const child of body.childNodes ?? []) walk(child, 0);
  const result = out.join('').trim();
  if (result === '' || Buffer.byteLength(result, 'utf8') > MAX_STORED_HTML_BYTES) return null;
  // A body that is only whitespace and empty wrappers says nothing the text does not.
  if (!/[^\s]/.test(result.replace(/<[^>]*>/g, '')) && !/<img\s/i.test(result)) return null;
  return result;
}
