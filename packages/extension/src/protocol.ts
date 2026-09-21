/*
 * The wire, with no socket and no browser in it.
 *
 * Everything that decides what a frame means lives here and talks to two
 * seams: `send` (a text frame towards the gateway) and `execute` (one browser
 * command). The service worker supplies a real WebSocket and the real
 * `chrome.*`; the tests supply two functions and a plain object, which is why
 * the whole handshake, the pairing dance and the error mapping are testable
 * without Chrome.
 */

import type { ChromeLike } from './chrome.js';

export interface ObservedTarget {
  ref: string;
  frame: number;
  role: string;
  name: string;
  href?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

/** The same shape `@buddi/tool-browser` builds from Playwright. An agent must not be able to tell them apart. */
export interface Observation {
  id: string;
  url: string;
  title: string;
  tree: string;
  targets?: ObservedTarget[];
  tabs: Array<{ id: string; url: string; title: string }>;
  capturedAt: string;
  screenshotSize?: { width: number; height: number };
}

export const COMMAND_NAMES = ['navigate', 'observe', 'click', 'fill', 'select', 'press', 'scroll', 'tab', 'close'] as const;
export type CommandName = (typeof COMMAND_NAMES)[number] | 'screenshot';

export interface Command {
  id: string;
  name: CommandName;
  session: string;
  args: Record<string, unknown>;
}

export interface CommandResult {
  observation?: Observation | null;
  screenshot?: string | null;
}

/** Refused before anything was dispatched, so the gateway can map it to BrowserPreconditionError. */
export class PreconditionError extends Error {}

/** Thrown out of an executor that noticed the gateway had cancelled the command. */
export class CancelledError extends Error {}

/**
 * One command's stop switch, handed to the executor.
 *
 * The gateway cancels on its own timeout, which means it has already given up
 * on the answer: dispatching a click after that would operate the owner's
 * browser on nobody's behalf. So the executor checks before every step, and
 * says whether it had already dispatched one, because that is the difference
 * between "nothing happened" and "something may have".
 */
export class Cancellation {
  #cancelled = false;
  #dispatched = false;
  cancel(): void { this.#cancelled = true; }
  /** Called immediately before a step that changes the browser. */
  dispatch(): void { this.#dispatched = true; }
  get cancelled(): boolean { return this.#cancelled; }
  get dispatched(): boolean { return this.#dispatched; }
  check(): void { if (this.#cancelled) throw new CancelledError('cancelled'); }
}

export type ConnectionState = 'offline' | 'connecting' | 'pairing' | 'paired';

export interface ClientState {
  connection: ConnectionState;
  /** The six digits the owner types into Settings, while the gateway is waiting for them. */
  code: string | null;
  installation: string | null;
  error: string | null;
}

export interface ProtocolOptions {
  chrome: Pick<ChromeLike, 'storage'>;
  version: string;
  send(frame: unknown): void;
  execute(command: Command, cancel: Cancellation): Promise<CommandResult>;
  /** Called on every state change so the popup can redraw. */
  onState?(state: ClientState): void;
  /** Closes the socket, which makes the worker reconnect. */
  disconnect?(reason: string): void;
  /** A socket that ends drops this browser's sessions and refs with it. */
  onReset?(): void;
}

const TOKEN_KEY = 'token';

const BAD_PROOF = 'That buddi could not prove it is the one this browser was paired with.';

const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer): string => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/**
 * The proof both ends compute: HMAC-SHA256 of the socket's nonce, keyed by the
 * token's SHA-256.
 *
 * Keyed by the hash rather than by the token so the gateway, which stores only
 * the hash, can compute it without ever holding the token; the extension holds
 * the token because it is what it has to send back afterwards.
 */
export async function proofFor(tokenHash: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(tokenHash), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(nonce)));
}

/** Equal, in a way that does not report where the first difference was. */
function sameProof(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

function nonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class Protocol {
  #options: ProtocolOptions;
  #state: ClientState = { connection: 'offline', code: null, installation: null, error: null };
  /** Fresh per socket: what the gateway has to sign to be believed. */
  #nonce = '';
  /** No command runs before the gateway proved itself and accepted our token. */
  #authenticated = false;
  #running = new Map<string, Cancellation>();

  constructor(options: ProtocolOptions) { this.#options = options; }

  /** For the worker and the tests: whether this socket may carry commands. */
  authenticated(): boolean { return this.#authenticated; }

  state(): ClientState { return { ...this.#state }; }

  #set(patch: Partial<ClientState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#options.onState?.(this.state());
  }

  /**
   * First frame on a fresh socket: who we are, a nonce, and whether we hold a
   * token. The token itself stays here until the gateway has signed the nonce
   * with it: a process that answers this port is not yet the buddi we paired
   * with, and handing it a working credential would be how it became one.
   */
  async open(): Promise<void> {
    const stored = await this.#token();
    this.#nonce = nonce();
    this.#authenticated = false;
    this.#set({ connection: 'connecting', code: null, error: null });
    this.#options.send({ type: 'hello', extension: this.#options.version, nonce: this.#nonce, paired: stored !== null });
  }

  closed(reason?: string): void {
    this.#authenticated = false;
    for (const cancel of this.#running.values()) cancel.cancel();
    this.#running.clear();
    this.#options.onReset?.();
    this.#set({ connection: 'offline', code: null, error: reason ?? null });
  }

  async #token(): Promise<string | null> {
    const stored = await this.#options.chrome.storage.local.get([TOKEN_KEY]);
    const token = stored[TOKEN_KEY];
    return typeof token === 'string' && token.length > 0 ? token : null;
  }

  /** Drops the token and asks for a new socket, which starts the pairing dance again. */
  async forget(): Promise<void> {
    await this.#options.chrome.storage.local.remove([TOKEN_KEY]);
    this.#authenticated = false;
    this.#set({ connection: 'offline', code: null, installation: null, error: null });
    this.#options.disconnect?.('The owner forgot this buddi.');
  }

  /** One text frame from the gateway. Never throws: a bad frame is ignored, a bad command answers with an error frame. */
  async receive(text: string): Promise<void> {
    let frame: unknown;
    try { frame = JSON.parse(text); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    const message = frame as Record<string, unknown>;
    switch (message['type']) {
      case 'ping':
        this.#options.send({ type: 'pong' });
        return;
      case 'pair': {
        const code = typeof message['code'] === 'string' ? message['code'] : null;
        this.#authenticated = false;
        this.#set({ connection: 'pairing', code, error: null });
        return;
      }
      case 'challenge':
        await this.#challenge(message);
        return;
      case 'paired': {
        const token = message['token'];
        if (typeof token === 'string' && token.length > 0) await this.#options.chrome.storage.local.set({ [TOKEN_KEY]: token });
        // Either the owner just typed the code on this socket, or the gateway
        // signed our nonce and then accepted our token. Both are proof.
        this.#authenticated = true;
        const installation = message['installation'];
        this.#set({ connection: 'paired', code: null, error: null,
          installation: typeof installation === 'string' ? installation : this.#state.installation });
        return;
      }
      case 'rehello':
        // The gateway lost track of this socket's state; start the handshake
        // over rather than sit in a state it no longer shares.
        await this.open();
        return;
      case 'cancel': {
        const id = typeof message['id'] === 'string' ? message['id'] : '';
        this.#running.get(id)?.cancel();
        return;
      }
      case 'command':
        await this.#command(message);
        return;
      default:
        return;
    }
  }

  /**
   * The gateway signed our nonce. Check it before the token leaves this browser.
   *
   * The key is the token's hash, which is all the gateway keeps, so a gateway
   * that cannot produce this signature is not the one this browser paired with
   * and never gets to see the token.
   */
  async #challenge(message: Record<string, unknown>): Promise<void> {
    const token = await this.#token();
    const claimed = typeof message['proof'] === 'string' ? message['proof'] : '';
    if (!token) { this.#options.disconnect?.('This browser has no token for that buddi.'); return; }
    const expected = await proofFor(await sha256Hex(token), this.#nonce);
    if (!sameProof(expected, claimed)) {
      this.#authenticated = false;
      this.#set({ connection: 'offline', code: null, error: BAD_PROOF });
      this.#options.disconnect?.(BAD_PROOF);
      return;
    }
    const installation = message['installation'];
    if (typeof installation === 'string') this.#set({ installation });
    this.#options.send({ type: 'auth', token });
  }

  async #command(message: Record<string, unknown>): Promise<void> {
    const id = typeof message['id'] === 'string' ? message['id'] : null;
    if (!id) return; // Nothing to answer on.
    if (!this.#authenticated) {
      this.#options.send({ type: 'result', id, ok: false, error: 'This browser is not paired with you.', precondition: true });
      return;
    }
    const name = message['name'];
    const session = message['session'];
    if (typeof name !== 'string' || !isCommandName(name)) {
      this.#options.send({ type: 'result', id, ok: false, error: `This buddi extension does not know the command ${String(name)}.`, precondition: true });
      return;
    }
    if (typeof session !== 'string' || session.length === 0) {
      this.#options.send({ type: 'result', id, ok: false, error: 'The command arrived without a session.', precondition: true });
      return;
    }
    const args = message['args'];
    const command: Command = { id, name, session, args: args && typeof args === 'object' ? args as Record<string, unknown> : {} };
    const cancel = new Cancellation();
    this.#running.set(id, cancel);
    try {
      const result = await this.#options.execute(command, cancel);
      // A cancel that arrived while the last step was in flight still counts:
      // the gateway has stopped waiting, so it hears the cancellation, not a
      // result it would have to reconcile.
      cancel.check();
      this.#options.send({ type: 'result', id, ok: true, observation: result.observation ?? null, screenshot: result.screenshot ?? null });
    } catch (error) {
      if (error instanceof CancelledError) {
        this.#options.send({ type: 'result', id, ok: false, error: 'cancelled', precondition: !cancel.dispatched });
      } else {
        this.#options.send({ type: 'result', id, ok: false, error: sentence(error), precondition: error instanceof PreconditionError });
      }
    } finally {
      this.#running.delete(id);
    }
  }
}

function isCommandName(name: string): name is CommandName {
  return name === 'screenshot' || (COMMAND_NAMES as readonly string[]).includes(name);
}

/** The gateway shows this to the owner, so it has to read like a sentence and never like a stack. */
export function sentence(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const trimmed = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!trimmed) return 'The browser extension could not run that command.';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
