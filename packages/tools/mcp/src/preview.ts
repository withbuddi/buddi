/**
 * What an approval card says about an MCP call, in words an owner reads at a
 * glance: what it does, where, then one short line per argument. The exact
 * arguments are on the envelope beside it; this is the summary, never raw JSON.
 */

const MAX_LINES = 8;
const MAX_VALUE = 80;

/** `update_document` → `Update document`. */
export function humanTool(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[_\-.\s]+/).filter(Boolean).map((w) => w.toLowerCase());
  if (words.length === 0) return name;
  return [words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1), ...words.slice(1)].join(' ');
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_VALUE ? `${flat.slice(0, MAX_VALUE - 1)}…` : flat;
}

/** One argument's value as a phrase: scalars as they are, containers by their shape. */
export function describeValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string') return value.trim() === '' ? 'empty' : clip(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'an empty list';
    if (value.every((v) => typeof v === 'string' || typeof v === 'number')) return clip(value.join(', '));
    return value.length === 1 ? '1 item' : `${value.length} items`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return 'nothing';
    const shown = keys.slice(0, 4).join(', ');
    const more = keys.length > 4 ? `, and ${keys.length - 4} more` : '';
    return `${keys.length === 1 ? '1 field' : `${keys.length} fields`}: ${shown}${more}`;
  }
  return clip(String(value));
}

export function callPreview(opts: { tool: string; where: string; destructive: boolean; input: Record<string, unknown> | undefined }): string {
  const head = `${humanTool(opts.tool)} on ${opts.where}${opts.destructive ? '. It can change or delete something.' : ''}`;
  const entries = Object.entries(opts.input ?? {});
  const lines = entries.slice(0, MAX_LINES).map(([key, value]) => `${humanTool(key)}: ${describeValue(value)}`);
  if (entries.length > MAX_LINES) lines.push(`and ${entries.length - MAX_LINES} more`);
  return [head, ...lines].join('\n');
}
