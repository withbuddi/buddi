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
import type { BrowserController, BrowserHand, HandInput } from '@buddi/tool-browser';
import { SessionStore, type Session } from './sessions.js';

/** The dashboard's half of the take-over, on the same upgrade listener. */
export const REMOTE_HAND_SOCKET_PATH = '/api/browser/hand';

/** A picture is large; a pointer event is not. Nothing here needs a megabyte. */
const MAX_FRAME_BYTES = 64 * 1024;
/** A socket that says nothing at all is a socket that never becomes a hand. */
const HELLO_TIMEOUT_MS = 10_000;

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
  /** The session behind this upgrade, or null. The dashboard's own gate. */
  authorize(req: IncomingMessage): Promise<Session | null>;
  /** The host controller, resolved per call the way the routes resolve it. */
  browser(): BrowserController;
  /** Where a *failure* goes. Never a frame, never a key, never a coordinate. */
  log?(line: string): void;
}

/**
 * One hand, or none.
 *
 * The endpoint owns no state worth the name: a socket, the session it is
 * driving, and the driver's hand while it is running.
 */
export class RemoteHandEndpoint {
  #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  #socket?: WebSocket;
  #sessionId?: string;
  #hand?: BrowserHand;
  constructor(readonly deps: RemoteHandDeps) {}

  /** Which browser session is being driven right now, if any. */
  get driving(): string | undefined { return this.#sessionId; }

  #refuse(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  /** Registered on the extension endpoint's upgrade listener, by path. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    void this.deps.authorize(req).then((session) => {
      if (!session) return this.#refuse(socket, 401, 'Unauthorized');
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, session));
    }, () => this.#refuse(socket, 500, 'Internal Server Error'));
  }

  #accept(ws: WebSocket, session: Session): void {
    const hello = setTimeout(() => { if (this.#socket !== ws) ws.close(1002, 'no hello'); }, HELLO_TIMEOUT_MS);
    hello.unref?.();
    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // Nothing the dashboard sends is bytes.
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(String(data)) as Record<string, unknown>; }
      catch { ws.close(1003, 'not json'); return; }
      // Never `frame` itself: it may hold a keystroke.
      void this.#frame(ws, session, frame).catch((error: unknown) => {
        this.deps.log?.(`browser hand: ${error instanceof Error ? error.message : 'failed'}`);
      });
    });
    ws.on('close', () => { clearTimeout(hello); if (this.#socket === ws) void this.#release(); });
    ws.on('error', () => { /* a closed socket reports itself through `close` */ });
  }

  async #frame(ws: WebSocket, session: Session, frame: Record<string, unknown>): Promise<void> {
    if (frame.type === 'hello') return this.#hello(ws, session, frame);
    if (this.#socket !== ws) return;
    if (frame.type === 'input') {
      const input = readInput(frame.input);
      // A refusal says only that one was refused. The event stays out of it.
      if (!input) { ws.send(JSON.stringify({ type: 'refused', error: 'That input was not understood.' })); return; }
      await this.#hand?.input(input).catch((error: unknown) => {
        this.deps.log?.(`browser hand: input refused: ${error instanceof Error ? error.message : 'failed'}`);
      });
      return;
    }
    if (frame.type === 'bye') ws.close(1000, 'done');
  }

  /**
   * The first frame: the CSRF token, and the session to drive.
   *
   * The cookie came with the upgrade; this is the other half of the
   * double-submit, which an upgrade request has no header for. Then the
   * take-over itself is checked — the hand exists only while the owner holds
   * the screen, and the controller is the one that decides that.
   */
  async #hello(ws: WebSocket, session: Session, frame: Record<string, unknown>): Promise<void> {
    if (this.#socket && this.#socket !== ws && this.#socket.readyState === this.#socket.OPEN) {
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
    this.#socket = ws;
    this.#sessionId = sessionId;
    this.#hand = offer.hand;
    try {
      await offer.hand.start((picture) => {
        if (this.#socket !== ws || ws.readyState !== ws.OPEN) return;
        // Metadata first, bytes second: the picture is what it says it is.
        ws.send(JSON.stringify({ type: 'frame', metadata: picture.metadata }));
        ws.send(picture.jpeg, { binary: true });
      });
    } catch (error) {
      this.deps.log?.(`browser hand: ${error instanceof Error ? error.message : 'could not start'}`);
      ws.send(JSON.stringify({ type: 'refused', error: error instanceof Error ? error.message : 'The live view could not be started.' }));
      await this.#release();
      ws.close(1011, 'no screencast');
      return;
    }
    ws.send(JSON.stringify({ type: 'driving', sessionId }));
  }

  /** Stop the screencast and forget the hand. The socket may already be gone. */
  async #release(): Promise<void> {
    const hand = this.#hand;
    this.#hand = undefined;
    this.#sessionId = undefined;
    this.#socket = undefined;
    await hand?.stop().catch((error: unknown) => this.deps.log?.(`browser hand: ${error instanceof Error ? error.message : 'could not stop'}`));
  }

  /**
   * The owner gave it back, or stopped everything.
   *
   * Called from the control routes rather than waited for: `resume`, `release`
   * and `stop` all mean the hand is over, and a dashboard still holding the
   * socket is told so instead of being left with a frozen picture it can
   * click on.
   */
  async close(sessionId?: string, reason = 'The take-over ended.'): Promise<void> {
    if (!this.#socket || (sessionId !== undefined && this.#sessionId !== sessionId)) return;
    const socket = this.#socket;
    await this.#release();
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'ended', error: reason }));
      socket.close(1000, 'ended');
    }
  }

  shutdown(): void {
    void this.#release();
    for (const client of this.#wss.clients) client.terminate();
    this.#wss.close();
  }
}
