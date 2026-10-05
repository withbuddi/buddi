/**
 * The lightbulb on Home's greeting row (docs/dashboard.md, Home) and the Tips
 * panel it opens right under the glance: the stack of tips (parts/TipStack),
 * every one whose condition holds, today's in front, the ones in their
 * cooldown at the back. A tip dismissed for good is not there; one put off
 * with "Not now" goes to the back. Empty, the panel says whether nothing
 * applies or the owner turned off every tip that does.
 *
 * The bulb carries a dot while a tip is ready that the owner has not had in
 * the stack yet; opening the panel clears it. The bulb shows pressed while
 * the panel is open; whether it is open is kept in this browser
 * (`buddi.tipsOpen`), closed by default. `#/?tip=<id>` opens it with that tip
 * in front, touching nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, ErrorBanner, Section } from '../../ui';
import { Icon } from '../../ui/Icon';
import { TipStack, useTipQueue, type TipQueue } from './TipStack';

/** Set to '1' while the Tips panel on Home is open. */
export const TIPS_OPEN_KEY = 'buddi.tipsOpen';
/**
 * The ids of the ready tips the owner has had in the stack, as JSON. Kept to
 * the ones still ready: a tip that leaves (put off, dismissed, no longer
 * true) is forgotten, so its return is new again.
 */
export const TIPS_SEEN_KEY = 'buddi.tipsSeen';

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(TIPS_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function readSeen(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(TIPS_SEEN_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeSeen(ids: string[]): void {
  try {
    if (ids.length) window.localStorage.setItem(TIPS_SEEN_KEY, JSON.stringify(ids));
    else window.localStorage.removeItem(TIPS_SEEN_KEY);
  } catch {
    /* a private window: the dot comes back next visit */
  }
}

export interface Tips {
  open: boolean;
  setOpen: (open: boolean) => void;
  queue: TipQueue;
  /** A ready tip the owner has not had in the stack. */
  unseen: boolean;
  /** A `?tip=` preview: nothing is remembered. */
  preview: boolean;
}

/** The queue, whether the panel is open and the dot: shared by the bulb and the panel. */
export function useTips(preview?: string): Tips {
  const [open, setOpenState] = useState(() => Boolean(preview) || readOpen());
  // A preview link opens the panel with its tips in front.
  useEffect(() => { if (preview) setOpenState(true); }, [preview]);
  const setOpen = useCallback((next: boolean): void => {
    setOpenState(next);
    if (preview) return;
    try {
      if (next) window.localStorage.setItem(TIPS_OPEN_KEY, '1');
      else window.localStorage.removeItem(TIPS_OPEN_KEY);
    } catch {
      /* a private window: open for this visit only */
    }
  }, [preview]);
  const queue = useTipQueue(preview, !open);
  const [seen, setSeen] = useState(readSeen);
  const ids = queue.tips.map((tip) => tip.id).join(',');
  useEffect(() => {
    if (preview || !queue.loaded || queue.error) return;
    const ready = ids ? ids.split(',') : [];
    // Open: every tip in the stack is seen. Closed: forget the ones gone.
    const next = open ? ready : seen.filter((id) => ready.includes(id));
    if (next.join(',') !== seen.join(',')) {
      setSeen(next);
      writeSeen(next);
    }
  }, [open, ids, preview, queue.loaded, queue.error, seen]);
  const unseen = !open && !preview && queue.tips.some((tip) => !seen.includes(tip.id));
  return { open, setOpen, queue, unseen, preview: Boolean(preview) };
}

export function TipsButton({ tips }: { tips: Tips }): JSX.Element {
  const { open, setOpen, unseen } = tips;
  const word = unseen ? 'A new tip' : 'Tips';
  return (
    <button
      type="button"
      className="ui-icon-btn home-tips-btn"
      aria-label={word}
      aria-pressed={open}
      title={word}
      data-open={open}
      onClick={() => setOpen(!open)}
    >
      <Icon name="bulb" />
      {unseen ? <span className="home-tips-dot" data-testid="tips-dot" /> : null}
    </button>
  );
}

export function TipsSection({ tips, navigate }: { tips: Tips; navigate: (route: string) => void }): JSX.Element | null {
  const { open, setOpen, queue } = tips;
  if (!open) return null;
  const empty = queue.loaded && !queue.shown;
  return (
    <div className="home-tips" data-testid="tips-section">
      <Section title="Tips" actions={<Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>}>
        <ErrorBanner message={queue.error} />
        {empty && !queue.error ? (
          <p className="home-tips-empty">
            {queue.allDismissed ? "You've turned off every tip that applies." : 'No tips right now. New ones appear as you use buddi.'}
          </p>
        ) : (
          <TipStack queue={queue} navigate={navigate} />
        )}
      </Section>
    </div>
  );
}
