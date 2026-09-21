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

import type { ClientState } from './protocol.js';

export interface ExtensionStatus {
  installed: true;
  version: string;
  state: 'disconnected' | 'pairing' | 'paired';
  code?: string;
  gateway: string;
}

/** `http://127.0.0.1:4317`, `http://localhost:5173`, `http://[::1]:4317` — and nothing else. */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname);
}

/** What the extension says about itself: connected or not, and to which buddi. */
export function describe(state: ClientState, gateway: string, version: string): ExtensionStatus {
  const named = state.connection === 'paired' ? 'paired' : state.connection === 'pairing' ? 'pairing' : 'disconnected';
  const status: ExtensionStatus = { installed: true, version, state: named, gateway };
  if (named === 'pairing' && state.code) status.code = state.code;
  return status;
}

export interface ExternalContext {
  origin?: string;
  state(): ClientState;
  gateway(): Promise<string>;
  version: string;
}

/**
 * Answers `{type:'buddi.status'}` from a loopback page, and nothing else from
 * anywhere. Returns true when an answer is on its way, which is how a
 * `chrome.runtime` listener says it will respond asynchronously; an ignored
 * message is left unanswered rather than refused, so a page that should not be
 * talking to us learns nothing from the shape of the silence.
 */
export function handleExternal(
  message: unknown,
  context: ExternalContext,
  respond: (answer: ExtensionStatus) => void,
): boolean {
  if (!isLoopbackOrigin(context.origin)) return false;
  const request = message as { type?: unknown } | null;
  if (!request || request.type !== 'buddi.status') return false;
  void context.gateway().then((address) => respond(describe(context.state(), address, context.version)));
  return true;
}
