/**
 * The canvas's tabs for one conversation, kept on the server
 * (`GET/PUT /api/chat/conversations/:id/canvas-tabs`): which tabs the owner
 * closed, and when each was last looked at, which is the strip's order. Read
 * when the conversation opens, written a moment after it changes — so the
 * strip is the same after a reload and on the phone.
 *
 * A read that fails leaves the strip as the transcript makes it; a write that
 * fails costs the order, never the conversation.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { chatApi, type CanvasTabsState } from '../api';

/** How long changes gather before one write. */
const SAVE_DELAY_MS = 600;

/** The newest this many of each half are kept, as the server keeps them. */
const LIMIT = 200;

const EMPTY: CanvasTabsState = { closed: [], touched: {} };

export interface CanvasTabs {
  /** The stored state has been read (or could not be): until then the strip waits, rather than flash a closed tab. */
  ready: boolean;
  closed: readonly string[];
  touched: Readonly<Record<string, number>>;
  /** Put these away (their stamps). */
  close: (stamps: readonly string[]) => void;
  /** Bring these back: a chat row clicked, a newer call. */
  reopen: (stamps: readonly string[]) => void;
  /** This tab was looked at now. */
  touch: (id: string) => void;
}

/** The ids the server accepts (gateway `web/canvas-tabs.ts`); anything else stays on this page. */
const ID = /^[\w:./-]{1,200}$/;

function trimmed(state: CanvasTabsState): CanvasTabsState {
  return {
    closed: state.closed.filter((id) => ID.test(id)).slice(-LIMIT),
    touched: Object.fromEntries(Object.entries(state.touched).filter(([id]) => ID.test(id)).sort((a, b) => a[1] - b[1]).slice(-LIMIT)),
  };
}

export function useCanvasTabs(conversationId: string | null, now: () => number = Date.now): CanvasTabs {
  const [state, setState] = useState<{ id: string | null; value: CanvasTabsState; ready?: boolean }>({ id: null, value: EMPTY });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ id: string; value: CanvasTabsState } | null>(null);
  /** Changes made before the read came back, applied on top of it. */
  const early = useRef<Array<(value: CanvasTabsState) => CanvasTabsState>>([]);
  const loaded = useRef<string | null>(null);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) void chatApi.saveCanvasTabs(next.id, next.value).catch(() => undefined);
  }, []);

  useEffect(() => {
    flush();
    early.current = [];
    loaded.current = null;
    setState({ id: conversationId, value: EMPTY });
    if (!conversationId) return;
    let live = true;
    void Promise.resolve()
      .then(() => chatApi.canvasTabs(conversationId))
      .catch(() => EMPTY)
      .then((stored) => {
        if (!live) return;
        const base: CanvasTabsState = stored && Array.isArray(stored.closed) && stored.touched && typeof stored.touched === 'object'
          ? stored : EMPTY;
        const value = early.current.reduce((acc, change) => change(acc), base);
        const changed = early.current.length > 0;
        early.current = [];
        loaded.current = conversationId;
        setState({ id: conversationId, value, ready: true });
        if (changed) {
          pending.current = { id: conversationId, value };
          flush();
        }
      });
    return () => { live = false; };
  }, [conversationId, flush]);

  // Whatever is still waiting goes when the page does.
  useEffect(() => () => flush(), [flush]);

  const change = useCallback((apply: (value: CanvasTabsState) => CanvasTabsState) => {
    if (!conversationId) return;
    if (loaded.current !== conversationId) early.current.push(apply);
    setState((current) => {
      const value = trimmed(apply(current.id === conversationId ? current.value : EMPTY));
      if (loaded.current === conversationId) {
        pending.current = { id: conversationId, value };
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, SAVE_DELAY_MS);
      }
      return { id: conversationId, value, ready: current.id === conversationId && current.ready === true };
    });
  }, [conversationId, flush]);

  const close = useCallback((stamps: readonly string[]) => change((value) => ({
    ...value, closed: [...value.closed.filter((id) => !stamps.includes(id)), ...stamps],
  })), [change]);
  const reopen = useCallback((stamps: readonly string[]) => change((value) => (
    value.closed.some((id) => stamps.includes(id)) ? { ...value, closed: value.closed.filter((id) => !stamps.includes(id)) } : value
  )), [change]);
  const touch = useCallback((id: string) => change((value) => ({ ...value, touched: { ...value.touched, [id]: now() } })), [change, now]);

  const value = state.id === conversationId ? state.value : EMPTY;
  const ready = conversationId === null || (state.id === conversationId && state.ready === true);
  return { ready, closed: value.closed, touched: value.touched, close, reopen, touch };
}
