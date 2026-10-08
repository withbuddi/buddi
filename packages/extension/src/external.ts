/*
 * The one question a page is allowed to ask this extension.
 *
 * The dashboard is a web page, and a web page cannot see whether an extension
 * is installed: `chrome.runtime.sendMessage` to an id that is not there simply
 * rejects. So the settings page asks, and this answers — which is the only
 * reason `externally_connectable` exists in the manifest at all.
 *
 * Two rules keep that narrow. The manifest lets loopback origins reach us, and
 * this checks the origin again itself, because a manifest is matched by Chrome
 * and an assertion here is matched by the tests. And the answer carries no
 * secret: the pairing token never leaves storage, and the six digits it may
 * carry are already on screen in the popup and are useless to anyone who
 * cannot also reach the buddi that minted them.
 *
 * No Chrome in this file, so the whole rule is tested without a browser.
 */

import { sameBuddi } from './pairings.js';
import type { ClientState } from './protocol.js';

type Named = 'disconnected' | 'pairing' | 'paired';

/** One buddi this browser knows, as a dashboard may see it: where, what it is called, how it stands. */
export interface PairingSummary { origin: string; name: string; state: Named; enabled: boolean }

export interface ExtensionStatus {
  installed: true;
  version: string;
  /** How this browser stands with the buddi that asked. */
  state: Named;
  code?: string;
  /**
   * The asking buddi's address when this browser knows it, else the first one
   * it knows: what a dashboard from before several buddis compares against.
   */
  gateway: string;
  /**
   * Every buddi this browser knows, the asking one included. Since one
   * extension pairs with several; an older dashboard ignores it.
   */
  pairings?: PairingSummary[];
}

/** `http://127.0.0.1:4317`, `http://localhost:5173`, `http://[::1]:4317` — and nothing else. */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname);
}

function named(state: ClientState): Named {
  return state.connection === 'paired' ? 'paired' : state.connection === 'pairing' ? 'pairing' : 'disconnected';
}

/** What the extension says about itself to one buddi: connected or not, and to which. */
export function describe(state: ClientState, gateway: string, version: string): ExtensionStatus {
  const status: ExtensionStatus = { installed: true, version, state: named(state), gateway };
  if (status.state === 'pairing' && state.code) status.code = state.code;
  return status;
}

/** One entry as the worker holds it: its address, its name, its link's state. */
export interface KnownBuddi { origin: string; name: string; state: ClientState; enabled: boolean }

/**
 * The answer for the dashboard at `origin`: its own pairing's state (and code,
 * while one is on screen), and the list. The code of another buddi is never in
 * it: a code is for the dashboard of the buddi that minted it.
 */
export function describeFor(origin: string, known: readonly KnownBuddi[], version: string): ExtensionStatus {
  const mine = known.find((entry) => sameBuddi(entry.origin, origin));
  const status = mine ? describe(mine.state, mine.origin, version) : describe({ connection: 'offline', code: null, installation: null, error: null }, known[0]?.origin ?? origin, version);
  status.pairings = known.map((entry) => ({ origin: entry.origin, name: entry.name, state: named(entry.state), enabled: entry.enabled }));
  return status;
}

export interface ExternalContext {
  origin?: string;
  known(): Promise<KnownBuddi[]>;
  version: string;
  /** A dashboard this browser has no pairing for asked: the popup offers its address. */
  unknown?(origin: string): void;
}

/**
 * Answers `{type:'buddi.status'}` from a loopback page, and nothing else from
 * anywhere. Returns true when an answer is on its way, which is how a
 * `chrome.runtime` listener says it will respond asynchronously; an ignored
 * message is left unanswered rather than refused, so a page that should not be
 * talking to us learns nothing from the shape of the silence.
 *
 * A page can never add a buddi or change one: a pairing is the owner's act in
 * the popup, because a socket to any loopback port is a socket that could
 * answer as a buddi. The most an unknown dashboard gets is its address offered
 * in the popup's Add a buddi, for the owner to accept.
 */
export function handleExternal(
  message: unknown,
  context: ExternalContext,
  respond: (answer: ExtensionStatus) => void,
): boolean {
  if (!isLoopbackOrigin(context.origin)) return false;
  const request = message as { type?: unknown } | null;
  if (!request || request.type !== 'buddi.status') return false;
  const origin = context.origin!;
  void context.known().then((known) => {
    if (!known.some((entry) => sameBuddi(entry.origin, origin))) context.unknown?.(origin);
    respond(describeFor(origin, known, context.version));
  });
  return true;
}
