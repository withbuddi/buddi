/**
 * Which files are text: the one rule the gateway (previews, the editor's
 * routes) and the dashboard (which files open in the editor) both apply, so
 * the page never opens an editor the server then refuses with 415.
 *
 * Genuinely textual formats, by mime or — for the `application/octet-stream`
 * a browser or a command gives anything it does not recognise — by
 * extension; never a binary container, however it is named. A leaf module
 * (no imports), reached through the `@buddi/core/text-files` subpath so the
 * dashboard bundle loads nothing else from core.
 */

const TEXT_MIMES = new Set([
  'application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml',
  'application/toml', 'application/sql', 'application/x-sh',
]);

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml', 'sql', 'html', 'htm', 'css',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'swift', 'sh', 'bash', 'zsh', 'log', 'ini', 'conf', 'env',
]);

/** Containers that are never text, however they are named or typed. */
const NEVER_TEXT_EXTS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'numbers', 'pages', 'key', 'rtf', 'odt', 'ods', 'odp', 'pdf']);

function extensionOf(filename: string | null | undefined): string {
  const name = (filename ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

/** Is this file text: previewed as text, and opened in the editor? */
export function isTextFile(mime: string, filename?: string | null): boolean {
  const ext = extensionOf(filename);
  if (NEVER_TEXT_EXTS.has(ext)) return false;
  const value = (mime || '').toLowerCase().split(';')[0]!.trim();
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
 * What every refused save says, wherever it was made — the editor, Restore,
 * the server's 409: one phrase for "a newer version was saved meanwhile".
 */
export const CHANGED_SINCE = 'This file changed since you opened it';
