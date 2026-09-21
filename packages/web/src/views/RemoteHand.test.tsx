import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteHand, modifiersOf, pagePoint, readFrame, type HandSocket } from './RemoteHand';

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

  it('packs the modifiers the way CDP expects', () => {
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(0);
    expect(modifiersOf({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: true })).toBe(10);
  });
});

function panel(socket: HandSocket, onGiveBack = vi.fn()) {
  render(<RemoteHand sessionId="s1" csrf="csrf-token" onGiveBack={onGiveBack} connect={() => socket} />);
  return onGiveBack;
}

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
    expect(wire.inputs().at(-1)).toMatchObject({ kind: 'wheel', deltaY: 120 });

    // A printable key is both a key press and a typed character.
    fireEvent.keyDown(picture, { key: 'a', code: 'KeyA' });
    fireEvent.keyUp(picture, { key: 'a', code: 'KeyA' });
    expect(wire.inputs().slice(-3)).toMatchObject([
      { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA' },
      { kind: 'key', type: 'char', text: 'a' },
      { kind: 'key', type: 'keyUp', key: 'a' },
    ]);
    // It went to the socket and nowhere a person or a test can read it back.
    expect(document.body.textContent).not.toContain('KeyA');
    expect(screen.getByLabelText('Type into the host browser')).toHaveValue('');

    fireEvent.keyDown(picture, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(wire.inputs().at(-1)).toMatchObject({ kind: 'key', type: 'keyDown', key: 'Enter', modifiers: 8 });
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
