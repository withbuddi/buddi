/**
 * The grip between the conversation and the canvas.
 *
 * A drag never goes through React: the pointer is captured on the handle,
 * moves are batched to one per frame, and each frame writes one CSS variable
 * on the column (`--wb-chat-w`). React hears the width once, when the drag
 * ends, and that is also when it is saved — so a drag across the window costs
 * one render, not three hundred.
 *
 * It snaps softly at a third, a half and two thirds, a double-click puts the
 * kit's own layout back, and with focus the arrow keys move it 24 pixels.
 * The arithmetic is in `split-math.ts`.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { bounds, CHAT_MIN, dragWidth, fitWidth, keyWidth, saveWidth, sharedRoom } from './split-math';

export const WIDTH_VAR = '--wb-chat-w';

export function Splitter({
  columnRef,
  width,
  onChange,
  label = 'Resize the conversation column',
}: {
  /** The conversation column; the canvas is the element after the grip. */
  columnRef: RefObject<HTMLElement>;
  /** The committed width, or null while the kit's flex decides. */
  width: number | null;
  /** Told once per drag, per key press, and with null on a reset. */
  onChange: (width: number | null) => void;
  label?: string;
}): JSX.Element {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; left: number; shared: number; next: number | null; frame: number | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [metrics, setMetrics] = useState<{ now: number; max: number }>({ now: width ?? CHAT_MIN, max: CHAT_MIN });

  /** The room the two panes share, and the column's current width. */
  const measure = (): { shared: number; current: number; left: number } => {
    const column = columnRef.current;
    const canvas = handle.current?.nextElementSibling as HTMLElement | null | undefined;
    const current = column?.getBoundingClientRect().width || column?.offsetWidth || width || CHAT_MIN;
    const parent = column?.parentElement;
    const overflow = parent ? parent.scrollWidth - parent.clientWidth : 0;
    const shared = sharedRoom(column?.getBoundingClientRect().width ?? 0, canvas?.getBoundingClientRect().width ?? 0, overflow);
    return { shared, current, left: column?.getBoundingClientRect().left ?? 0 };
  };

  const refresh = (now?: number): void => {
    const { shared, current } = measure();
    setMetrics({ now: Math.round(now ?? current), max: bounds(shared).max });
  };

  // aria-valuenow follows the committed width, and the room on first paint.
  useEffect(() => { refresh(width ?? undefined); }, [width]);

  /** Write the width where the stylesheet reads it, outside React. */
  const paint = (next: number | null): void => {
    const column = columnRef.current;
    if (!column) return;
    if (next === null) {
      column.style.removeProperty(WIDTH_VAR);
      delete column.dataset['sized'];
    } else {
      column.style.setProperty(WIDTH_VAR, `${next}px`);
      column.dataset['sized'] = 'true';
    }
  };

  const commit = (next: number | null): void => {
    paint(next);
    saveWidth(next);
    onChange(next);
  };

  const end = (): void => {
    const state = drag.current;
    if (!state) return;
    if (state.frame !== null) cancelAnimationFrame(state.frame);
    drag.current = null;
    setDragging(false);
    document.documentElement.removeAttribute('data-resizing');
    if (state.next !== null) commit(state.next);
  };

  /*
   * When the room changes under a committed width (the window narrows, a
   * rail opens), the column is drawn at what fits — never wider than leaves
   * the canvas its minimum — and the committed width is kept, so it comes
   * back when the room does. Nothing is saved: the owner did not move it.
   */
  useEffect(() => {
    if (width === null) return;
    const parent = columnRef.current?.parentElement;
    if (!parent) return;
    const fit = (): void => {
      if (drag.current) return;
      const { shared } = measure();
      if (shared <= 0) return;
      const drawn = fitWidth(width, shared);
      paint(drawn);
      setMetrics({ now: drawn, max: bounds(shared).max });
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(parent);
    window.addEventListener('resize', fit);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [width]);

  // A drag that outlives the component (the canvas became a sheet) is let go.
  useEffect(() => () => {
    if (drag.current?.frame != null) cancelAnimationFrame(drag.current.frame);
    document.documentElement.removeAttribute('data-resizing');
  }, []);

  return (
    <div
      ref={handle}
      className="wb-grip"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={CHAT_MIN}
      aria-valuemax={Math.max(CHAT_MIN, metrics.max)}
      aria-valuenow={metrics.now}
      title="Drag to resize · double-click to reset"
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const { shared, left } = measure();
        drag.current = { pointerId: event.pointerId, left, shared, next: null, frame: null };
        setDragging(true);
        document.documentElement.setAttribute('data-resizing', 'true');
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state || state.pointerId !== event.pointerId) return;
        state.next = dragWidth(event.clientX - state.left, state.shared);
        if (state.frame !== null) return;
        state.frame = requestAnimationFrame(() => {
          const current = drag.current;
          if (!current) return;
          current.frame = null;
          if (current.next !== null) paint(current.next);
        });
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => {
        commit(null);
        refresh();
      }}
      onKeyDown={(event) => {
        const { shared, current } = measure();
        const next = keyWidth(width ?? current, event.key, shared);
        if (next === null) return;
        event.preventDefault();
        commit(next);
      }}
    />
  );
}
