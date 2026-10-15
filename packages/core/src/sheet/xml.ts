/**
 * The little XML a workbook's parts need read: an element's attributes and
 * its text, entities decoded. Spreadsheet XML is regular enough that a pass
 * of regular expressions reads it; nothing here builds a tree.
 */
import { decodeEntities } from '../entities.js';

/**
 * The namespaces a workbook's parts are read in, with the prefix the
 * readers' patterns are written for: SpreadsheetML and package
 * relationships unprefixed, document relationships `r:`, DrawingML `a:`.
 */
const READ_AS: ReadonlyArray<[uri: string, prefix: string]> = [
  ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', ''],
  ['http://schemas.openxmlformats.org/package/2006/relationships', ''],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'r'],
  ['http://schemas.openxmlformats.org/drawingml/2006/main', 'a'],
];

/**
 * A part's XML with its own prefixes for the namespaces buddi reads
 * (`READ_AS`) renamed to the ones the readers expect: `<x:row>` reads as
 * `<row>`, `rel:id="…"` as `r:id="…"`. Some exporters write SpreadsheetML
 * prefixed; read as written, such a workbook would have no sheets. Only
 * element and attribute names change, never text or values; a part already
 * written the usual way comes back as it is.
 */
export function withReadPrefixes(xml: string): string {
  let out = xml;
  for (const [uri, want] of READ_AS) {
    const declared = new RegExp(`\\sxmlns:([A-Za-z_][\\w.-]*)\\s*=\\s*(?:"${uri.replace(/[.]/g, '\\.')}"|'${uri.replace(/[.]/g, '\\.')}')`, 'g');
    for (const m of [...out.matchAll(declared)]) {
      const prefix = m[1]!;
      if (prefix === want) continue;
      const to = want === '' ? '' : `${want}:`;
      const escaped = prefix.replace(/[.-]/g, '\\$&');
      // Inside tags only (text never holds a raw `<`): the element's name, then attribute names.
      const element = new RegExp(`^<(/?)${escaped}:(?=[A-Za-z_])`);
      const attribute = new RegExp(`(\\s)${escaped}:(?=[A-Za-z_][\\w.-]*\\s*=)`, 'g');
      out = out.replace(/<[^<>]*>/g, (tag) => tag.replace(element, `<$1${to}`).replace(attribute, `$1${to}`));
    }
  }
  return out;
}

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
