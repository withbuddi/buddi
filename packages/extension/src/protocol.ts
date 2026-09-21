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
  execute(command: Command): Promise<CommandResult>;
  /** Called on every state change so the popup can redraw. */
  onState?(state: ClientState): void;
  /** Closes the socket, which makes the worker reconnect. */
  disconnect?(reason: string): void;
}

const TOKEN_KEY = 'token';

export class Protocol {
  #options: ProtocolOptions;
  #state: ClientState = { connection: 'offline', code: null, installation: null, error: null };

  constructor(options: ProtocolOptions) { this.#options = options; }

  state(): ClientState { return { ...this.#state }; }

  #set(patch: Partial<ClientState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#options.onState?.(this.state());
  }

  /** First frame on a fresh socket: who we are, and the token if this browser was paired before. */
  async open(): Promise<void> {
    const stored = await this.#token();
    this.#set({ connection: 'connecting', code: null, error: null });
    this.#options.send({ type: 'hello', extension: this.#options.version, token: stored });
  }

  closed(reason?: string): void {
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
        this.#set({ connection: 'pairing', code, error: null });
        return;
      }
      case 'paired': {
        const token = message['token'];
        if (typeof token === 'string' && token.length > 0) await this.#options.chrome.storage.local.set({ [TOKEN_KEY]: token });
        const installation = message['installation'];
        this.#set({ connection: 'paired', code: null, error: null,
          installation: typeof installation === 'string' ? installation : this.#state.installation });
        return;
      }
      case 'command':
        await this.#command(message);
        return;
      default:
        return;
    }
  }

  async #command(message: Record<string, unknown>): Promise<void> {
    const id = typeof message['id'] === 'string' ? message['id'] : null;
    if (!id) return; // Nothing to answer on.
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
    try {
      const result = await this.#options.execute(command);
      this.#options.send({ type: 'result', id, ok: true, observation: result.observation ?? null, screenshot: result.screenshot ?? null });
    } catch (error) {
      this.#options.send({ type: 'result', id, ok: false, error: sentence(error), precondition: error instanceof PreconditionError });
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
