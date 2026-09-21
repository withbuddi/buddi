import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteHand, modifiersOf, pagePoint, type HandSocket } from './RemoteHand';

const metadata = { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 };

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
    picture: (bytes: string) => act(() => { socket.onmessage?.({ data: new TextEncoder().encode(bytes).buffer }); }),
    drop: () => act(() => { socket.onclose?.({}); }),
  };
}

beforeEach(() => {
  // jsdom has no object URLs, and the panel must not need them to be tested.
  vi.stubGlobal('URL', Object.assign(globalThis.URL, { createObjectURL: () => 'blob:frame', revokeObjectURL: () => {} }));
});
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
    wire.say({ type: 'frame', metadata });
    wire.picture('jpeg-bytes');
    const picture = await screen.findByAltText('The host browser, live');
    expect(picture).toHaveAttribute('src', 'blob:frame');
  });

  it('sends a click at page coordinates and a keystroke that is never shown', async () => {
    const wire = fakeSocket();
    panel(wire.socket);
    wire.open();
    wire.say({ type: 'driving', sessionId: 's1' });
    wire.say({ type: 'frame', metadata });
    wire.picture('jpeg-bytes');
    const picture = await screen.findByAltText('The host browser, live');
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

  it('gives the keyboard back on a modifier and Escape rather than sending it', async () => {
    const wire = fakeSocket();
    panel(wire.socket);
    wire.open();
    wire.say({ type: 'driving', sessionId: 's1' });
    wire.say({ type: 'frame', metadata });
    wire.picture('jpeg-bytes');
    const picture = await screen.findByAltText('The host browser, live');
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
    wire.say({ type: 'frame', metadata });
    wire.picture('jpeg-bytes');
    await screen.findByAltText('The host browser, live');

    fireEvent.click(screen.getByRole('button', { name: 'Give it back' }));
    expect(giveBack).toHaveBeenCalled();

    wire.drop();
    await waitFor(() => expect(screen.getByTestId('remote-hand')).toHaveAttribute('data-phase', 'lost'));
    expect(screen.getByText(/Connection lost/)).toBeInTheDocument();
    // The last frame is still there to look at, and Reconnect asks again.
    expect(screen.getByAltText('The host browser, live')).toBeInTheDocument();
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
