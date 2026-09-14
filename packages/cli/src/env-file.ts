/**
 * Reading and writing `.env` without losing what is already in it.
 *
 * The wizard must be idempotent, which means it edits the file rather than
 * regenerating it: a key that is already there is replaced in place, comments
 * and ordering survive, and a key the owner added by hand is never dropped.
 *
 * Values are written raw — no quoting — because that is what `dotenv` reads and
 * what the existing `.env.example` uses. A secret is never echoed back.
 */

export interface EnvEdit {
  key: string;
  value: string;
}

/** `KEY=value` pairs, ignoring blanks and comments. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

/** True when the key is absent, empty, or whitespace — i.e. still to be asked for. */
export function isBlank(env: Record<string, string>, key: string): boolean {
  const v = env[key];
  return v === undefined || v.trim() === '';
}

/**
 * Apply edits to the text of a `.env`, in place where the key exists (including
 * a commented-out `# KEY=…` line, which is uncommented) and appended otherwise.
 */
export function applyEnvEdits(text: string, edits: EnvEdit[]): string {
  const lines = text === '' ? [] : text.split('\n');
  const remaining: EnvEdit[] = [];

  for (const edit of edits) {
    const live = new RegExp(`^\\s*${escapeRe(edit.key)}\\s*=`);
    const commented = new RegExp(`^\\s*#\\s*${escapeRe(edit.key)}\\s*=`);
    let index = lines.findIndex((l) => live.test(l));
    if (index === -1) index = lines.findIndex((l) => commented.test(l));
    if (index === -1) {
      remaining.push(edit);
      continue;
    }
    lines[index] = `${edit.key}=${edit.value}`;
  }

  if (remaining.length > 0) {
    if (lines.length > 0 && lines[lines.length - 1]?.trim() !== '') lines.push('');
    for (const edit of remaining) lines.push(`${edit.key}=${edit.value}`);
  }

  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A secret, shown as its shape only. `.env` values are never printed in full. */
export function maskSecret(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return '•'.repeat(v.length);
  return `${v.slice(0, 4)}…${'•'.repeat(6)} (${v.length} chars)`;
}
