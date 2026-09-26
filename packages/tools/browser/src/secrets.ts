/**
 * Where the owner's secrets go through this plugin (docs/owner-secrets.md
 * §3): the three destinations the manifest registers, and the pure helpers the
 * backends and the tools share.
 *
 * The target a use names is always what the *backend* reported — the field's
 * frame origin as the driver read it, or the focused app's bundle id as macOS
 * reported it — never what the agent claimed, because the agent's claim is the
 * one thing a phishing page controls (§8). `checkTarget` compares that live
 * value against the binding in the exact canonical form `canonicalOrigin`
 * produces, so a look-alike host, a punycode spelling or the right site in a
 * frame on the wrong one is refused before any card is drawn.
 *
 * `deliver` parks the value against the use id and nothing else: the tool that
 * asked takes it the same turn and hands it straight to the driver, which is
 * the one place it goes (the extension backend's loopback socket included,
 * owner-secrets.md §3). There is no read path and no log line carries one.
 */
import type { SecretDestination } from '@buddi/core/plugin';
import { BrowserPreconditionError } from './types.js';

/** The owner's password, TOTP code or sign-in name, into a field of one bound origin. */
export const FIELD_KIND = 'browser.field';
/** Card, account and tax numbers, into a named field on a bound origin — every use a card. */
export const FORM_KIND = 'browser.form.data';
/** Typed into the focused field of a native app, by its bundle id — every use a card. */
export const NATIVE_KIND = 'browser.native.type';

/** What a backend reports about the field a secret is aimed at. Never a value. */
export interface SecretFieldFacts {
  /** The frame's own origin, scheme://host[:port], host lower-cased — not the top page's. */
  origin: string;
  /** Whether the page marks the field as a password. */
  password: boolean;
  /** The field's accessible name, as the page gives it; the form.data target's field. */
  name: string;
}

/**
 * The canonical origin a binding compares: scheme, lower-cased host, port when
 * there is one. Undefined for anything that is not an http(s) address —
 * about:blank, file, sandboxed frames report `null` or their scheme, and none
 * of those is a place a secret can be bound to.
 */
export function canonicalOrigin(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  return parsed.origin;
}

/**
 * The origin a field's frame reports, refused when the frame has none buddi can
 * bind to. A driver calls this on what the frame itself answered.
 */
export function fieldOrigin(url: string | null | undefined): string {
  const origin = canonicalOrigin(url);
  if (origin === undefined) {
    throw new BrowserPreconditionError('That field sits in a frame with no web origin buddi can bind a secret to (about:blank, a file or a sandboxed frame). Observe a page on an http or https address first.');
  }
  return origin;
}

/**
 * The fill-time re-check (§3): the field's frame must still report the origin
 * the use was delivered for. A navigation between the check and the fill — the
 * moment a card's approval was spent — refuses before anything is entered.
 */
export function checkSecretOrigin(url: string | null | undefined, expectedOrigin: string): string {
  const origin = canonicalOrigin(url);
  if (origin === undefined || origin !== expectedOrigin) {
    throw new BrowserPreconditionError('The page moved between the check and the fill; nothing was entered. Observe again and start the fill over.');
  }
  return origin;
}

/** Two origins bind to each other only when both are canonical and equal. */
function sameOrigin(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = canonicalOrigin(a);
  return left !== undefined && left === canonicalOrigin(b);
}

/** The form.data target: exact origin and field name, plain JSON for the row. */
export interface FormTarget { origin: string; field: string }

function formTarget(target: unknown): FormTarget | undefined {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const { origin, field } = target as Record<string, unknown>;
  if (typeof origin !== 'string' || typeof field !== 'string') return undefined;
  if (canonicalOrigin(origin) === undefined) return undefined;
  return { origin, field };
}

/**
 * Whether the owner bound this secret as `browser.field` to the origin the
 * field sits on. Names, kinds and targets only — `ctx.buddi.secrets.list()`
 * never carries a value.
 */
export function fieldBoundTo(bindings: ReadonlyArray<{ kind: string; target: unknown }>, origin: string): boolean {
  return bindings.some((binding) => binding.kind === FIELD_KIND && sameOrigin(binding.target, origin));
}

/**
 * Which destination one fill takes (§3): a TOTP code goes into `browser.field`
 * whatever the field is (OTP fields are text), and so does a password. A
 * visible field takes `browser.field` too when the owner bound the secret as
 * `browser.field` to that field's origin — a username is always a visible
 * field — and anything else is form data, which is a card every time. So a
 * password field never takes a form-data-only secret, and a card number bound
 * as form data never skips its card. The caller learns `totp` and the bindings
 * from `ctx.buddi.secrets.list()` and `password` from the backend.
 */
export function secretKindFor(totp: boolean, password: boolean, fieldBound = false): typeof FIELD_KIND | typeof FORM_KIND {
  return totp || password || fieldBound ? FIELD_KIND : FORM_KIND;
}

/** Values delivered and not yet taken, by use id — `email`'s credentials pattern. */
const handed = new Map<string, string>();

/** The value one use delivered, taken exactly once. Undefined when there is none. */
export function takeDelivered(use: string): string | undefined {
  const value = handed.get(use);
  handed.delete(use);
  return value;
}

function deliver(value: string, _target: unknown, { use }: { use: string }): void {
  handed.set(use, value);
}

/**
 * A `browser.field` use's target: the origin, or for a visible field the
 * origin and the field's name, so the card says exactly where it goes. The
 * binding is always the origin alone.
 */
function fieldTargetOrigin(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const { origin, field } = target as Record<string, unknown>;
  return typeof origin === 'string' && typeof field === 'string' ? origin : undefined;
}

/** `browser.field`: the owner's secret into a field of one exact origin. */
export const fieldDestination: SecretDestination = {
  kind: FIELD_KIND,
  maxRule: 'pre-approved',
  checkTarget: (target, bound) => typeof bound === 'string' && sameOrigin(fieldTargetOrigin(target), bound),
  describe(target) {
    if (typeof target === 'string') return `the page at ${target}`;
    const asked = formTarget(target);
    return asked === undefined ? 'a page field' : `the ${asked.field} field on ${asked.origin}`;
  },
  deliver,
};

/**
 * `browser.form.data`: a named field on a bound origin. Every use a card, and
 * the use row records the field — the target carries it (§3).
 */
export const formDataDestination: SecretDestination = {
  kind: FORM_KIND,
  maxRule: 'every-time',
  checkTarget(target, bound) {
    const asked = formTarget(target);
    const owned = formTarget(bound);
    if (asked === undefined || owned === undefined) return false;
    if (!sameOrigin(asked.origin, owned.origin)) return false;
    return asked.field === owned.field;
  },
  describe(target) {
    const asked = formTarget(target);
    return asked === undefined ? 'a form field' : `the field "${asked.field}" on ${asked.origin}`;
  },
  deliver,
};

/** `browser.native.type`: typed into the focused field of one app, by bundle id. */
export const nativeTypeDestination: SecretDestination = {
  kind: NATIVE_KIND,
  maxRule: 'every-time',
  checkTarget: (target, bound) => typeof target === 'string' && typeof bound === 'string' && target.trim().length > 0 && target === bound,
  describe: (target) => `the app ${String(target)}`,
  deliver,
};