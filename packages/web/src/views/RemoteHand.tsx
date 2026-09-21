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
 * The picture arrives as a metadata line and then the JPEG bytes, which is how
 * the frame knows how big the page it came from is. Clicks are mapped back
 * through that metadata and the size the picture is *displayed* at, so a phone
 * showing a 1280-wide page in a 380-wide column still clicks the right link.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Notice, Toolbar } from '../ui';

/** Where a frame came from, as the host browser measured it. */
export interface HandFrameMetadata {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor: number;
  offsetTop: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
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

const BUTTONS = ['left', 'middle', 'right'] as const;

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
}

type Phase = 'connecting' | 'driving' | 'lost' | 'refused';

export function RemoteHand({ sessionId, csrf, onGiveBack, connect }: RemoteHandProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('connecting');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<HandFrameMetadata | null>(null);
  const [typing, setTyping] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const socket = useRef<HandSocket | null>(null);
  const picture = useRef<HTMLImageElement | null>(null);
  const keyboard = useRef<HTMLInputElement | null>(null);
  const held = useRef<string | null>(null);
  const expecting = useRef<HandFrameMetadata | null>(null);

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
        // The bytes that follow a metadata line: the picture it described.
        const waiting = expecting.current;
        expecting.current = null;
        if (!waiting || typeof URL?.createObjectURL !== 'function') return;
        const url = URL.createObjectURL(new Blob([event.data as ArrayBuffer], { type: 'image/jpeg' }));
        if (held.current) URL.revokeObjectURL(held.current);
        held.current = url;
        setMetadata(waiting);
        setFrame(url);
        return;
      }
      const message = JSON.parse(event.data) as { type?: string; metadata?: HandFrameMetadata; error?: string };
      if (message.type === 'frame' && message.metadata) { expecting.current = message.metadata; return; }
      if (message.type === 'driving') { setPhase('driving'); setRefusal(null); return; }
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
      try { ws.close(); } catch { /* already gone */ }
    };
  }, [sessionId, csrf, attempt, connect]);

  useEffect(() => () => { if (held.current && typeof URL?.revokeObjectURL === 'function') URL.revokeObjectURL(held.current); }, []);

  /** One event, straight out to the socket. Never stored on the way. */
  const send = useCallback((input: Record<string, unknown>): void => {
    const ws = socket.current;
    if (!ws) return;
    try { ws.send(JSON.stringify({ type: 'input', input })); } catch { /* the close handler says so */ }
  }, []);

  const point = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const element = picture.current;
    if (!element || !metadata) return null;
    const box = element.getBoundingClientRect?.();
    return box ? pagePoint(box, metadata, event.clientX, event.clientY) : null;
  };

  const pointer = (type: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => (event: React.MouseEvent<HTMLImageElement>) => {
    const at = point(event);
    if (!at) return;
    if (type === 'mousePressed') {
      event.preventDefault();
      picture.current?.focus?.();
    }
    send({ kind: 'mouse', type, x: at.x, y: at.y, button: BUTTONS[event.button] ?? 'left',
      clickCount: type === 'mouseMoved' ? 0 : Math.min(3, Math.max(1, event.detail || 1)), modifiers: modifiersOf(event) });
  };

  const wheel = (event: React.WheelEvent<HTMLImageElement>): void => {
    const at = point(event);
    if (!at) return;
    send({ kind: 'wheel', x: at.x, y: at.y, deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY) });
  };

  const keyDown = (event: React.KeyboardEvent): void => {
    // A modifier and Escape is how you get your own keyboard back; everything
    // else on this surface belongs to the page on the other end.
    if (event.key === 'Escape' && (event.ctrlKey || event.metaKey || event.altKey)) {
      setTyping(false);
      (event.target as HTMLElement).blur?.();
      return;
    }
    event.preventDefault();
    const modifiers = modifiersOf(event);
    send({ kind: 'key', type: 'keyDown', key: event.key, code: event.code, modifiers });
    if (typedCharacter(event.key) && !event.ctrlKey && !event.metaKey) {
      send({ kind: 'key', type: 'char', key: event.key, code: event.code, text: event.key, modifiers });
    }
  };

  const keyUp = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape' && (event.ctrlKey || event.metaKey || event.altKey)) return;
    event.preventDefault();
    send({ kind: 'key', type: 'keyUp', key: event.key, code: event.code, modifiers: modifiersOf(event) });
  };

  return (
    <section className="hand" data-testid="remote-hand" data-phase={phase} aria-label="Driving the host browser">
      <div className="hand-bar">
        <span className="hand-said" role="status">You are driving. Nothing you type here is kept.</span>
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
      </div>
      {phase === 'lost' ? (
        <Notice tone="warning" role="status">
          Connection lost. The picture below is the last frame that arrived.
          <Toolbar align="end"><Button size="sm" variant="accent" onClick={() => { setPhase('connecting'); setAttempt((n) => n + 1); }}>Reconnect</Button></Toolbar>
        </Notice>
      ) : null}
      {phase === 'refused' && refusal ? <Notice tone="warning" role="status">{refusal}</Notice> : null}
      <div className="hand-screen">
        {frame ? (
          <img
            ref={picture}
            className="hand-picture"
            src={frame}
            alt="The host browser, live"
            draggable={false}
            tabIndex={0}
            onMouseDown={pointer('mousePressed')}
            onMouseUp={pointer('mouseReleased')}
            onMouseMove={pointer('mouseMoved')}
            onWheel={wheel}
            onKeyDown={keyDown}
            onKeyUp={keyUp}
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
        onBlur={() => setTyping(false)}
      />
    </section>
  );
}
