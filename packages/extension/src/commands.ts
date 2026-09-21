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
import { PreconditionError, type Command, type CommandResult, type Observation, type ObservedTarget } from './protocol.js';
import type { CollectedElement } from './tree.js';

interface Session { groupId: number; tabs: Map<string, number>; active: string | null }
/** What a ref points at, and what it looked like, so a semantic target can find it again. */
interface Ref { tabId: number; frameId: number; local: string; frame: number; role: string; name: string }

interface FrameObservation {
  url: string; title: string; tree: string; elements: CollectedElement[]; scroll: { x: number; y: number };
}

const GROUP_TITLE = 'buddi';
/** The driver reads the main frame plus ten, and caps the whole tree at 32k. */
const MAX_FRAMES = 11;
const MAX_TREE = 32_000;
const MAX_TARGETS = 240;
const LOAD_TIMEOUT = 30_000;

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

/** Only http(s). A chrome:// or file:// tab is not somewhere an agent gets to go. */
function checkUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new PreconditionError(`${url} is not an address this browser can open.`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new PreconditionError('Only http and https addresses can be opened in your browser.');
  return parsed.toString();
}

export interface Executor { run(command: Command): Promise<CommandResult> }

export class BrowserCommands implements Executor {
  #chrome: WorkerChrome;
  #sessions = new Map<string, Session>();
  /** Refs are handed out per observation; the next command resolves them here. */
  #refs = new Map<string, Map<string, Ref>>();
  #uuid: () => string;
  #contentFile: string;

  constructor(chrome: WorkerChrome, options: { uuid?: () => string; contentFile?: string } = {}) {
    this.#chrome = chrome;
    this.#uuid = options.uuid ?? (() => crypto.randomUUID());
    this.#contentFile = options.contentFile ?? 'content.js';
  }

  async run(command: Command): Promise<CommandResult> {
    switch (command.name) {
      case 'navigate': return this.#navigate(command);
      case 'observe': return { observation: await this.#observe(command.session) };
      case 'click': return this.#click(command);
      case 'fill': return this.#fill(command);
      case 'select': return this.#select(command);
      case 'press': return this.#press(command);
      case 'scroll': return this.#scroll(command);
      case 'tab': return this.#tab(command);
      case 'screenshot': return { screenshot: await this.#screenshot(command.session) };
      case 'close': return this.#close(command);
      default: throw new PreconditionError(`This browser cannot run ${command.name}.`);
    }
  }

  /* ---- sessions and tabs ---- */

  async #session(session: string): Promise<Session> {
    const existing = this.#sessions.get(session);
    if (existing) return existing;
    const created: Session = { groupId: -1, tabs: new Map(), active: null };
    this.#sessions.set(session, created);
    return created;
  }

  #activeTab(session: Session): number {
    const id = session.active ? session.tabs.get(session.active) : undefined;
    if (id === undefined) throw new PreconditionError('This conversation has no browser tab yet. Navigate to open one.');
    return id;
  }

  async #openTab(session: Session, url: string): Promise<number> {
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

  async #navigate(command: Command): Promise<CommandResult> {
    const url = checkUrl(str(command.args, 'url') ?? '');
    const session = await this.#session(command.session);
    let tabId: number | undefined = session.active ? session.tabs.get(session.active) : undefined;
    if (tabId !== undefined && !(await this.#chrome.tabs.get(tabId).catch(() => undefined))) {
      session.tabs.delete(session.active!);
      session.active = null;
      tabId = undefined;
    }
    if (tabId === undefined) tabId = await this.#openTab(session, url);
    else await this.#chrome.tabs.update(tabId, { url });
    await this.#waitForLoad(tabId);
    return {};
  }

  async #tab(command: Command): Promise<CommandResult> {
    const session = await this.#session(command.session);
    const wanted = str(command.args, 'tabId') ?? '';
    const tabId = session.tabs.get(wanted);
    if (tabId === undefined || !(await this.#chrome.tabs.get(tabId).catch(() => undefined))) throw new PreconditionError('No such tab in this conversation.');
    session.active = wanted;
    return {};
  }

  async #close(command: Command): Promise<CommandResult> {
    const session = this.#sessions.get(command.session);
    if (!session) return {};
    const ids = [...session.tabs.values()];
    if (ids.length > 0) await this.#chrome.tabs.remove(ids).catch(() => undefined);
    this.#sessions.delete(command.session);
    this.#refs.delete(command.session);
    return {};
  }

  /** The owner may have closed an agent tab by hand; a session forgets those before it reports. */
  async #liveTabs(session: Session): Promise<Array<{ id: string; tab: TabInfo }>> {
    const live: Array<{ id: string; tab: TabInfo }> = [];
    for (const [key, tabId] of [...session.tabs]) {
      const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab) { session.tabs.delete(key); if (session.active === key) session.active = null; continue; }
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

  async #observe(sessionId: string): Promise<Observation> {
    const session = await this.#session(sessionId);
    const live = await this.#liveTabs(session);
    const tabId = this.#activeTab(session);
    await this.#inject(tabId);
    const frames = await this.#chrome.scripting.executeScript<[], FrameObservation | null>({
      target: { tabId, allFrames: true }, func: readObservation,
    }).catch(() => [] as Array<{ frameId: number; result: FrameObservation | null }>);

    const refs = new Map<string, Ref>();
    const targets: ObservedTarget[] = [];
    const parts: string[] = [];
    let main: FrameObservation | undefined;
    for (const [index, frame] of frames.slice(0, MAX_FRAMES).entries()) {
      const result = frame.result;
      if (!result) { parts.push(`Frame ${index} ([frame not readable]):\n`); continue; }
      if (index === 0) main = result;
      for (const element of result.elements) {
        if (targets.length >= MAX_TARGETS) break;
        const ref = `e${targets.length + 1}`;
        refs.set(ref, { tabId, frameId: frame.frameId, local: element.id, frame: index, role: element.role, name: element.name });
        targets.push({ ref, frame: index, role: element.role, name: element.name,
          ...(element.href ? { href: element.href } : {}), ...(element.bounds ? { bounds: element.bounds } : {}) });
        result.tree = result.tree.split(`[ref=${element.id}]`).join(`[ref=${ref}]`);
      }
      parts.push(`Frame ${index} (${result.url}):\n${result.tree.slice(0, index === 0 ? 20_000 : 3_000)}`);
    }
    this.#refs.set(sessionId, refs);
    const tab = await this.#chrome.tabs.get(tabId);
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
  #ref(command: Command): Ref {
    const raw = command.args['target'];
    const target = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (target['x'] !== undefined || target['y'] !== undefined) throw new PreconditionError('Native apps and coordinate targets require Computer mode.');
    const table = this.#refs.get(command.session);
    const ref = target['ref'];
    if (typeof ref === 'string' && ref) {
      const found = table?.get(ref);
      if (!found) throw new PreconditionError('Stale page observation. Observe again and use a fresh ref.');
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

  async #locate(ref: Ref, options: { focus?: boolean; clear?: boolean } = {}): Promise<{ point?: { x: number; y: number } }> {
    const [frame] = await this.#chrome.scripting.executeScript<[string, { focus?: boolean; clear?: boolean }], { ok: boolean; reason?: string; point?: { x: number; y: number } }>({
      target: { tabId: ref.tabId, frameIds: [ref.frameId] }, func: locateRef, args: [ref.local, options],
    });
    const result = frame?.result;
    if (!result?.ok) throw new PreconditionError(result?.reason ?? 'The referenced element changed or disappeared.');
    return { point: result.point };
  }

  /** The debugger stays attached for exactly one command, so the yellow bar is never left up. */
  async #withDebugger<T>(tabId: number, body: (send: (method: string, params?: unknown) => Promise<unknown>) => Promise<T>): Promise<T> {
    await this.#chrome.debugger.attach({ tabId }, '1.3');
    try {
      return await body((method, params) => this.#chrome.debugger.sendCommand({ tabId }, method, params));
    } finally {
      await this.#chrome.debugger.detach({ tabId }).catch(() => undefined);
    }
  }

  async #click(command: Command): Promise<CommandResult> {
    const ref = this.#ref(command);
    const { point } = await this.#locate(ref);
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
    await this.#waitForLoad(ref.tabId);
    return {};
  }

  async #fill(command: Command): Promise<CommandResult> {
    const ref = this.#ref(command);
    const value = str(command.args, 'value') ?? '';
    await this.#locate(ref, { focus: true, clear: true });
    if (ref.frameId !== 0) {
      await this.#chrome.scripting.executeScript({ target: { tabId: ref.tabId, frameIds: [ref.frameId] }, func: typeRef, args: [ref.local, value] });
      return {};
    }
    await this.#withDebugger(ref.tabId, (send) => send('Input.insertText', { text: value }));
    return {};
  }

  async #press(command: Command): Promise<CommandResult> {
    const ref = this.#ref(command);
    const key = str(command.args, 'key') ?? '';
    const descriptor = KEYS[key];
    if (!descriptor) throw new PreconditionError(`This browser cannot press ${key}.`);
    await this.#locate(ref, { focus: true });
    if (ref.frameId !== 0) {
      await this.#chrome.scripting.executeScript({ target: { tabId: ref.tabId, frameIds: [ref.frameId] }, func: pressRef, args: [ref.local, descriptor.key, descriptor.code, descriptor.keyCode] });
      return {};
    }
    await this.#withDebugger(ref.tabId, async (send) => {
      const common = { key: descriptor.key, code: descriptor.code, windowsVirtualKeyCode: descriptor.keyCode, nativeVirtualKeyCode: descriptor.keyCode };
      await send('Input.dispatchKeyEvent', { ...common, type: descriptor.text ? 'keyDown' : 'rawKeyDown', ...(descriptor.text ? { text: descriptor.text } : {}) });
      await send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
    });
    await this.#waitForLoad(ref.tabId);
    return {};
  }

  async #select(command: Command): Promise<CommandResult> {
    const ref = this.#ref(command);
    const value = str(command.args, 'value') ?? '';
    const [frame] = await this.#chrome.scripting.executeScript<[string, string], { ok: boolean; reason?: string }>({
      target: { tabId: ref.tabId, frameIds: [ref.frameId] }, func: chooseRef, args: [ref.local, value],
    });
    if (!frame?.result?.ok) throw new PreconditionError(frame?.result?.reason ?? 'That option is not in the list.');
    return {};
  }

  async #scroll(command: Command): Promise<CommandResult> {
    const session = await this.#session(command.session);
    const tabId = this.#activeTab(session);
    const direction = str(command.args, 'direction') === 'up' ? 'up' : 'down';
    await this.#inject(tabId);
    await this.#chrome.scripting.executeScript<[('up' | 'down')], unknown>({ target: { tabId }, func: scrollPage, args: [direction] });
    return {};
  }

  async #screenshot(sessionId: string): Promise<string | null> {
    const session = await this.#session(sessionId);
    const tabId = this.#activeTab(session);
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
