/**
 * The little XML a workbook's parts need read: an element's attributes and
 * its text, entities decoded. Spreadsheet XML is regular enough that a pass
 * of regular expressions reads it; nothing here builds a tree.
 */
import { decodeEntities } from '../entities.js';

/** Text with its XML entities (named and numeric) decoded: core's one decoder (`entities.ts`). */
export function decodeXml(text: string): string {
  return decodeEntities(text);
}

/** Text made safe inside an element or a double-quoted attribute. */
export function encodeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One attribute, as XML allows it: either quote, space around `=`. Prefixed names (`r:id`) are matched as written. */
function attrPattern(name: string, flags = ''): RegExp {
  return new RegExp(`(?:^|\\s)${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, flags);
}

/** One attribute of a start tag's attribute text, decoded, or null. */
export function attr(tag: string, name: string): string | null {
  const match = attrPattern(name).exec(tag);
  return match ? decodeXml(match[1] ?? match[2]!) : null;
}

/** A start tag's attribute text without one attribute, however it was quoted. */
export function withoutAttr(tag: string, name: string): string {
  return tag.replace(attrPattern(name, 'g'), '');
}

/** A numeric attribute, or null. */
export function numAttr(tag: string, name: string): number | null {
  const value = attr(tag, name);
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A boolean attribute as Office writes them: `1`/`true` on, `0`/`false` off, absent = `fallback`. */
export function boolAttr(tag: string, name: string, fallback = false): boolean {
  const value = attr(tag, name);
  if (value === null) return fallback;
  return value === '1' || value === 'true';
}

/** The text of every `<t>` inside a fragment (a shared string's runs), phonetic runs left out. */
export function runText(xml: string): string {
  const cleaned = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of cleaned.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += decodeXml(m[1] ?? '');
  return out;
}
