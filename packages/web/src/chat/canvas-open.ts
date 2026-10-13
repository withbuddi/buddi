/**
 * Whether the desktop canvas is open, per conversation.
 *
 * A conversation starts as a conversation: the chat has the whole width and
 * there is no empty canvas beside it waiting to be filled. The canvas opens by
 * itself the first time something lands on it, and from then on it is the
 * owner's: once he closes it, it stays closed for that conversation, and what
 * arrives later only counts up on the header's Canvas button. He opens it
 * again from there whenever he likes, empty or not.
 *
 * Three states, of which only two are ever stored: never decided (closed
 * until used), open, and closed by the owner. Kept in sessionStorage keyed by
 * conversation, so a reload keeps the choice and a new tab starts fresh. A
 * conversation that has no id yet keeps its state in memory and hands it to
 * the id its first send creates (`adopt`), so closing the canvas before the
 * first reply sticks. Only the send hands it on: opening an older thread
 * from the history after toggling an unsent one must not rewrite that
 * thread's choice.
 *
 * The phone never reads this: there the canvas is a sheet the owner opens.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type CanvasMode = 'open' | 'closed';

const PREFIX = 'buddi.canvas.';
/** The conversation that has no id yet. */
const NEW = '';

function read(id: string): CanvasMode | null {
  try {
    const value = window.sessionStorage.getItem(PREFIX + id);
    return value === 'open' || value === 'closed' ? value : null;
  } catch {
    return null;
  }
}

function write(id: string, mode: CanvasMode): void {
  try {
    window.sessionStorage.setItem(PREFIX + id, mode);
  } catch {
    // Private windows and blocked storage: the choice lasts as long as the page.
  }
}

export function useCanvasOpen(conversationId: string | null, used: boolean): {
  open: boolean;
  /** The owner's decision, or the first arrival's: remembered for this conversation. */
  setMode: (mode: CanvasMode) => void;
  /** The unsent conversation was just given this id: its choice goes with it. */
  adopt: (id: string) => void;
} {
  const key = conversationId ?? NEW;
  const [modes, setModes] = useState<Record<string, CanvasMode | null>>({});
  const mode = key in modes ? modes[key] ?? null : conversationId ? read(conversationId) : null;

  const setMode = useCallback((next: CanvasMode): void => {
    setModes((current) => (current[key] === next ? current : { ...current, [key]: next }));
    if (key !== NEW) write(key, next);
  }, [key]);

  const adopt = useCallback((id: string): void => {
    setModes((current) => {
      const carried = current[NEW];
      if (!carried || current[id] || read(id) !== null) return current;
      write(id, carried);
      return { ...current, [id]: carried };
    });
  }, []);

  // A new conversation starts undecided again.
  const previous = useRef(key);
  useEffect(() => {
    const before = previous.current;
    previous.current = key;
    if (before !== key && key === NEW) setModes((current) => (current[NEW] == null ? current : { ...current, [NEW]: null }));
  }, [key]);

  // The first arrival opens it, and that is remembered: closing every tab
  // afterwards leaves an open, empty canvas rather than folding it away.
  useEffect(() => {
    if (mode === null && used) setMode('open');
  }, [mode, used, setMode]);

  return { open: mode === 'open' || (mode === null && used), setMode, adopt };
}
