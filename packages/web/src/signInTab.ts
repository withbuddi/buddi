import { useEffect, useRef, useState } from 'react';

/**
 * A provider's sign-in page in a tab of its own, opened from the owner's click.
 *
 * A browser lets a page open a tab only while it handles a click: after an
 * `await` the same `window.open` is a pop-up and is blocked. So the tab is
 * opened blank inside the click and pointed at the page once buddi names it.
 * The shells expect exactly this: the desktop app (apps/desktop) keeps a blank
 * `window.open('', '_blank')` hidden and hands its first navigation to the
 * default browser; buddi.app (apps/mac) does the same in its WKUIDelegate.
 *
 * Every sign-in start in the dashboard goes through here, so there is one way.
 */
export interface SignInTab {
  /** False when the browser refused the tab, or it was closed (by buddi or the owner): the screen's own link is the way out. */
  readonly opened: boolean;
  /** Point the tab at `url` (http or https only). Closes it, and says false, when there is nothing to show or the tab is gone. */
  go(url: string | null | undefined): boolean;
  /** Close the tab: a failed or abandoned start leaves no empty window behind (an installed app's included). */
  close(): void;
  /** Close the tab only while it is still blank: a sign-in left before buddi named the page. */
  abandon(): void;
}

/** Only a web page goes in the tab; a server never sends anything else, and a stray scheme is not followed. */
function webPage(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** Open a blank tab now, inside the click. Point it with `go` once the address is known. */
export function openSignInTab(): SignInTab {
  let tab: Window | null = null;
  let pointed = false;
  try {
    tab = typeof window.open === 'function' ? window.open('', '_blank') : null;
  } catch {
    tab = null;
  }
  if (tab) {
    // Not `noopener` in the call: with it the browser hands back null and the tab cannot be pointed.
    try { tab.opener = null; } catch { /* a shell's window may not take it */ }
    try {
      tab.document.title = 'Opening sign-in…';
      tab.document.body.textContent = 'Opening the sign-in page…';
    } catch { /* not ours to write, or a shell's hidden window */ }
  }
  /** The tab, while it is still there: one the owner closed counts as gone. */
  const live = (): Window | null => {
    let closed = false;
    try { closed = tab?.closed === true; } catch { closed = false; }
    if (closed) tab = null;
    return tab;
  };
  const close = (): void => {
    try { tab?.close(); } catch { /* already gone */ }
    tab = null;
  };
  return {
    get opened() { return live() !== null; },
    go(url) {
      const page = webPage(url);
      const target = live();
      if (!target) return false;
      if (!page) { close(); return false; }
      try {
        target.location.href = page;
        pointed = true;
        return true;
      } catch {
        close();
        return false;
      }
    },
    close,
    abandon() { if (!pointed) close(); },
  };
}

/** A page whose address is already known, opened from the click. False when the browser refused the tab. */
export function openSignInPage(url: string): boolean {
  return openSignInTab().go(url);
}

/** What a started sign-in comes to. `cancelled`: it was left before the start answered, and nothing was opened. */
export interface SignInOutcome<T> { result: T; opened: boolean; cancelled: boolean }

/** A sign-in in flight: `done` settles when the start does; `cancel` closes its tab and makes a late answer go nowhere. */
export interface SignInAttempt<T> {
  done: Promise<SignInOutcome<T>>;
  /** Closes the tab, pointed or not, and ignores the start's answer if it is still to come. */
  cancel(): void;
  /** Leaving: closes the tab only if the start has not answered yet. */
  abandon(): void;
}

/**
 * Start a sign-in from a click: the tab opens before `start` is asked, goes to
 * `urlOf(result)` when it answers, and closes if it fails or was cancelled.
 * Call it synchronously from the click handler (a promise chain is fine, an
 * earlier `await` is not).
 */
export function startSignIn<T>(
  start: () => Promise<T>,
  urlOf: (result: T) => string | null | undefined,
): SignInAttempt<T> {
  const tab = openSignInTab();
  let cancelled = false;
  let answered = false;
  const done = (async (): Promise<SignInOutcome<T>> => {
    let result: T;
    try {
      result = await start();
    } catch (error) {
      answered = true;
      tab.close();
      throw error;
    }
    answered = true;
    if (cancelled) return { result, opened: false, cancelled: true };
    return { result, opened: tab.go(urlOf(result)), cancelled: false };
  })();
  return {
    done,
    cancel() { cancelled = true; tab.close(); },
    abandon() { if (!answered) { cancelled = true; tab.close(); } },
  };
}

/** One screen's sign-in tab: a new start or a cancel closes the last one's, and leaving closes one still blank. */
export interface SignInSlot {
  /** The key (an account id) whose start opened its page in a tab; null once cancelled or refused. */
  openedFor: string | null;
  /** `startSignIn` for `key`, after cancelling the one before. Call it synchronously from the click. */
  start<T>(key: string, start: () => Promise<T>, urlOf: (result: T) => string | null | undefined): Promise<SignInOutcome<T>>;
  /** The owner cancelled: its tab closes and a late answer is ignored. */
  cancel(): void;
}

export function useSignIn(): SignInSlot {
  const current = useRef<SignInAttempt<unknown> | null>(null);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  // Closing the sheet or leaving the page: a start still in flight opens nothing.
  useEffect(() => () => current.current?.abandon(), []);
  return {
    openedFor,
    start(key, start, urlOf) {
      current.current?.cancel();
      const attempt = startSignIn(start, urlOf);
      current.current = attempt as SignInAttempt<unknown>;
      setOpenedFor(null);
      return attempt.done.then((outcome) => {
        if (current.current === attempt && !outcome.cancelled) setOpenedFor(outcome.opened ? key : null);
        return outcome;
      });
    },
    cancel() {
      current.current?.cancel();
      current.current = null;
      setOpenedFor(null);
    },
  };
}
