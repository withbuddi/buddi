/**
 * Words and shapes the Keys and secrets page reads and writes
 * (docs/owner-secrets.md §6), kept out of the component so the rules
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
import type { SecretListingView, SecretRule, SecretUserView } from '../api';
import { fmtRelative } from '../format';
import { NEEDS_ROUTE, accountRoute, connectionRoute, pluginSettingsRoute, settingsRoute } from '../routes';
// The browser plugin's own rule for a wildcard origin and its public-suffix
// list: pure files with no dependencies, read here so the form refuses
// exactly what the destination would.
import { isOriginPattern, parseOriginPattern } from '../../../tools/browser/src/origin-pattern';

/** Strictest first, the same order core's `SECRET_RULES` keeps. */
export const SECRET_RULES: readonly SecretRule[] = ['every-time', 'first-time', 'pre-approved'];

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

/** The one line a secret with no binding says on the page (§2). */
export const UNBOUND_LINE = 'Stored, not usable until it has a binding.';

/**
 * What one binding's target input asks for, in the owner's words: the shape,
 * with an example. For a two-part kind the second part never holds a space
 * (a header name, a variable name, a field name), so the placeholder shows
 * the parts separated by one.
 */
export function targetPlaceholder(kind: string): string {
  if (kind === 'browser.field') return 'the origin of the site that holds the field, e.g. https://en.wikipedia.org or *.wikimedia.org';
  if (kind === 'browser.form.data') return 'the origin, then the field name — e.g. https://localhost:8443 card-number';
  if (kind === 'browser.native.type') return 'the app’s bundle id, e.g. com.bank.app';
  if (kind === 'http.header') return 'the host, then the header name — e.g. localhost:9200 Authorization';
  if (kind === 'http.url') return 'the plugin, then the host — e.g. calendar calendar.google.com';
  if (kind === 'http.basic') return 'the plugin, then the host — e.g. calendar *.icloud.com';
  if (kind === 'http.bearer') return 'the plugin, then the host — e.g. calendar www.googleapis.com';
  if (kind === 'developer.env') return 'the workspace, then the variable name — e.g. cour des comptes ADMIN_PASSWORD';
  if (isAccountKind(kind)) return 'the account id, e.g. acct-1';
  return 'the place, as JSON — e.g. {"host":"localhost","header":"Authorization"}';
}

/** The two-part kinds, and the JSON each pair builds. */
const TWO_PART_KINDS: Record<string, { hint: string; build: (first: string, second: string) => Record<string, string> }> = {
  'browser.form.data': { hint: 'an origin, then the field name', build: (origin, field) => ({ origin, field }) },
  'http.header': { hint: 'a host, then the header name', build: (host, header) => ({ host, header }) },
  'http.url': { hint: 'a plugin, then the host', build: (plugin, host) => ({ plugin, host }) },
  'http.basic': { hint: 'a plugin, then the host', build: (plugin, host) => ({ plugin, host }) },
  'http.bearer': { hint: 'a plugin, then the host', build: (plugin, host) => ({ plugin, host }) },
  'developer.env': { hint: 'a workspace, then the variable name', build: (workspace, variable) => ({ workspace, variable }) },
};

/** What one text input stands for: `{ ok, target }` or why not. */
export type TargetParse = { ok: true; target: unknown } | { ok: false; error: string };

/** The one sentence for each way a wildcard can be wrong. */
export const WILDCARD_PLACEMENT = 'A wildcard may only stand for the leftmost part of a site, like *.wikimedia.org.';
const publicSuffixSentence = (pattern: string) => `That is a public suffix; ${pattern} would match every site.`;
const ORIGIN_EXAMPLE = 'Give the site as an origin, like https://en.wikipedia.org.';

/**
 * A browser binding's origin, the way the destination compares it: scheme,
 * lower-cased host, port. A bare host is what people type; https is what
 * they mean. `*.wikimedia.org` is a wildcard origin — `*.` for the leftmost
 * labels only, never on a public suffix.
 */
function originInput(raw: string): TargetParse {
  // Joined at runtime on purpose: the bundle check reads a whole `https://…`
  // literal as a place this page might reach, and a minifier folds a template.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : ['https:', '//', raw].join('');
  if (isOriginPattern(raw)) {
    const parsed = parseOriginPattern(withScheme);
    if (parsed.ok) return { ok: true, target: parsed.value.pattern };
    if (parsed.reason === 'placement') return { ok: false, error: WILDCARD_PLACEMENT };
    if (parsed.reason === 'public-suffix') {
      const typed = withScheme.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#:].*$/, '').toLowerCase();
      return { ok: false, error: publicSuffixSentence(typed) };
    }
    return { ok: false, error: ORIGIN_EXAMPLE };
  }
  try {
    const url = new URL(withScheme);
    if (url.origin === 'null' || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error('not an origin');
    return { ok: true, target: url.origin };
  } catch {
    return { ok: false, error: ORIGIN_EXAMPLE };
  }
}

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
  if (kind === 'browser.field') return originInput(raw);
  if (kind === 'browser.native.type' || isAccountKind(kind)) return { ok: true, target: raw };
  const two = TWO_PART_KINDS[kind];
  if (two === undefined) return { ok: true, target: raw };
  const parts = lastTwoParts(raw);
  if (parts === null) return { ok: false, error: `${kind} needs both: ${two.hint}.` };
  if (kind === 'browser.form.data') {
    const origin = originInput(parts[0]);
    if (!origin.ok) return origin;
    return { ok: true, target: two.build(origin.target as string, parts[1]) };
  }
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

/** The kind a model account's credential is bound with; its target is the account id. */
export const PROVIDER_ACCOUNT_KIND = 'accounts.provider';

/** A model account as this page names it: the owner's label and which provider it is. */
export interface AccountName {
  label: string;
  provider: string;
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
/* ------------------------------------------------------------------ *
 * The page's words for a secret (the redesign of 2026-10-01): which group
 * it sits in, the human name, one line on where it may go, the problem as a
 * sentence with its one fix, and "not used by anything". Never an id or a
 * stored name in any of these — those live behind the sheet's Details.
 * ------------------------------------------------------------------ */

/** The groups, in page order; a plugin's own group sits between Mail and the read-only two. */
export type SecretGroupId = 'mine' | 'mail' | 'models' | 'connections' | `plugin:${string}`;

/** The names buddi generates for a credential it keeps for a row: they never belong to "Your secrets". */
const MODEL_NAME = /^(PROVIDER_ACCOUNT_|CODEX_ACCOUNT_|ANTHROPIC_ACCOUNT_|OLLAMA_DEVICE_)/;
const CONNECTION_NAME = /^MCP_(TOKEN|ENV|CONNECTION)_/;
/** The old `.env` mailbox password: Mail's, whatever its bindings say. */
export const LEGACY_MAILBOX_SECRET = 'GMAIL_APP_PASSWORD';

/** Which group a secret sits in: what holds it first, then what it is bound to, then its own. */
export function secretGroup(secret: SecretListingView): SecretGroupId {
  const users = secret.usedBy ?? [];
  const kinds = secret.bindings.map((binding) => binding.kind);
  if (users.some((u) => u.kind === 'mailbox') || kinds.includes('email.account') || secret.name === LEGACY_MAILBOX_SECRET) return 'mail';
  if (users.some((u) => u.kind === 'model-account') || kinds.includes(PROVIDER_ACCOUNT_KIND) || MODEL_NAME.test(secret.name)) return 'models';
  if (users.some((u) => u.kind === 'connection') || kinds.includes('mcp.env') || CONNECTION_NAME.test(secret.name)) return 'connections';
  for (const binding of secret.bindings) {
    if ((binding.kind === 'http.url' || binding.kind === 'http.basic' || binding.kind === 'http.bearer') && isRecord(binding.target) && typeof binding.target.plugin === 'string') return `plugin:${binding.target.plugin}`;
    if (isAccountKind(binding.kind)) return `plugin:${binding.kind.slice(0, -'.account'.length)}`;
  }
  return 'mine';
}

/** A group's heading and its quiet aside. */
export function groupHeading(group: SecretGroupId): { title: string; aside: string } {
  if (group === 'mine') return { title: 'Your secrets', aside: 'Agents fill these where you allow, without seeing them.' };
  if (group === 'mail') return { title: 'Mail', aside: 'Mailbox passwords. A new one is set on the Email page, which tests it first.' };
  if (group === 'models') return { title: 'Model accounts', aside: 'Managed in Model accounts.' };
  if (group === 'connections') return { title: 'Connections', aside: 'Managed in Connections.' };
  const plugin = group.slice('plugin:'.length);
  if (plugin === 'calendar') return { title: 'Calendar links and sign-ins', aside: 'Private links and app passwords, used only by the calendar plugin.' };
  return { title: plugin.charAt(0).toUpperCase() + plugin.slice(1), aside: `Kept for the ${plugin} plugin.` };
}

/** Page order: Your secrets, Mail, the plugins' groups by name, then the two managed elsewhere. */
export function groupOrder(a: SecretGroupId, b: SecretGroupId): number {
  const rank = (g: SecretGroupId): number => (g === 'mine' ? 0 : g === 'mail' ? 1 : g === 'models' ? 3 : g === 'connections' ? 4 : 2);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** Whether the owner changes a group's secrets on this page; the other two link to where they are managed. */
export function isManagedElsewhere(group: SecretGroupId): boolean {
  return group === 'models' || group === 'connections';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A site as a person says it: no scheme, no `www.`, a wildcard as "any … site". */
export function siteWords(origin: string): string {
  const host = origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return host.startsWith('*.') ? `any ${host.slice(2)} site` : host;
}

const mailboxesOf = (secret: SecretListingView) => (secret.usedBy ?? []).flatMap((u) => (u.kind === 'mailbox' ? [u] : []));
const modelOf = (secret: SecretListingView) => (secret.usedBy ?? []).find((u) => u.kind === 'model-account') as Extract<SecretUserView, { kind: 'model-account' }> | undefined;
const connectionOf = (secret: SecretListingView) => (secret.usedBy ?? []).find((u) => u.kind === 'connection') as Extract<SecretUserView, { kind: 'connection' }> | undefined;

/**
 * The human name of a secret: a mailbox's provider and what kind of
 * password it is, a model account's label, a connection's name, a plugin
 * secret's own words after its "Calendar link: " prefix, the owner's own name.
 */
export function secretTitle(secret: SecretListingView, accounts: ReadonlyMap<string, AccountName> = new Map()): string {
  const group = secretGroup(secret);
  if (group === 'mail') {
    const mailbox = mailboxesOf(secret)[0];
    if (!mailbox) return 'Old mailbox password';
    const provider = mailbox.provider === 'Email' ? 'Mailbox' : mailbox.provider;
    return `${provider} ${mailbox.auth === 'xoauth2' ? 'sign-in' : 'app password'}`;
  }
  if (group === 'models') {
    const model = modelOf(secret);
    const id = model?.id ?? secret.bindings.find((b) => b.kind === PROVIDER_ACCOUNT_KIND && typeof b.target === 'string')?.target;
    const known = typeof id === 'string' ? accounts.get(id) : undefined;
    return known?.label ?? model?.label ?? 'Old model account key';
  }
  if (group === 'connections') return connectionOf(secret)?.name ?? 'Old connection sign-in';
  if (group.startsWith('plugin:')) {
    const words = /^[^:]{1,40}:\s+(.+)$/.exec(secret.name);
    return words ? words[1]! : secret.name;
  }
  if (secret.login) return `Login · ${secret.login.site}`;
  return secret.name;
}

/** A user name as the page says it: an address's mailbox and "@…", anything long cut short. Not a secret, but not shouted either. */
export function shortUsername(username: string): string {
  const at = username.indexOf('@');
  if (at > 0) return `${username.slice(0, Math.min(at, 24))}@…`;
  return username.length > 24 ? `${username.slice(0, 23)}…` : username;
}

/** "3 Oct": the day a login was saved, as a row says it. */
export function savedDay(iso: string, timezone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(timezone ? { timeZone: timezone } : {}) }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(at);
  }
}

/**
 * A login buddi kept from the owner's own sign-in (docs/browser.md, "Saving a
 * sign-in"): "for sam@… · saved 3 Oct". Null for any other secret.
 */
export function loginLine(secret: SecretListingView, timezone?: string): string | null {
  const login = secret.login;
  if (!login) return null;
  const day = savedDay(login.savedAt, timezone);
  return [login.username ? `for ${shortUsername(login.username)}` : null, day ? `saved ${day}` : null].filter(Boolean).join(' · ');
}

/** A model account's provider beside its name ("Anthropic"), when the account is known. */
export function secretTag(secret: SecretListingView, accounts: ReadonlyMap<string, AccountName>): string | null {
  if (secretGroup(secret) !== 'models') return null;
  const id = modelOf(secret)?.id ?? secret.bindings.find((b) => b.kind === PROVIDER_ACCOUNT_KIND && typeof b.target === 'string')?.target;
  return typeof id === 'string' ? accounts.get(id)?.provider ?? null : null;
}

/** One place a binding lets the value go, in the owner's words. */
export function placeWords(kind: string, target: unknown): string {
  const obj = isRecord(target) ? target : {};
  const str = (key: string): string => (typeof obj[key] === 'string' ? (obj[key] as string) : '');
  if (kind === 'browser.field' && typeof target === 'string') return `Filled on ${siteWords(target)}`;
  if (kind === 'browser.form.data' && str('origin')) return `Filled into “${str('field')}” on ${siteWords(str('origin'))}`;
  if (kind === 'browser.native.type' && typeof target === 'string') return `Typed into the app ${target}`;
  if ((kind === 'http.header' || kind === 'http.url' || kind === 'http.basic' || kind === 'http.bearer') && str('host')) return `Sent only to ${str('host')}`;
  if (kind === 'developer.env' && str('variable')) return `Given to ${str('workspace')} as ${str('variable')}`;
  if (kind === 'mcp.env' && str('variable')) return `Given to a program as ${str('variable')}`;
  if (kind === 'email.account') return 'Used by a mailbox';
  if (kind === PROVIDER_ACCOUNT_KIND) return 'Used by a model account';
  if (isAccountKind(kind)) return `Used by a ${kind.slice(0, -'.account'.length)} account`;
  return `Goes to ${renderTarget(kind, target)}`;
}

/** A use in the history, in the owner's words: where it went. */
export function useWords(kind: string, target: unknown): string {
  if (isAccountKind(kind) || kind === PROVIDER_ACCOUNT_KIND) return 'Signed in';
  return placeWords(kind, target).replace(/^Sent only to/, 'Sent to');
}

const AUTH_LINES: Record<string, string> = {
  'api-key': 'API key for this model account',
  chatgpt: 'ChatGPT sign-in for this model account',
  'anthropic-oauth': 'Claude sign-in for this model account',
  'device-key': 'Ollama device key for this model account',
};

/** "and" between the last two: "a, b and c". */
function andList(items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The one line under a secret's name on where it may go: who holds it for
 * the groups something holds, else its places — "Filled on pnc.com", "Sent
 * only to calendar.google.com" — with when it asks the owner, when it does,
 * and that a one-time-code secret fills a fresh code. Empty when nothing
 * may use it yet (the problem line says so).
 */
export function whereLine(secret: SecretListingView): string {
  const group = secretGroup(secret);
  if (group === 'mail') {
    const mailboxes = mailboxesOf(secret).map((m) => m.address);
    if (mailboxes.length) return `Used by the ${mailboxes.length === 1 ? 'mailbox' : 'mailboxes'} ${andList(mailboxes)}`;
    return secret.name === LEGACY_MAILBOX_SECRET ? 'From the old .env setup' : 'No mailbox uses it';
  }
  if (group === 'models') {
    const model = modelOf(secret);
    return model ? AUTH_LINES[model.auth] ?? 'Key for this model account' : 'No model account uses it';
  }
  if (group === 'connections') {
    const connection = connectionOf(secret);
    if (connection?.variable) return `Given to the program as ${connection.variable}`;
    const header = secret.bindings.find((b) => b.kind === 'http.header');
    const host = header && isRecord(header.target) && typeof header.target.host === 'string' ? header.target.host : null;
    return host ? `Sign-in token · sent only to ${host}` : connection ? 'Sign-in for this connection' : 'No connection uses it';
  }
  if (secret.bindings.length === 0) return '';
  // Saved on a sign-in card for one site: its page, the site and every host under it read as that one site.
  const site = oneSite(secret);
  const places = site ? [`Filled on ${site}`] : secret.bindings.map((b) => placeWords(b.kind, b.target));
  let line = places.length <= 2 ? places.join(' · ') : `${places[0]} and ${places.length - 1} more places`;
  const rules = new Set(secret.bindings.map((b) => (b.rule === 'first-time' && b.firstApprovedAt !== null ? 'pre-approved' : b.rule)));
  if (rules.size === 1 && rules.has('every-time')) line += ' · asks you every time';
  if (rules.size === 1 && rules.has('first-time')) line += ' · asks you the first time';
  if (secret.totp) line += ' · a fresh code each time';
  return line;
}

/**
 * The site a secret saved on a sign-in card goes to, when every place it may
 * go is a page of that site (`https://wikipedia.org`, `https://*.wikipedia.org`,
 * `https://en.wikipedia.org`). Null otherwise.
 */
function oneSite(secret: SecretListingView): string | null {
  const site = secret.savedFrom?.site;
  if (!site) return null;
  const under = (target: unknown): boolean => {
    if (typeof target !== 'string') return false;
    const host = target.replace(/^https?:\/\//, '').replace(/:\d+$/, '').replace(/^\*\./, '').replace(/^www\./, '');
    return host === site || host.endsWith(`.${site}`);
  };
  return secret.bindings.every((b) => b.kind === 'browser.field' && under(b.target)) ? site : null;
}

/** "Last used 5 minutes ago" or "Never used". */
export function lastUsedLine(secret: SecretListingView, now = Date.now()): string {
  return secret.lastUse ? `Last used ${fmtRelative(secret.lastUse.at, now)}` : 'Never used';
}

/** The one fix a problem offers: open a form here, or go where it is fixed. */
export type SecretFix =
  | { label: string; action: 'replace' | 'places' }
  | { label: string; href: string };

export interface SecretProblem {
  text: string;
  fix: SecretFix | null;
}

/** Where a mailbox's password is set again: its row's form on the Email page, which tests the login first. */
export function mailboxPasswordHref(mailboxId: string): string {
  return pluginSettingsRoute('email', 'settings', { account: mailboxId, set: 'password' });
}

/** Where a secret managed elsewhere is managed: its model account or connection, opened. */
export function managedHref(secret: SecretListingView): { label: string; href: string } | null {
  const group = secretGroup(secret);
  if (group === 'models') {
    const id = modelOf(secret)?.id;
    return { label: 'Managed in Model accounts', href: id ? accountRoute(id) : settingsRoute('accounts') };
  }
  if (group === 'connections') {
    const id = connectionOf(secret)?.id;
    return { label: 'Managed in Connections', href: id ? connectionRoute(id) : settingsRoute('connections') };
  }
  return null;
}

/** The place a "not bound" refusal names, when it can be said without an id. */
function refusedPlace(detail: string): string | null {
  const match = /is not bound to (.+?)\.?$/.exec(detail);
  if (!match) return null;
  const place = match[1]!;
  return /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(place) ? null : place;
}

/**
 * What is wrong with a secret, as one sentence, and the one thing that fixes
 * it. "Held back" is the truthful word for a refusal: buddi itself declined
 * to hand the value over (not bound to that place, no value, the vault
 * locked) and the value never left. A mailbox the mail server turned down is
 * the Email page's own record. Null when nothing is wrong — and for a secret
 * nothing uses any more, which has its own quiet line instead.
 */
export function secretProblem(secret: SecretListingView, now = Date.now()): SecretProblem | null {
  if (secret.unused) return null;
  const group = secretGroup(secret);
  const mailbox = mailboxesOf(secret)[0];
  const managed = managedHref(secret);
  const setValue = (): SecretFix | null => {
    if (mailbox) return { label: 'Set password', href: mailboxPasswordHref(mailbox.id) };
    if (managed) return { label: group === 'models' ? 'Fix in Model accounts' : 'Fix in Connections', href: managed.href };
    return { label: 'Set a value', action: 'replace' };
  };
  const last = secret.lastUse;
  const ago = last ? fmtRelative(last.at, now) : '';
  const detail = last?.detail ?? '';
  if (secret.hasValue === false || (last?.outcome === 'refused' && /has no value stored/.test(detail))) {
    return { text: 'No value stored.', fix: setValue() };
  }
  if (mailbox?.loginFailedAt) {
    const who = mailbox.provider === 'Email' ? 'The mail server' : mailbox.provider;
    return { text: `${who} turned it down at sign-in ${fmtRelative(mailbox.loginFailedAt, now)}.`, fix: { label: 'Set password', href: mailboxPasswordHref(mailbox.id) } };
  }
  if (last?.outcome === 'refused') {
    if (/vault is locked/.test(detail)) return { text: `Held back ${ago}: the vault was locked.`, fix: null };
    if (/TOTP secret/.test(detail)) return { text: `Held back ${ago}: a one-time code goes only into a field on a website.`, fix: null };
    if (/is not bound to/.test(detail)) {
      const place = group === 'mine' ? refusedPlace(detail) : null;
      return {
        text: place ? `Held back ${ago}: it was asked for at ${place}, where it may not go.` : `Held back ${ago}: it was asked for somewhere it may not go.`,
        fix: group === 'mine' ? { label: 'Change where it may go', action: 'places' } : null,
      };
    }
    return { text: `Held back ${ago}: ${refusalWords(detail || null)}.`, fix: null };
  }
  if (last?.outcome === 'failed') {
    const fix = mailbox ? setValue() : managed ? null : { label: 'Replace value', action: 'replace' as const };
    return { text: `Didn’t go through ${ago}${detail ? `: ${detail.replace(/\.$/, '')}` : ''}.`, fix };
  }
  if (last?.outcome === 'pending') return { text: `Waiting for your approval since ${ago}.`, fix: { label: 'Review', href: NEEDS_ROUTE } };
  if (group === 'mine' && secret.bindings.length === 0) {
    return { text: 'Can’t be used anywhere until you choose where it may go.', fix: { label: 'Choose where it may go', action: 'places' } };
  }
  return null;
}

/** The quiet line of a secret nothing reaches any more; empty when something does. */
export function unusedLine(secret: SecretListingView): string {
  if (!secret.unused) return '';
  const group = secretGroup(secret);
  if (group === 'mail') return 'Not used by anything — no mailbox uses it any more.';
  if (group === 'models') return 'Not used by anything — no model account uses it any more.';
  if (group === 'connections') return 'Not used by anything — no connection uses it any more.';
  return 'Not used by anything — what it was for is gone.';
}

/** The quiet note when the server could not check what holds a secret: no Remove then. */
export function uncheckedLine(secret: SecretListingView): string {
  return secret.usageUnknown && !secret.unused ? 'Couldn’t check what uses it just now.' : '';
}

/** Whether the page offers Remove: only for a confirmed unused secret, and never in a group managed elsewhere. */
export function offersRemove(secret: SecretListingView): boolean {
  return Boolean(secret.unused) && !isManagedElsewhere(secretGroup(secret));
}

/** What a delete stops, in one sentence, for the dialog that asks. */
export function deleteStops(secret: SecretListingView): string {
  if (secret.unused || secret.bindings.length === 0) return 'Nothing uses it, so nothing stops working.';
  const where = whereLine(secret).split(' · ')[0] ?? '';
  if (where.startsWith('Filled on ')) return `Agents can no longer fill it on ${where.slice('Filled on '.length)}.`;
  if (where.startsWith('Sent only to ')) return `Agents can no longer send it to ${where.slice('Sent only to '.length)}.`;
  return `Whatever uses it stops working: ${where.charAt(0).toLowerCase()}${where.slice(1)}.`;
}

/** A binding's rule as the sheet says it. */
export const RULE_ASKS: Record<SecretRule, string> = {
  'every-time': 'Every time',
  'first-time': 'The first time, then not again',
  'pre-approved': 'Never — allowed ahead of time',
};

/** A destination kind as the "where it may go" form names it. */
export function kindWords(kind: string): string {
  const words: Record<string, string> = {
    'browser.field': 'A field on a website',
    'browser.form.data': 'A form field, by its name',
    'browser.native.type': 'An app on this computer',
    'http.header': 'A request to a host',
    'http.url': 'A plugin’s web address',
    'http.basic': 'A plugin’s sign-in',
    'http.bearer': 'A plugin’s account sign-in',
    'developer.env': 'A workspace variable',
    'mcp.env': 'A program’s variable',
    [PROVIDER_ACCOUNT_KIND]: 'A model account',
  };
  if (words[kind]) return words[kind]!;
  if (isAccountKind(kind)) return `A ${kind.slice(0, -'.account'.length)} account`;
  return kind;
}

/** The rule as the form's "Asks you" picks it. */
export const RULE_CHOICES: Record<SecretRule, string> = {
  'every-time': 'Every time',
  'first-time': 'The first time',
  'pre-approved': 'Never',
};

/** A refusal's recorded sentence in the page's words: "asked for at uploads.github.com, where it may not go". */
export function refusalWords(detail: string | null): string {
  if (!detail) return 'buddi didn’t hand it over';
  if (/has no value stored/.test(detail)) return 'no value was stored';
  if (/vault is locked/.test(detail)) return 'the vault was locked';
  if (/TOTP secret/.test(detail)) return 'a one-time code goes only into a field on a website';
  const place = /is not bound to/.test(detail) ? refusedPlace(detail) : undefined;
  if (place !== undefined) return place ? `asked for at ${place}, where it may not go` : 'asked for somewhere it may not go';
  return detail.replace(/\.$/, '');
}

/** A short example of a place, for the form's input: the shape at a glance. */
export function placeExample(kind: string): string {
  if (kind === 'browser.field') return 'www.pnc.com';
  if (kind === 'browser.form.data') return 'www.pnc.com card-number';
  if (kind === 'browser.native.type') return 'com.bank.app';
  if (kind === 'http.header') return 'api.github.com Authorization';
  if (kind === 'http.url') return 'calendar calendar.google.com';
  if (kind === 'http.basic') return 'calendar caldav.fastmail.com';
  if (kind === 'http.bearer') return 'calendar www.googleapis.com';
  if (kind === 'developer.env') return 'my-app ADMIN_PASSWORD';
  if (isAccountKind(kind)) return 'acct-1';
  return '{"host":"localhost","header":"Authorization"}';
}

/** The rule a new place starts at: "the first time" where the kind allows it — never looser by default. */
export function defaultRule(maxRule: SecretRule): SecretRule {
  return allowedRules(maxRule).includes('first-time') ? 'first-time' : maxRule;
}

/** One use in the history, in words: what became of it. */
export function historyWords(use: { kind: string; target: unknown; outcome: string; detail: string | null }): { text: string; tone?: 'warning' } {
  const where = useWords(use.kind, use.target);
  if (use.outcome === 'refused') return { text: `Held back — ${refusalWords(use.detail)}`, tone: 'warning' };
  if (use.outcome === 'failed') return { text: `Didn’t go through — ${(use.detail ?? where).replace(/\.$/, '')}`, tone: 'warning' };
  if (use.outcome === 'pending') return { text: `Asked for your approval · ${where}` };
  return { text: where };
}
