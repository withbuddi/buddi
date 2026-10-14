/**
 * The little XML a workbook's parts need read: an element's attributes and
 * its text, entities decoded. Spreadsheet XML is regular enough that a pass
 * of regular expressions reads it; nothing here builds a tree.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Text with its XML entities (named and numeric) decoded. */
export function decodeXml(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_all, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[code.toLowerCase()] ?? '';
  });
}

/** Text made safe inside an element or a double-quoted attribute. */
export function encodeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One attribute of a start tag's attribute text, decoded, or null. Prefixed names (`r:id`) are matched as written. */
export function attr(tag: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name.replace(/[.:]/g, '\\$&')}="([^"]*)"`).exec(tag);
  return match ? decodeXml(match[1]!) : null;
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
