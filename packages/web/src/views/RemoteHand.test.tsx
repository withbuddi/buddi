import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PASTE, RemoteHand, WheelCoalescer, modifiersOf, pagePoint, paintWhileScrolling, pastedText, readFrame, wheelPixels, type HandSocket } from './RemoteHand';

const metadata = { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 };

/** The gateway's `packFrame`, as the dashboard has to be able to read it. */
function packFrame(bytes: string, meta = metadata): ArrayBuffer {
  const head = new TextEncoder().encode(JSON.stringify(meta));
  const jpeg = new TextEncoder().encode(bytes);
  const out = new Uint8Array(3 + head.length + jpeg.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, 1);
  view.setUint16(1, head.length);
  out.set(head, 3);
  out.set(jpeg, 3 + head.length);
  return out.buffer;
}

/** A socket the test drives from both ends. */
function fakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const socket: HandSocket = {
    binaryType: '',
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send: (data: string) => { sent.push(JSON.parse(data) as Record<string, unknown>); },
    close: () => {},
  };
  return {
    socket,
    sent,
    inputs: () => sent.filter((frame) => frame.type === 'input').map((frame) => frame.input as Record<string, unknown>),
    // Wrapped, because every one of these is the server changing the panel.
    open: () => act(() => { socket.onopen?.({}); }),
    say: (message: unknown) => act(() => { socket.onmessage?.({ data: JSON.stringify(message) }); }),
    picture: (bytes: string) => act(() => { socket.onmessage?.({ data: packFrame(bytes) }); }),
    drop: () => act(() => { socket.onclose?.({}); }),
  };
}

// jsdom has neither a JPEG decoder nor a 2D canvas context. The panel must not
// need either to be driven: a frame that cannot be drawn is still a frame the
// owner may click on, and everything below is about what reaches the socket.
afterEach(() => vi.unstubAllGlobals());

describe('mapping a click back onto the page', () => {
  it('uses the displayed size, the page scale and the frame offset', () => {
    const box = { left: 0, top: 0, width: 640, height: 400 };
    // Half size on screen: the middle of the picture is the middle of the page.
    expect(pagePoint(box, metadata, 320, 200)).toEqual({ x: 640, y: 400 });
    // An offset frame starts below the top of the picture it was cut from.
    expect(pagePoint(box, { ...metadata, offsetTop: 40 }, 320, 200)).toEqual({ x: 640, y: 360 });
    // A pinched page: CSS pixels are what the browser is told, not device ones.
    expect(pagePoint(box, { ...metadata, pageScaleFactor: 2 }, 320, 200)).toEqual({ x: 320, y: 200 });
    // The panel is not always at the top left of the window.
    expect(pagePoint({ left: 20, top: 100, width: 640, height: 400 }, metadata, 340, 300)).toEqual({ x: 640, y: 400 });
    // Nothing off the end of the page ever reaches the wire.
    expect(pagePoint(box, metadata, 5_000, 5_000)).toEqual({ x: 1280, y: 800 });
  });

  it('keeps a paste to typing: newlines and tabs, and nothing longer than a field', () => {
    expect(pastedText('one\r\ntwo\tthree')).toBe('one\ntwo\tthree');
    expect(pastedText('bell\u0007null\u0000')).toBe('bellnull');
    expect(pastedText('x'.repeat(MAX_PASTE + 100))).toHaveLength(MAX_PASTE);
  });

  it('packs the modifiers the way CDP expects', () => {
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(0);
    expect(modifiersOf({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: true })).toBe(10);
  });
});

function panel(socket: HandSocket, onGiveBack = vi.fn()) {
  render(<RemoteHand sessionId="s1" csrf="csrf-token" onGiveBack={onGiveBack} connect={() => socket} />);
  return onGiveBack;
}

describe('scrolling without the shake', () => {
  it('sums the wheel deltas of one animation frame into one message', () => {
    const sent: Array<Record<string, unknown>> = [];
    const frames: Array<() => void> = [];
    const wheels = new WheelCoalescer((input) => sent.push(input), (run) => frames.push(run), () => { frames.length = 0; });
    wheels.add({ x: 10, y: 20 }, 0, 4);
    wheels.add({ x: 10, y: 21 }, 1, 6.4);
    wheels.add({ x: 11, y: 22 }, 0, 10);
    expect(sent).toEqual([]);
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(sent).toEqual([{ kind: 'wheel', x: 11, y: 22, deltaX: 1, deltaY: 20 }]);
    // The next frame starts from nothing; a frame with nothing summed sends nothing.
    wheels.add({ x: 11, y: 22 }, 0, -3);
    frames.shift()!();
    expect(sent.at(-1)).toMatchObject({ deltaX: 0, deltaY: -3 });
    wheels.flush();
    expect(sent).toHaveLength(2);
    // Bounded the way the gateway bounds it.
    wheels.add({ x: 0, y: 0 }, 0, 50_000);
    wheels.flush();
    expect(sent.at(-1)).toMatchObject({ deltaY: 10_000 });
  });

  it('reads lines and pages as pixels', () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toEqual({ dx: 0, dy: 48 });
    expect(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 600)).toEqual({ dx: 0, dy: 600 });
    expect(wheelPixels({ deltaX: 2, deltaY: 5 })).toEqual({ dx: 2, dy: 5 });
  });

  it('holds back a frame that only scrolls the page against the gesture, and draws everything else', () => {
    const shown = { ...metadata, scrollOffsetY: 300 };
    const down = { dx: 0, dy: 40 };
    // With the finger: drawn.
    expect(paintWhileScrolling(shown, { ...shown, scrollOffsetY: 340 }, down)).toBe(true);
    // Against it, scroll alone: the host catching up on an older wheel. Held.
    expect(paintWhileScrolling(shown, { ...shown, scrollOffsetY: 280 }, down)).toBe(false);
    // Anything more than the scroll changed: drawn.
    expect(paintWhileScrolling(shown, { ...shown, scrollOffsetY: 280, url: 'https://example.com/next' }, down)).toBe(true);
    // No gesture going: everything is drawn.
    expect(paintWhileScrolling(shown, { ...shown, scrollOffsetY: 280 }, null)).toBe(true);
  });

  it('sends a scroll waiting for its frame before a click, so the click lands on the scrolled page', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const wire = fakeSocket();
    panel(wire.socket);
    wire.open();
    wire.say({ type: 'driving', sessionId: 's1' });
    wire.picture('jpeg-bytes');
    const picture = await screen.findByLabelText('The host browser, live');
    picture.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 400 } as DOMRect);
    fireEvent.wheel(picture, { clientX: 10, clientY: 10, deltaY: 30 });
    fireEvent.wheel(picture, { clientX: 10, clientY: 10, deltaY: 30 });
    fireEvent.wheel(picture, { clientX: 10, clientY: 10, deltaY: 30 });
    // The frame never came (a frozen requestAnimationFrame): nothing yet.
    expect(wire.inputs()).toEqual([]);
    fireEvent.mouseDown(picture, { clientX: 20, clientY: 20, button: 0, detail: 1 });
    expect(wire.inputs()).toMatchObject([
      { kind: 'wheel', x: 20, y: 20, deltaY: 90 },
      { kind: 'mouse', type: 'mousePressed', x: 40, y: 40 },
    ]);
  });

  it('keeps the dashboard from scrolling under the picture', async () => {
    const wire = fakeSocket();
    panel(wire.socket);
    wire.open();
    wire.picture('jpeg-bytes');
    const picture = await screen.findByLabelText('The host browser, live');
    const event = new WheelEvent('wheel', { deltaY: 40, cancelable: true, bubbles: true });
    picture.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('driving the host browser', () => {
  it('says hello with the CSRF token and shows the first frame', async () => {
    const wire = fakeSocket();
    panel(wire.socket);
    wire.open();
    expect(wire.sent[0]).toEqual({ type: 'hello', csrf: 'csrf-token', sessionId: 's1' });
    expect(screen.getByRole('status', { name: '' }).textContent).toContain('Nothing you type here is kept');

    wire.say({ type: 'driving', sessionId: 's1' });
    wire.picture('jpeg-bytes');
    expect(await screen.findByLabelText('The host browser, live')).toBeInTheDocument();
  });

  it('hands a sign-in the owner just made to the Page tab: the site and the user name, nothing else', () => {
    const wire = fakeSocket();
    const onLoginSeen = vi.fn();
    render(<RemoteHand sessionId="s1" csrf="csrf-token" onGiveBack={vi.fn()} connect={() => wire.socket} onLoginSeen={onLoginSeen} />);
    wire.open();
    wire.say({ type: 'driving', sessionId: 's1' });
    wire.say({ type: 'loginSeen', id: 'q1', site: 'amazon.com', username: 'sam@example.com' });
    wire.say({ type: 'loginSeen', id: 7, site: 'amazon.com', username: 'sam@example.com' });
    expect(onLoginSeen).toHaveBeenCalledTimes(1);
    expect(onLoginSeen).toHaveBeenCalledWith({ id: 'q1', site: 'amazon.com', username: 'sam@example.com' });
    // The question changes nothing about driving: the panel still says what it was saying.
    expect(screen.getByRole('status', { name: '' }).textContent).toContain('Nothing you type here is kept');
  });

  it('reads a frame out of the one message the gateway sends', () => {
    const read = readFrame(packFrame('jpeg-bytes', { ...metadata, offsetTop: 40 }));
    expect(read?.metadata.offsetTop).toBe(40);
    expect(read?.jpeg.size).toBe('jpeg-bytes'.length);
    // Anything that is not one of those is not drawn rather than guessed at.
    expect(readFrame(new Uint8Array([9, 9, 9]).buffer)).toBeNull();
    expect(readFrame(new Uint8Array([1]).buffer)).toBeNull();
  });

  it('sends a click at page coordinates and a keystroke that is never shown', async () => {
    const wire = fakeSocket();
    panel(wire.socket);
    wire.open();
    wire.say({ type: 'driving', sessionId: 's1' });
    wire.picture('jpeg-bytes');
    const picture = await screen.findByLabelText('The host browser, live');
    picture.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 400 } as DOMRect);

    fireEvent.mouseDown(picture, { clientX: 320, clientY: 200, button: 0, detail: 1 });
    fireEvent.mouseUp(picture, { clientX: 320, clientY: 200, button: 0, detail: 1 });
    expect(wire.inputs()).toMatchObject([
      { kind: 'mouse', type: 'mousePressed', x: 640, y: 400, button: 'left', clickCount: 1 },
      { kind: 'mouse', type: 'mouseReleased', x: 640, y: 400 },
    ]);

    fireEvent.wheel(picture, { clientX: 0, clientY: 0, deltaX: 0, deltaY: 120 });
    // On the next animation frame, not at once.
    await waitFor(() => expect(wire.inputs().at(-1)).toMatchObject({ kind: 'wheel', deltaY: 120 }));

    // A printable key is a typed character and only that: the key itself types
    // it at the far end, so sending both is how "ame" came back "aammee".
    fireEvent.keyDown(picture, { key: 'a', code: 'KeyA' });
    fireEvent.keyUp(picture, { key: 'a', code: 'KeyA' });
    expect(wire.inputs().slice(-1)).toMatchObject([{ kind: 'key', type: 'char', key: 'a', code: 'KeyA', text: 'a' }]);
    // It went to the socket and nowhere a person or a test can read it back.
    expect(document.body.textContent).not.toContain('KeyA');
    expect(screen.getByLabelText('Type into the host browser')).toHaveValue('');

    fireEvent.keyDown(picture, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(wire.inputs().at(-1)).toMatchObject({ kind: 'key', type: 'keyDown', key: 'Enter', modifiers: 8 });
  });

  it('types one character per key, and nothing else', async () => {
    const wire = fakeSocket();
    panel(wire.socket);
    wire.open();
    wire.say({ type: 'driving', sessionId: 's1' });
    wire.picture('jpeg-bytes');
    const picture = await screen.findByLabelText('The host browser, live');

    for (const character of 'ame') {
      fireEvent.keyDown(picture, { key: character, code: `Key${character.toUpperCase()}` });
      fireEvent.keyUp(picture, { key: character, code: `Key${character.toUpperCase()}` });
    }
    // Three keystrokes, three events, one insertion each — not "aammee".
    expect(wire.inputs()).toHaveLength(3);
    expect(wire.inputs().map((event) => event.type)).toEqual(['char', 'char', 'char']);
    expect(wire.inputs().map((event) => event.text).join('')).toBe('ame');

    // A shortcut is a press, not a character: it goes down and up, with no
    // text on it for a backend to type.
    fireEvent.keyDown(picture, { key: 'a', code: 'KeyA', metaKey: true });
    fireEvent.keyUp(picture, { key: 'a', code: 'KeyA', metaKey: true });
    expect(wire.inputs().slice(-2)).toMatchObject([
      { kind: 'key', type: 'keyDown', key: 'a', modifiers: 4 },
      { kind: 'key', type: 'keyUp', key: 'a', modifiers: 4 },
    ]);
    expect(wire.inputs().slice(-2).every((event) => event.text === undefined)).toBe(true);
  });

  it('carries a paste as text, and never forwards the paste shortcut', async () => {
    const wire = fakeSocket();
    panel(wire.socket);
    wire.open();
    wire.say({ type: 'driving', sessionId: 's1' });
    wire.picture('jpeg-bytes');
    const picture = await screen.findByLabelText('The host browser, live');

    // The shortcut itself is the *host's* clipboard, which is not the owner's,
    // so it goes nowhere. The paste event is the real one.
    fireEvent.keyDown(picture, { key: 'v', code: 'KeyV', metaKey: true });
    fireEvent.keyUp(picture, { key: 'v', code: 'KeyV', metaKey: true });
    fireEvent.keyDown(picture, { key: 'v', code: 'KeyV', ctrlKey: true });
    expect(wire.inputs()).toHaveLength(0);

    fireEvent.paste(picture, { clipboardData: { getData: () => 'hunter2\r\nsecond line\u0007' } });
    expect(wire.inputs()).toEqual([{ kind: 'text', text: 'hunter2\nsecond line' }]);

    // Nothing pasted is anywhere a person or a test can read it back.
    expect(document.body.textContent).not.toContain('hunter2');
    expect(screen.getByLabelText('Type into the host browser')).toHaveValue('');

    // An empty clipboard is not an event.
    fireEvent.paste(picture, { clipboardData: { getData: () => '' } });
    expect(wire.inputs()).toHaveLength(1);
    // And nothing longer than a form field's worth goes at all.
    fireEvent.paste(picture, { clipboardData: { getData: () => 'x'.repeat(5_000) } });
    expect((wire.inputs().at(-1)!.text as string).length).toBe(MAX_PASTE);
  });

  it('sends at most one pointer position every thirty milliseconds, and always the last one', async () => {
    const wire = fakeSocket();
    panel(wire.socket);
    wire.open();
    wire.say({ type: 'driving', sessionId: 's1' });
    wire.picture('jpeg-bytes');
    const picture = await screen.findByLabelText('The host browser, live');
    picture.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 800 } as DOMRect);

    // A finger dragging across the picture: a move per pixel, none of which
    // anyone will ever see but the last.
    for (let i = 0; i < 40; i++) fireEvent.mouseMove(picture, { clientX: 100 + i, clientY: 300 });
    const moves = () => wire.inputs().filter((input) => input.type === 'mouseMoved');
    expect(moves().length).toBe(1);
    // The one waiting is the newest, and it goes out on its own.
    await waitFor(() => expect(moves().length).toBe(2));
    expect(moves().at(-1)).toMatchObject({ x: 139, y: 300 });

    // A press does not wait behind the throttle, and takes the pending
    // position with it so the button lands where the finger is.
    for (let i = 0; i < 5; i++) fireEvent.mouseMove(picture, { clientX: 300 + i, clientY: 300 });
    fireEvent.mouseDown(picture, { clientX: 304, clientY: 300, button: 0, detail: 1 });
    expect(wire.inputs().at(-1)).toMatchObject({ type: 'mousePressed', x: 304 });
    expect(wire.inputs().at(-2)).toMatchObject({ type: 'mouseMoved', x: 304 });
  });

  it('gives the keyboard back on a modifier and Escape rather than sending it', async () => {
    const wire = fakeSocket();
    panel(wire.socket);
    wire.open();
    wire.say({ type: 'driving', sessionId: 's1' });
    wire.picture('jpeg-bytes');
    const picture = await screen.findByLabelText('The host browser, live');
    const before = wire.inputs().length;
    fireEvent.keyDown(picture, { key: 'Escape', code: 'Escape', metaKey: true });
    expect(wire.inputs()).toHaveLength(before);
    // A plain Escape is the page's, because a page may well want one.
    fireEvent.keyDown(picture, { key: 'Escape', code: 'Escape' });
    expect(wire.inputs().at(-1)).toMatchObject({ key: 'Escape' });
  });

  it('turns the phone keyboard on with the toggle', () => {
    const wire = fakeSocket();
    panel(wire.socket);
    wire.open();
    const toggle = screen.getByRole('button', { name: 'Keyboard' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(document.activeElement).toBe(screen.getByLabelText('Type into the host browser'));
  });

  it('hands the screen back, and freezes with a way to reconnect when the socket drops', async () => {
    const wire = fakeSocket();
    const giveBack = panel(wire.socket);
    wire.open();
    wire.say({ type: 'driving', sessionId: 's1' });
    wire.picture('jpeg-bytes');
    await screen.findByLabelText('The host browser, live');

    fireEvent.click(screen.getByRole('button', { name: 'Give it back' }));
    expect(giveBack).toHaveBeenCalled();

    wire.drop();
    await waitFor(() => expect(screen.getByTestId('remote-hand')).toHaveAttribute('data-phase', 'lost'));
    expect(screen.getByText(/Connection lost/)).toBeInTheDocument();
    // The last frame is still there to look at, and Reconnect asks again.
    expect(screen.getByLabelText('The host browser, live')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('says why when the mode cannot be driven from here', async () => {
    const wire = fakeSocket();
    panel(wire.socket);
    wire.open();
    wire.say({ type: 'refused', supported: false, error: 'Take over at the computer for this mode.' });
    expect(await screen.findByText('Take over at the computer for this mode.')).toBeInTheDocument();
  });
});
