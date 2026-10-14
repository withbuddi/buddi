/**
 * Which files are text: the one rule the gateway (previews, the editor's
 * routes) and the dashboard (which files open in the editor) both apply, so
 * the page never opens an editor the server then refuses with 415.
 *
 * Genuinely textual formats, by mime or — for the `application/octet-stream`
 * a browser or a command gives anything it does not recognise — by
 * extension; never a binary container, however it is named (the Office
 * list is `office-files.ts`'s). A leaf module but for that list, reached
 * through the `@buddi/core/text-files` subpath so the dashboard bundle loads
 * nothing else from core.
 */

import { bareMime, extensionOf, OFFICE_EXTS } from './office-files.js';

const TEXT_MIMES = new Set([
  'application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml',
  'application/toml', 'application/sql', 'application/x-sh',
]);

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml', 'sql', 'html', 'htm', 'css',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'swift', 'sh', 'bash', 'zsh', 'log', 'ini', 'conf', 'env',
]);

/** Containers that are never text, however they are named or typed. */
const NEVER_TEXT_EXTS = new Set([...OFFICE_EXTS, 'pdf']);

/** Is this file text: previewed as text, and opened in the editor? */
export function isTextFile(mime: string, filename?: string | null): boolean {
  const ext = extensionOf(filename);
  if (NEVER_TEXT_EXTS.has(ext)) return false;
  const value = bareMime(mime);
  if (value.startsWith('text/') || TEXT_MIMES.has(value)) return true;
  return (value === '' || value === 'application/octet-stream') && TEXT_EXTS.has(ext);
}

/**
 * The name a version is downloaded under: the file's own name, with ` (vN)`
 * before the extension from the second version on. Stored names never carry
 * the mark; a download does, so two versions saved side by side differ.
 */
export function versionedFileName(name: string | null | undefined, version: number, fallback = 'download'): string {
  const plain = name && name.trim() !== '' ? name : fallback;
  if (!Number.isInteger(version) || version <= 1) return plain;
  const dot = plain.lastIndexOf('.');
  return dot > 0 ? `${plain.slice(0, dot)} (v${version})${plain.slice(dot)}` : `${plain} (v${version})`;
}

/**
 * A title made into a file name, the one rule for every name buddi gives a
 * file from words (an agent's document title, a folder label): safe on every
 * system the owner might save it to — no separators, no control characters,
 * nothing a shell or Windows refuses, no leading dots (so never `..` or a
 * hidden file) — and still readable. Punctuation set off by spaces, like a
 * title's ": ", becomes " - " ("List: Two" is "List - Two", never
 * "List- Two"); inside a word it is a hyphen ("A/B" is "A-B"). Longer than
 * `max`, it is cut at a word.
 */
export function safeFileName(raw: string, max: number, fallback: string): string {
  let name = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/(\s*)[\\/:*?"<>|]+(\s*)/g, (_all, before: string, after: string) => (before || after ? ' - ' : '-'))
    .replace(/\s+/g, ' ')
    .replace(/( - )+/g, ' - ')
    .trim()
    .replace(/^[.\-\s]+/, '')
    .replace(/[.\-\s]+$/, '');
  if (name.length > max) {
    const cut = name.slice(0, max);
    const space = cut.lastIndexOf(' ');
    name = (space > max / 2 ? cut.slice(0, space) : cut).replace(/[.\s-]+$/, '');
  }
  // Names Windows reserves for devices, whatever the extension.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) name = `${name}-file`;
  return name === '' ? fallback : name;
}

/**
 * What every refused save says, wherever it was made — the editor, Restore,
 * the server's 409: one phrase for "a newer version was saved meanwhile".
 */
export const CHANGED_SINCE = 'This file changed since you opened it';
