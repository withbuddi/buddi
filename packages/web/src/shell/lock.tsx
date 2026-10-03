/**
 * The lock gate: whether the app is drawn at all (docs/dashboard.md, "Lock
 * screen").
 *
 * The server decides — a locked session's API calls are answered 423 — and
 * this follows it. While locked, the shell is not mounted: nothing of the app
 * is in the page under the lock screen, so there is nothing to blur, read
 * from the DOM, or leave behind in memory.
 *
 * It also keeps the page's half of the bargain:
 *
 *  - **Activity.** A pointer, a key, a wheel or a touch is the owner using the
 *    page. Reported to the server at most twice a minute (the server locks a
 *    session it heard nothing from for the delay plus a minute), shared with
 *    the other tabs, and timed here so the screen locks on the minute rather
 *    than at the server's next answer. Polls and streams never count.
 *  - **Lock now** from anywhere: ⌃⌘L on a Mac, Ctrl+Alt+L elsewhere, the owner
 *    menu, the status line's padlock, Settings.
 *  - **Every tab at once**: a lock or an unlock in one tab is broadcast to the
 *    others, which share the session.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, LOCKED, api, type LockState } from '../api';
import { settingsRoute } from '../routes';
import { LockScreen } from './LockScreen';

/** How often the page tells the server the owner is using it, at most. */
export const ACTIVITY_REPORT_MS = 30_000;
/** How often the page looks at the clock for its own idle lock. */
export const IDLE_TICK_MS = 5_000;
/** The tab-to-tab channel. */
export const LOCK_CHANNEL = 'buddi-lock';
/** Set while this browser's session is locked, so a reload with buddi out of reach still opens on the lock screen. */
export const LOCKED_FLAG = 'buddi-locked';
/** Where Settings keeps the lock screen. */
export const LOCK_SETTINGS_ROUTE = settingsRoute('lock');

/** A Mac (or an iPad with a keyboard): the shortcut is ⌃⌘L there, Ctrl+Alt+L elsewhere. */
export function isMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || navigator.platform || navigator.userAgent);
}

export function lockShortcutLabel(mac = isMac()): string {
  return mac ? '⌃⌘L' : 'Ctrl+Alt+L';
}

/** Is this key press Lock now? */
export function isLockShortcut(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, mac = isMac()): boolean {
  const l = event.code === 'KeyL' || event.key.toLowerCase() === 'l';
  if (!l || !event.ctrlKey || event.shiftKey) return false;
  return mac ? event.metaKey && !event.altKey : event.altKey && !event.metaKey;
}

export interface LockControls {
  /** A PIN is set: Lock now does something. */
  pin: boolean;
  state: LockState | null;
  /** Lock this session now. Without a PIN, opens Settings → Lock screen instead. */
  lockNow: () => void;
  /** Settings changed the lock: take its answer. */
  update: (state: LockState) => void;
  shortcut: string;
}

/** Exported for tests that draw a piece of the shell with a PIN set. */
export const LockContext = createContext<LockControls>({ pin: false, state: null, lockNow: () => {}, update: () => {}, shortcut: '⌃⌘L' });

/** The lock's controls, for the owner menu, the status line and Settings. */
export function useLock(): LockControls {
  return useContext(LockContext);
}

function remember(locked: boolean): void {
  try {
    if (locked) localStorage.setItem(LOCKED_FLAG, '1');
    else localStorage.removeItem(LOCKED_FLAG);
  } catch {
    /* storage off: the server still decides */
  }
}

function remembered(): boolean {
  try {
    return localStorage.getItem(LOCKED_FLAG) === '1';
  } catch {
    return false;
  }
}

type Message = { type: 'locked' } | { type: 'unlocked' } | { type: 'activity'; at: number };

function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(LOCK_CHANNEL);
  } catch {
    return null;
  }
}

export function LockGate({ children }: { children: ReactNode }): JSX.Element | null {
  const [phase, setPhase] = useState<'checking' | 'open' | 'locked'>('checking');
  const [state, setState] = useState<LockState | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const lastActive = useRef(Date.now());
  const lastReported = useRef(0);
  const reportedActive = useRef(0);
  const lastShared = useRef(0);

  const show = useCallback((next: LockState | null, locked: boolean) => {
    if (next) setState(next);
    setPhase(locked ? 'locked' : 'open');
    remember(locked);
    if (!locked) lastActive.current = Date.now();
  }, []);

  const check = useCallback(() => {
    api
      .lockState()
      .then((next) => show(next, next.locked))
      .catch((err: unknown) => {
        // A 423 here cannot happen (the route is allowed while locked); a
        // 401 is the gateway's to answer, on a reload. Out of reach: trust
        // what this browser last knew.
        if (err instanceof ApiError && err.status === 401) return setPhase('open');
        show(null, remembered());
      });
  }, [show]);

  useEffect(() => {
    check();
  }, [check]);

  const lockNow = useCallback((reason: 'owner' | 'idle' = 'owner') => {
    if (!state?.pin) {
      window.location.hash = LOCK_SETTINGS_ROUTE;
      return;
    }
    // Down at once, before the server answers: the point is privacy now.
    setPhase('locked');
    remember(true);
    if (reason === 'owner') channel.current?.postMessage({ type: 'locked' } satisfies Message);
    api.lockNow(reason).then((next) => {
      // An idle lock is this tab's view; the server may know of use it never
      // saw (another tab, a fresh session from `buddi dashboard --unlock`) and
      // refuse it. Only a lock it took is passed on to the other tabs.
      if (reason === 'idle' && next.locked) channel.current?.postMessage({ type: 'locked' } satisfies Message);
      show(next, next.locked);
    }).catch(() => check());
  }, [state?.pin, show, check]);

  // The server said 423 somewhere in the app: up goes the lock screen.
  useEffect(() => {
    const onLocked = (): void => {
      setPhase('locked');
      remember(true);
      check();
    };
    window.addEventListener(LOCKED, onLocked);
    return () => window.removeEventListener(LOCKED, onLocked);
  }, [check]);

  // The other tabs share this session: a lock or an unlock in one is in all.
  useEffect(() => {
    const ch = openChannel();
    channel.current = ch;
    if (!ch) return undefined;
    ch.onmessage = (event: MessageEvent<Message>) => {
      const message = event.data;
      if (message?.type === 'locked') { setPhase('locked'); remember(true); }
      else if (message?.type === 'unlocked') check();
      else if (message?.type === 'activity' && typeof message.at === 'number') lastActive.current = Math.max(lastActive.current, message.at);
    };
    return () => { ch.close(); channel.current = null; };
  }, [check]);

  // Lock now from the keyboard, anywhere — a text field included.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isLockShortcut(event)) return;
      event.preventDefault();
      if (phase === 'open') lockNow('owner');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase, lockNow]);

  // The owner using the page, and the idle lock.
  const delay = state?.pin ? state.delayMinutes : null;
  useEffect(() => {
    if (phase !== 'open' || !state?.pin) return undefined;
    // What happened before now is already known to the server (an unlock, a
    // PIN just set) or was not use at all (the page opening).
    reportedActive.current = lastActive.current;
    const used = (): void => {
      const now = Date.now();
      lastActive.current = now;
      if (now - lastShared.current > 10_000) {
        lastShared.current = now;
        channel.current?.postMessage({ type: 'activity', at: now } satisfies Message);
      }
    };
    const report = (): void => {
      const now = Date.now();
      if (lastActive.current <= reportedActive.current || now - lastReported.current < ACTIVITY_REPORT_MS) return;
      lastReported.current = now;
      reportedActive.current = lastActive.current;
      api.lockActivity().catch(() => {});
    };
    const tick = (): void => {
      if (delay !== null && Date.now() - lastActive.current >= delay * 60_000) {
        lockNow('idle');
        return;
      }
      report();
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    for (const name of events) window.addEventListener(name, used, { passive: true, capture: true });
    const timer = window.setInterval(tick, IDLE_TICK_MS);
    // Coming back to a tab is looking at it, and a tab left asleep catches up here.
    const onVisible = (): void => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    // Opening the page is not use: a reload by itself (a new build) must not
    // push the lock back. The server's clock runs from the last real use.
    return () => {
      for (const name of events) window.removeEventListener(name, used, { capture: true });
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [phase, state?.pin, delay, lockNow]);

  const controls = useMemo<LockControls>(() => ({
    pin: state?.pin === true,
    state,
    lockNow: () => lockNow('owner'),
    update: (next) => show(next, next.locked),
    shortcut: lockShortcutLabel(),
  }), [state, lockNow, show]);

  if (phase === 'checking') return null;
  if (phase === 'locked') {
    return (
      <LockScreen
        initial={state}
        onUnlocked={(next) => {
          channel.current?.postMessage({ type: 'unlocked' } satisfies Message);
          show(next, false);
        }}
      />
    );
  }
  return <LockContext.Provider value={controls}>{children}</LockContext.Provider>;
}
