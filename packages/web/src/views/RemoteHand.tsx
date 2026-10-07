/**
 * You are driving.
 *
 * The other half of Take over: while the agent is paused, this panel is a live
 * picture of the host browser and the owner's own pointer and keyboard on it.
 * It exists for the five minutes a task spends stuck behind a login, an MFA
 * prompt or a consent banner — the moments where the answer is one click and a
 * password, and where walking to the machine is the only thing standing
 * between the agent and the rest of its task.
 *
 * **Nothing typed here is kept.** The keystroke goes to the socket and
 * nowhere else: not into React state, not into the conversation, not into a
 * log. That is what the bar over the picture says, and the gateway keeps the
 * same promise on its side.
 *
 * The picture arrives as one binary message — a short header saying how big
 * the page it came from is, then the JPEG — and is drawn straight onto a
 * canvas. One message rather than two because two is two chances to wait on a
 * slow link, and a canvas rather than an `<img src=blob:>` because a blob URL
 * per frame is an allocation the browser has to be asked to take back, and at
 * ten frames a second it was not always asked. Clicks are mapped back through
 * that header and the size the picture is *displayed* at, so a phone showing a
 * 1280-wide page in a 380-wide column still clicks the right link.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { LoginSeen } from '../api';
import { Button, Notice, Toolbar } from '../ui';

/** Where a frame came from, as the host browser measured it. */
export interface HandFrameMetadata {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor: number;
  offsetTop: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  /** Where the page was when this frame was painted; the address field follows it. */
  url?: string;
}

/** A displayed rectangle, which is all of `DOMRect` this needs. */
export interface Box { left: number; top: number; width: number; height: number }

/**
 * A point on the picture, in the page's own CSS pixels.
 *
 * Two scales, not one: the picture is laid out to whatever width the column
 * gives it, and the frame itself was already scaled down by the host. The page
 * offset is the browser's own — a frame that starts below a banner is not a
 * page that starts there.
 */
export function pagePoint(box: Box, metadata: HandFrameMetadata, clientX: number, clientY: number): { x: number; y: number } {
  const width = box.width || 1;
  const height = box.height || 1;
  const scale = metadata.pageScaleFactor || 1;
  const x = ((clientX - box.left) * (metadata.deviceWidth / width)) / scale;
  const y = ((clientY - box.top) * (metadata.deviceHeight / height) - metadata.offsetTop) / scale;
  const clamp = (value: number, limit: number): number => Math.max(0, Math.min(Math.round(value), Math.round(limit)));
  return { x: clamp(x, metadata.deviceWidth), y: clamp(y, metadata.deviceHeight) };
}

/** How CDP packs the four modifier keys. */
export function modifiersOf(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

/** One character the page would have typed, as opposed to a named key. */
export function typedCharacter(key: string): boolean {
  return [...key].length === 1 && key.codePointAt(0)! >= 0x20 && key.codePointAt(0)! !== 0x7f;
}

/** A paste is as long as a form field, never as long as a file. */
export const MAX_PASTE = 4_000;

/**
 * What the owner pasted, as the page on the other end may receive it.
 *
 * Their clipboard is theirs: the host has no way to reach it, so the text
 * travels on this socket or not at all. A newline and a tab are typing and
 * survive; everything else below a space is not text a keyboard makes, and a
 * carriage return is spelt the one way both backends insert.
 */
export function pastedText(raw: string): string {
  const text = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return text.slice(0, MAX_PASTE);
}

const BUTTONS = ['left', 'middle', 'right'] as const;

/**
 * At most one pointer position every this many milliseconds.
 *
 * A finger dragging across the picture fires a move per pixel. Thirty a second
 * is more than the host can paint and far more than anyone can see; the rest
 * are positions nobody will ever look at, spending a link that has a live
 * picture to carry. The last one always goes, so the pointer ends where the
 * finger ended rather than wherever the throttle happened to fall.
 */
const MOVE_MS = 33;

/**
 * How long after the last wheel event a scroll gesture still counts as going.
 * A trackpad fires one every frame or so while a finger moves; a gap this long
 * is the finger lifted.
 */
export const WHEEL_SETTLE_MS = 150;
/** The gateway's bound on one wheel delta. */
const MAX_WHEEL_DELTA = 10_000;

/** A wheel event's deltas in CSS pixels, whatever unit the browser reported them in. */
export function wheelPixels(event: { deltaX: number; deltaY: number; deltaMode?: number }, pageHeight = 800): { dx: number; dy: number } {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1;
  return { dx: event.deltaX * unit, dy: event.deltaY * unit };
}

/**
 * Wheel deltas, summed until the next animation frame and sent as one.
 *
 * A trackpad fires a wheel event per pixel of finger travel, faster than the
 * host paints and far faster than a picture comes back. Sent one by one they
 * queue at the host, each a mouse move and a wheel, and the frames that come
 * back are a step behind the finger and a step behind each other: the picture
 * bounces. One message per frame, the deltas summed, is the same scroll in a
 * fraction of the events.
 */
export class WheelCoalescer {
  #dx = 0;
  #dy = 0;
  #x = 0;
  #y = 0;
  #scheduled: number | undefined;
  constructor(
    private readonly sendWheel: (input: { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }) => void,
    private readonly schedule: (run: () => void) => number = (run) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16) as unknown as number),
    private readonly cancel: (handle: number) => void = (handle) => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle); else clearTimeout(handle); },
  ) {}
  /** One wheel event, at a page point. */
  add(at: { x: number; y: number }, dx: number, dy: number): void {
    this.#dx += dx; this.#dy += dy; this.#x = at.x; this.#y = at.y;
    if (this.#scheduled === undefined) this.#scheduled = this.schedule(() => { this.#scheduled = undefined; this.flush(); });
  }
  /** Send what is summed now: on the frame, or before a click that must land after the scroll. */
  flush(): void {
    if (this.#scheduled !== undefined) { this.cancel(this.#scheduled); this.#scheduled = undefined; }
    const clamp = (value: number): number => Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, Math.round(value)));
    const deltaX = clamp(this.#dx), deltaY = clamp(this.#dy);
    this.#dx = 0; this.#dy = 0;
    if (deltaX === 0 && deltaY === 0) return;
    this.sendWheel({ kind: 'wheel', x: this.#x, y: this.#y, deltaX, deltaY });
  }
  /** Drop what is pending, when the socket goes. */
  reset(): void {
    if (this.#scheduled !== undefined) this.cancel(this.#scheduled);
    this.#scheduled = undefined; this.#dx = 0; this.#dy = 0;
  }
}

/**
 * Should this frame be drawn while the owner is scrolling?
 *
 * A frame that differs from the one on screen only by where the page is
 * scrolled to, and moves it *against* the way the owner is scrolling, is the
 * host catching up on an older wheel: drawing it is the bounce. It is held,
 * and the newest frame is drawn once the gesture ends. A frame that moves with
 * the gesture is drawn (the picture follows the finger), and anything that
 * changed more than the scroll always is.
 */
export function paintWhileScrolling(shown: HandFrameMetadata | null, next: HandFrameMetadata, gesture: { dx: number; dy: number } | null): boolean {
  if (!gesture || !shown || !sameFrameShape(shown, next)) return true;
  const movedX = next.scrollOffsetX - shown.scrollOffsetX;
  const movedY = next.scrollOffsetY - shown.scrollOffsetY;
  if (movedX === 0 && movedY === 0) return true;
  const against = (moved: number, way: number): boolean => moved !== 0 && way !== 0 && Math.sign(moved) !== Math.sign(way);
  return !against(movedX, gesture.dx) && !against(movedY, gesture.dy);
}

/** Has anything a click depends on moved? */
function sameFrameShape(a: HandFrameMetadata, b: HandFrameMetadata): boolean {
  return a.deviceWidth === b.deviceWidth && a.deviceHeight === b.deviceHeight
    && a.pageScaleFactor === b.pageScaleFactor && a.offsetTop === b.offsetTop && a.url === b.url;
}

/**
 * The other half of the gateway's `packFrame`: a version byte, the header's
 * length, the header as JSON, and the JPEG bytes.
 */
export function readFrame(buffer: ArrayBuffer): { metadata: HandFrameMetadata; jpeg: Blob } | null {
  if (buffer.byteLength < 3) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== 1) return null;
  const length = view.getUint16(1);
  if (buffer.byteLength < 3 + length) return null;
  try {
    const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 3, length))) as HandFrameMetadata;
    return { metadata, jpeg: new Blob([new Uint8Array(buffer, 3 + length)], { type: 'image/jpeg' }) };
  } catch { return null; }
}

/** Same origin, same session; the protocol follows the page's. */
export function handUrl(location: { protocol: string; host: string } = window.location): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/browser/hand`;
}

/** Just enough of a socket to drive, so a test can hand over its own. */
export interface HandSocket {
  send(data: string): void;
  close(): void;
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RemoteHandProps {
  /** The browser session being driven. */
  sessionId: string;
  /** The page's CSRF value, sent as the socket's first frame. */
  csrf: string;
  /** "Give it back": the owner is done, and the agent may observe again. */
  onGiveBack: () => void;
  /** Injected by tests; the real one is a `WebSocket`. */
  connect?: (url: string) => HandSocket;
  /**
   * The Page tab draws Keyboard and Give it back in its own header (the kit's
   * take-over): the hand then shows only the picture, and the keyboard is the
   * header's to switch.
   */
  bare?: boolean;
  typing?: boolean;
  onTyping?: (typing: boolean) => void;
  /** The page's address as the frames report it, for the window's address field. */
  onLocation?: (url: string) => void;
  /** The owner signed in on the page: the site and the user name to ask "Save this login?" about. Never the password. */
  onLoginSeen?: (login: LoginSeen) => void;
}

/** The window's buttons, sent down the same socket as the clicks. */
export type HandNav = 'back' | 'forward' | 'reload' | 'navigate';

/** What the Page tab's window bar reaches into the hand for. */
export interface RemoteHandHandle {
  /** Back, forward, reload, or an address; false when there is no socket to send it on. */
  nav(action: HandNav, url?: string): boolean;
  /** The last picture drawn, as an image URL, for the Page tab to keep showing after Give it back. */
  snapshot(): string | null;
}

type Phase = 'connecting' | 'driving' | 'lost' | 'refused';

export const RemoteHand = forwardRef<RemoteHandHandle, RemoteHandProps>(function RemoteHand({ sessionId, csrf, onGiveBack, connect, bare = false, typing: typingProp, onTyping, onLocation, onLoginSeen }, handle): JSX.Element {
  const [phase, setPhase] = useState<Phase>('connecting');
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Whether any picture has arrived. The picture itself lives on the canvas. */
  const [painted, setPainted] = useState(false);
  const [metadata, setMetadata] = useState<HandFrameMetadata | null>(null);
  const [typingOwn, setTypingOwn] = useState(false);
  const typing = typingProp ?? typingOwn;
  const setTyping = (next: boolean) => { if (onTyping) onTyping(next); else setTypingOwn(next); };
  const [attempt, setAttempt] = useState(0);
  const socket = useRef<HandSocket | null>(null);
  /** The latest listener, so a new one does not reconnect the socket. */
  const loginSeen = useRef(onLoginSeen);
  loginSeen.current = onLoginSeen;
  const picture = useRef<HTMLCanvasElement | null>(null);
  const keyboard = useRef<HTMLInputElement | null>(null);
  /** The last pointer position sent, and the one waiting for the throttle. */
  const moved = useRef<{ at: number; pending?: Record<string, unknown>; timer?: ReturnType<typeof setTimeout> }>({ at: 0 });
  // A keyboard switched from the header: the hidden input takes focus, which is what raises a phone's keys.
  useEffect(() => {
    if (typingProp === undefined) return;
    if (typingProp) keyboard.current?.focus?.(); else keyboard.current?.blur?.();
  }, [typingProp]);

  /** Wheel deltas waiting for the next animation frame. */
  const wheels = useRef<WheelCoalescer | null>(null);
  /** The scroll gesture in progress: its direction, and when its last wheel was. */
  const gesture = useRef<{ dx: number; dy: number; at: number } | null>(null);
  /** The frame on screen, the newest one held back while scrolling, and the order they came in. */
  const screenState = useRef<{ arrived: number; drawn: number; shown: HandFrameMetadata | null; held?: { metadata: HandFrameMetadata; jpeg: Blob; seq: number }; timer?: ReturnType<typeof setTimeout> }>({ arrived: 0, drawn: 0, shown: null });

  /**
   * Decode and draw one frame, in the order frames came. Decoding is off the
   * main thread and its promises do not resolve in order: an older frame
   * finishing after a newer one is a picture that jumps back, so a frame older
   * than the one on screen is dropped. While the owner scrolls, a frame that
   * would move the page against the gesture is held (`paintWhileScrolling`)
   * and the newest held one is drawn when the gesture ends.
   */
  const paint = (picked: { metadata: HandFrameMetadata; jpeg: Blob }, known?: number): void => {
    const state = screenState.current;
    const seq = known ?? ++state.arrived;
    const going = gesture.current && Date.now() - gesture.current.at < WHEEL_SETTLE_MS ? gesture.current : null;
    if (known === undefined && !paintWhileScrolling(state.shown, picked.metadata, going)) {
      state.held = { ...picked, seq };
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        const held = screenState.current.held;
        screenState.current.held = undefined;
        if (held) paint(held, held.seq);
      }, WHEEL_SETTLE_MS);
      return;
    }
    if (known === undefined && state.held && state.held.seq < seq) state.held = undefined;
    if (typeof createImageBitmap !== 'function') return;
    void createImageBitmap(picked.jpeg).then((bitmap) => {
      const canvas = picture.current;
      const now = screenState.current;
      if (!canvas || seq <= now.drawn) { bitmap.close?.(); return; }
      now.drawn = seq;
      now.shown = picked.metadata;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      bitmap.close?.();
    }).catch(() => { /* a frame that will not decode is a frame not drawn */ });
  };

  useEffect(() => {
    const open = connect ?? ((url: string) => new WebSocket(url) as unknown as HandSocket);
    let live = true;
    let ws: HandSocket;
    try { ws = open(handUrl()); } catch { setPhase('lost'); return undefined; }
    ws.binaryType = 'arraybuffer';
    socket.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', csrf, sessionId }));
    ws.onmessage = (event: { data: unknown }) => {
      if (!live) return;
      if (typeof event.data !== 'string') {
        const picked = readFrame(event.data as ArrayBuffer);
        if (!picked) return;
        // Only when it actually changed: this arrives thirty times a second,
        // and a page whose size and scroll have not moved does not need the
        // panel re-rendered for it.
        setMetadata((current) => (current && sameFrameShape(current, picked.metadata) ? current : picked.metadata));
        setPainted(true);
        paint(picked);
        return;
      }
      const message = JSON.parse(event.data) as { type?: string; error?: string; id?: unknown; site?: unknown; username?: unknown; update?: unknown };
      if (message.type === 'driving') { setPhase('driving'); setRefusal(null); return; }
      if (message.type === 'loginSeen') {
        if (typeof message.id === 'string' && typeof message.site === 'string' && typeof message.username === 'string') loginSeen.current?.({ id: message.id, site: message.site, username: message.username, ...(message.update === true ? { update: true } : {}) });
        return;
      }
      if (message.type === 'refused' || message.type === 'ended') {
        setRefusal(message.error ?? 'The screen cannot be driven from here.');
        setPhase('refused');
      }
    };
    ws.onclose = () => { if (live) setPhase((current) => (current === 'refused' ? current : 'lost')); };
    ws.onerror = () => { if (live) setPhase((current) => (current === 'refused' ? current : 'lost')); };
    return () => {
      live = false;
      socket.current = null;
      wheels.current?.reset();
      clearTimeout(screenState.current.timer);
      screenState.current.held = undefined;
      try { ws.close(); } catch { /* already gone */ }
    };
  }, [sessionId, csrf, attempt, connect]);

  useEffect(() => () => { clearTimeout(moved.current.timer); }, []);
  // The address the page reports, whenever it changes (a link the owner clicked, a back).
  const location = metadata?.url;
  useEffect(() => { if (location) onLocation?.(location); }, [location]);

  /** One event, straight out to the socket. Never stored on the way. */
  const send = useCallback((input: Record<string, unknown>): void => {
    const ws = socket.current;
    if (!ws) return;
    try { ws.send(JSON.stringify({ type: 'input', input })); } catch { /* the close handler says so */ }
  }, []);

  if (!wheels.current) wheels.current = new WheelCoalescer((input) => send(input));

  useImperativeHandle(handle, () => ({
    nav: (action: HandNav, url?: string): boolean => {
      if (!socket.current) return false;
      send({ kind: 'nav', action, ...(action === 'navigate' && url ? { url } : {}) });
      return true;
    },
    snapshot: (): string | null => {
      const canvas = picture.current;
      // Only a picture that was really drawn: an empty canvas is not one worth keeping.
      if (!canvas || screenState.current.drawn === 0 || !canvas.width || !canvas.height) return null;
      try {
        const url = canvas.toDataURL('image/jpeg', 0.85);
        return typeof url === 'string' && url.startsWith('data:image/') ? url : null;
      } catch { return null; }
    },
  }), [send]);

  const point = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const element = picture.current;
    if (!element || !metadata) return null;
    const box = element.getBoundingClientRect?.();
    return box ? pagePoint(box, metadata, event.clientX, event.clientY) : null;
  };

  /**
   * A pointer position, at most thirty a second and only ever the latest.
   *
   * A press or a release is an event and goes at once — and takes the pending
   * move with it, so the button lands where the finger actually is. A move is
   * only ever the newest one: any older position is somewhere the pointer has
   * already left.
   */
  const move = (input: Record<string, unknown>): void => {
    const state = moved.current;
    const now = Date.now();
    clearTimeout(state.timer);
    state.timer = undefined;
    const wait = state.at + MOVE_MS - now;
    if (wait <= 0) { state.at = now; state.pending = undefined; send(input); return; }
    state.pending = input;
    state.timer = setTimeout(() => {
      const waiting = moved.current.pending;
      moved.current.timer = undefined;
      moved.current.pending = undefined;
      moved.current.at = Date.now();
      if (waiting) send(waiting);
    }, wait);
  };

  const flushMove = (): void => {
    const state = moved.current;
    clearTimeout(state.timer);
    state.timer = undefined;
    const waiting = state.pending;
    state.pending = undefined;
    if (waiting) { state.at = Date.now(); send(waiting); }
  };

  const pointer = (type: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => (event: React.MouseEvent<HTMLCanvasElement>) => {
    const at = point(event);
    if (!at) return;
    if (type === 'mousePressed') {
      event.preventDefault();
      picture.current?.focus?.();
    }
    const input = { kind: 'mouse', type, x: at.x, y: at.y, button: BUTTONS[event.button] ?? 'left',
      clickCount: type === 'mouseMoved' ? 0 : Math.min(3, Math.max(1, event.detail || 1)), modifiers: modifiersOf(event) };
    if (type === 'mouseMoved') { move(input); return; }
    flushMove();
    // A click after a scroll lands on the page as scrolled.
    wheels.current?.flush();
    send(input);
  };

  /*
   * The wheel, on a listener of its own: React's is passive, and a wheel the
   * dashboard also takes scrolls the column under the picture, which is a
   * second thing moving under the owner's finger.
   */
  const latestPoint = useRef(point);
  latestPoint.current = point;
  useEffect(() => {
    const canvas = picture.current;
    if (!painted || !canvas) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const at = latestPoint.current(event);
      if (!at) return;
      flushMove();
      const { dx, dy } = wheelPixels(event, canvas.getBoundingClientRect?.().height || 800);
      gesture.current = { dx: dx || gesture.current?.dx || 0, dy: dy || gesture.current?.dy || 0, at: Date.now() };
      wheels.current?.add(at, dx, dy);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [painted]);

  /**
   * A character, or a key — never both.
   *
   * A printable key with no Ctrl, Cmd or Alt on it is a *character*, and goes
   * as one `char` and nothing else. Both backends type the character out of a
   * `keyDown` all by themselves (Playwright's `keyboard.down`, Chrome's
   * `dispatchKeyEvent` with text), so sending the key as well is why "ame"
   * came back "aammee". Named keys and shortcuts are the other case: they go
   * down and up, carrying no text, because Enter is a press and Cmd+A is a
   * press, not something typed.
   */
  const shortcut = (event: React.KeyboardEvent): boolean => event.ctrlKey || event.metaKey || event.altKey;

  const keyDown = (event: React.KeyboardEvent): void => {
    // A modifier and Escape is how you get your own keyboard back; everything
    // else on this surface belongs to the page on the other end.
    if (event.key === 'Escape' && shortcut(event)) {
      setTyping(false);
      (event.target as HTMLElement).blur?.();
      return;
    }
    event.preventDefault();
    // Paste is the owner's clipboard, which is here and not on the host: the
    // shortcut would paste whatever the *host* machine happens to be holding,
    // which is not theirs to reach. The `paste` event below does the real one.
    if ((event.metaKey || event.ctrlKey) && (event.key === 'v' || event.key === 'V')) return;
    const modifiers = modifiersOf(event);
    if (typedCharacter(event.key) && !shortcut(event)) {
      send({ kind: 'key', type: 'char', key: event.key, code: event.code, text: event.key, modifiers });
      return;
    }
    send({ kind: 'key', type: 'keyDown', key: event.key, code: event.code, modifiers });
  };

  const keyUp = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape' && shortcut(event)) return;
    event.preventDefault();
    if ((event.metaKey || event.ctrlKey) && (event.key === 'v' || event.key === 'V')) return;
    // The character went as a `char` on the way down; there is no key here to
    // let go of, and a `keyUp` would be a second event for one keystroke.
    if (typedCharacter(event.key) && !shortcut(event)) return;
    send({ kind: 'key', type: 'keyUp', key: event.key, code: event.code, modifiers: modifiersOf(event) });
  };

  /**
   * The owner's clipboard, on the page they are driving.
   *
   * Nothing on the host can read what is on a phone's clipboard, so a paste is
   * carried here as text and inserted there in one piece — bounded, stripped
   * of anything that is not typing, and, like every keystroke on this panel,
   * held by nothing: it goes from the clipboard event to the socket.
   */
  const paste = (event: React.ClipboardEvent): void => {
    event.preventDefault();
    const text = pastedText(event.clipboardData?.getData('text/plain') ?? '');
    if (text === '') return;
    send({ kind: 'text', text });
  };

  return (
    <section className="hand" data-testid="remote-hand" data-phase={phase} data-bare={bare ? 'true' : undefined} aria-label="Driving the page">
      {bare ? null : <div className="hand-bar">
        <span className="hand-said" role="status">You have the page. Nothing you type here is kept.</span>
        <Toolbar align="end">
          <Button
            size="sm"
            variant={typing ? 'accent' : 'ghost'}
            aria-pressed={typing}
            onClick={() => { const next = !typing; setTyping(next); if (next) keyboard.current?.focus?.(); else keyboard.current?.blur?.(); }}
          >
            Keyboard
          </Button>
          <Button size="sm" variant="accent" onClick={onGiveBack}>Give it back</Button>
        </Toolbar>
      </div>}
      {phase === 'lost' ? (
        <Notice tone="warning" role="status">
          Connection lost. The picture below is the last frame that arrived.
          <Toolbar align="end"><Button size="sm" variant="accent" onClick={() => { setPhase('connecting'); setAttempt((n) => n + 1); }}>Reconnect</Button></Toolbar>
        </Notice>
      ) : null}
      {phase === 'refused' && refusal ? <Notice tone="warning" role="status">{refusal}</Notice> : null}
      <div className="hand-screen">
        {painted ? (
          <canvas
            ref={picture}
            className="hand-picture"
            role="img"
            aria-label="The host browser, live"
            data-testid="hand-picture"
            tabIndex={0}
            onMouseDown={pointer('mousePressed')}
            onMouseUp={pointer('mouseReleased')}
            onMouseMove={pointer('mouseMoved')}
            onKeyDown={keyDown}
            onKeyUp={keyUp}
            onPaste={paste}
            onContextMenu={(event) => event.preventDefault()}
          />
        ) : (
          <p className="muted hand-waiting">{phase === 'lost' ? 'No picture arrived before the connection dropped.' : 'Waiting for the first frame…'}</p>
        )}
      </div>
      {/*
        * A phone has no keyboard until something focusable asks for one. This
        * input is that something: it is never read, and what it holds is
        * discarded on every keystroke.
        */}
      <input
        ref={keyboard}
        className="hand-typing"
        aria-label="Type into the host browser"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value=""
        onChange={() => {}}
        onKeyDown={keyDown}
        onKeyUp={keyUp}
        onPaste={paste}
        onBlur={() => setTyping(false)}
      />
    </section>
  );
});
