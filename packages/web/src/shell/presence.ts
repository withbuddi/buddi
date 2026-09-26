/**
 * Presence: the page tells buddi whether the owner is looking at it
 * (docs/notifications.md, "When and where").
 *
 * `active` on load, when the window gains focus or the tab becomes visible,
 * and every 30 seconds while the tab is visible and the window focused;
 * `away` on blur and on hide. A focus and blur flutter sends at most one
 * request a second: the last state asked for wins, sent when the second is up.
 *
 * `onBeat` runs each time `active` is sent, so whatever should refresh while
 * the owner is here (the notifications) rides on the same timer.
 */
import { useEffect, useRef } from 'react';
import { ApiError, api } from '../api';

export const PRESENCE_EVERY_MS = 30_000;
export const PRESENCE_MIN_GAP_MS = 1_000;

type State = 'active' | 'away';

export function usePresence(enabled: boolean, onBeat?: () => void, onSignedOut?: () => void): void {
  const beat = useRef(onBeat);
  beat.current = onBeat;
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;

  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    let lastSentAt = -Infinity;
    let wanted: State | null = null;
    let trailing: number | null = null;
    // A page that has just loaded is in front of the owner; focus and blur keep it right after that.
    let focused = true;
    const visible = (): boolean => document.visibilityState !== 'hidden';

    const send = (state: State): void => {
      lastSentAt = Date.now();
      api.presence(state).catch((err: unknown) => {
        // Signed out: stop talking until the shell signs in again.
        if (err instanceof ApiError && err.status === 401) {
          stopped = true;
          signedOut.current?.();
        }
      });
      if (state === 'active') beat.current?.();
    };
    const report = (state: State): void => {
      if (stopped) return;
      wanted = state;
      if (trailing !== null) return;
      const wait = lastSentAt + PRESENCE_MIN_GAP_MS - Date.now();
      if (wait <= 0) {
        wanted = null;
        send(state);
        return;
      }
      trailing = window.setTimeout(() => {
        trailing = null;
        if (stopped || wanted === null) return;
        const next = wanted;
        wanted = null;
        send(next);
      }, wait);
    };

    const onFocus = (): void => { focused = true; if (visible()) report('active'); };
    const onBlur = (): void => { focused = false; report('away'); };
    const onVisibility = (): void => report(visible() ? 'active' : 'away');

    if (visible()) report('active');
    const timer = window.setInterval(() => { if (visible() && focused) report('active'); }, PRESENCE_EVERY_MS);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      if (trailing !== null) window.clearTimeout(trailing);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);
}
