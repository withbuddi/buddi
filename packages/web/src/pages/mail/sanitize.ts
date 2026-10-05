/**
 * An email body, made safe to draw (host API 1.30, the `message` component).
 *
 * The plugin already stores a sanitised copy, and this is the second door: the
 * dashboard never trusts the HTML it is handed. The string is parsed by the
 * browser's own `DOMParser` — an inert document, in which nothing runs and no
 * image is fetched — and walked into a small tree of plain objects that only
 * the allow-list below can produce. React draws that tree; no HTML string is
 * ever handed to the DOM, so there is no `innerHTML` anywhere on this path.
 *
 * What survives:
 *
 *  - **Tags** from a reading set (paragraphs, lists, tables, emphasis, links,
 *    images). Scripts, styles, forms, frames, media and anything active are
 *    dropped *with* their content; an unknown tag is unwrapped, its text kept.
 *  - **Attributes**: a link's `href` when it is http(s) or mailto, an image's
 *    `src` when it is http(s), `cid:` or a small inline picture, a cell's
 *    spans, and a safe subset of inline `style` (colours, type, spacing,
 *    borders, alignment) with every `url(…)`, `expression` and escape refused.
 *    Legacy presentation attributes (`bgcolor`, `align`, `width`) become the
 *    equivalent style.
 *  - **Images** are sorted, never fetched here: a remote one is drawn only
 *    once the owner has said so for that sender, a `cid:` one only from a file
 *    already in his library, and a tracking pixel (1×1, or hidden) never.
 *  - **Quoted earlier messages** — Gmail's `gmail_quote`, a `blockquote
 *    type=cite`, Outlook's reply header — become `quote` nodes, which the
 *    page draws folded.
 *
 * Caps keep a hostile or merely enormous message from costing the page:
 * input over `MAX_HTML_CHARS` is not parsed at all (the text is drawn), the
 * tree stops at `MAX_NODES`, and anything nested deeper than `MAX_DEPTH` is
 * kept as its text alone.
 */

/** Input longer than this is not parsed: the plain text is drawn instead. */
export const MAX_HTML_CHARS = 600_000;
/** Elements past this many are not drawn; the body says it was cut. */
export const MAX_NODES = 5_000;
/** Deeper than this, an element keeps only its text. */
export const MAX_DEPTH = 32;
/** An inline `data:` picture longer than this is dropped. */
export const MAX_DATA_IMAGE_CHARS = 256 * 1024;

export type SafeStyle = Record<string, string>;

export type SafeNode =
  | { t: 'text'; v: string }
  | { t: 'el'; tag: string; style?: SafeStyle; attrs?: Record<string, string | number>; kids: SafeNode[] }
  | { t: 'link'; href: string; outside: boolean; style?: SafeStyle; kids: SafeNode[] }
  | { t: 'img'; kind: 'remote' | 'cid' | 'data'; src: string; alt: string; style?: SafeStyle }
  | { t: 'quote'; kids: SafeNode[] };

export interface SafeBody {
  nodes: SafeNode[];
  /** Remote pictures held back (tracking pixels not counted: they are never drawn). */
  remoteImages: number;
  /** Tracking pixels dropped. */
  pixels: number;
  /** The tree was cut at a cap. */
  truncated: boolean;
}

/** Dropped with everything inside them. */
const DROP = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button',
  'select', 'option', 'textarea', 'noscript', 'template', 'svg', 'math', 'head', 'title', 'meta', 'link',
  'base', 'audio', 'video', 'source', 'track', 'canvas', 'map', 'area', 'dialog', 'portal', 'slot', 'xml',
]);

/** Drawn as themselves. */
const KEEP = new Set([
  'p', 'div', 'span', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small',
  'big', 'sub', 'sup', 'code', 'pre', 'kbd', 'tt', 'samp', 'q', 'cite', 'abbr', 'blockquote', 'center', 'font',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'wbr', 'address', 'section', 'article', 'header', 'footer',
  'main', 'aside', 'figure', 'figcaption', 'a', 'img',
]);

/** The React element each kept tag is drawn as (old tags become what they meant). */
const AS: Record<string, string> = { center: 'div', font: 'span', big: 'span', tt: 'code', strike: 's', section: 'div', article: 'div', header: 'div', footer: 'div', main: 'div', aside: 'div', address: 'div' };

/** Void elements: no children. */
const VOID = new Set(['br', 'hr', 'wbr', 'col', 'img']);

/** Inline style properties that survive, by their CSS name. */
const STYLE_ALLOWED = new Set([
  'color', 'background-color', 'font-weight', 'font-style', 'font-size', 'font-family', 'font-variant',
  'text-decoration', 'text-decoration-line', 'text-align', 'text-transform', 'text-indent', 'vertical-align',
  'line-height', 'letter-spacing', 'word-spacing', 'white-space', 'word-break', 'overflow-wrap',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-style',
  'border-width', 'border-radius', 'border-collapse', 'border-spacing',
  'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height',
  'display', 'list-style-type', 'table-layout', 'float', 'clear',
]);

/** `display` values that keep the reading flow (no `fixed`-like tricks hide in here). */
const DISPLAY_ALLOWED = new Set(['block', 'inline', 'inline-block', 'none', 'table', 'table-row', 'table-cell', 'list-item', 'flex']);

/** What may never appear in a style value, whatever the property. */
const STYLE_REFUSED = /url\s*\(|expression|javascript:|vbscript:|@import|\\|behavior|binding|attr\s*\(|var\s*\(/i;

/** Classes that mark a quoted earlier message. */
const QUOTE_CLASSES = ['gmail_quote', 'yahoo_quoted', 'protonmail_quote', 'moz-cite-prefix', 'reply-head'];

const SAFE_DATA_IMAGE = /^data:image\/(png|gif|jpeg|jpg|webp);base64,[a-z0-9+/=\s]+$/i;

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** A length in a presentation attribute (`width="600"`), as CSS. */
function lengthOf(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (/^\d{1,4}$/.test(value)) return `${value}px`;
  if (/^\d{1,3}%$/.test(value)) return value;
  return null;
}

/** A colour in a presentation attribute (`bgcolor="#fff"`). */
function colourOf(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  return /^#[0-9a-f]{3,8}$/i.test(value) || /^[a-z]{3,20}$/i.test(value) ? value : null;
}

/** The safe subset of one element's inline style, as React wants it. */
function styleOf(el: Element): SafeStyle {
  const out: SafeStyle = {};
  const style = (el as HTMLElement).style;
  if (!style) return out;
  for (let i = 0; i < style.length; i += 1) {
    const name = style.item(i).toLowerCase();
    if (!STYLE_ALLOWED.has(name)) continue;
    const value = style.getPropertyValue(name).trim();
    if (value === '' || value.length > 200 || STYLE_REFUSED.test(value)) continue;
    if (name === 'display' && !DISPLAY_ALLOWED.has(value.toLowerCase())) continue;
    out[camel(name)] = value;
  }
  return out;
}

/** Whether an image is a tracking pixel: tiny, or hidden. */
function isPixel(el: Element, style: SafeStyle): boolean {
  const tiny = (raw: string | null | undefined): boolean => {
    if (raw === null || raw === undefined) return false;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n <= 2 && !/%/.test(raw);
  };
  return (
    tiny(el.getAttribute('width')) ||
    tiny(el.getAttribute('height')) ||
    tiny(style.width) ||
    tiny(style.height) ||
    (style.display ?? '').toLowerCase() === 'none' ||
    /visibility\s*:\s*hidden/i.test(el.getAttribute('style') ?? '')
  );
}

/** A link target worth following: http(s) to a new tab, mailto in place. */
export function safeHref(raw: string | null): { href: string; outside: boolean } | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') return { href: url.toString(), outside: true };
    } catch {
      return null;
    }
  }
  if (/^mailto:[^\s<>"]+$/i.test(value)) return { href: value, outside: false };
  return null;
}

/** The marks of a quoted earlier message on one element. */
function isQuote(el: Element, tag: string): boolean {
  if (tag === 'blockquote' && (el.getAttribute('type') ?? '').toLowerCase() === 'cite') return true;
  const classes = (el.getAttribute('class') ?? '').split(/\s+/);
  if (QUOTE_CLASSES.some((name) => classes.includes(name))) return true;
  return (el.getAttribute('id') ?? '') === 'divRplyFwdMsg';
}

/** Whether this quote mark takes everything after it too (Outlook's reply header). */
function takesTheRest(el: Element): boolean {
  const classes = (el.getAttribute('class') ?? '').split(/\s+/);
  return classes.includes('reply-head') || (el.getAttribute('id') ?? '') === 'divRplyFwdMsg';
}

/**
 * Parse and walk. Never throws: a body the parser cannot read comes back
 * empty, and the page draws the text.
 */
export function sanitizeHtml(html: string): SafeBody | null {
  if (typeof html !== 'string' || html.trim() === '' || html.length > MAX_HTML_CHARS) return null;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }
  const state = { nodes: 0, remoteImages: 0, pixels: 0, truncated: false };

  const textOf = (node: Node): SafeNode[] => {
    const text = node.textContent ?? '';
    return text.trim() === '' ? [] : [{ t: 'text', v: text }];
  };

  /** `quoteRoot`: the parent is a fold already, so a quote mark right inside it is not a second one. */
  const walkChildren = (parent: Node, depth: number, quoteRoot = false): SafeNode[] => {
    const out: SafeNode[] = [];
    const children = Array.from(parent.childNodes);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (child.nodeType === 1 && isQuote(child as Element, (child as Element).tagName.toLowerCase()) && takesTheRest(child as Element)) {
        // Outlook: the reply header and every sibling after it are the earlier message.
        const rest = children.slice(index);
        const kids = rest.flatMap((node) => walk(node, depth + 1, true));
        if (kids.length > 0) out.push({ t: 'quote', kids });
        break;
      }
      out.push(...walk(child, depth, quoteRoot));
    }
    return out;
  };

  const walk = (node: Node, depth: number, insideRest: boolean): SafeNode[] => {
    if (node.nodeType === 3) {
      const v = node.nodeValue ?? '';
      return v === '' ? [] : [{ t: 'text', v }];
    }
    if (node.nodeType !== 1) return [];
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) return [];
    if (state.nodes >= MAX_NODES) {
      state.truncated = true;
      return [];
    }
    if (depth > MAX_DEPTH) {
      state.truncated = true;
      return textOf(el);
    }
    state.nodes += 1;
    if (!insideRest && isQuote(el, tag) && !takesTheRest(el)) {
      const kids = walkChildren(el, depth + 1, true);
      return kids.length > 0 ? [{ t: 'quote', kids }] : [];
    }
    if (!KEEP.has(tag)) return walkChildren(el, depth + 1);

    const style = styleOf(el);
    const bg = colourOf(el.getAttribute('bgcolor'));
    if (bg && !style.backgroundColor) style.backgroundColor = bg;
    if (tag === 'font') {
      const colour = colourOf(el.getAttribute('color'));
      if (colour && !style.color) style.color = colour;
      const face = el.getAttribute('face');
      if (face && /^[\w\s,'"-]{1,80}$/.test(face) && !style.fontFamily) style.fontFamily = face;
    }
    const align = (el.getAttribute('align') ?? '').toLowerCase();
    if (['left', 'right', 'center', 'justify'].includes(align) && !style.textAlign && tag !== 'img' && tag !== 'table') style.textAlign = align;
    if (tag === 'table' && align === 'center') {
      style.marginLeft = style.marginLeft ?? 'auto';
      style.marginRight = style.marginRight ?? 'auto';
    }
    const valign = (el.getAttribute('valign') ?? '').toLowerCase();
    if (['top', 'middle', 'bottom', 'baseline'].includes(valign) && !style.verticalAlign) style.verticalAlign = valign;
    if (['table', 'td', 'th', 'img', 'col'].includes(tag)) {
      const width = lengthOf(el.getAttribute('width'));
      const height = lengthOf(el.getAttribute('height'));
      if (width && !style.width) style.width = width;
      if (height && !style.height && tag !== 'table') style.height = height;
    }
    const styled = Object.keys(style).length > 0 ? { style } : {};

    if (tag === 'img') {
      const src = (el.getAttribute('src') ?? '').trim();
      const alt = (el.getAttribute('alt') ?? '').slice(0, 200);
      if (/^https?:\/\//i.test(src)) {
        if (isPixel(el, style)) {
          state.pixels += 1;
          return [];
        }
        state.remoteImages += 1;
        return [{ t: 'img', kind: 'remote', src, alt, ...styled }];
      }
      if (/^cid:/i.test(src)) return [{ t: 'img', kind: 'cid', src: src.slice(4).replace(/^<|>$/g, ''), alt, ...styled }];
      if (SAFE_DATA_IMAGE.test(src) && src.length <= MAX_DATA_IMAGE_CHARS) {
        if (isPixel(el, style)) {
          state.pixels += 1;
          return [];
        }
        return [{ t: 'img', kind: 'data', src, alt, ...styled }];
      }
      return alt ? [{ t: 'text', v: alt }] : [];
    }
    const kids = VOID.has(tag) ? [] : walkChildren(el, depth + 1);
    if (tag === 'a') {
      const target = safeHref(el.getAttribute('href'));
      if (!target) return kids.length > 0 ? [{ t: 'el', tag: 'span', ...styled, kids }] : [];
      return [{ t: 'link', href: target.href, outside: target.outside, ...styled, kids }];
    }
    const attrs: Record<string, string | number> = {};
    if (tag === 'td' || tag === 'th') {
      const colSpan = Number.parseInt(el.getAttribute('colspan') ?? '', 10);
      const rowSpan = Number.parseInt(el.getAttribute('rowspan') ?? '', 10);
      if (colSpan > 1 && colSpan <= 100) attrs.colSpan = colSpan;
      if (rowSpan > 1 && rowSpan <= 100) attrs.rowSpan = rowSpan;
    }
    if (tag === 'ol') {
      const start = Number.parseInt(el.getAttribute('start') ?? '', 10);
      if (Number.isFinite(start)) attrs.start = start;
    }
    if (tag === 'table') {
      const padding = Number.parseInt(el.getAttribute('cellpadding') ?? '', 10);
      const spacing = Number.parseInt(el.getAttribute('cellspacing') ?? '', 10);
      if (Number.isFinite(padding) && padding >= 0 && padding <= 40) attrs.cellPadding = padding;
      if (Number.isFinite(spacing) && spacing >= 0 && spacing <= 40) attrs.cellSpacing = spacing;
    }
    const title = el.getAttribute('title');
    if (title) attrs.title = title.slice(0, 200);
    const dir = (el.getAttribute('dir') ?? '').toLowerCase();
    if (dir === 'rtl' || dir === 'ltr' || dir === 'auto') attrs.dir = dir;
    return [
      {
        t: 'el',
        tag: AS[tag] ?? tag,
        ...styled,
        ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
        kids,
      },
    ];
  };

  const nodes = walkChildren(doc.body, 0);
  return { nodes, remoteImages: state.remoteImages, pixels: state.pixels, truncated: state.truncated };
}

/* ------------------------------------------------------------------ *
 * Plain text
 * ------------------------------------------------------------------ */

export type TextPart = { t: 'text'; v: string } | { t: 'quote'; head: string | null; inner: string };

/** The line that introduces a quote, in the languages mail most often arrives in. */
const ATTRIBUTION = /(wrote|a écrit|schrieb|escribió|scrisse|schreef|написал)\s*:\s*$/i;
/** Where a client puts the whole earlier message under, unquoted. */
const ORIGINAL = /^(-{2,}\s*(original message|forwarded message|message d'origine)\s*-{2,}|_{10,})\s*$/i;

/** Text longer than this is cut, with a line saying so. */
export const MAX_TEXT_CHARS = 200_000;

/**
 * A plain body as runs of text and quoted earlier messages. A run of lines
 * starting with `>` is one quote (blank lines inside it kept), the
 * "On Tue, Ana wrote:" line above it goes with it, and an "Original Message"
 * separator takes everything below. Nested quotes are left in `inner` for the
 * fold to split again when it is opened.
 */
export function splitQuotes(text: string): TextPart[] {
  const lines = text.split(/\r?\n/);
  const out: TextPart[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) out.push({ t: 'text', v: current.join('\n') });
    current = [];
  };
  /** The attribution line just above, if the text so far ends with one. */
  const takeHead = (): string | null => {
    let end = current.length - 1;
    while (end >= 0 && current[end]!.trim() === '') end -= 1;
    if (end < 0 || !ATTRIBUTION.test(current[end]!)) return null;
    const head = current[end]!.trim();
    current = current.slice(0, end);
    return head;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (ORIGINAL.test(line.trim())) {
      const head = takeHead();
      flush();
      out.push({ t: 'quote', head, inner: lines.slice(i + 1).join('\n') });
      return out;
    }
    if (line.startsWith('>')) {
      const run: string[] = [];
      let j = i;
      while (j < lines.length && (lines[j]!.startsWith('>') || (lines[j]!.trim() === '' && (lines[j + 1] ?? '').startsWith('>')))) {
        run.push(lines[j]!.replace(/^> ?/, ''));
        j += 1;
      }
      const head = takeHead();
      flush();
      out.push({ t: 'quote', head, inner: run.join('\n') });
      i = j - 1;
      continue;
    }
    current.push(line);
  }
  flush();
  return out;
}

export type TextRun = { t: 'text'; v: string } | { t: 'link'; href: string; v: string };

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Links in a plain body: http(s) only, a trailing full stop or bracket left out of the link. */
export function linkify(text: string): TextRun[] {
  const out: TextRun[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    let raw = match[0];
    // Sentence punctuation after an address is the sentence's, not the address's.
    while (/[.,;:!?)\]}'"]$/.test(raw)) {
      if (raw.endsWith(')') && (raw.match(/\(/g)?.length ?? 0) >= (raw.match(/\)/g)?.length ?? 0)) break;
      raw = raw.slice(0, -1);
    }
    const start = match.index ?? 0;
    const target = safeHref(raw);
    if (!target || !target.outside) continue;
    if (start > last) out.push({ t: 'text', v: text.slice(last, start) });
    out.push({ t: 'link', href: target.href, v: raw });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

/* ------------------------------------------------------------------ *
 * "Show images", per sender
 * ------------------------------------------------------------------ */

const IMAGES_KEY = 'buddi.mail.images.v1';

/** The senders whose pictures the owner said to show. Empty when storage is unavailable. */
export function imageSenders(): Set<string> {
  try {
    const raw = window.localStorage.getItem(IMAGES_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Remember (or forget) one sender. Quietly does nothing when storage is unavailable. */
export function rememberImages(sender: string, show: boolean): void {
  const key = sender.trim().toLowerCase();
  if (key === '') return;
  try {
    const senders = imageSenders();
    if (show) senders.add(key);
    else senders.delete(key);
    // A bounded list: the oldest choices go first.
    window.localStorage.setItem(IMAGES_KEY, JSON.stringify([...senders].slice(-500)));
  } catch {
    /* private window, blocked storage: the choice lasts this view only */
  }
}
