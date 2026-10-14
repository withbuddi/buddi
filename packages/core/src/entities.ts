/**
 * The one character-reference decoder: XML's five named entities (or a
 * caller's larger set, HTML's), and numeric references, decimal and hex.
 * A reference it does not know is left as written. A leaf module, used by
 * the sheet reader, the Office text and render passes, the web reader and
 * the Markdown export.
 */

export const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Text with its character references decoded; named ones looked up in `named` (case-insensitively). */
export function decodeEntities(text: string, named: Readonly<Record<string, string>> = XML_ENTITIES): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return named[code.toLowerCase()] ?? whole;
  });
}
