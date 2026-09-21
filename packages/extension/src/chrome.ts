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
  };
  tabGroups: {
    update(groupId: number, properties: { title?: string; collapsed?: boolean }): Promise<unknown>;
    get(groupId: number): Promise<unknown>;
  };
  /** Only to answer one question: is the owner looking at this tab right now? */
  windows: {
    get(windowId: number): Promise<{ id?: number; focused?: boolean }>;
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
