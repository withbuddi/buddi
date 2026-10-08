/*
 * One socket to one buddi, for as long as Chrome runs and the owner keeps
 * that buddi switched on in the popup.
 *
 * The worker holds one of these per enabled pairing (pairings.ts). Each has
 * its own socket, its own handshake, its own token, its own commands and its
 * own tab groups; nothing one buddi does reaches another's tabs.
 *
 * A Manifest V3 worker is killed when it goes idle, but WebSocket traffic
 * counts as activity, so the gateway's 20-second ping is what keeps this alive
 * as well as what proves the link. When the worker is killed anyway (Chrome
 * restarts, the machine sleeps), `onStartup`, the alarm and the popup all
 * bring it back, and the reconnect loop backs off to at most 30 seconds so a
 * buddi that is simply not running costs nothing.
 *
 * Tabs are deliberately not cleaned up when the socket drops. They are the
 * owner's browser, and an agent losing its connection is not a reason for the
 * window to change under their hands.
 */

import { BrowserCommands } from './commands.js';
import { AgentDownloads, type DownloadsApi } from './downloads.js';
import type { WorkerChrome } from './chrome.js';
import { BINARY_FRAMES, base64Bytes, packFrame } from './frames.js';
import type { Colour, GroupRegistry, PairingStore } from './pairings.js';
import { Protocol, type ClientState, type FrameMessage } from './protocol.js';

const MAX_BACKOFF = 30_000;
/** How long a knock waits for buddi before the socket is left alone this round. */
const KNOCK_MS = 3000;
/** Three missed pings and the gateway is gone; reconnecting is cheap. */
const SILENCE = 70_000;
/**
 * Chrome stops a Manifest V3 worker after thirty seconds without an event,
 * an open WebSocket or not; only traffic on the socket counts as one. The
 * gateway pings a paired socket every twenty seconds, but a socket waiting for
 * its code heard nothing from an older gateway, and the worker died half a
 * minute into pairing with the code still on the popup. So the worker speaks
 * first, every twenty seconds, whatever state the socket is in. The gateway
 * ignores the frame.
 */
export const KEEPALIVE_MS = 20_000;

/** Loopback only. This extension talks to a buddi on this machine, never to a host on the internet. */
export function socketUrl(address: string): string {
  const parsed = new URL(address);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)) throw new Error('A buddi address has to be on this machine.');
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('A buddi address starts with http.');
  return `${parsed.protocol === 'https:' ? 'wss' : 'ws'}://${parsed.host}/api/extension/socket`;
}

/**
 * Nothing that escapes a promise may reach Chrome as an unhandled rejection:
 * the worker logs one line and carries on, because a background task that
 * failed is not a reason to lose the socket.
 */
export const LOST = 'buddi: a background task did not finish.';
export function safely(work: () => unknown): void {
  try {
    void Promise.resolve(work()).catch(() => console.warn(LOST));
  } catch { console.warn(LOST); }
}

/**
 * Frames the handshake cannot do without.
 *
 * A pong or a screencast frame that missed its socket is stale by the time the
 * next one opens, and sending it at a gateway that never asked is worse than
 * dropping it. A `hello`, an `auth` or a `result` is one half of a conversation
 * the other end is waiting on, so it waits for the socket instead.
 */
const DURABLE = new Set(['hello', 'auth', 'result']);

const frameType = (frame: unknown): string =>
  frame && typeof frame === 'object' ? String((frame as { type?: unknown }).type ?? '') : '';

export interface LinkOptions {
  chrome: WorkerChrome;
  /** The pairing this link speaks for, by its local id, and where that buddi listens. */
  id: string;
  origin: string;
  store: PairingStore;
  groups: GroupRegistry;
  version: string;
  /** What this buddi's tab groups are called and coloured, read when a group is made. */
  title(): string;
  colour(): Colour | undefined;
  /** Every state change, so the popup can redraw. */
  onState?(id: string, state: ClientState): void;
  /** The buddi said its name: the store keeps it. */
  onName?(id: string, name: string): void;
  /** The socket constructor; the tests hand in a fake one. */
  WebSocket?: typeof WebSocket;
}

export class Link {
  readonly id: string;
  readonly origin: string;
  readonly commands: BrowserCommands;
  readonly protocol: Protocol;
  readonly downloads: AgentDownloads;
  #options: LinkOptions;
  #socket: WebSocket | undefined;
  /** Text frames waiting for the socket that is still connecting; discarded if it never opens. */
  #pending: string[] = [];
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #silence: ReturnType<typeof setTimeout> | undefined;
  #keepalive: ReturnType<typeof setInterval> | undefined;
  #last: ClientState = { connection: 'offline', code: null, installation: null, error: null };
  /** The tail of the frame queue: every frame waits for the one before it. */
  #incoming: Promise<void> = Promise.resolve();
  /** Switched off or removed: no reconnects, nothing sent. */
  #disposed = false;

  constructor(options: LinkOptions) {
    this.#options = options;
    this.id = options.id;
    this.origin = options.origin;
    /*
     * Agents' downloads: watched only once the owner allowed the optional
     * `downloads` permission (the popup's Allow downloads), and only for what an
     * agent's command started (downloads.ts). A finished one goes to buddi as a
     * frame; it is a report, not an answer, so a socket that is not open drops it.
     */
    this.downloads = new AgentDownloads({ send: (frame) => this.send(frame) });
    this.commands = new BrowserCommands(options.chrome, {
      // Screencast frames are not answers to anything: they arrive while the
      // agent or the owner is driving and go straight out, outside the
      // command/result pairing.
      onFrame: (frame) => this.sendFrame(frame), onEvent: (event) => this.send(event), onLogin: (frame) => this.send(frame),
      downloads: this.downloads, instance: options.id, groups: options.groups, groupTitle: options.title, groupColour: options.colour,
    });
    this.protocol = new Protocol({
      tokens: options.store.tokens(options.id),
      version: options.version,
      send: (frame) => this.send(frame),
      execute: (command, cancel) => this.commands.run(command, cancel),
      // The socket ended: sessions and refs go with it. The tabs do not.
      onReset: () => this.commands.reset(),
      onLoginAck: (id, answer) => this.commands.logins.ack(id, answer),
      onState: (state) => {
        const named = state.name && state.name !== this.#last.name ? state.name : null;
        this.#last = state;
        if (named) { this.#options.onName?.(this.id, named); safely(() => this.commands.retitle()); }
        this.#options.onState?.(this.id, state);
      },
      disconnect: () => this.#socket?.close(),
    });
  }

  state(): ClientState { return { ...this.#last }; }

  attachDownloads(api: DownloadsApi | undefined): void { if (api) this.downloads.attach(api); }

  get #WebSocket(): typeof WebSocket { return this.#options.WebSocket ?? WebSocket; }

  /**
   * One way out for everything this link says, so a frame and a result travel
   * the same socket.
   *
   * A socket that is still CONNECTING throws on `send`, and the worker reconnects
   * often enough — an alarm, a pong, a screencast that outlived the last socket —
   * that something always arrives early. So this is the only place that decides:
   * send it, queue it, or let it go.
   */
  send(frame: unknown): void {
    const live = this.#socket;
    const text = JSON.stringify(frame);
    const Socket = this.#WebSocket;
    if (live && live.readyState === Socket.OPEN) {
      try { live.send(text); } catch { /* The socket died between the check and the send. */ }
      return;
    }
    if (live && live.readyState === Socket.CONNECTING && DURABLE.has(frameType(frame))) this.#pending.push(text);
  }

  /**
   * A screencast frame: as bytes to a gateway that said it reads them (the
   * picture, without base64 inside JSON), as the old JSON frame otherwise.
   * Never queued: a frame that missed its socket is stale.
   */
  sendFrame(frame: FrameMessage): void {
    const live = this.#socket;
    if (!live || live.readyState !== this.#WebSocket.OPEN) return;
    if (!(this.#last.features ?? []).includes(BINARY_FRAMES)) { this.send(frame); return; }
    try {
      const bytes = packFrame({ session: frame.session, ...frame.metadata, ...(frame.url ? { url: frame.url } : {}) }, base64Bytes(frame.data));
      live.send(bytes);
    } catch { /* a frame that cannot be packed is a frame not sent */ }
  }

  /** Everything that waited for this socket, in the order it was said. */
  #flush(open: WebSocket): void {
    const queued = this.#pending;
    this.#pending = [];
    for (const text of queued) {
      if (open.readyState !== this.#WebSocket.OPEN) return;
      try { open.send(text); } catch { return; }
    }
  }

  #quiet(): void {
    if (this.#silence) clearTimeout(this.#silence);
    this.#silence = setTimeout(() => this.#socket?.close(), SILENCE);
  }

  /** Connect now, unless a socket is already open or opening. */
  async connect(): Promise<void> {
    if (this.#disposed) return;
    const Socket = this.#WebSocket;
    const socket = this.#socket;
    if (socket && (socket.readyState === Socket.OPEN || socket.readyState === Socket.CONNECTING)) return;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    // The last socket is gone. A screencast it left running would paint frames at
    // a socket that never asked for them, and whatever it queued was for a
    // conversation that ended, so both stop here rather than on the new socket.
    this.#socket = undefined;
    this.#pending = [];
    this.commands.reset();
    let url: string;
    try { url = socketUrl(this.origin); }
    catch (error) { this.protocol.closed(error instanceof Error ? error.message : String(error)); return; }
    /*
     * On a reconnect, knock first. A refused WebSocket is logged by Chrome as
     * an extension error every time, and a buddi that is restarting or off
     * would fill that page with them; a refused fetch is not logged. The first
     * connect (and the owner's Connect click) still opens the socket at once.
     */
    if (this.#attempt > 0 && !(await answering(url))) {
      if (this.#disposed) return;
      this.protocol.closed('buddi did not answer at this address. Is it running?');
      this.#schedule();
      return;
    }
    if (this.#disposed) return;
    const opening = new Socket(url);
    opening.binaryType = 'arraybuffer';
    this.#socket = opening;
    opening.addEventListener('open', () => {
      this.#attempt = 0; this.#quiet(); this.#flush(opening);
      if (this.#keepalive) clearInterval(this.#keepalive);
      this.#keepalive = setInterval(() => { if (this.#socket === opening) this.send({ type: 'keepalive' }); }, KEEPALIVE_MS);
      safely(() => this.protocol.open());
    });
    // One frame at a time, in the order they arrived. A WebSocket delivers them
    // in order and the protocol is written as if they were handled that way: a
    // command that follows `paired` must not overtake it, and two commands must
    // not interleave their dispatches in the owner's browser.
    opening.addEventListener('message', (event) => {
      this.#quiet();
      const text = String((event as MessageEvent).data);
      this.#incoming = this.#incoming.then(() => this.protocol.receive(text)).catch(() => { console.warn(LOST); });
    });
    // A socket that errors before it opens takes everything queued for it with
    // it: the gateway never heard the hello those frames belonged to.
    opening.addEventListener('error', () => { if (this.#socket === opening) this.#pending = []; });
    opening.addEventListener('close', () => {
      if (this.#socket === opening) { this.#socket = undefined; this.#pending = []; if (this.#keepalive) { clearInterval(this.#keepalive); this.#keepalive = undefined; } }
      if (this.#silence) { clearTimeout(this.#silence); this.#silence = undefined; }
      if (this.#disposed) return;
      this.protocol.closed('buddi did not answer at this address. Is it running?');
      this.#schedule();
    });
  }

  /** The owner pressed Connect or Try again: start over at once. */
  async retry(): Promise<void> {
    this.#attempt = 0;
    this.#socket?.close();
    await this.connect();
  }

  /** Drop the token and pair again from a fresh code. */
  forget(): Promise<void> { return this.protocol.forget(); }

  /**
   * Switched off or removed in the popup: the socket closes and stays closed,
   * the sessions and their refs go. The tabs stay; they are the owner's.
   */
  dispose(): void {
    this.#disposed = true;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    if (this.#keepalive) { clearInterval(this.#keepalive); this.#keepalive = undefined; }
    if (this.#silence) { clearTimeout(this.#silence); this.#silence = undefined; }
    const socket = this.#socket;
    this.#socket = undefined;
    this.#pending = [];
    try { socket?.close(); } catch { /* already gone */ }
    this.protocol.closed();
    this.commands.reset();
  }

  #schedule(): void {
    if (this.#timer || this.#disposed) return;
    const wait = Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(this.#attempt, 5));
    this.#attempt += 1;
    this.#timer = setTimeout(() => { this.#timer = undefined; safely(() => this.connect()); }, wait);
  }
}

/** Does anything answer on buddi's HTTP side? Any status counts; only no answer at all is a no. */
async function answering(socket: string): Promise<boolean> {
  let http: URL;
  try {
    http = new URL(socket);
    http.protocol = http.protocol === 'wss:' ? 'https:' : 'http:';
    http.pathname = '/api/version';
    http.search = '';
  } catch { return false; }
  try {
    await fetch(http.toString(), { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(KNOCK_MS) });
    return true;
  } catch {
    return false;
  }
}
