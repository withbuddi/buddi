/**
 * Words and shapes the Keys and secrets page reads and writes
 * (docs/specs/owner-secrets.md §6), kept out of the component so the rules
 * can be reasoned about on their own. Pure: no React, no fetch.
 *
 * A binding's `target` is plain JSON that the destination itself checks at
 * use time, so this module never *validates* a target — it only builds the
 * JSON the owner's one text input stands for, and reads a stored one back as
 * readable text. The shapes the page knows are the ones buddi's own kinds
 * bind with: a string for an origin, a bundle id or an account id, and
 * `{ host, header }`, `{ workspace, variable }` and `{ origin, field }` for
 * the two-part kinds. Anything else passes through as it was typed.
 */
import type { SecretRule } from '../api';

/** Strictest first, the same order core's `SECRET_RULES` keeps. */
export const SECRET_RULES: readonly SecretRule[] = ['every-time', 'first-time', 'pre-approved'];

/** The rule as the page says it. */
export const RULE_LABELS: Record<SecretRule, string> = {
  'every-time': 'every time',
  'first-time': 'first time only',
  'pre-approved': 'pre-approved',
};

/**
 * The rules at most as loose as `maxRule`: the kind's own loosest, or any
 * stricter one. A destination states the loosest it allows; the owner may
 * pick a stricter one, never a looser one (§2).
 */
export function allowedRules(maxRule: SecretRule): SecretRule[] {
  const at = SECRET_RULES.indexOf(maxRule);
  return SECRET_RULES.slice(0, at < 0 ? 1 : at + 1);
}

/** An account kind (`<plugin>.account`) — the one exception to "never held" (§4). */
export function isAccountKind(kind: string): boolean {
  return kind.endsWith('.account');
}

/** The one line a Settings row says for an account binding (§4). */
export const ACCOUNT_HELD_LINE = 'This account’s process holds the value for as long as its connection lives.';

/** The one line a secret with no binding says on the page (§2). */
export const UNBOUND_LINE = 'Stored, not usable until it has a binding.';

/**
 * What one binding's target input asks for, in the owner's words: the shape,
 * with an example. For a two-part kind the second part never holds a space
 * (a header name, a variable name, a field name), so the placeholder shows
 * the parts separated by one.
 */
export function targetPlaceholder(kind: string): string {
  if (kind === 'browser.field') return 'the exact origin — scheme, host and port — e.g. https://localhost:8443';
  if (kind === 'browser.form.data') return 'the origin, then the field name — e.g. https://localhost:8443 card-number';
  if (kind === 'browser.native.type') return 'the app’s bundle id, e.g. com.bank.app';
  if (kind === 'http.header') return 'the host, then the header name — e.g. localhost:9200 Authorization';
  if (kind === 'developer.env') return 'the workspace, then the variable name — e.g. cour des comptes ADMIN_PASSWORD';
  if (isAccountKind(kind)) return 'the account id, e.g. acct-1';
  return 'the place, as JSON — e.g. {"host":"localhost","header":"Authorization"}';
}

/** The two-part kinds, and the JSON each pair builds. */
const TWO_PART_KINDS: Record<string, { hint: string; build: (first: string, second: string) => Record<string, string> }> = {
  'browser.form.data': { hint: 'an origin, then the field name', build: (origin, field) => ({ origin, field }) },
  'http.header': { hint: 'a host, then the header name', build: (host, header) => ({ host, header }) },
  'developer.env': { hint: 'a workspace, then the variable name', build: (workspace, variable) => ({ workspace, variable }) },
};

/** What one text input stands for: `{ ok, target }` or why not. */
export type TargetParse = { ok: true; target: unknown } | { ok: false; error: string };

/** The last whitespace-separated token, and everything before it: the second part of a two-part target never holds a space. */
function lastTwoParts(text: string): [string, string] | null {
  const at = text.search(/\s\S+\s*$/);
  if (at <= 0) return null;
  const second = text.slice(at).trim();
  const first = text.slice(0, at).trim();
  return first && second ? [first, second] : null;
}

/**
 * Build a binding's `target` from the owner's one text input. Text that
 * opens with `{` is read as the JSON the owner meant — the way to bind a
 * kind this page does not know the shape of. A two-part kind splits at its
 * last space, because its second part (the header, the variable, the field)
 * never holds one and its first part may.
 */
export function parseTargetInput(kind: string, text: string): TargetParse {
  const raw = text.trim();
  if (raw === '') return { ok: false, error: 'Give the exact place this value may go.' };
  if (raw.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, target: parsed };
      return { ok: false, error: 'A target in JSON is an object, like {"host":"localhost","header":"Authorization"}.' };
    } catch {
      return { ok: false, error: 'That opens like JSON but does not parse.' };
    }
  }
  if (kind === 'browser.field' || kind === 'browser.native.type' || isAccountKind(kind)) return { ok: true, target: raw };
  const two = TWO_PART_KINDS[kind];
  if (two === undefined) return { ok: true, target: raw };
  const parts = lastTwoParts(raw);
  if (parts === null) return { ok: false, error: `${kind} needs both: ${two.hint}.` };
  return { ok: true, target: two.build(parts[0], parts[1]) };
}

/** A stored target as the one text input takes it: a string as it is, anything else as its JSON. */
export function targetInputText(target: unknown): string {
  if (typeof target === 'string') return target;
  try {
    return JSON.stringify(target) ?? '';
  } catch {
    return '';
  }
}

/**
 * A stored target as a row reads it: readable for the shapes buddi knows,
 * JSON for anything else. Never a value — this is the binding's place.
 */
export function renderTarget(kind: string, target: unknown): string {
  if (typeof target === 'string') return target;
  if (target !== null && typeof target === 'object' && !Array.isArray(target)) {
    const obj = target as Record<string, unknown>;
    const pair = TWO_PART_KINDS[kind];
    if (pair !== undefined) {
      const keys = Object.keys(pair.build('a', 'b'));
      const values = keys.map((key) => obj[key]);
      if (keys.every((key) => typeof obj[key] === 'string')) return values.join(' · ');
    }
  }
  try {
    return JSON.stringify(target) ?? String(target);
  } catch {
    return String(target);
  }
}

/** A use's outcome as the tone its pill wears (§6). */
export function outcomeTone(outcome: string): 'good' | 'warning' | 'critical' | undefined {
  if (outcome === 'delivered') return 'good';
  if (outcome === 'held' || outcome === 'pending') return 'warning';
  if (outcome === 'refused' || outcome === 'failed') return 'critical';
  return undefined;
}

/** One place a value was found in, with how often — never the value itself. */
export interface FoundPlace {
  place: string;
  count: number;
}

/**
 * The places one write's answer reports, read out of `{ result }` — the
 * save's `found` or the scrub's `scrubbed`, both a list of `{ place, count }`.
 */
export function placeCounts(result: unknown, key: 'found' | 'scrubbed'): FoundPlace[] {
  if (typeof result !== 'object' || result === null) return [];
  const listed = (result as Record<string, unknown>)[key];
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const place = (row as Record<string, unknown>).place;
    const count = (row as Record<string, unknown>).count;
    if (typeof place !== 'string' || typeof count !== 'number' || !(count > 0)) return [];
    return [{ place, count }];
  });
}

/** "3 events and 1 memory note" — the places of one report, counted. */
export function placesSentence(places: readonly FoundPlace[]): string {
  const named = places.map(({ place, count }) => `${count.toLocaleString('en-GB')} ${count === 1 ? place.replace(/s$/, '') : place}`);
  if (named.length <= 1) return named[0] ?? '';
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

/** What the page says when a save landed where buddi already holds text; empty when it found nothing. */
export function foundSentence(result: unknown): string {
  const places = placeCounts(result, 'found');
  return places.length ? `The value already sits in ${placesSentence(places)}.` : '';
}

/** What the page says after the one-tap scrub; empty when there was nothing to replace. */
export function scrubbedSentence(result: unknown): string {
  const places = placeCounts(result, 'scrubbed');
  return places.length ? `Replaced with ‹secret:…› in ${placesSentence(places)}.` : '';
}