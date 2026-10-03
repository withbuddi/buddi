/**
 * Tool names out of owner-facing catalogue text.
 *
 * A listing's pitch, description, about, changes, examples, mission names
 * and skill descriptions are read by the owner, who never needs to see
 * `artifacts.write`. The market check refuses them in new listings; this
 * rewrites them in older ones as they are drawn: a known tool's name becomes
 * a short phrase from its own description, or (with none to borrow) leaves,
 * taking a parenthetical it stood alone in with it.
 */

/** What reads like a tool name; only a name the tool list knows is rewritten (so `withbuddi.com` stays). */
const TOOL_TOKEN = /\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\b/g;

export interface ToolWords {
  name: string;
  description?: string;
}

/** The first clause of a tool's description, lower-cased, when it is short enough to sit in a sentence. */
export function toolPhrase(description: string | undefined): string | null {
  if (!description) return null;
  const clause = description.trim().split(/[.;:(]|\s—\s|\s-\s/)[0]?.trim() ?? '';
  if (clause.length < 3 || clause.length > 48 || TOOL_TOKEN.test(clause)) {
    TOOL_TOKEN.lastIndex = 0;
    return null;
  }
  return clause.charAt(0).toLowerCase() + clause.slice(1);
}

/** The text with every known tool name rewritten for the owner; unchanged when it names none. */
export function ownerText(text: string, tools: readonly ToolWords[]): string {
  if (!text.includes('.')) return text;
  const known = new Map(tools.map((t) => [t.name, toolPhrase(t.description)]));
  const isKnown = (token: string): boolean => known.has(token);
  if (!(text.match(TOOL_TOKEN) ?? []).some(isKnown)) return text;
  // A parenthetical that is only tool names: "(artifacts.write)" or "(web.search, web.fetch)".
  let out = text.replace(/\s*\(([^()]*)\)/g, (whole, inner: string) => {
    const parts = inner.split(/\s*(?:,|\band\b|\/)\s*/).filter((p) => p !== '');
    if (parts.length === 0 || !parts.every(isKnown)) return whole;
    const phrases = [...new Set(parts.map((p) => known.get(p)).filter((p): p is string => p !== null && p !== undefined))];
    return phrases.length === 0 ? '' : ` (${phrases.join(', ')})`;
  });
  // A name in running text.
  out = out.replace(TOOL_TOKEN, (token) => (isKnown(token) ? (known.get(token) ?? '') : token));
  return out.replace(/ {2,}/g, ' ').replace(/\s+([,.;:!?)])/g, '$1').replace(/\(\s+/g, '(').trim();
}
