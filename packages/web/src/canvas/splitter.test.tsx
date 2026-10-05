/**
 * The grip between the conversation and the canvas: the arithmetic (clamp,
 * snap, keys) and the one thing a render has to prove — that the width is
 * kept on this device, comes back on the next visit, and a double-click
 * forgets it.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState, type CSSProperties } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bounds, CANVAS_MIN, CHAT_MIN, clamp, DETENT, dragWidth, fitWidth, KEY_STEP, keyWidth, readWidth, saveWidth, sharedRoom, snap, WIDTH_KEY } from './split-math';
import { Splitter, WIDTH_VAR } from './Splitter';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  try { window.localStorage.clear(); } catch { /* fine */ }
});

describe('the arithmetic', () => {
  it('keeps both panes over their minimums', () => {
    expect(bounds(1200)).toEqual({ min: CHAT_MIN, max: 1200 - CANVAS_MIN });
    expect(clamp(100, 1200)).toBe(CHAT_MIN);
    expect(clamp(1100, 1200)).toBe(1200 - CANVAS_MIN);
    expect(clamp(500.4, 1200)).toBe(500);
    // Too little room for both: the conversation keeps its floor.
    expect(bounds(500).max).toBe(CHAT_MIN);
    // Unmeasured (jsdom, before layout): only the floor holds.
    expect(clamp(900, 0)).toBe(900);
    expect(clamp(Number.NaN, 1200)).toBe(CHAT_MIN);
  });

  it('snaps softly at a third, a half and two thirds', () => {
    expect(snap(400 + DETENT, 1200)).toBe(400);
    expect(snap(600 - DETENT, 1200)).toBe(600);
    expect(snap(800 + 5, 1200)).toBe(800);
    // Just past the detent it follows the pointer again.
    expect(snap(600 + DETENT + 1, 1200)).toBe(600 + DETENT + 1);
    expect(snap(500, 1200)).toBe(500);
    // A snap point outside the bounds is still clamped.
    expect(dragWidth(305, 900)).toBe(CHAT_MIN);
    expect(dragWidth(1000, 1200)).toBe(1200 - CANVAS_MIN);
  });

  it('moves 24px per arrow, to the ends on Home and End, and ignores other keys', () => {
    expect(keyWidth(500, 'ArrowRight', 1200)).toBe(500 + KEY_STEP);
    expect(keyWidth(500, 'ArrowLeft', 1200)).toBe(500 - KEY_STEP);
    // Keys do not snap: 590 + 24 is 614, not the half at 600.
    expect(keyWidth(590, 'ArrowRight', 1200)).toBe(614);
    expect(keyWidth(CHAT_MIN + 10, 'ArrowLeft', 1200)).toBe(CHAT_MIN);
    expect(keyWidth(910, 'ArrowRight', 1200)).toBe(1200 - CANVAS_MIN);
    expect(keyWidth(500, 'Home', 1200)).toBe(CHAT_MIN);
    expect(keyWidth(500, 'End', 1200)).toBe(1200 - CANVAS_MIN);
    expect(keyWidth(500, 'End', 0)).toBeNull();
    expect(keyWidth(500, 'Enter', 1200)).toBeNull();
  });

  it('draws a committed width exactly, and inside both minimums when the room narrows', () => {
    // Both panes fit: the column is exactly what was asked, near the minimum too.
    expect(fitWidth(CHAT_MIN + 4, 1200)).toBe(CHAT_MIN + 4);
    expect(fitWidth(1200 - CANVAS_MIN, 1200)).toBe(1200 - CANVAS_MIN);
    // The window narrowed to 900 under a 700px column: the canvas stopped at
    // its minimum and 80px spilled over. The real room is 900, and the column
    // is drawn at 620 so the canvas keeps its 280.
    const shared = sharedRoom(700, CANVAS_MIN, 80);
    expect(shared).toBe(900);
    expect(fitWidth(700, shared)).toBe(900 - CANVAS_MIN);
    expect(fitWidth(700, shared) + CANVAS_MIN).toBe(shared);
    // No spill (a negative difference never adds room).
    expect(sharedRoom(500, 700, -20)).toBe(1200);
  });

  it('reads and writes the width without ever throwing', () => {
    saveWidth(512.6);
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe('513');
    expect(readWidth()).toBe(513);
    window.localStorage.setItem(WIDTH_KEY, '12');
    expect(readWidth()).toBeNull();
    window.localStorage.setItem(WIDTH_KEY, 'wide');
    expect(readWidth()).toBeNull();
    saveWidth(null);
    expect(window.localStorage.getItem(WIDTH_KEY)).toBeNull();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readWidth()).toBeNull();
    expect(() => saveWidth(600)).not.toThrow();
    vi.restoreAllMocks();
  });
});

/** The page, reduced to what the grip touches: a column, the grip, a canvas. */
function Harness({ onRender }: { onRender?: () => void }): JSX.Element {
  const column = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number | null>(readWidth);
  onRender?.();
  return (
    <div>
      <section
        ref={column}
        data-testid="column"
        data-sized={width === null ? undefined : 'true'}
        style={width === null ? undefined : ({ [WIDTH_VAR]: `${width}px` } as CSSProperties)}
      />
      <Splitter columnRef={column} width={width} onChange={setWidth} />
      <div data-testid="canvas" />
    </div>
  );
}

function rect(element: HTMLElement, left: number, width: number): void {
  element.getBoundingClientRect = () => ({ left, width, top: 0, height: 600, right: left + width, bottom: 600, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
}

/** Animation frames, run when the test says a frame has passed. */
const frames: FrameRequestCallback[] = [];
function flush(): void {
  for (const run of frames.splice(0)) run(0);
}

describe('the grip on the page', () => {
  beforeEach(() => {
    // jsdom's pointer events carry no pointerId or clientX; a mouse event that does.
    class TestPointerEvent extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? 'mouse';
      }
    }
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    frames.length = 0;
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => frames.push(run));
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  it('keeps the width per device and brings it back on the next visit', () => {
    render(<Harness />);
    const grip = screen.getByRole('separator', { name: 'Resize the conversation column' });
    expect(grip.getAttribute('aria-orientation')).toBe('vertical');
    expect(grip.tabIndex).toBe(0);
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe(String(CHAT_MIN + KEY_STEP));
    expect(grip.getAttribute('aria-valuenow')).toBe(String(CHAT_MIN + KEY_STEP));
    cleanup();

    render(<Harness />);
    const column = screen.getByTestId('column');
    expect(column.dataset['sized']).toBe('true');
    expect(column.style.getPropertyValue(WIDTH_VAR)).toBe(`${CHAT_MIN + KEY_STEP}px`);

    // A double-click puts the kit's layout back, and forgets.
    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(window.localStorage.getItem(WIDTH_KEY)).toBeNull();
    expect(column.dataset['sized']).toBeUndefined();
    expect(column.style.getPropertyValue(WIDTH_VAR)).toBe('');
  });

  it('drags through the CSS variable, renders once at the end, and snaps', () => {
    let renders = 0;
    render(<Harness onRender={() => { renders += 1; }} />);
    const column = screen.getByTestId('column');
    rect(column, 100, 500);
    rect(screen.getByTestId('canvas'), 600, 700);
    const grip = screen.getByRole('separator');
    grip.setPointerCapture = vi.fn();
    grip.releasePointerCapture = vi.fn();

    act(() => { fireEvent.pointerDown(grip, { pointerId: 7, button: 0, pointerType: 'touch', clientX: 600 }); });
    expect(grip.setPointerCapture).toHaveBeenCalledWith(7);
    expect(document.documentElement.getAttribute('data-resizing')).toBe('true');
    const before = renders;
    // Shared room is 1200: the moves land at 450, 520 and then near the half.
    for (const x of [550, 620, 708]) fireEvent.pointerMove(grip, { pointerId: 7, clientX: x });
    // Three moves inside one frame: one paint.
    expect(frames).toHaveLength(1);
    flush();
    expect(renders).toBe(before);
    // 708 - 100 = 608, inside the detent of the half (600).
    expect(column.style.getPropertyValue(WIDTH_VAR)).toBe('600px');
    expect(window.localStorage.getItem(WIDTH_KEY)).toBeNull();

    act(() => { fireEvent.pointerUp(grip, { pointerId: 7, clientX: 708 }); });
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe('600');
    expect(document.documentElement.hasAttribute('data-resizing')).toBe(false);
    expect(grip.getAttribute('data-dragging')).toBeNull();
  });

  it('does not let a sized column shrink against the canvas', () => {
    const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
    const rule = css.match(/\.wb-chat\[data-sized='true'\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/flex:\s*0 0 auto/);
  });

  it('re-draws a committed width at what fits when the room narrows, and saves nothing', () => {
    let resized: (() => void) | null = null;
    vi.stubGlobal('ResizeObserver', class { constructor(run: () => void) { resized = run; } observe() {} disconnect() {} });
    window.localStorage.setItem(WIDTH_KEY, '700');
    render(<Harness />);
    const column = screen.getByTestId('column');
    const parent = column.parentElement!;
    rect(column, 0, 700);
    rect(screen.getByTestId('canvas'), 700, CANVAS_MIN);
    Object.defineProperty(parent, 'clientWidth', { configurable: true, value: 900 });
    Object.defineProperty(parent, 'scrollWidth', { configurable: true, value: 980 });
    act(() => { resized?.(); });
    expect(column.style.getPropertyValue(WIDTH_VAR)).toBe(`${900 - CANVAS_MIN}px`);
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe('700');
  });

  it('never lets a drag take either pane under its minimum', () => {
    render(<Harness />);
    const column = screen.getByTestId('column');
    rect(column, 0, 500);
    rect(screen.getByTestId('canvas'), 500, 500);
    const grip = screen.getByRole('separator');
    act(() => { fireEvent.pointerDown(grip, { pointerId: 1, button: 0, pointerType: 'mouse', clientX: 500 }); });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 990 });
    flush();
    expect(column.style.getPropertyValue(WIDTH_VAR)).toBe(`${1000 - CANVAS_MIN}px`);
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 40 });
    flush();
    expect(column.style.getPropertyValue(WIDTH_VAR)).toBe(`${CHAT_MIN}px`);
    act(() => { fireEvent.pointerUp(grip, { pointerId: 1 }); });
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe(String(CHAT_MIN));
  });
});
