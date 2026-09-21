/*
 * One command, one browser action.
 *
 * Every tab this opens belongs to a session (one conversation) and lives in a
 * tab group called "buddi", in the background: the owner keeps using the
 * window, and when they look at it they can see exactly which tabs are the
 * agent's. `close` takes the group away again; a dropped socket does not,
 * because by then those tabs are the owner's.
 *
 * Input goes through the debugger rather than through synthetic DOM events:
 * `Input.dispatchMouseEvent` reaches a background tab and is indistinguishable
 * from a real click, which is what makes this backend behave like the
 * Playwright one instead of like a script. Inside a subframe, where the
 * debugger's viewport coordinates would need the frame's offset in the top
 * document, the page side acts on the element directly and says so.
 */

import type { TabInfo, WorkerChrome } from './chrome.js';
import { Cancellation, PreconditionError, type Command, type CommandResult, type FrameMessage, type Observation, type ObservedTarget } from './protocol.js';
import type { CollectedElement } from './tree.js';

interface Session {
  groupId: number;
  tabs: Map<string, number>;
  active: string | null;
  /** Bumped by every observation, so a ref from an older one is recognisable. */
  generation: number;
  /** The tab and page the last observation described. */
  observed?: { generation: number; tabKey: string; url: string };
}
/** What a ref points at, and what it looked like, so a semantic target can find it again. */
interface Ref {
  tabKey: string; tabId: number; frameId: number; local: string; frame: number; role: string; name: string;
  /** The document the ref was read from, and the observation it belongs to. */
  docUrl: string; generation: number;
}

/** The owner moved this tab out of the group: it is theirs now, and off limits. */
const TAKEN = 'The owner took this tab; observe again to continue in a new one.';
/** The page under a ref is not the page the ref was read from. */
const MOVED = 'This page has changed since that observation. Observe again.';
const WATCHED = 'You are looking at this tab. buddi only acts in background tabs; observe again to continue in a new one.';

interface FrameObservation {
  url: string; title: string; tree: string; elements: CollectedElement[]; scroll: { x: number; y: number };
}

const GROUP_TITLE = 'buddi';
/** The driver reads the main frame plus ten, and caps the whole tree at 32k. */
const MAX_FRAMES = 11;
const MAX_TREE = 32_000;
const MAX_TARGETS = 240;
const LOAD_TIMEOUT = 30_000;
/** How long a click or a key gets to turn into a navigation before we stop watching. */
const SETTLE_MS = 600;
const SETTLE_STEP_MS = 50;
/** At most ten frames a second leave this browser, whatever Chrome paints. */
const MIN_FRAME_MS = 100;
/** The screencast's own bounds; the gateway asks within them and gets clamped if it does not. */
const MAX_CAST_SIDE = 4096;
/** A page coordinate no real viewport reaches, past which the input is not a coordinate. */
const MAX_COORDINATE = 20_000;
const MAX_DELTA = 10_000;

/** No screencast for this session, so nobody is looking and nothing may be typed. */
const NO_CAST = 'No screencast is running for this conversation, so there is nothing to type into.';

interface ScreencastFrame { data: string; metadata: Record<string, number>; sessionId: string | number }

/** One live screencast: the tab it watches, and the frame it is holding back. */
interface Screencast {
  session: string;
  tabId: number;
  lastSentAt: number;
  pending?: ScreencastFrame;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
}

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
};

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A screencast side Chrome will accept, whatever the gateway asked for. */
function side(value: unknown, fallback: number): number {
  const asked = num(value) ?? fallback;
  return Math.min(MAX_CAST_SIDE, Math.max(1, Math.round(asked)));
}

function clamp(value: unknown, limit: number, fallback = 0): number {
  const asked = num(value);
  if (asked === undefined) return fallback;
  return Math.min(limit, Math.max(-limit, asked));
}

/**
 * The six numbers the dashboard needs to turn a click on its picture back into
 * a page coordinate, and nothing else Chrome happened to attach.
 */
function metadataOf(value: unknown): Record<string, number> {
  const source = (value ?? {}) as Record<string, unknown>;
  const metadata: Record<string, number> = {};
  for (const key of ['deviceWidth', 'deviceHeight', 'pageScaleFactor', 'offsetTop', 'scrollOffsetX', 'scrollOffsetY']) {
    const found = num(source[key]);
    if (found !== undefined) metadata[key] = found;
  }
  return metadata;
}

const MOUSE_TYPES = new Set(['mousePressed', 'mouseReleased', 'mouseMoved']);
const KEY_TYPES = new Set(['keyDown', 'keyUp', 'char', 'rawKeyDown']);
const BUTTONS: Record<string, number> = { none: 0, left: 1, right: 2, middle: 4, back: 8, forward: 16 };

/** Windows virtual key codes for the keys whose `key` is not the character itself. */
const VIRTUAL_KEYS: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Pause: 19, CapsLock: 20, Escape: 27,
  ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46, Meta: 91,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

function virtualKey(key: string): number {
  const named = VIRTUAL_KEYS[key];
  if (named !== undefined) return named;
  return key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined;
}

/**
 * One event from the owner's hand, turned into one CDP call.
 *
 * Everything is bounded here as well as at the gateway, because what arrives is
 * whatever a socket sent and what leaves operates the owner's real browser.
 */
function inputEvent(args: Record<string, unknown>): { method: string; params: Record<string, unknown> } {
  const kind = str(args, 'kind');
  const modifiers = Math.min(15, Math.max(0, Math.trunc(num(args['modifiers']) ?? 0)));
  if (kind === 'wheel') {
    return { method: 'Input.dispatchMouseEvent', params: {
      type: 'mouseWheel', x: clamp(args['x'], MAX_COORDINATE), y: clamp(args['y'], MAX_COORDINATE),
      deltaX: clamp(args['deltaX'], MAX_DELTA), deltaY: clamp(args['deltaY'], MAX_DELTA), modifiers,
    } };
  }
  if (kind === 'mouse') {
    const type = str(args, 'type') ?? '';
    if (!MOUSE_TYPES.has(type)) throw new PreconditionError(`${type || 'That'} is not a mouse event this browser dispatches.`);
    const name = str(args, 'button') ?? 'left';
    const button = name in BUTTONS ? name : 'left';
    // `buttons` is what is held down now, which only the press and a drag have.
    const buttons = num(args['buttons']) !== undefined
      ? Math.min(31, Math.max(0, Math.trunc(num(args['buttons'])!)))
      : type === 'mousePressed' ? BUTTONS[button]! : 0;
    return { method: 'Input.dispatchMouseEvent', params: {
      type, x: clamp(args['x'], MAX_COORDINATE), y: clamp(args['y'], MAX_COORDINATE),
      button, buttons, clickCount: Math.min(3, Math.max(0, Math.trunc(num(args['clickCount']) ?? (type === 'mouseMoved' ? 0 : 1)))), modifiers,
    } };
  }
  if (kind === 'key') {
    const type = str(args, 'type') ?? '';
    if (!KEY_TYPES.has(type)) throw new PreconditionError(`${type || 'That'} is not a key event this browser dispatches.`);
    const key = text(args['key'], 32) ?? '';
    const code = text(args['code'], 32) ?? '';
    // A named key that carries a character carries it here too: Chrome makes
    // no keypress out of a `keyDown` with no text, and with no keypress an
    // Enter in the login form the owner took the browser over for submits
    // nothing. The wire only ever carries a printable `text`, so the carriage
    // return is supplied on this side or nowhere.
    const typed = text(args['text'], 8) ?? (type === 'keyDown' ? KEYS[key]?.text : undefined);
    if (type === 'char' && !typed) throw new PreconditionError('A typed character arrived with no text in it.');
    const virtual = virtualKey(key);
    return { method: 'Input.dispatchKeyEvent', params: {
      type, key, code, modifiers,
      ...(typed ? { text: typed } : {}),
      ...(type === 'char' ? {} : { windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual }),
    } };
  }
  throw new PreconditionError(`This browser cannot dispatch ${kind ?? 'that'} input.`);
}

/** Only http(s). A chrome:// or file:// tab is not somewhere an agent gets to go. */
function checkUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new PreconditionError(`${url} is not an address this browser can open.`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new PreconditionError('Only http and https addresses can be opened in your browser.');
  return parsed.toString();
}

/** Two URLs are compared as strings, so both go through the same parser first. */
function normalize(url: string): string {
  try { return new URL(url).toString(); } catch { return url; }
}

export interface Executor { run(command: Command, cancel?: Cancellation): Promise<CommandResult> }

export class BrowserCommands implements Executor {
  #chrome: WorkerChrome;
  #sessions = new Map<string, Session>();
  /** Refs are handed out per observation; the next command resolves them here. */
  #refs = new Map<string, Map<string, Ref>>();
  #uuid: () => string;
  #contentFile: string;
  #onFrame: (frame: FrameMessage) => void;
  #now: () => number;
  /** How many things want the debugger on this tab. A screencast is one of them, and it outlives a command. */
  #attached = new Map<number, number>();
  #casts = new Map<string, Screencast>();
  #castsByTab = new Map<number, Screencast>();

  constructor(chrome: WorkerChrome, options: { uuid?: () => string; contentFile?: string; onFrame?: (frame: FrameMessage) => void; now?: () => number } = {}) {
    this.#chrome = chrome;
    this.#onFrame = options.onFrame ?? (() => undefined);
    this.#now = options.now ?? (() => Date.now());
    chrome.debugger.onEvent.addListener((source, method, params) => this.#debuggerEvent(source, method, params));
    // Chrome took the debugger back: the tab closed, the owner dismissed the
    // yellow bar, or another client attached. Either way this screencast is over.
    chrome.debugger.onDetach.addListener((source) => {
      const tabId = source.tabId;
      if (tabId === undefined) return;
      this.#attached.delete(tabId);
      const cast = this.#castsByTab.get(tabId);
      if (cast) this.#forgetCast(cast);
    });
    this.#uuid = options.uuid ?? (() => crypto.randomUUID());
    this.#contentFile = options.contentFile ?? 'content.js';
  }

  async run(command: Command, cancel: Cancellation = new Cancellation()): Promise<CommandResult> {
    cancel.check();
    switch (command.name) {
      case 'navigate': return this.#navigate(command, cancel);
      case 'observe': return { observation: await this.#observe(command.session, cancel) };
      case 'click': return this.#click(command, cancel);
      case 'fill': return this.#fill(command, cancel);
      case 'select': return this.#select(command, cancel);
      case 'press': return this.#press(command, cancel);
      case 'scroll': return this.#scroll(command, cancel);
      case 'tab': return this.#tab(command);
      case 'screenshot': return { screenshot: await this.#screenshot(command.session, cancel) };
      case 'screencast.start': return this.#startScreencast(command, cancel);
      case 'screencast.stop': { await this.#stopScreencast(command.session); return {}; }
      case 'input': return this.#input(command, cancel);
      case 'close': return this.#close(command, cancel);
      default: throw new PreconditionError(`This browser cannot run ${command.name}.`);
    }
  }

  /**
   * The socket ended: forget which tabs belonged to which conversation.
   *
   * The tabs themselves stay open, because they are the owner's now; what goes
   * is every ref and every session, so a later socket cannot act on evidence
   * nobody can still see.
   */
  reset(): void {
    for (const session of [...this.#casts.keys()]) void this.#stopScreencast(session).catch(() => undefined);
    this.#sessions.clear();
    this.#refs.clear();
  }

  /* ---- sessions and tabs ---- */

  async #session(session: string): Promise<Session> {
    const existing = this.#sessions.get(session);
    if (existing) return existing;
    const created: Session = { groupId: -1, tabs: new Map(), active: null, generation: 0 };
    this.#sessions.set(session, created);
    return created;
  }

  #forget(session: Session, key: string): void {
    session.tabs.delete(key);
    if (session.active === key) session.active = null;
    if (session.observed?.tabKey === key) session.observed = undefined;
  }

  /**
   * This session's tab, if it is still this session's.
   *
   * A tab the owner dragged out of the "buddi" group is theirs: an agent must
   * not act in it and must not close it, so the session forgets it here rather
   * than anywhere a command could still reach it.
   */
  async #ownTab(session: Session, key: string): Promise<TabInfo> {
    const tabId = session.tabs.get(key);
    if (tabId === undefined) throw new PreconditionError('This conversation has no browser tab yet. Navigate to open one.');
    const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) { this.#forget(session, key); throw new PreconditionError('That tab is gone. Observe again to continue in a new one.'); }
    if (session.groupId >= 0 && tab.groupId !== session.groupId) { this.#forget(session, key); throw new PreconditionError(TAKEN); }
    return tab;
  }

  #activeKey(session: Session): string {
    if (!session.active) throw new PreconditionError('This conversation has no browser tab yet. Navigate to open one.');
    return session.active;
  }

  /**
   * Reading a tab is harmless; typing into one the owner is reading is not.
   *
   * Unless the typing is theirs: a command marked `owner` came from the hand on
   * the dashboard, and refusing it would refuse the owner their own browser.
   */
  async #background(tab: TabInfo, owner = false): Promise<void> {
    if (owner) return;
    if (tab.active !== true || tab.windowId === undefined) return;
    const window = await this.#chrome.windows.get(tab.windowId).catch(() => undefined);
    if (window?.focused) throw new PreconditionError(WATCHED);
  }

  /** Where the tab actually is now, which a redirect may have changed. */
  #liveUrl(tab: TabInfo): string {
    return checkUrl(tab.url ?? '');
  }

  async #openTab(session: Session, url: string, cancel: Cancellation): Promise<number> {
    cancel.dispatch();
    const tab = await this.#chrome.tabs.create({ url, active: false });
    if (tab.id === undefined) throw new Error('Chrome opened a tab without an id.');
    const groupId = await this.#chrome.tabs.group(session.groupId >= 0
      ? { tabIds: [tab.id], groupId: session.groupId }
      : { tabIds: [tab.id] });
    if (session.groupId !== groupId) {
      session.groupId = groupId;
      await this.#chrome.tabGroups.update(groupId, { title: GROUP_TITLE, collapsed: false }).catch(() => undefined);
    }
    const key = `tab-${this.#uuid().slice(0, 12)}`;
    session.tabs.set(key, tab.id);
    session.active = key;
    return tab.id;
  }

  /** The key of this session's current tab, opening one when there is none to reuse. */
  async #reuseOrOpen(session: Session, url: string, cancel: Cancellation): Promise<void> {
    const key = session.active;
    if (key) {
      // Check the group before the URL: a tab the owner adopted gets a new one
      // opened beside it rather than navigated away under their hands.
      const tab = await this.#ownTab(session, key).catch(() => undefined);
      if (tab && tab.id !== undefined) {
        cancel.dispatch();
        await this.#chrome.tabs.update(tab.id, { url });
        await this.#waitForLoad(tab.id);
        return;
      }
    }
    const opened = await this.#openTab(session, url, cancel);
    await this.#waitForLoad(opened);
  }

  /**
   * Wait for what the input may have started, not for what was already there.
   *
   * After a click or an Enter that submits, the tab's `status` is still
   * `complete` for the page the event was dispatched on, so waiting for
   * `complete` returns immediately and the next observation describes the page
   * the agent has just left. So watch briefly for the tab to leave `complete`
   * or change its URL, and only then wait for the load. A click that navigates
   * nowhere costs those few hundred milliseconds and nothing else. Polling
   * rather than `tabs.onUpdated`, because the worker can be evicted between
   * registering a listener and the event, and a missed event would hang.
   */
  async #settle(tabId: number, before: TabInfo): Promise<void> {
    const deadline = Date.now() + SETTLE_MS;
    for (;;) {
      const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab) return; // Closed under us; the next command is the one that says so.
      if (tab.status !== 'complete' || tab.url !== before.url) return this.#waitForLoad(tabId);
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_STEP_MS));
    }
  }

  async #waitForLoad(tabId: number): Promise<void> {
    const deadline = Date.now() + LOAD_TIMEOUT;
    for (;;) {
      const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab) throw new Error('The tab closed while it was loading.');
      if (tab.status === 'complete') return;
      if (Date.now() > deadline) return; // A page that never finishes is still observable.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async #navigate(command: Command, cancel: Cancellation): Promise<CommandResult> {
    const url = checkUrl(str(command.args, 'url') ?? '');
    const session = await this.#session(command.session);
    // Evidence from the old page cannot describe the new one.
    session.observed = undefined;
    this.#refs.delete(command.session);
    cancel.check();
    await this.#reuseOrOpen(session, url, cancel);
    return {};
  }

  async #tab(command: Command): Promise<CommandResult> {
    const session = await this.#session(command.session);
    const wanted = str(command.args, 'tabId') ?? '';
    if (!session.tabs.has(wanted)) throw new PreconditionError('No such tab in this conversation.');
    await this.#ownTab(session, wanted).catch((error: unknown) => {
      throw error instanceof PreconditionError ? error : new PreconditionError('No such tab in this conversation.');
    });
    session.active = wanted;
    return {};
  }

  /** Closes this session's own tabs, and only the ones still in its group. */
  async #close(command: Command, cancel: Cancellation): Promise<CommandResult> {
    const session = this.#sessions.get(command.session);
    if (!session) return {};
    const ids: number[] = [];
    for (const [key, tabId] of [...session.tabs]) {
      const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab) continue;
      // A tab the owner took out of the group is not this session's to close.
      if (session.groupId >= 0 && tab.groupId !== session.groupId) { this.#forget(session, key); continue; }
      ids.push(tabId);
    }
    if (ids.length > 0) {
      cancel.check();
      cancel.dispatch();
      await this.#chrome.tabs.remove(ids).catch(() => undefined);
    }
    this.#sessions.delete(command.session);
    this.#refs.delete(command.session);
    return {};
  }

  /** The owner may have closed or adopted an agent tab; a session forgets those before it reports. */
  async #liveTabs(session: Session): Promise<Array<{ id: string; tab: TabInfo }>> {
    const live: Array<{ id: string; tab: TabInfo }> = [];
    for (const [key, tabId] of [...session.tabs]) {
      const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab || (session.groupId >= 0 && tab.groupId !== session.groupId)) { this.#forget(session, key); continue; }
      live.push({ id: key, tab });
    }
    if (!session.active && live[0]) session.active = live[0].id;
    return live;
  }

  /* ---- observing ---- */

  /** Injected per command rather than declared for every page the owner visits. */
  async #inject(tabId: number): Promise<void> {
    await this.#chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [this.#contentFile] }).catch(() => undefined);
  }

  async #observe(sessionId: string, cancel: Cancellation): Promise<Observation> {
    const session = await this.#session(sessionId);
    const live = await this.#liveTabs(session);
    const key = this.#activeKey(session);
    const tab = await this.#ownTab(session, key);
    const tabId = tab.id!;
    cancel.check();
    await this.#inject(tabId);
    const frames = await this.#chrome.scripting.executeScript<[], FrameObservation | null>({
      target: { tabId, allFrames: true }, func: readObservation,
    }).catch(() => [] as Array<{ frameId: number; result: FrameObservation | null }>);

    /*
     * Frame 0 is the main frame by frame id, not by arrival order: Chrome
     * returns the frames in whatever order they answered, and reading a
     * subframe as the page would put the model on the wrong document. With no
     * main frame there is no observation to give.
     */
    const top = frames.find((frame) => frame.frameId === 0);
    if (!top?.result) throw new PreconditionError('The page did not answer. Wait for it to finish loading and observe again.');
    const ordered = [top, ...frames.filter((frame) => frame.frameId !== 0)];

    const generation = session.generation + 1;
    session.generation = generation;
    const refs = new Map<string, Ref>();
    const targets: ObservedTarget[] = [];
    const parts: string[] = [];
    let main: FrameObservation | undefined;
    for (const [index, frame] of ordered.slice(0, MAX_FRAMES).entries()) {
      const result = frame.result;
      if (!result) { parts.push(`Frame ${index} ([frame not readable]):\n`); continue; }
      if (index === 0) main = result;
      for (const element of result.elements) {
        // Past the cap there is no ref to hand out, so the local id goes too:
        // a `[ref=l7]` left in the tree is a ref the model cannot use.
        if (targets.length >= MAX_TARGETS) { result.tree = result.tree.split(` [ref=${element.id}]`).join('').split(`[ref=${element.id}]`).join(''); continue; }
        const ref = `e${targets.length + 1}`;
        refs.set(ref, { tabKey: key, tabId, frameId: frame.frameId, local: element.id, frame: index,
          role: element.role, name: element.name, docUrl: normalize(result.url), generation });
        targets.push({ ref, frame: index, role: element.role, name: element.name,
          ...(element.href ? { href: element.href } : {}), ...(element.bounds ? { bounds: element.bounds } : {}) });
        result.tree = result.tree.split(`[ref=${element.id}]`).join(`[ref=${ref}]`);
      }
      parts.push(`Frame ${index} (${result.url}):\n${result.tree.slice(0, index === 0 ? 20_000 : 3_000)}`);
    }
    this.#refs.set(sessionId, refs);
    session.observed = { generation, tabKey: key, url: normalize(main?.url ?? tab.url ?? '') };
    const scroll = main?.scroll ?? { x: 0, y: 0 };
    const tree = `${parts.join('\n\n')}\n\nScroll: ${scroll.x}, ${scroll.y}`.slice(0, MAX_TREE);
    return {
      id: this.#uuid(), url: main?.url ?? tab.url ?? '', title: main?.title ?? tab.title ?? '',
      tree, targets, capturedAt: new Date().toISOString(),
      tabs: live.map(({ id, tab: info }) => ({ id, url: info.url ?? '', title: info.title ?? '' })),
    };
  }

  /* ---- acting ---- */

  /*
   * A ref, or the semantic target the tool description promises.
   *
   * `browser.act` tells the model it may write `by:"role", role:"link",
   * name:"Sign in"`, and an agent must not have to learn which backend answered
   * it. Chrome has no `getByRole`, but the last observation already listed every
   * target with its role and its accessible name, so the match happens against
   * that list: exact role, name compared without case or surrounding space. An
   * ambiguous label is where a model quietly clicks the wrong "Edit", so two
   * matches is a refusal that hands back the refs to choose between.
   */
  #ref(session: Session, command: Command): Ref {
    const raw = command.args['target'];
    const target = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (target['x'] !== undefined || target['y'] !== undefined) throw new PreconditionError('Native apps and coordinate targets require Computer mode.');
    const table = this.#refs.get(command.session);
    const ref = target['ref'];
    if (typeof ref === 'string' && ref) {
      const found = table?.get(ref);
      if (!found || found.generation !== session.generation) throw new PreconditionError('Stale page observation. Observe again and use a fresh ref.');
      return found;
    }
    const name = typeof target['name'] === 'string' ? target['name'] : '';
    if (!name) throw new PreconditionError('Use a ref from the latest observation.targets, or an exact name.');
    if (!table || table.size === 0) throw new PreconditionError('Stale page observation. Observe again and use a fresh ref.');
    const by = typeof target['by'] === 'string' ? target['by'] : 'role';
    // `by:"link"` is the compatibility shorthand the command schema already
    // rewrites to role:"link"; accept it here too rather than depend on that.
    const role = by === 'link' ? 'link' : typeof target['role'] === 'string' ? target['role'] : undefined;
    const frame = typeof target['frame'] === 'number' ? target['frame'] : 0;
    const wanted = name.trim().toLowerCase();
    const matches = [...table].filter(([, candidate]) => candidate.frame === frame
      && candidate.name.trim().toLowerCase() === wanted
      // `label`, `placeholder` and `text` all end up in the accessible name the
      // tree builder computed, so only `role` narrows further.
      && (by !== 'role' || !role || candidate.role === role));
    const described = role ?? 'element';
    if (matches.length === 0) throw new PreconditionError(`No ${described} named ${name} in the last observation. Observe again and use a ref from observation.targets.`);
    if (matches.length > 1) throw new PreconditionError(`More than one ${described} named ${name} in the last observation (${matches.map(([key]) => key).join(', ')}). Use one of those refs.`);
    return matches[0]![1];
  }

  /**
   * Everything an acting command has to be sure of before it dispatches: the
   * ref is from the latest observation, the tab is still this session's, it is
   * still on the page that was observed, and the owner is not looking at it.
   */
  async #aim(command: Command, cancel: Cancellation): Promise<{ ref: Ref; tab: TabInfo }> {
    const session = await this.#session(command.session);
    const ref = this.#ref(session, command);
    const tab = await this.#ownTab(session, ref.tabKey);
    // The main frame's document is the tab's URL, so a redirect since the
    // observation is visible from here. A subframe's is not, and the page side
    // refuses a ref whose element no longer matches what was observed.
    if (ref.frameId === 0 && this.#liveUrl(tab) !== ref.docUrl) throw new PreconditionError(MOVED);
    await this.#background(tab, command.owner);
    cancel.check();
    return { ref, tab };
  }

  async #locate(ref: Ref, options: { focus?: boolean; clear?: boolean } = {}): Promise<{ point?: { x: number; y: number } }> {
    const [frame] = await this.#chrome.scripting.executeScript<[string, { focus?: boolean; clear?: boolean }], { ok: boolean; reason?: string; point?: { x: number; y: number } }>({
      target: { tabId: ref.tabId, frameIds: [ref.frameId] }, func: locateRef, args: [ref.local, options],
    });
    const result = frame?.result;
    if (!result?.ok) throw new PreconditionError(result?.reason ?? 'The referenced element changed or disappeared.');
    return { point: result.point };
  }

  /**
   * Claim the debugger on a tab, attaching it if nobody holds it yet.
   *
   * A screencast holds one of these for its whole life, so a command that runs
   * while the owner is watching finds the debugger already there and shares it
   * instead of attaching a second one, which Chrome would refuse.
   *
   * An attach that fails is a precondition failure, not a broken command: the
   * usual reason is that the owner has DevTools open on that tab, and nothing
   * was dispatched.
   */
  async #claimDebugger(tabId: number): Promise<void> {
    const held = this.#attached.get(tabId) ?? 0;
    if (held === 0) {
      try { await this.#chrome.debugger.attach({ tabId }, '1.3'); }
      catch (error) {
        throw new PreconditionError(`Chrome would not let buddi drive that tab (${error instanceof Error ? error.message : String(error)}). Close DevTools on it and observe again.`);
      }
    }
    this.#attached.set(tabId, held + 1);
  }

  /** Let go, and detach once nothing else is holding it, so the yellow bar never outlives the work. */
  async #releaseDebugger(tabId: number): Promise<void> {
    const held = this.#attached.get(tabId) ?? 0;
    if (held <= 1) {
      this.#attached.delete(tabId);
      await this.#chrome.debugger.detach({ tabId }).catch(() => undefined);
      return;
    }
    this.#attached.set(tabId, held - 1);
  }

  #send(tabId: number, method: string, params?: unknown): Promise<unknown> {
    return this.#chrome.debugger.sendCommand({ tabId }, method, params);
  }

  /**
   * The debugger for exactly one command, unless a screencast is already
   * holding it, and released even when the command is cancelled.
   */
  async #withDebugger<T>(tabId: number, body: (send: (method: string, params?: unknown) => Promise<unknown>) => Promise<T>): Promise<T> {
    await this.#claimDebugger(tabId);
    try {
      return await body((method, params) => this.#send(tabId, method, params));
    } finally {
      await this.#releaseDebugger(tabId);
    }
  }

  /* ---- the owner's own hand: a screencast out, input in ---- */

  /**
   * Start painting this session's tab to the dashboard.
   *
   * The debugger is claimed for the screencast's whole life rather than per
   * frame: frames arrive as events, not as answers, and a detach between them
   * would end the stream. Starting twice on the same session restarts it,
   * which is what a reconnecting dashboard does.
   */
  async #startScreencast(command: Command, cancel: Cancellation): Promise<CommandResult> {
    const session = await this.#session(command.session);
    const tab = await this.#ownTab(session, this.#activeKey(session));
    this.#liveUrl(tab);
    const tabId = tab.id!;
    cancel.check();
    await this.#stopScreencast(command.session);
    await this.#claimDebugger(tabId);
    const cast: Screencast = { session: command.session, tabId, lastSentAt: 0, stopped: false };
    this.#casts.set(command.session, cast);
    this.#castsByTab.set(tabId, cast);
    try {
      await this.#send(tabId, 'Page.startScreencast', {
        format: 'jpeg',
        // Smaller and cheaper than a screenshot on purpose: this is a picture
        // for a phone on someone else's network, not evidence for a model.
        quality: Math.min(90, Math.max(20, Math.trunc(num(command.args['quality']) ?? 50))),
        maxWidth: side(command.args['maxWidth'], 960),
        maxHeight: side(command.args['maxHeight'], 600),
        everyNthFrame: Math.min(10, Math.max(1, Math.trunc(num(command.args['everyNthFrame']) ?? 1))),
      });
      // A cancel that landed while the screencast was starting has already
      // given up on the answer, so leaving the stream running would paint at
      // nobody.
      cancel.check();
    } catch (error) {
      await this.#stopScreencast(command.session);
      throw error;
    }
    return {};
  }

  /** Idempotent: a stop for a session with no screencast is an answer, not a failure. */
  async #stopScreencast(session: string): Promise<void> {
    const cast = this.#casts.get(session);
    if (!cast) return;
    this.#forgetCast(cast);
    await this.#send(cast.tabId, 'Page.stopScreencast').catch(() => undefined);
    await this.#releaseDebugger(cast.tabId);
  }

  /** Drop every trace of a screencast without touching the debugger, for when Chrome already has. */
  #forgetCast(cast: Screencast): void {
    cast.stopped = true;
    if (cast.timer) { clearTimeout(cast.timer); cast.timer = undefined; }
    cast.pending = undefined;
    if (this.#casts.get(cast.session) === cast) this.#casts.delete(cast.session);
    if (this.#castsByTab.get(cast.tabId) === cast) this.#castsByTab.delete(cast.tabId);
  }

  #debuggerEvent(source: { tabId?: number }, method: string, params?: unknown): void {
    if (method !== 'Page.screencastFrame' || source.tabId === undefined) return;
    const cast = this.#castsByTab.get(source.tabId);
    if (!cast || cast.stopped) return;
    const message = (params ?? {}) as Record<string, unknown>;
    const data = message['data'];
    const sessionId = message['sessionId'];
    if (typeof data !== 'string' || typeof sessionId !== 'number' && typeof sessionId !== 'string') return;
    this.#offer(cast, { data, metadata: metadataOf(message['metadata']), sessionId });
  }

  /**
   * One painted frame, acked at once and sent at most ten times a second.
   *
   * The ack comes first, always, and before the throttle rather than after it.
   * Chrome paints nothing more until the frame it sent is acknowledged, so a
   * frame held back for up to a hundred milliseconds and only acked on the way
   * out stalls the *stream*, not just that frame: the browser sits idle for
   * the whole window. Acking on arrival costs nothing and keeps Chrome
   * painting; what the throttle drops is only the bytes on the socket.
   *
   * A frame that arrives too soon is held rather than thrown away, so a burst
   * that ends inside the window still leaves the dashboard looking at the page
   * as it finally settled.
   */
  #offer(cast: Screencast, frame: ScreencastFrame): void {
    this.#ack(cast, frame.sessionId);
    const wait = cast.lastSentAt + MIN_FRAME_MS - this.#now();
    if (wait <= 0) { this.#emit(cast, frame); return; }
    cast.pending = frame;
    if (cast.timer) return;
    cast.timer = setTimeout(() => {
      cast.timer = undefined;
      const held = cast.pending;
      cast.pending = undefined;
      if (held && !cast.stopped) this.#emit(cast, held);
    }, wait);
  }

  #emit(cast: Screencast, frame: ScreencastFrame): void {
    cast.lastSentAt = this.#now();
    this.#onFrame({ type: 'frame', session: cast.session, data: frame.data, metadata: frame.metadata, sessionId: frame.sessionId });
  }

  #ack(cast: Screencast, sessionId: string | number): void {
    void this.#send(cast.tabId, 'Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  }

  /**
   * A pointer or a key from the owner's hand.
   *
   * Only while a screencast is running for that session: input with nothing
   * painting it is an agent reaching for coordinates, which this backend does
   * not do. The tab is the screencast's, not the session's active one, so a
   * click cannot land somewhere the owner is not looking at.
   */
  async #input(command: Command, cancel: Cancellation): Promise<CommandResult> {
    const cast = this.#casts.get(command.session);
    if (!cast) throw new PreconditionError(NO_CAST);
    const session = await this.#session(command.session);
    const tab = await this.#chrome.tabs.get(cast.tabId).catch(() => undefined);
    if (!tab) { await this.#stopScreencast(command.session); throw new PreconditionError('That tab is gone. Observe again to continue in a new one.'); }
    if (session.groupId >= 0 && tab.groupId !== session.groupId) { await this.#stopScreencast(command.session); throw new PreconditionError(TAKEN); }
    await this.#background(tab, command.owner);
    const event = inputEvent(command.args);
    cancel.check();
    cancel.dispatch();
    await this.#send(cast.tabId, event.method, event.params);
    // Evidence the agent holds describes a page the owner has since been
    // typing into, so nothing here refreshes it; `resume` is what makes the
    // agent look again.
    return {};
  }

  async #click(command: Command, cancel: Cancellation): Promise<CommandResult> {
    const { ref, tab } = await this.#aim(command, cancel);
    const { point } = await this.#locate(ref);
    cancel.check();
    cancel.dispatch();
    if (ref.frameId !== 0 || !point) {
      await this.#chrome.scripting.executeScript({ target: { tabId: ref.tabId, frameIds: [ref.frameId] }, func: clickRef, args: [ref.local] });
      return {};
    }
    await this.#withDebugger(ref.tabId, async (send) => {
      const base = { x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1 };
      await send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 });
      await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
      await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
    });
    await this.#settle(ref.tabId, tab);
    return {};
  }

  async #fill(command: Command, cancel: Cancellation): Promise<CommandResult> {
    const { ref } = await this.#aim(command, cancel);
    const value = str(command.args, 'value') ?? '';
    // Focusing and clearing the field is already a change to the page.
    cancel.dispatch();
    await this.#locate(ref, { focus: true, clear: true });
    cancel.check();
    if (ref.frameId !== 0) {
      await this.#chrome.scripting.executeScript({ target: { tabId: ref.tabId, frameIds: [ref.frameId] }, func: typeRef, args: [ref.local, value] });
      return {};
    }
    await this.#withDebugger(ref.tabId, (send) => send('Input.insertText', { text: value }));
    return {};
  }

  async #press(command: Command, cancel: Cancellation): Promise<CommandResult> {
    const key = str(command.args, 'key') ?? '';
    const descriptor = KEYS[key];
    if (!descriptor) throw new PreconditionError(`This browser cannot press ${key}.`);
    const { ref, tab } = await this.#aim(command, cancel);
    cancel.dispatch();
    await this.#locate(ref, { focus: true });
    cancel.check();
    if (ref.frameId !== 0) {
      await this.#chrome.scripting.executeScript({ target: { tabId: ref.tabId, frameIds: [ref.frameId] }, func: pressRef, args: [ref.local, descriptor.key, descriptor.code, descriptor.keyCode] });
      return {};
    }
    await this.#withDebugger(ref.tabId, async (send) => {
      const common = { key: descriptor.key, code: descriptor.code, windowsVirtualKeyCode: descriptor.keyCode, nativeVirtualKeyCode: descriptor.keyCode };
      await send('Input.dispatchKeyEvent', { ...common, type: descriptor.text ? 'keyDown' : 'rawKeyDown', ...(descriptor.text ? { text: descriptor.text } : {}) });
      await send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
    });
    await this.#settle(ref.tabId, tab);
    return {};
  }

  async #select(command: Command, cancel: Cancellation): Promise<CommandResult> {
    const { ref } = await this.#aim(command, cancel);
    const value = str(command.args, 'value') ?? '';
    cancel.dispatch();
    const [frame] = await this.#chrome.scripting.executeScript<[string, string], { ok: boolean; reason?: string }>({
      target: { tabId: ref.tabId, frameIds: [ref.frameId] }, func: chooseRef, args: [ref.local, value],
    });
    if (!frame?.result?.ok) throw new PreconditionError(frame?.result?.reason ?? 'That option is not in the list.');
    return {};
  }

  /**
   * Scroll names no element, so what it checks instead is the observation: the
   * page the model is reading has to be the page still in the tab.
   */
  async #scroll(command: Command, cancel: Cancellation): Promise<CommandResult> {
    const session = await this.#session(command.session);
    const observed = session.observed;
    if (!observed || observed.generation !== session.generation) throw new PreconditionError('Stale page observation. Observe again before scrolling.');
    const tab = await this.#ownTab(session, observed.tabKey);
    if (this.#liveUrl(tab) !== observed.url) throw new PreconditionError(MOVED);
    await this.#background(tab, command.owner);
    const tabId = tab.id!;
    const direction = str(command.args, 'direction') === 'up' ? 'up' : 'down';
    cancel.check();
    await this.#inject(tabId);
    cancel.check();
    cancel.dispatch();
    await this.#chrome.scripting.executeScript<[('up' | 'down')], unknown>({ target: { tabId }, func: scrollPage, args: [direction] });
    return {};
  }

  async #screenshot(sessionId: string, cancel: Cancellation): Promise<string | null> {
    const session = await this.#session(sessionId);
    const tab = await this.#ownTab(session, this.#activeKey(session));
    // A tab that redirected somewhere this browser may not drive is not
    // evidence about anything; the driver asks for a fresh observation.
    this.#liveUrl(tab);
    const tabId = tab.id!;
    cancel.check();
    return this.#withDebugger(tabId, async (send) => {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }) as { data?: string } | undefined;
      return shot?.data ?? null;
    }).catch(() => null);
  }
}

/* ---- the functions below run in the page, never in the worker ---- */

/*
 * `chrome.scripting.executeScript` serializes these, so they may not close over
 * anything in this module. Each one is self-contained on purpose.
 */

function readObservation(): FrameObservation | null {
  const api = (globalThis as unknown as Record<string, { observe(): FrameObservation } | undefined>)['__buddiBrowser'];
  return api ? api.observe() : null;
}

function locateRef(ref: string, options: { focus?: boolean; clear?: boolean }): { ok: boolean; reason?: string; point?: { x: number; y: number } } {
  const api = (globalThis as unknown as Record<string, { locate(ref: string, options: unknown): { ok: boolean; reason?: string; point?: { x: number; y: number } } } | undefined>)['__buddiBrowser'];
  return api ? api.locate(ref, options) : { ok: false, reason: 'The page was reloaded. Observe again.' };
}

function chooseRef(ref: string, value: string): { ok: boolean; reason?: string } {
  const api = (globalThis as unknown as Record<string, { choose(ref: string, value: string): { ok: boolean; reason?: string } } | undefined>)['__buddiBrowser'];
  return api ? api.choose(ref, value) : { ok: false, reason: 'The page was reloaded. Observe again.' };
}

function scrollPage(direction: 'up' | 'down'): void {
  const api = (globalThis as unknown as Record<string, { scroll(direction: 'up' | 'down'): void } | undefined>)['__buddiBrowser'];
  api?.scroll(direction);
}

function clickRef(ref: string): void {
  const api = (globalThis as unknown as Record<string, { locate(ref: string, options: unknown): { ok: boolean } } | undefined>)['__buddiBrowser'];
  api?.locate(ref, {});
  const holder = (globalThis as unknown as Record<string, { refs: Map<string, WeakRef<Element>> } | undefined>)['__buddiBrowserRegistry'];
  const element = holder?.refs.get(ref)?.deref() as HTMLElement | undefined;
  element?.click();
}

function typeRef(ref: string, value: string): void {
  const holder = (globalThis as unknown as Record<string, { refs: Map<string, WeakRef<Element>> } | undefined>)['__buddiBrowserRegistry'];
  const element = holder?.refs.get(ref)?.deref() as HTMLInputElement | undefined;
  if (!element) return;
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function pressRef(ref: string, key: string, code: string, keyCode: number): void {
  const holder = (globalThis as unknown as Record<string, { refs: Map<string, WeakRef<Element>> } | undefined>)['__buddiBrowserRegistry'];
  const element = holder?.refs.get(ref)?.deref() as HTMLElement | undefined;
  if (!element) return;
  for (const type of ['keydown', 'keypress', 'keyup']) {
    element.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, bubbles: true, cancelable: true } as KeyboardEventInit));
  }
}
