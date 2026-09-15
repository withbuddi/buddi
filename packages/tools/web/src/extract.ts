/**
 * HTML in, readable text out — and nothing else.
 *
 * No DOM, no `jsdom`, no readability library. A dependency that parses hostile
 * markup is a dependency that parses hostile markup in the same process as the
 * owner's bank data, and this plugin only needs three things from a page: its
 * title, its prose, and its links dropped on the floor. A few hundred lines of
 * regexes cannot be made to execute anything.
 *
 * What is deliberately thrown away:
 *
 *  - `<script>`, `<style>`, `<noscript>`, `<template>`, `<svg>` and comments,
 *    **contents included**. An HTML comment is a favourite place to hide a
 *    paragraph of instructions aimed at whatever is reading the page.
 *  - `<nav>`, `<header>`, `<footer>`, `<aside>`, `<form>` — chrome, which is
 *    most of a modern page's bytes and none of its meaning.
 *  - Every attribute, so `title=`, `alt=` and `aria-label=` text never reaches
 *    the model as if it were prose.
 *
 * The result is plain text with blank lines between blocks. It is still
 * untrusted; stripping markup does not make a sentence honest.
 */

/** Blocks whose *contents* go too, not just their tags. */
const DROPPED_ELEMENTS =
  /<(script|style|noscript|template|svg|math|iframe|object|canvas|nav|header|footer|aside|form|button|select)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** An unterminated one at the end of a truncated page still has to go. */
const DROPPED_TAIL =
  /<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*$/i;

const BLOCK_BOUNDARY =
  /<\/?(p|div|section|article|main|h[1-6]|li|ul|ol|tr|table|blockquote|pre|br|hr|dd|dt|figcaption)\b[^>]*>/gi;

const ANY_TAG = /<[^>]*>/g;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  euro: '€',
  pound: '£',
  deg: '°',
  times: '×',
  middot: '·',
  bull: '•',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[lower] ?? whole;
  });
}

/** The page's `<title>`, trimmed and collapsed, or `null`. */
export function extractTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!match) {
    // A page with no <title> often still has an <h1>, which is usually the
    // better label anyway.
    const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
    if (!h1) return null;
    const text = collapse(decodeEntities((h1[1] as string).replace(ANY_TAG, ' ')));
    return text === '' ? null : text.slice(0, 200);
  }
  const text = collapse(decodeEntities(match[1] as string));
  return text === '' ? null : text.slice(0, 200);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The page as prose.
 *
 * `maxChars` is not a nicety: a model that is handed 300 kB of page text will
 * quote the wrong part of it, and a long page is also a long opportunity to
 * bury an instruction. Truncation is reported to the caller, which reports it
 * to the agent, which can say so rather than pretending it read the whole
 * thing.
 */
export function htmlToText(html: string, maxChars: number): { text: string; truncated: boolean } {
  let out = html.replace(/<!--[\s\S]*?-->/g, ' ');
  out = out.replace(DROPPED_ELEMENTS, ' ');
  out = out.replace(DROPPED_TAIL, ' ');
  out = out.replace(BLOCK_BOUNDARY, '\n');
  out = out.replace(ANY_TAG, ' ');
  out = decodeEntities(out);
  out = out
    .split('\n')
    .map((line) => collapse(line))
    .filter((line) => line !== '')
    .join('\n')
    // Three or more blank-ish lines read as a gap; two is enough.
    .replace(/\n{3,}/g, '\n\n');
  if (out.length <= maxChars) return { text: out, truncated: false };
  return { text: `${out.slice(0, maxChars).trimEnd()}…`, truncated: true };
}

/** Plain text (or JSON, or markdown) still gets bounded and tidied. */
export function plainToText(body: string, maxChars: number): { text: string; truncated: boolean } {
  const trimmed = body.replace(/\r\n/g, '\n').trim();
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false };
  return { text: `${trimmed.slice(0, maxChars).trimEnd()}…`, truncated: true };
}
