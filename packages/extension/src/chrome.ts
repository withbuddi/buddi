/*
 * The slice of the Chrome extension API this extension uses, written out by
 * hand.
 *
 * `@types/chrome` would describe all of it, but it is a large dependency for
 * the dozen calls below and it types every call as available everywhere, which
 * is exactly the mistake a service worker makes. Naming the slice here also
 * gives the tests something to fake: `protocol.ts` takes this interface, so a
 * plain object satisfies it.
 */

export interface TabInfo { id?: number; url?: string; title?: string; status?: string; groupId?: number; windowId?: number; active?: boolean }

export type WindowType = 'normal' | 'popup' | 'panel' | 'app' | 'devtools';
export interface WindowInfo { id?: number; focused?: boolean; type?: WindowType }

export interface ChromeLike {
  storage: {
    local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string[]): Promise<void>;
    };
  };
  tabs: {
    create(properties: { url: string; active?: boolean; windowId?: number }): Promise<TabInfo>;
    update(tabId: number, properties: { url?: string; active?: boolean }): Promise<TabInfo>;
    get(tabId: number): Promise<TabInfo>;
    remove(tabIds: number[]): Promise<void>;
    query(query: { windowId?: number }): Promise<TabInfo[]>;
    /** A tab finished loading (or changed): a held tab's bar is drawn again on its new page. */
    onUpdated?: { addListener(listener: (tabId: number, change: { status?: string }, tab: TabInfo) => void): void };
    /** A tab closed: a sign-in it was waiting to save goes with it. */
    onRemoved?: { addListener(listener: (tabId: number) => void): void };
  };
  tabGroups: {
    update(groupId: number, properties: { title?: string; collapsed?: boolean }): Promise<unknown>;
    get(groupId: number): Promise<unknown>;
  };
  /**
   * Is the owner looking at this tab right now, and which window is an
   * ordinary one to open a tab in. A popup, an app or an installed web app's
   * window has no tab strip: Chrome refuses to group a tab there.
   */
  windows: {
    get(windowId: number): Promise<WindowInfo>;
    getLastFocused?(options: { windowTypes?: WindowType[] }): Promise<WindowInfo>;
    getAll?(options: { windowTypes?: WindowType[] }): Promise<WindowInfo[]>;
    create?(data: { url?: string; focused?: boolean; state?: 'normal' }): Promise<WindowInfo & { tabs?: TabInfo[] }>;
    /** Bring a window to the front: a take-over in place focuses the held tab's window. */
    update?(windowId: number, data: { focused?: boolean }): Promise<WindowInfo>;
  };
  scripting: {
    executeScript<Args extends unknown[] = [], Result = unknown>(injection: {
      target: { tabId: number; allFrames?: boolean; frameIds?: number[] };
      /** Either a function to serialize into the page, or a bundled file to inject. */
      func?: (...args: Args) => Result;
      files?: string[];
      args?: Args;
      world?: 'MAIN' | 'ISOLATED';
    }): Promise<Array<{ frameId: number; result: Result }>>;
  };
  debugger: {
    attach(target: { tabId: number }, version: string): Promise<void>;
    detach(target: { tabId: number }): Promise<void>;
    sendCommand(target: { tabId: number }, method: string, params?: unknown): Promise<unknown>;
    /** Screencast frames arrive here, not as the answer to a command. */
    onEvent: { addListener(listener: (source: { tabId?: number }, method: string, params?: unknown) => void): void };
    /** Chrome took the debugger away: the tab closed, or the owner dismissed the yellow bar. */
    onDetach: { addListener(listener: (source: { tabId?: number }, reason?: string) => void): void };
  };
}

/** `chrome.tabs.group` and `chrome.runtime`, kept apart because only the worker has them. */
export interface WorkerChrome extends ChromeLike {
  tabs: ChromeLike['tabs'] & { group(options: { tabIds: number[]; groupId?: number; createProperties?: { windowId?: number } }): Promise<number> };
  /** The one timer that survives an evicted service worker. */
  alarms: {
    create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): void;
    onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
  };
  runtime: {
    getManifest(): { version: string };
    onMessage: { addListener(listener: (message: unknown, sender: unknown, respond: (response?: unknown) => void) => boolean | void): void };
    sendMessage(message: unknown): Promise<unknown>;
    lastError?: { message: string };
  };
}
