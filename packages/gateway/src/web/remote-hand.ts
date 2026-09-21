/**
 * The remote hand: the owner's own pointer and keyboard, on the screen an
 * agent was driving, from wherever they happen to be.
 *
 * The dashboard has always been able to *watch* — a screenshot, re-requested
 * every two seconds. This is the other half. Once the owner presses Take over,
 * this socket carries a live picture out of the host browser and their clicks
 * and keystrokes back into it, so a login, an MFA prompt or a cookie banner
 * that stopped an agent can be dealt with from a phone rather than by walking
 * to the machine.
 *
 * **Nothing typed here is kept.** Not in a log line, not in an event row, not
 * in the transcript, not in a field on this object. A key event is validated,
 * forwarded to the driver and forgotten inside one function; the only string
 * on that path that ever came from a keyboard is a single character of `text`,
 * and it never leaves the stack. That is the promise the bar over the picture
 * makes to the owner, and it is kept here or not at all.
 *
 * One hand at a time, for one session: a second dashboard tab is told another
 * tab is driving rather than quietly fighting it for the mouse. The socket is
 * gated exactly as the dashboard's routes are — the session cookie on the
 * upgrade request, and the CSRF token as the first frame, because a WebSocket
 * upgrade carries no headers a page can set.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BrowserController, BrowserHand, HandFrame, HandInput } from '@buddi/tool-browser';
import { SessionStore, type Session } from './sessions.js';

/** The dashboard's half of the take-over, on the same upgrade listener. */
export const REMOTE_HAND_SOCKET_PATH = '/api/browser/hand';

/** A picture is large; a pointer event is not. Nothing here needs a megabyte. */
const MAX_FRAME_BYTES = 64 * 1024;
/** A socket that says nothing at all is a socket that never becomes a hand. */
const HELLO_TIMEOUT_MS = 10_000;
/** A phone that walks out of range does not close its socket; it goes quiet. */
const PING_MS = 15_000;
const MISSED_PONGS = 2;
/** Nobody drives for ten minutes without touching anything. */
const IDLE_MS = 10 * 60_000;
/** Whatever else is true, a hand is not a thing that lasts an afternoon. */
const MAX_LIFETIME_MS = 2 * 60 * 60_000;
/** How often an idle socket's session is asked about again. */
const LEASE_MS = 30_000;
/** And how stale the answer may be while input is flowing. */
const LEASE_FRESH_MS = 1_000;
/** Unsent JPEGs are this process's memory, not the viewer's problem. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const CONGESTION_MS = 10_000;

/** Coordinates are page pixels, and no page is twenty thousand wide. */
const MAX_COORDINATE = 20_000;
const MAX_DELTA = 10_000;
/** Shift, Control, Alt and Meta, as CDP packs them. */
const MAX_MODIFIERS = 15;

const BUTTONS = new Set(['none', 'left', 'middle', 'right']);
const MOUSE_TYPES = new Set(['mousePressed', 'mouseReleased', 'mouseMoved']);
const KEY_TYPES = new Set(['keyDown', 'keyUp', 'char']);

/**
 * The keys a hand may press.
 *
 * An allow list rather than a length check, because `key` is the one field an
 * ill-behaved page script could otherwise use to push an arbitrary string
 * through this socket. Printable characters are not here: they arrive as a
 * `char` event carrying exactly one character of `text`.
 */
const NAMED_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'Insert',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

/** A printable single character, which `keyDown` names and `char` types. */
function printable(value: string): boolean {
  return [...value].length === 1 && value.codePointAt(0)! >= 0x20 && value.codePointAt(0)! !== 0x7f;
}

function bounded(value: unknown, limit: number, min = -limit): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= limit ? value : null;
}

/**
 * What the dashboard sent, or nothing.
 *
 * Deliberately total: every field is checked, and one that is not understood
 * fails the whole event rather than being dropped and dispatched without.
 */
export function readInput(raw: unknown): HandInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const modifiers = bounded(input.modifiers ?? 0, MAX_MODIFIERS, 0);
  if (input.kind === 'wheel') {
    const x = bounded(input.x, MAX_COORDINATE, 0), y = bounded(input.y, MAX_COORDINATE, 0);
    const deltaX = bounded(input.deltaX, MAX_DELTA), deltaY = bounded(input.deltaY, MAX_DELTA);
    if (x === null || y === null || deltaX === null || deltaY === null) return null;
    return { kind: 'wheel', x, y, deltaX, deltaY };
  }
  if (input.kind === 'mouse') {
    const x = bounded(input.x, MAX_COORDINATE, 0), y = bounded(input.y, MAX_COORDINATE, 0);
    const clickCount = bounded(input.clickCount ?? 0, 3, 0);
    if (x === null || y === null || clickCount === null || modifiers === null) return null;
    if (typeof input.type !== 'string' || !MOUSE_TYPES.has(input.type)) return null;
    const button = typeof input.button === 'string' && BUTTONS.has(input.button) ? input.button : 'none';
    return { kind: 'mouse', type: input.type as 'mousePressed' | 'mouseReleased' | 'mouseMoved',
      x, y, button: button as 'none' | 'left' | 'middle' | 'right', clickCount, modifiers };
  }
  if (input.kind !== 'key') return null;
  if (typeof input.type !== 'string' || !KEY_TYPES.has(input.type) || modifiers === null) return null;
  const key = typeof input.key === 'string' ? input.key : '';
  const code = typeof input.code === 'string' ? input.code : '';
  if (!NAMED_KEYS.has(key) && !printable(key)) return null;
  if (code !== '' && !/^[A-Za-z0-9]{1,24}$/.test(code)) return null;
  // One character, because that is what a keystroke is. Nothing longer can be
  // pasted through this field into the owner's browser, or through this
  // process on its way there.
  const text = typeof input.text === 'string' ? input.text : undefined;
  if (input.type === 'char' && (text === undefined || !printable(text))) return null;
  if (text !== undefined && !printable(text)) return null;
  return { kind: 'key', type: input.type as 'keyDown' | 'keyUp' | 'char', key, code, ...(text !== undefined ? { text } : {}), modifiers };
}

export interface RemoteHandDeps {
  /**
   * The session behind this request, or null.
   *
   * Called at the upgrade *and* for as long as the socket lives, because a
   * session that has expired, been destroyed, or lost the tailnet identity it
   * was minted for must not keep a hand on the owner's browser. It is the one
   * function that knows how this gateway authenticates, so it is the one thing
   * the lease below asks.
   */
  authorize(req: IncomingMessage): Promise<Session | null>;
  /** The host controller, resolved per call the way the routes resolve it. */
  browser(): BrowserController;
  /** Where a *failure* goes, as a reason code. Never a frame, never a key. */
  log?(line: string): void;
  /** The intervals, so a test does not have to wait two hours. */
  pingMs?: number;
  idleMs?: number;
  lifetimeMs?: number;
  leaseMs?: number;
  congestionMs?: number;
}

/** What is still pressed, so it can be let go of when the hand ends. */
interface Held {
  keys: Map<string, { key: string; code: string }>;
  buttons: Set<'left' | 'middle' | 'right'>;
  x: number;
  y: number;
}

/** One adopted socket and everything that ends with it. */
interface Live {
  ws: WebSocket;
  /** The upgrade request, kept so the lease can be asked again. */
  req: IncomingMessage;
  /** The dashboard session this hand belongs to, by id. */
  lease: string;
  /** The browser session being driven. */
  sessionId: string;
  hand: BrowserHand;
  since: number;
  lastInput: number;
  checkedAt: number;
  missed: number;
  congestedSince?: number;
  closing: boolean;
  finishing?: Promise<void>;
  held: Held;
  timer?: NodeJS.Timeout;
}

/**
 * One hand, or none.
 *
 * Everything that matters is on the one `Live` record: the socket, the session
 * lease behind it, the driver's hand, the queue that keeps input in order, and
 * what is still held down. When the record goes, all of it goes with it.
 */
export class RemoteHandEndpoint {
  #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  #live?: Live;
  /** Every message this endpoint handles, one after another. */
  #queue: Promise<void> = Promise.resolve();
  /** True while a queued task runs, so ending from inside one cannot await itself. */
  #inQueue = false;
  constructor(readonly deps: RemoteHandDeps) {}

  /** Which browser session is being driven right now, if any. */
  get driving(): string | undefined { return this.#live?.sessionId; }

  #say(reason: string): void { this.deps.log?.(`browser hand: ${reason}`); }

  #refuse(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  /** Registered on the extension endpoint's upgrade listener, by path. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    void this.deps.authorize(req).then((session) => {
      if (!session) return this.#refuse(socket, 401, 'Unauthorized');
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, req, session));
    }, () => this.#refuse(socket, 500, 'Internal Server Error'));
  }

  #accept(ws: WebSocket, req: IncomingMessage, session: Session): void {
    const hello = setTimeout(() => { if (this.#live?.ws !== ws) ws.close(1002, 'no hello'); }, HELLO_TIMEOUT_MS);
    hello.unref?.();
    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // Nothing the dashboard sends is bytes.
      let frame: Record<string, unknown>;
      // Not even the parse error: Node puts a piece of the input in it, and a
      // piece of this input is a keystroke.
      try { frame = JSON.parse(String(data)) as Record<string, unknown>; }
      catch { this.#say('malformed frame'); ws.close(1003, 'not json'); return; }
      this.#frame(ws, req, session, frame);
    });
    ws.on('pong', () => { if (this.#live?.ws === ws) this.#live.missed = 0; });
    ws.on('close', () => { clearTimeout(hello); const live = this.#live; if (live?.ws === ws) void this.#finish(live, 'The connection ended.'); });
    ws.on('error', () => { /* a closed socket reports itself through `close` */ });
  }

  #frame(ws: WebSocket, req: IncomingMessage, session: Session, frame: Record<string, unknown>): void {
    if (frame.type === 'hello') {
      this.#enqueue(() => this.#hello(ws, req, session, frame));
      return;
    }
    const live = this.#live;
    if (!live || live.ws !== ws) return;
    if (frame.type === 'input') {
      const input = readInput(frame.input);
      // A refusal says only that one was refused. The event stays out of it.
      if (!input) { this.#say('input refused by validation'); ws.send(JSON.stringify({ type: 'refused', error: 'That input was not understood.' })); return; }
      if (live.closing) { ws.send(JSON.stringify({ type: 'refused', error: 'The take-over is ending.' })); return; }
      live.lastInput = Date.now();
      this.#enqueue(() => this.#dispatch(live, input));
      return;
    }
    if (frame.type === 'bye') void this.#finish(live, 'The take-over ended.');
  }

  /**
   * One queue for the whole socket.
   *
   * Two clicks, or a click and the key that follows it, must reach the host in
   * the order the owner made them — and, more importantly, nothing may still
   * be executing when Resume hands the screen back to the agent. So every
   * message is a link in one chain, and ending the hand drains that chain
   * before it stops the screencast.
   */
  #enqueue(task: () => Promise<void>): void {
    const run = async () => {
      this.#inQueue = true;
      try { await task(); }
      catch { this.#say('hand task failed'); }
      finally { this.#inQueue = false; }
    };
    this.#queue = this.#queue.then(run, run);
  }

  /**
   * One input, once the lease still says this dashboard may drive.
   *
   * A failure here is the end of the hand rather than a message: the host
   * refuses input when the page it was driving is gone, and the honest answer
   * to that is to stop showing a picture of it. The exception itself is never
   * logged — Playwright puts the key it was given into its message.
   */
  async #dispatch(live: Live, input: HandInput): Promise<void> {
    if (live.closing || this.#live !== live) return;
    if (!(await this.#leased(live))) { await this.#finish(live, 'Your session ended. Sign in again.'); return; }
    try { await live.hand.input(input); }
    catch { this.#say('input failed at the host'); await this.#finish(live, 'The screen you were driving is gone. Take over again.'); return; }
    this.#track(live.held, input);
  }

  /** What is down, so what is down can be let go of. Never the typed text. */
  #track(held: Held, input: HandInput): void {
    if (input.kind === 'wheel') { held.x = input.x; held.y = input.y; return; }
    if (input.kind === 'mouse') {
      held.x = input.x; held.y = input.y;
      if (input.button === 'none') return;
      if (input.type === 'mousePressed') held.buttons.add(input.button);
      if (input.type === 'mouseReleased') held.buttons.delete(input.button);
      return;
    }
    if (input.type === 'keyDown') held.keys.set(input.key, { key: input.key, code: input.code });
    if (input.type === 'keyUp') held.keys.delete(input.key);
  }

  /**
   * Is this dashboard still allowed to drive?
   *
   * The upgrade proved it once; a socket can outlive everything that proof
   * rested on. So the lease is asked again — the same function the routes ask,
   * so an expired session, a destroyed one, a tailnet login that is no longer
   * allowed and Tailscale being switched off all end the hand — at most once a
   * second while input is flowing, and on the timer while it is not.
   */
  async #leased(live: Live, force = false): Promise<boolean> {
    const now = Date.now();
    if (now - live.since > (this.deps.lifetimeMs ?? MAX_LIFETIME_MS)) return false;
    if (!force && now - live.checkedAt < LEASE_FRESH_MS) return true;
    const session = await this.deps.authorize(live.req).catch(() => null);
    if (!session || session.id !== live.lease) return false;
    live.checkedAt = Date.now();
    return true;
  }

  /**
   * The first frame: the CSRF token, and the session to drive.
   *
   * The cookie came with the upgrade; this is the other half of the
   * double-submit, which an upgrade request has no header for. Then the
   * take-over itself is checked — the hand exists only while the owner holds
   * the screen, and the controller is the one that decides that.
   */
  async #hello(ws: WebSocket, req: IncomingMessage, session: Session, frame: Record<string, unknown>): Promise<void> {
    const current = this.#live;
    if (current && current.ws !== ws && current.ws.readyState === current.ws.OPEN) {
      ws.send(JSON.stringify({ type: 'refused', error: 'Another tab is driving.' }));
      ws.close(1000, 'another tab is driving');
      return;
    }
    // The same comparison every write goes through, so the hand is neither
    // stricter nor looser than the routes beside it.
    if (!SessionStore.csrfMatches(session, typeof frame.csrf === 'string' ? frame.csrf : undefined)) { ws.close(1008, 'csrf'); return; }
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : '';
    if (sessionId === '') { ws.send(JSON.stringify({ type: 'refused', error: 'Select a browser session first.' })); ws.close(1008, 'no session'); return; }
    const browser = this.deps.browser();
    const status = browser.status({ sessionId });
    if (status.session?.id !== sessionId) { ws.send(JSON.stringify({ type: 'refused', error: 'That browser session is gone. Refresh the page.' })); ws.close(1000, 'gone'); return; }
    const offer = browser.hand?.({ sessionId }) ?? { supported: false, message: 'This host has no remote hand.' };
    if (!offer.hand) {
      ws.send(JSON.stringify({ type: 'refused', supported: offer.supported, error: offer.message ?? 'This screen cannot be driven from here.' }));
      ws.close(1000, 'no hand');
      return;
    }
    const now = Date.now();
    const live: Live = { ws, req, lease: session.id, sessionId, hand: offer.hand, since: now, lastInput: now,
      checkedAt: now, missed: 0, closing: false, held: { keys: new Map(), buttons: new Set(), x: 0, y: 0 } };
    this.#live = live;
    try {
      await offer.hand.start((picture) => this.#picture(live, picture));
    } catch {
      // Whatever went wrong, the words belong to the owner, not to the log.
      this.#say('screencast failed to start');
      ws.send(JSON.stringify({ type: 'refused', error: 'The live view could not be started.' }));
      await this.#finish(live, 'The live view could not be started.');
      return;
    }
    live.timer = setInterval(() => this.#tick(live), this.deps.pingMs ?? PING_MS);
    live.timer.unref?.();
    ws.send(JSON.stringify({ type: 'driving', sessionId }));
  }

  /**
   * A frame, unless the socket is too far behind to take it.
   *
   * A phone that walks out of range does not close its TCP connection; it goes
   * quiet, and the JPEGs pile up in this process. So a socket with two
   * megabytes still unsent is skipped rather than fed, and one that stays that
   * way for ten seconds is not a viewer at all.
   */
  #picture(live: Live, picture: HandFrame): void {
    const ws = live.ws;
    if (this.#live !== live || live.closing || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      live.congestedSince ??= Date.now();
      return;
    }
    live.congestedSince = undefined;
    // Metadata first, bytes second: the picture is what it says it is.
    ws.send(JSON.stringify({ type: 'frame', metadata: picture.metadata }));
    ws.send(picture.jpeg, { binary: true });
  }

  /** Liveness, idleness, the lease and the send buffer, on one timer. */
  #tick(live: Live): void {
    const ws = live.ws;
    if (this.#live !== live || live.closing) return;
    const now = Date.now();
    if (live.congestedSince && now - live.congestedSince > (this.deps.congestionMs ?? CONGESTION_MS)) {
      this.#say('socket fell too far behind');
      ws.terminate();
      void this.#finish(live, 'The connection fell behind.');
      return;
    }
    if (now - live.lastInput > (this.deps.idleMs ?? IDLE_MS)) {
      void this.#finish(live, 'The take-over went idle.');
      return;
    }
    if (now - live.since > (this.deps.lifetimeMs ?? MAX_LIFETIME_MS)) {
      void this.#finish(live, 'This take-over reached its limit. Take over again.');
      return;
    }
    if (++live.missed > MISSED_PONGS) {
      this.#say('no pong');
      ws.terminate();
      void this.#finish(live, 'The connection stopped answering.');
      return;
    }
    if (now - live.checkedAt > (this.deps.leaseMs ?? LEASE_MS)) {
      this.#enqueue(async () => { if (!(await this.#leased(live, true))) await this.#finish(live, 'Your session ended. Sign in again.'); });
    }
    try { ws.ping(); } catch { /* the close handler says so */ }
  }

  /**
   * End the hand, in the one order that is safe.
   *
   * Mark it closing so nothing new is accepted, let what is already running
   * finish, let go of whatever the owner still had pressed, and only then stop
   * the screencast. Resume waits on all of that: an agent must never start
   * acting while a keystroke of the owner's is still on its way to the page.
   */
  #finish(live: Live, reason: string): Promise<void> {
    if (live.finishing) return live.finishing;
    live.closing = true;
    live.finishing = (async () => {
      // Called from inside the queue: that task is the only one running, and
      // waiting for it here would be waiting for this.
      if (!this.#inQueue) await this.#queue.catch(() => {});
      await this.#letGo(live);
      await live.hand.stop().catch(() => this.#say('screencast did not stop cleanly'));
      clearInterval(live.timer);
      if (this.#live === live) this.#live = undefined;
      const ws = live.ws;
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'ended', error: reason }));
        ws.close(1000, 'ended');
      }
    })();
    return live.finishing;
  }

  /**
   * Let go of everything still down.
   *
   * A socket that dies between `mousePressed` and `mouseReleased`, or with
   * Shift held, would otherwise hand the agent a page with a button stuck
   * down. Buttons first, then keys, because a modifier held through a drag is
   * part of that drag.
   */
  async #letGo(live: Live): Promise<void> {
    const { held } = live;
    for (const button of held.buttons) {
      await live.hand.input({ kind: 'mouse', type: 'mouseReleased', x: held.x, y: held.y, button, clickCount: 1, modifiers: 0 })
        .catch(() => this.#say('could not release a button'));
    }
    held.buttons.clear();
    for (const { key, code } of held.keys.values()) {
      await live.hand.input({ kind: 'key', type: 'keyUp', key, code, modifiers: 0 })
        .catch(() => this.#say('could not release a key'));
    }
    held.keys.clear();
  }

  /**
   * A session died somewhere else.
   *
   * The lease would catch it within the second, or within half a minute on an
   * idle socket — but "now" is what the owner means when they sign a device
   * out or turn the tailnet switch off, and a live picture of their browser is
   * the last thing that should outlive that.
   */
  revoke(held: (leaseId: string) => boolean, reason = 'Your session ended. Sign in again.'): void {
    const live = this.#live;
    if (live && held(live.lease)) void this.#finish(live, reason);
  }

  /**
   * The owner gave it back, or stopped everything.
   *
   * Awaited by the control routes: `resume`, `release` and `stop` all mean the
   * hand is over, and none of them may return while an input of the owner's is
   * still in flight.
   */
  async close(sessionId?: string, reason = 'The take-over ended.'): Promise<void> {
    const live = this.#live;
    if (!live || (sessionId !== undefined && live.sessionId !== sessionId)) return;
    await this.#finish(live, reason);
  }

  shutdown(): void {
    const live = this.#live;
    if (live) void this.#finish(live, 'buddi is shutting down.');
    for (const client of this.#wss.clients) client.terminate();
    this.#wss.close();
  }
}
