/**
 * A report's Markdown as Telegram HTML (`parse_mode: 'HTML'`).
 *
 * Reports are written in light Markdown (Anchor's editions above all: a
 * heading per topic, bold headlines, the source in italics with its link on
 * the outlet's name). Shown as plain text, every asterisk and hash reaches the
 * phone; shown through Telegram's own Markdown modes, one stray `_` refuses
 * the whole message. So it is converted here, to the handful of tags Telegram
 * accepts, with every other character escaped:
 *
 * - `# Heading` (any level) → a bold line in capitals (the kit's topic line on
 *   Telegram), its words as written when it carries a link;
 * - `**bold**`, `__bold__` → `<b>`; `*italic*`, `_italic_` → `<i>`; `~~x~~` → `<s>`;
 * - `` `code` `` → `<code>`; a fenced block → `<pre>`;
 * - `[label](https://…)` → `<a href>`; a link to anything but http(s) keeps its label only;
 * - a raw URL stays as it is (Telegram links it itself);
 * - `- item` → `• item`; a table row → its cells joined with " — ".
 *
 * The markers follow the plain-text net's rules (`outbound.ts`): they only
 * count when they wrap a span, so `2 * 3` and `snake_case` are left alone.
 *
 * Splitting happens here too, on the converted text: a message never passes
 * 4,096 characters and never cuts a tag, the cut falls between paragraphs,
 * and before a heading when one is in the second half (a longer edition
 * splits at a topic).
 */
import { TELEGRAM_MAX_MESSAGE_CHARS } from './api.js';
import { stripToolNames } from './outbound.js';

/** One block of the source: its converted lines, each balanced on its own. */
interface HtmlBlock {
  units: string[];
  heading: boolean;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const escapeAttr = (text: string): string => escapeHtml(text).replace(/"/g, '&quot;');

const FENCE = /^\s*(```|~~~)[A-Za-z0-9_+-]*\s*$/;
const HEADING = /^\s{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const BULLET = /^(\s*)[-*+][ \t]+(.*)$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

const INLINE =
  /`([^`\n]+)`|\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*|(?<![\w])__(?=\S)([^_\n]+?)(?<=\S)__(?!\w)|~~(?=\S)([^~\n]+?)(?<=\S)~~|(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])|(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])|\[([^\]\n]+)\]\(\s*<?([^()\s<>]*)>?\s*\)/;

/** One line's inline Markdown as Telegram HTML; everything else escaped. */
export function inlineHtml(text: string): string {
  let out = '';
  let rest = text;
  while (rest !== '') {
    const m = INLINE.exec(rest);
    if (!m) { out += escapeHtml(rest); break; }
    out += escapeHtml(rest.slice(0, m.index));
    if (m[1] !== undefined) out += `<code>${escapeHtml(m[1])}</code>`;
    else if (m[2] !== undefined) out += `<b>${inlineHtml(m[2])}</b>`;
    else if (m[3] !== undefined) out += `<b>${inlineHtml(m[3])}</b>`;
    else if (m[4] !== undefined) out += `<s>${inlineHtml(m[4])}</s>`;
    else if (m[5] !== undefined) out += `<i>${inlineHtml(m[5])}</i>`;
    else if (m[6] !== undefined) out += `<i>${inlineHtml(m[6])}</i>`;
    else if (m[7] !== undefined) {
      const url = m[8] ?? '';
      out += /^https?:\/\/\S+$/i.test(url) ? `<a href="${escapeAttr(url)}">${inlineHtml(m[7])}</a>` : inlineHtml(m[7]);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function tableCells(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|') || trimmed.length < 2) return undefined;
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}

/** Cut a `<pre>` body into pieces that fit, each wrapped on its own. */
function preUnits(body: string, limit: number): string[] {
  const room = limit - '<pre></pre>'.length;
  const units: string[] = [];
  let current = '';
  for (const line of body.split('\n')) {
    const escaped = escapeHtml(line);
    const next = current === '' ? escaped : `${current}\n${escaped}`;
    if (next.length <= room) { current = next; continue; }
    if (current !== '') units.push(`<pre>${current}</pre>`);
    if (escaped.length <= room) { current = escaped; continue; }
    // One line longer than a message: cut it into successive pieces, never
    // inside an entity (each character is escaped on its own), none dropped.
    current = '';
    for (const ch of line) {
      const e = escapeHtml(ch);
      if (current.length + e.length > room) { units.push(`<pre>${current}</pre>`); current = ''; }
      current += e;
    }
  }
  if (current !== '' || units.length === 0) units.push(`<pre>${current}</pre>`);
  return units;
}

/** The source as blocks of converted lines. */
export function markdownBlocks(markdown: string, limit = TELEGRAM_MAX_MESSAGE_CHARS): HtmlBlock[] {
  const lines = stripToolNames(markdown.replace(/\r\n/g, '\n')).split('\n');
  const blocks: HtmlBlock[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) blocks.push({ units: para, heading: false });
    para = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '') { flush(); continue; }
    if (FENCE.test(line)) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i]!)) { body.push(lines[i]!); i += 1; }
      blocks.push({ units: preUnits(body.join('\n'), limit), heading: false });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const words = heading[1]!;
      blocks.push({ units: [`<b>${inlineHtml(/\]\(/.test(words) ? words : words.toLocaleUpperCase())}</b>`], heading: true });
      continue;
    }
    if (HR.test(line)) { flush(); continue; }
    const cells = tableCells(line);
    if (cells) {
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
      para.push(inlineHtml(cells.join(' — ')));
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) { para.push(`${bullet[1]!.replace(/\t/g, '  ')}• ${inlineHtml(bullet[2]!)}`); continue; }
    const quote = QUOTE.exec(line);
    if (quote) { para.push(inlineHtml(quote[1]!)); continue; }
    para.push(inlineHtml(line.trim()));
  }
  flush();
  return blocks;
}

/** The text a unit carries, tags dropped: the last resort for one line longer than a message. */
function plainOf(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** A unit that cannot fit even alone: its text, escaped, in pieces that do. */
function hardCut(unit: string, limit: number): string[] {
  const out: string[] = [];
  let rest = plainOf(unit);
  while (rest !== '') {
    let take = Math.min(rest.length, limit);
    // Escaping grows the text; shrink until the escaped piece fits.
    while (escapeHtml(rest.slice(0, take)).length > limit) take -= Math.max(1, Math.floor(take / 20));
    out.push(escapeHtml(rest.slice(0, take)));
    rest = rest.slice(take);
  }
  return out;
}

/**
 * Pack the blocks into messages under `limit`: paragraphs joined by a blank
 * line, a cut only between blocks (between lines when one block is longer
 * than a message), before the last heading when it sits in the second half.
 */
export function packHtml(blocks: HtmlBlock[], limit = TELEGRAM_MAX_MESSAGE_CHARS): string[] {
  const messages: string[] = [];
  let current: Array<{ html: string; heading: boolean }> = [];
  const size = (parts: Array<{ html: string }>): number =>
    parts.reduce((n, part, i) => n + part.html.length + (i > 0 ? 2 : 0), 0);
  const emit = (parts: Array<{ html: string }>): void => {
    if (parts.length > 0) messages.push(parts.map((p) => p.html).join('\n\n'));
  };

  for (const block of blocks) {
    const html = block.units.join('\n');
    if (html.length <= limit) {
      if (size([...current, { html }]) <= limit) { current.push({ html, heading: block.heading }); continue; }
      // Over: cut before the last heading when that leaves at least half a message.
      const at = current.map((p) => p.heading).lastIndexOf(true);
      if (at > 0 && size(current.slice(0, at)) >= limit * 0.5 && size([...current.slice(at), { html }]) <= limit) {
        emit(current.slice(0, at));
        current = [...current.slice(at), { html, heading: block.heading }];
      } else {
        emit(current);
        current = [{ html, heading: block.heading }];
      }
      continue;
    }
    // One block longer than a message: line by line.
    emit(current);
    current = [];
    let lines: string[] = [];
    for (const unit of block.units.flatMap((u) => (u.length <= limit ? [u] : hardCut(u, limit)))) {
      const next = [...lines, unit].join('\n');
      if (next.length <= limit) { lines.push(unit); continue; }
      if (lines.length > 0) messages.push(lines.join('\n'));
      lines = [unit];
    }
    if (lines.length > 0) current = [{ html: lines.join('\n'), heading: false }];
  }
  emit(current);
  return messages;
}

/** Markdown in, Telegram HTML messages out, none longer than `limit`. */
export function markdownToTelegramHtml(markdown: string, limit = TELEGRAM_MAX_MESSAGE_CHARS): string[] {
  return packHtml(markdownBlocks(markdown, limit), limit);
}

/**
 * An owner message as HTML: its title in bold, then its text converted, then
 * the lines that ask something, escaped. The same parts, in the same order,
 * as `ownerMessageText` gives the plain path.
 */
export function ownerMessageHtml(
  message: { title: string; text?: string; action?: string; parts?: ReadonlyArray<{ title: string; action?: string }> },
  limit = TELEGRAM_MAX_MESSAGE_CHARS,
): string[] {
  const blocks: HtmlBlock[] = [{ units: [`<b>${escapeHtml(message.title.trim())}</b>`], heading: false }];
  const text = message.text?.trim();
  if (text) blocks.push(...markdownBlocks(text, limit));
  const asks = (message.parts ?? [])
    .filter((part) => (part.action?.trim() ?? '') !== '')
    .map((part) => escapeHtml(`→ ${part.title.trim()}: ${part.action!.trim()}`));
  const action = message.action?.trim();
  const lines = [...asks, ...(action ? [escapeHtml(`→ ${action}`)] : [])];
  if (lines.length > 0) blocks.push({ units: lines, heading: false });
  return packHtml(blocks, limit);
}
