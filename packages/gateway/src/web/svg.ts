/**
 * A market icon, made safe to put in the page as markup.
 *
 * The icon is drawn inline so it takes the colour of the tile it sits in
 * (`currentColor`), which an `<img>` cannot do. Inline markup from the
 * internet is a script waiting to happen, so this is an allowlist, not a
 * filter: the input is tokenised, and what comes out is re-written from the
 * tokens using only simple shape elements and the presentation attributes a
 * line icon needs. Anything else in the element tree — a `<script>`, a
 * `<style>`, a `<use>`, an `<image>`, text, an entity, a doctype — and the
 * whole icon is refused (`undefined`), because an icon that needed one of
 * them would not draw right without it anyway. An attribute that is not on
 * the list, or whose value is more than numbers, colours and path letters,
 * is dropped on its own.
 */

/** The elements a line icon is made of. */
const ELEMENTS: ReadonlySet<string> = new Set(['svg', 'g', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon']);

/**
 * The attributes kept. `x1`…`y2` and `ry` go with `line` and `rect`, which
 * are on the element list and draw nothing without them.
 */
const ATTRIBUTES: ReadonlySet<string> = new Set([
  'viewBox',
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'width',
  'height',
  'rx',
  'ry',
  'r',
  'cx',
  'cy',
  'points',
  'stroke',
  'fill',
]);

/** Numbers, path letters, `#hex`, `currentColor`, `none`, percentages: never a `url(`, a colon, a quote or an entity. */
const VALUE = /^[A-Za-z0-9#.,\s%+-]*$/;

/** Past this, it is not an icon. */
export const MAX_ICON_BYTES = 16 * 1024;

const TAG = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/y;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

function keepAttribute(name: string): boolean {
  return ATTRIBUTES.has(name) || /^stroke-[a-z-]+$/.test(name);
}

function attributesOf(raw: string): string {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const match of raw.matchAll(ATTR)) {
    const name = match[1] as string;
    const value = match[2] ?? match[3];
    if (value === undefined || seen.has(name) || !keepAttribute(name) || !VALUE.test(value)) continue;
    seen.add(name);
    kept.push(`${name}="${value.trim()}"`);
  }
  return kept.length === 0 ? '' : ` ${kept.join(' ')}`;
}

/**
 * The icon re-written from its allowed parts, or `undefined` when it is not
 * an icon this page will draw.
 */
export function sanitizeIconSvg(input: string): string | undefined {
  if (input.length > MAX_ICON_BYTES) return undefined;
  // An XML prolog and comments carry nothing an icon needs; anything else that
  // is not a tag (a doctype, CDATA, a processing instruction) refuses it below.
  const text = input.replace(/^﻿/, '').replace(/^\s*<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const out: string[] = [];
  const open: string[] = [];
  let at = 0;
  let closedRoot = false;
  while (at < text.length) {
    const next = text.indexOf('<', at);
    const between = next === -1 ? text.slice(at) : text.slice(at, next);
    // Text between tags is whitespace or it is not an icon.
    if (between.trim() !== '') return undefined;
    if (next === -1) break;
    if (closedRoot) return undefined;
    TAG.lastIndex = next;
    const tag = TAG.exec(text);
    if (!tag) return undefined;
    at = TAG.lastIndex;
    const [, closing, rawName, rawAttrs, selfClosing] = tag as unknown as [string, string, string, string, string];
    const name = rawName;
    if (!ELEMENTS.has(name)) return undefined;
    if (open.length === 0 && (closing || name !== 'svg')) return undefined;
    if (open.length > 0 && !closing && name === 'svg') return undefined;
    if (closing) {
      if (open.pop() !== name) return undefined;
      out.push(`</${name}>`);
      if (open.length === 0) closedRoot = true;
      continue;
    }
    const attrs = attributesOf(rawAttrs);
    const head = name === 'svg' ? `<svg xmlns="http://www.w3.org/2000/svg"${attrs}` : `<${name}${attrs}`;
    if (selfClosing) {
      out.push(`${head}/>`);
      if (name === 'svg') closedRoot = true;
    } else {
      out.push(`${head}>`);
      open.push(name);
    }
  }
  if (open.length > 0 || !closedRoot) return undefined;
  return out.join('');
}
