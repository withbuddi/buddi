/**
 * Output scrubbing (docs/specs/owner-secrets.md §5).
 *
 * Every text that leaves buddi's core for a model, a log, the canvas, Activity
 * or Telegram is scrubbed for every stored value, and each match is replaced
 * by `‹secret:NAME›`. buddi's own keys are scrubbed the same way under their
 * own names. This is not a second line behind the destinations; it is how a
 * process that prints its environment, a page that echoes a field, or an error
 * that quotes a header stays safe.
 *
 * One automaton over each value and its common encodings — exact, URL-encoded
 * (both `%20` and `+` for a space), JSON-escaped, and base64 in both alphabets
 * at each of the three byte alignments (the stable middle of the encoding, so
 * a secret inside a longer base64 blob still matches). One pass over the text,
 * linear in its length, whatever the number of secrets. The automaton is
 * rebuilt when a secret is saved, renamed or deleted (`invalidateSecretScrubber`).
 * Values shorter than eight characters match only on token boundaries, so a
 * four-digit PIN does not blank every year in a page.
 *
 * The automaton lives at process scope because the choke points are scattered
 * across core, the runtime and the gateway, and one scrubber is the point. A
 * process that never configures a source (a unit test, a CLI turn with no
 * vault) scrubs nothing: `scrubText` is then the identity. The composition
 * root primes it at boot; the async choke points re-prime after an
 * invalidation before they answer.
 *
 * There is deliberately no read path here. What a caller learns from
 * `findSecretMatches` is which secret *names* a text contains and how often —
 * never a value.
 */
import { KNOWN_SECRETS } from '../vault/resolve.js';
import { ownerSecretVaultName, type Vault } from '../vault/types.js';

/** The marker a match is replaced by. */
export function secretMarker(name: string): string {
  return `‹secret:${name}›`;
}

/** `isVaultPlaceholder` without the import cycle: the marker, quoted or not. */
function isVaultPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === '<vault>' || trimmed === '"<vault>"';
}

/* ------------------------------------------------------------------ *
 * The encodings
 * ------------------------------------------------------------------ */

/**
 * The encodings one value is sought under. A process that prints its
 * environment, a page that echoes a field, and an error that quotes a header
 * are the cases; a token in a JSON body is the fourth.
 */
export function encodingsOf(value: string): string[] {
  const out = new Set<string>();
  if (value === '') return [];
  out.add(value);

  // URL-encoded: every reserved character percent-escaped, and the form-style
  // variant where a space is `+`.
  let url = '';
  const formUrl: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    const code = ch.charCodeAt(0);
    const unreserved =
      (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) ||
      ch === '-' || ch === '_' || ch === '.' || ch === '~';
    const piece = unreserved ? ch : '%' + code.toString(16).toUpperCase().padStart(2, '0');
    url += piece;
    formUrl.push(ch === ' ' ? '+' : piece);
  }
  if (url !== value) out.add(url);
  const form = formUrl.join('');
  if (form !== value) out.add(form);

  // JSON-escaped: what the value looks like inside a JSON string literal —
  // the quoting of `"`, `\` and the control characters.
  let json = '';
  for (const ch of value) {
    if (ch === '"') json += '\\"';
    else if (ch === '\\') json += '\\\\';
    else if (ch === '\n') json += '\\n';
    else if (ch === '\r') json += '\\r';
    else if (ch === '\t') json += '\\t';
    else if (ch === '\b') json += '\\b';
    else if (ch === '\f') json += '\\f';
    else if (ch < ' ') json += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    else json += ch;
  }
  if (json !== value) out.add(json);

  // Base64, both alphabets, at each of the three byte alignments. The exact
  // encoding matches a value carried whole; the stable middle of each
  // alignment matches the value inside a longer base64 blob, where its bytes
  // begin at an offset the sender chose.
  const bytes = Buffer.from(value, 'utf8');
  for (const alphabet of ['standard', 'url'] as const) {
    for (let pad = 0; pad < 3; pad++) {
      for (const candidate of base64Of(bytes, pad, alphabet)) out.add(candidate);
    }
  }

  return [...out].filter((s) => s.length > 0);
}

/**
 * The base64 forms of `bytes` preceded by `pad` filler bytes: the whole
 * encoding, and the stable middle that survives embedding in a longer blob.
 *
 * The filler bytes stand for whatever preceded the value in the blob. The
 * characters that mix filler bits with value bits depend on bytes this call
 * does not know, so they are dropped; the characters entirely inside the
 * value's bits are identical whatever preceded it, and those are the match.
 */
function base64Of(bytes: Buffer, pad: number, alphabet: 'standard' | 'url'): string[] {
  const stream = Buffer.concat([Buffer.alloc(pad), bytes]);
  let encoded = stream.toString('base64').replace(/=+$/, '');
  if (alphabet === 'url') encoded = encoded.replaceAll('+', '-').replaceAll('/', '_');
  // Characters fully inside the value's bits: character k covers bit positions
  // [6k, 6k+5]; keep those entirely within [8*pad, 8*(pad+len)).
  const totalBits = 8 * (pad + bytes.length);
  const first = Math.ceil((8 * pad) / 6);
  const last = Math.floor((totalBits - 6) / 6);
  const out = [encoded];
  if (first <= last) {
    const core = encoded.slice(first, last + 1);
    if (core.length >= 4 && core !== encoded) out.push(core);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The automaton
 * ------------------------------------------------------------------ */

/**
 * One Aho–Corasick automaton over every pattern. Built once per change to the
 * secret set, consulted on every scrub: the scan is linear in the text's
 * length whatever the number of patterns. Patterns are matched as UTF-16 code
 * units, the way a string is indexed.
 */
export class SecretAutomaton {
  readonly #names: ReadonlyMap<string, string>; // pattern → secret name
  readonly #short: ReadonlySet<string>;
  readonly #goto = new Map<number, Map<string, number>>();
  readonly #fail = new Map<number, number>();
  /** Node → the patterns that end here, plus every suffix pattern (merged). */
  readonly #output = new Map<number, string[]>();
  #next = 1;

  constructor(patterns: ReadonlyArray<{ pattern: string; name: string }>) {
    this.#names = new Map(patterns.map((p) => [p.pattern, p.name]));
    // Short values match only on token boundaries, so they are tracked
    // separately: a boundary check runs on their hits, never on the others'.
    this.#short = new Set([...this.#names.keys()].filter((p) => p.length < 8));
    this.#build();
  }

  /** How many patterns went in — for the boot line and the tests. */
  get size(): number {
    return this.#names.size;
  }

  #build(): void {
    this.#goto.set(0, new Map());
    for (const pattern of this.#names.keys()) {
      let node = 0;
      for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i]!;
        let next = this.#goto.get(node)!.get(ch);
        if (next === undefined) {
          next = this.#next++;
          this.#goto.get(node)!.set(ch, next);
          this.#goto.set(next, new Map());
          this.#fail.set(next, 0);
        }
        node = next;
      }
      this.#output.set(node, [...(this.#output.get(node) ?? []), pattern]);
    }
    // The failure links, breadth-first, with the suffix outputs merged in.
    const queue: number[] = [...this.#goto.get(0)!.values()];
    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const [ch, next] of this.#goto.get(node)!) {
        let f = this.#fail.get(node)!;
        while (f !== 0 && !this.#goto.get(f)!.has(ch)) f = this.#fail.get(f)!;
        const via = this.#goto.get(f)!.get(ch);
        this.#fail.set(next, via !== undefined && via !== next ? via : 0);
        const inherited = this.#output.get(this.#fail.get(next)!);
        if (inherited) this.#output.set(next, [...(this.#output.get(next) ?? []), ...inherited]);
        queue.push(next);
      }
    }
  }

  /** Every match: pattern, its name, and where it sits in the text. */
  matches(text: string): Array<{ pattern: string; name: string; start: number; end: number }> {
    const found: Array<{ pattern: string; name: string; start: number; end: number }> = [];
    let node = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      while (node !== 0 && !this.#goto.get(node)!.has(ch)) node = this.#fail.get(node)!;
      node = this.#goto.get(node)!.get(ch) ?? 0;
      const hits = this.#output.get(node);
      if (hits === undefined) continue;
      for (const pattern of hits) {
        const start = i - pattern.length + 1;
        if (this.#short.has(pattern) && !this.#atTokenBoundary(text, start, i + 1)) continue;
        found.push({ pattern, name: this.#names.get(pattern)!, start, end: i + 1 });
      }
    }
    return found;
  }

  /** A short pattern counts only where a word could end: not inside a token. */
  #atTokenBoundary(text: string, start: number, end: number): boolean {
    const token = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
    return !token(text[start - 1]) && !token(text[end]);
  }
}

/** Splice the matches in, longest first where they overlap, leftmost first otherwise. */
function replaceMatches(text: string, matches: ReturnType<SecretAutomaton['matches']>): string {
  if (matches.length === 0) return text;
  const sorted = [...matches].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: typeof sorted = [];
  let cursor = -1;
  for (const m of sorted) {
    if (m.start < cursor) continue;
    kept.push(m);
    cursor = m.end;
  }
  let out = '';
  let at = 0;
  for (const m of kept) {
    out += text.slice(at, m.start) + secretMarker(m.name);
    at = m.end;
  }
  return out + text.slice(at);
}

/* ------------------------------------------------------------------ *
 * The process-level scrubber
 * ------------------------------------------------------------------ */

/** One secret as the scrubber holds it: the name that labels the marker, and the value. */
export interface SecretScrubEntry {
  name: string;
  value: string;
}

type ScrubSource = () => Promise<SecretScrubEntry[]>;

let source: ScrubSource | null = null;
let automaton: SecretAutomaton | null = null;
let stale = true;
let building: Promise<void> | null = null;

/**
 * Hand the scrubber its source: the composition root, once per process. `null`
 * detaches (tests). The source is read on every rebuild — a vault that has
 * changed answers differently the next time.
 */
export function setSecretScrubSource(next: ScrubSource | null): void {
  source = next;
  stale = true;
  automaton = null;
}

/** A secret was saved, renamed or deleted: the next ensured rebuild happens. */
export function invalidateSecretScrubber(): void {
  stale = true;
}

/**
 * Build now, from the source. An async choke point calls this before it
 * scrubs, so a secret saved a moment ago is in the automaton that reads its
 * output. Never throws: a source that fails (a locked vault) leaves the last
 * automaton standing, or none — identity.
 */
export async function primeSecretScrubber(): Promise<void> {
  if (source === null) {
    automaton = null;
    stale = false;
    return;
  }
  if (!stale && automaton !== null) return;
  building ??= (async () => {
    try {
      const entries = (await source!()).filter((e) => typeof e.value === 'string' && e.value !== '');
      automaton = new SecretAutomaton(
        entries.flatMap((entry) =>
          encodingsOf(entry.value).map((pattern) => ({ pattern, name: entry.name })),
        ),
      );
      stale = false;
    } catch {
      // A locked vault or a dead database is not a reason to stop logging;
      // the previous automaton, or none, stands until the next prime.
    } finally {
      building = null;
    }
  })();
  await building;
}

/** What `scrubText` currently works from — a boot line, never a value. */
export function secretScrubberSize(): number {
  return automaton?.size ?? 0;
}

/** The one scrub. Linear in the text, identity when nothing is loaded. */
export function scrubText(text: string): string {
  if (automaton === null || text === '') return text;
  return replaceMatches(text, automaton.matches(text));
}

/** Which stored values a text contains, by name and count. Never a value. */
export function findSecretMatches(text: string): Array<{ name: string; count: number }> {
  if (automaton === null || text === '') return [];
  const counts = new Map<string, number>();
  for (const m of automaton.matches(text)) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * How many times one value sits in a set of texts — the save-time look of the
 * Keys and secrets page (owner-secrets §6): the value is not a stored secret
 * yet, so the process automaton does not know it. A one-off automaton over
 * just that value; the texts are read here, the value never leaves.
 */
export function scanTextsForValue(value: string, texts: readonly string[]): number {
  if (value === '') return 0;
  const one = new SecretAutomaton(encodingsOf(value).map((pattern) => ({ pattern, name: 'value' })));
  let count = 0;
  for (const text of texts) {
    if (text === '') continue;
    count += one.matches(text).length;
  }
  return count;
}

/**
 * Replace every form of `value` in a text with `‹secret:NAME›` — the one-tap
 * scrub of the history search (owner-secrets §6). The value comes from the
 * vault, held only in this call.
 */
export function scrubValueFrom(value: string, name: string, text: string): { text: string; count: number } {
  if (value === '' || text === '') return { text, count: 0 };
  const one = new SecretAutomaton(encodingsOf(value).map((pattern) => ({ pattern, name })));
  const matches = one.matches(text);
  return { text: replaceMatches(text, matches), count: matches.length };
}

/**
 * Scrub every string in a JSON-ish value: objects, arrays, and the strings
 * inside them. Keys are scrubbed too — a key may be built from user text as
 * easily as a value. Non-plain objects pass through untouched, and cycles are
 * broken by identity.
 */
export function scrubDeep<T>(value: T): T {
  if (automaton === null) return value;
  return scrubValue(value, new Set()) as T;
}

function scrubValue(value: unknown, seen: Set<object>): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, seen));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value; // a Date, a Buffer, a class instance: not JSON text
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[scrubText(key)] = scrubValue(item, seen);
  }
  return out;
}

/**
 * Where the entries come from: every owner secret by name, and buddi's own
 * keys from the vault under their own names (owner-secrets §5, §7). An env
 * value answers only when the vault has none — the day-1 path still leaves
 * the process in tool output and logs, so it is scrubbed under its own name.
 * The `<vault>` marker is never treated as a value.
 */
export async function loadScrubEntries(
  pool: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> },
  vault: Vault | undefined,
  env: NodeJS.ProcessEnv,
): Promise<SecretScrubEntry[]> {
  const entries: SecretScrubEntry[] = [];
  if (vault !== undefined) {
    const { rows } = await pool.query(`select id, name from core.secrets`);
    for (const row of rows) {
      try {
        const value = await vault.get(ownerSecretVaultName(String(row.id)));
        if (value !== null && value !== '') entries.push({ name: String(row.name), value });
      } catch {
        // Locked or vanished: that one is not in this automaton round.
      }
    }
    for (const name of KNOWN_SECRETS) {
      try {
        const value = await vault.get(name);
        if (value !== null && value.trim() !== '') entries.push({ name, value: value.trim() });
      } catch {
        // As above.
      }
    }
  }
  for (const name of KNOWN_SECRETS) {
    const raw = env[name];
    if (typeof raw !== 'string' || raw.trim() === '' || isVaultPlaceholderValue(raw)) continue;
    if (entries.some((e) => e.name === name && e.value === raw.trim())) continue;
    entries.push({ name, value: raw.trim() });
  }
  return entries;
}