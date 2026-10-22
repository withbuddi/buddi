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
  /** False when the browser refused the tab, or it was closed: the screen's own link is the way out. */
  readonly opened: boolean;
  /** Point the tab at `url` (http or https only). Closes it, and says false, when there is nothing to show. */
  go(url: string | null | undefined): boolean;
  /** Close the tab: a failed start leaves no empty window behind (an installed app's included). */
  close(): void;
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
  const close = (): void => {
    try { tab?.close(); } catch { /* already gone */ }
    tab = null;
  };
  return {
    get opened() { return tab !== null; },
    go(url) {
      const page = webPage(url);
      if (!tab) return false;
      if (!page) { close(); return false; }
      try {
        tab.location.href = page;
        return true;
      } catch {
        close();
        return false;
      }
    },
    close,
  };
}

/** A page whose address is already known, opened from the click. False when the browser refused the tab. */
export function openSignInPage(url: string): boolean {
  return openSignInTab().go(url);
}

/**
 * Start a sign-in from a click: the tab opens before `start` is asked, goes to
 * `urlOf(result)` when it answers, and closes if it fails. Call it
 * synchronously from the click handler (a promise chain is fine, an earlier
 * `await` is not).
 */
export async function startSignIn<T>(
  start: () => Promise<T>,
  urlOf: (result: T) => string | null | undefined,
): Promise<{ result: T; opened: boolean }> {
  const tab = openSignInTab();
  let result: T;
  try {
    result = await start();
  } catch (error) {
    tab.close();
    throw error;
  }
  return { result, opened: tab.go(urlOf(result)) };
}
