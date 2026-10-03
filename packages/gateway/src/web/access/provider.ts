/**
 * Trusted access providers (specs/trusted-access.md §3).
 *
 * Something in front of buddi proves who is knocking — Tailscale's daemon,
 * Cloudflare Access's signed JWT, later the withbuddi relay's signed pass —
 * buddi checks that proof itself, and then buddi's own `remote` session rules
 * apply: 12 hours idle, CSRF, exact Origin, approvals, the lock screen.
 *
 * A provider is a core module, one file per provider, never a plugin: sign-in
 * is the one thing a plugin must never be able to widen. This file is the
 * shape every provider has; `registry.ts` holds the ones this gateway runs.
 *
 * The rules every provider keeps:
 *
 * - `identify` never throws, and never trusts a header alone. "Could not ask"
 *   (a daemon, a JWKS endpoint, a relay that did not answer) is its own
 *   answer, `unanswered`, which never ends a session and never counts as a
 *   failed sign-in.
 * - `matches` decides by how a request arrived (`arrival.ts`), never by a
 *   header alone.
 * - Neither a header nor a provider identity ever yields a `local` session.
 */
import type { IncomingMessage } from 'node:http';
import type { Arrival } from './arrival.js';

/** The providers there are. `withbuddi` is the relay (provider 3), not built yet. */
export type AccessProviderId = 'tailscale' | 'cloudflare-access' | 'withbuddi';

export const ACCESS_PROVIDER_IDS: readonly AccessProviderId[] = ['tailscale', 'cloudflare-access', 'withbuddi'];

export function isAccessProviderId(value: unknown): value is AccessProviderId {
  return typeof value === 'string' && (ACCESS_PROVIDER_IDS as readonly string[]).includes(value);
}

/** A verified identity, as a provider hands it to the session it mints. */
export interface AccessIdentity {
  provider: AccessProviderId;
  /**
   * Who it is: the login (Tailscale), the email (Cloudflare Access), or the
   * account id (the relay's device identity). What `confirm` checks again.
   */
  subject: string;
  /** A name to greet, when the provider has one. Never a credential. */
  name?: string | undefined;
  /**
   * Whatever else the provider keeps on the session row, as strings: a
   * tailnet address, an issuer, a device label. Shown, never trusted.
   */
  detail?: Record<string, string> | undefined;
  /**
   * The rate-limit bucket this request belongs to, now that it verified
   * (Cloudflare's `Cf-Connecting-Ip`, the relay's client address).
   */
  bucket?: string | undefined;
  /** This identity's own end, when it has one shorter than the provider's cap (a JWT's `exp`). */
  expiresAt?: Date | undefined;
}

/**
 * Why a request earned no identity: a fixed name the provider logs and the
 * signed-out page may say in words. Never a supplied value.
 */
export interface AccessRefusal {
  refusal: string;
  /** The sentence the log and the page say. Never holds a supplied login or address. */
  sentence: string;
  /**
   * `unanswered`: the provider could not be asked (keep the session, 503).
   * `login`: set up, and this person is not the one it allows.
   * `other`: anything else; the request is simply unauthenticated.
   */
  kind: 'unanswered' | 'login' | 'other';
}

export type AccessIdentifyResult = { ok: true; identity: AccessIdentity } | ({ ok: false } & AccessRefusal);

/**
 * What a provider says on every request of a session it minted:
 * `keep` it; `end` it (the identity changed or was withdrawn); `refuse` this
 * request alone (401, the session stays — a stray request without
 * Cloudflare's header must not sign the owner out); `unanswered` (503, the
 * session stays).
 */
export type AccessConfirmation =
  | { answer: 'keep'; refusal?: undefined }
  | { answer: 'end' | 'refuse' | 'unanswered'; refusal?: AccessRefusal | undefined };

export type AccessState = 'off' | 'needs-setup' | 'waiting' | 'ready' | 'unanswered';

export interface AccessStatus {
  state: AccessState;
  /** One sentence for the panel's row and for `buddi doctor`. */
  sentence: string;
}

/** One line of the panel's setup copy; a Copy button sits beside `command`. */
export interface AccessSetupStep {
  text: string;
  command?: string | undefined;
}

/** A field the provider stores, as the shared panel draws it. */
export interface AccessField {
  key: string;
  label: string;
  hint?: string | undefined;
  placeholder?: string | undefined;
}

/** The panel's copy and fields. Text, never React: one shared panel draws every provider. */
export interface AccessSetup {
  steps: AccessSetupStep[];
  fields: AccessField[];
}

/** What a provider may ask of the gateway it runs in. */
export interface AccessContext {
  /** The port the dashboard is bound to. */
  dashboardPort: () => number;
  /** The ingress listener's port, or null while it is not listening. */
  ingressPort: () => number | null;
  /** The configured public origin, if any. */
  publicOrigin: () => string | undefined;
}

/** The session fields a provider re-checks. */
export interface AccessSessionView {
  provider?: AccessProviderId | undefined;
  providerSubject?: string | undefined;
  providerDetail?: Record<string, string> | undefined;
}

export interface AccessProvider<S = unknown> {
  readonly id: AccessProviderId;
  /** What the panel's row says. */
  readonly title: string;
  /** `login` names a person; `device` names a browser that finished a sign-in (§3.2). */
  readonly identity: 'login' | 'device';
  /** Whether the proxy runs on this machine (`tailscale serve`, cloudflared) or elsewhere (the relay). */
  readonly proxy: 'this-machine' | 'elsewhere';
  /** The listener its requests arrive on. */
  readonly arrival: Arrival;
  /** The key its settings are stored under in `core.web_settings`. */
  readonly settingKey: string;
  /** The hard cap on a session, on top of the 12-hour idle rule. */
  readonly absoluteCapMs: number;

  /** What is stored, made safe: anything unexpected reads as off. */
  parseSetting(raw: unknown): S;
  enabled(setting: S): boolean;
  /** The subject this setting allows, for "is this the same person" checks. */
  allowed(setting: S): string;
  status(setting: S, ctx: AccessContext): Promise<AccessStatus>;
  setup(setting: S, ctx: AccessContext): AccessSetup;
  /**
   * Did this request come through me? By arrival first; a provider on the
   * main listener (Tailscale) may then look for its own headers, which only
   * ever narrows.
   */
  matches(req: IncomingMessage): boolean;
  /** Who this request is, verified, or why not. Null: the request makes no claim at all. */
  identify(req: IncomingMessage, setting: S, now: Date): Promise<AccessIdentifyResult | null>;
  confirm(session: AccessSessionView, req: IncomingMessage, setting: S, now: Date): Promise<AccessConfirmation>;
  /**
   * The rate-limit bucket for a request that arrived its way (§7.5), before
   * anything verified; a verified identity names its own (`bucket`).
   */
  clientKey(req: IncomingMessage): string;
}

/** Two subjects are the same person when they differ only in case. */
export function sameSubject(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
