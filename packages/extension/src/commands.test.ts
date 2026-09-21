/**
 * Targets, from both ends: the ref the model copied, and the role and name it
 * wrote instead. Chrome is a fake here; what is under test is which element a
 * command lands on and what it refuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserCommands } from './commands.js';
import type { WorkerChrome } from './chrome.js';
import { Cancellation, CancelledError, PreconditionError, type Command, type FrameMessage } from './protocol.js';
import type { CollectedElement } from './tree.js';

interface FrameResult { url: string; title: string; tree: string; elements: CollectedElement[]; scroll: { x: number; y: number } }

const PAGE: FrameResult = {
  url: 'https://example.test/', title: 'Example', scroll: { x: 0, y: 0 },
  tree: '- main\n  - link "Sign in" [ref=l1]\n  - button "Sign in" [ref=l2]\n  - textbox "Email" [ref=l3]\n  - link "Docs" [ref=l4]',
  elements: [
    { id: 'l1', role: 'link', name: 'Sign in', href: 'https://example.test/in' },
    { id: 'l2', role: 'button', name: 'Sign in' },
    { id: 'l3', role: 'textbox', name: 'Email' },
    { id: 'l4', role: 'link', name: ' Docs ' },
  ],
};

interface FakeTab { id: number; url: string; title: string; status: string; groupId: number; windowId: number; active: boolean }

type DebuggerEvent = (source: { tabId?: number }, method: string, params?: unknown) => void;
type DebuggerDetach = (source: { tabId?: number }, reason?: string) => void;

function fakeChrome(frames: Array<{ frameId: number; result: FrameResult | null }> = [{ frameId: 0, result: structuredClone(PAGE) }]) {
  const located: string[] = [];
  const dispatched: string[] = [];
  const sent: Array<{ method: string; params?: unknown }> = [];
  const attachments: number[] = [];
  const events: DebuggerEvent[] = [];
  const detaches: DebuggerDetach[] = [];
  const injected: string[] = [];
  const tabs = new Map<number, FakeTab>();
  const windows = new Map<number, { id: number; focused: boolean }>([[1, { id: 1, focused: true }]]);
  const failures: { attach?: string } = {};
  let nextTabId = 100;
  const chrome = {
    storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
    tabs: {
      async create({ url }: { url: string }) {
        const tab = { id: (nextTabId += 1), url, title: 'Example', status: 'complete', groupId: -1, windowId: 1, active: false };
        tabs.set(tab.id, tab);
        return tab;
      },
      async update(id: number, { url }: { url?: string }) { const tab = tabs.get(id)!; if (url) tab.url = url; return tab; },
      async get(id: number) { const tab = tabs.get(id); if (!tab) throw new Error('no such tab'); return tab; },
      async remove(ids: number[]) { for (const id of ids) tabs.delete(id); },
      async query() { return [...tabs.values()]; },
      // Chrome puts the tab in the group; the fake has to as well, because
      // every command now asks whether the tab is still in it.
      async group({ tabIds }: { tabIds: number[] }) { for (const id of tabIds) tabs.get(id)!.groupId = 7; return 7; },
    },
    tabGroups: { async update() { return {}; }, async get() { return {}; } },
    windows: { async get(id: number) { const found = windows.get(id); if (!found) throw new Error('no such window'); return found; } },
    scripting: {
      async executeScript(injection: { target: { frameIds?: number[]; allFrames?: boolean }; files?: string[] }) {
        if (injection.files) { injected.push(injection.files.join(',')); return []; }
        if (injection.target.frameIds) {
          located.push(String(injection.target.frameIds[0]));
          return [{ frameId: injection.target.frameIds[0]!, result: { ok: true, point: { x: 10, y: 20 } } }];
        }
        return frames;
      },
    },
    debugger: {
      async attach({ tabId }: { tabId: number }) { if (failures.attach) throw new Error(failures.attach); attachments.push(tabId); },
      async detach() { dispatched.push('detach'); },
      async sendCommand(_target: unknown, method: string, params?: unknown) {
        dispatched.push(method);
        sent.push({ method, params });
        return { data: 'iVBORw0KGgo=' };
      },
      onEvent: { addListener(listener: DebuggerEvent) { events.push(listener); } },
      onDetach: { addListener(listener: DebuggerDetach) { detaches.push(listener); } },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { getManifest: () => ({ version: '0.1.0' }), onMessage: { addListener() {} }, async sendMessage() { return undefined; } },
  } as unknown as WorkerChrome;
  return { chrome, located, dispatched, sent, attachments, events, detaches, injected, tabs, windows, failures };
}

const command = (name: Command['name'], args: Record<string, unknown> = {}, owner = false): Command => ({ id: 'c1', name, session: 's1', args, owner });

async function opened(frames?: Array<{ frameId: number; result: FrameResult | null }>, options: { onFrame?: (frame: FrameMessage) => void; now?: () => number } = {}) {
  const fake = fakeChrome(frames);
  const commands = new BrowserCommands(fake.chrome, { uuid: () => 'fixed-uuid-value', ...options });
  await commands.run(command('navigate', { url: 'https://example.test/' }));
  return { ...fake, commands };
}

describe('observing', () => {
  it('numbers refs across the observation and reports them as targets', async () => {
    const { commands } = await opened();
    const { observation } = await commands.run(command('observe'));
    expect(observation!.targets!.map((target) => [target.ref, target.role, target.name])).toEqual([
      ['e1', 'link', 'Sign in'], ['e2', 'button', 'Sign in'], ['e3', 'textbox', 'Email'], ['e4', 'link', ' Docs '],
    ]);
    expect(observation!.tree).toContain('- link "Sign in" [ref=e1]');
    expect(observation!.tree).toContain('Frame 0 (https://example.test/)');
    expect(observation!.tree).toContain('Scroll: 0, 0');
    expect(observation!.tabs).toHaveLength(1);
  });
});

describe('targets', () => {
  it('acts on the ref the model copied', async () => {
    const { commands, dispatched } = await opened();
    await commands.run(command('observe'));
    await commands.run(command('click', { target: { ref: 'e2' } }));
    expect(dispatched).toEqual(['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'detach']);
  });

  it('resolves a role and a name against the last observation', async () => {
    const { commands } = await opened();
    await commands.run(command('observe'));
    await expect(commands.run(command('click', { target: { by: 'role', role: 'link', name: 'Sign in' } }))).resolves.toEqual({});
  });

  it('ignores case and surrounding space in the name', async () => {
    const { commands } = await opened();
    await commands.run(command('observe'));
    await expect(commands.run(command('click', { target: { by: 'role', role: 'link', name: 'docs' } }))).resolves.toEqual({});
  });

  it('takes by:"link" as the shorthand for a link', async () => {
    const { commands } = await opened();
    await commands.run(command('observe'));
    await expect(commands.run(command('click', { target: { by: 'link', name: 'Docs' } }))).resolves.toEqual({});
  });

  it('matches a label, a placeholder and a text target against the accessible name', async () => {
    const { commands } = await opened();
    await commands.run(command('observe'));
    await expect(commands.run(command('fill', { target: { by: 'label', name: 'Email' }, value: 'a@b.test' }))).resolves.toEqual({});
    await expect(commands.run(command('click', { target: { by: 'text', name: 'Docs' } }))).resolves.toEqual({});
  });

  it('refuses a name that is not on the page, without dispatching anything', async () => {
    const { commands, dispatched } = await opened();
    await commands.run(command('observe'));
    await expect(commands.run(command('click', { target: { by: 'role', role: 'button', name: 'Checkout' } })))
      .rejects.toThrow(/No button named Checkout in the last observation/);
    expect(dispatched).toEqual([]);
  });

  it('refuses an ambiguous label and says which refs to choose between', async () => {
    const { commands } = await opened();
    await commands.run(command('observe'));
    const failure = await commands.run(command('click', { target: { by: 'text', name: 'Sign in' } })).catch((error) => error);
    expect(failure).toBeInstanceOf(PreconditionError);
    expect(String(failure.message)).toBe('More than one element named Sign in in the last observation (e1, e2). Use one of those refs.');
  });

  it('refuses a coordinate target, as Playwright mode does', async () => {
    const { commands } = await opened();
    await commands.run(command('observe'));
    await expect(commands.run(command('click', { target: { x: 10, y: 20 } }))).rejects.toThrow(/Computer mode/);
  });

  it('refuses any target before the first observation', async () => {
    const { commands } = await opened();
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).rejects.toThrow(/Stale page observation/);
    await expect(commands.run(command('click', { target: { by: 'role', role: 'link', name: 'Sign in' } }))).rejects.toThrow(/Stale page observation/);
  });

  it('refuses a target with neither a ref nor a name', async () => {
    const { commands } = await opened();
    await commands.run(command('observe'));
    await expect(commands.run(command('click', {}))).rejects.toThrow(/Use a ref from the latest observation.targets/);
  });

  it('keeps a semantic target inside the frame it names', async () => {
    const second: FrameResult = { url: 'https://example.test/frame', title: '', scroll: { x: 0, y: 0 },
      tree: '- button "Only here" [ref=l1]', elements: [{ id: 'l1', role: 'button', name: 'Only here' }] };
    const { commands } = await opened([
      { frameId: 0, result: structuredClone(PAGE) },
      { frameId: 4, result: second },
    ]);
    await commands.run(command('observe'));
    await expect(commands.run(command('click', { target: { by: 'role', role: 'button', name: 'Only here' } })))
      .rejects.toThrow(/No button named Only here in the last observation/);
    await expect(commands.run(command('click', { target: { by: 'role', role: 'button', name: 'Only here', frame: 1 } }))).resolves.toEqual({});
  });
});

describe('the session', () => {
  it('closes the tabs it opened and forgets the refs', async () => {
    const { commands, tabs } = await opened();
    await commands.run(command('observe'));
    expect(tabs.size).toBe(1);
    await commands.run(command('close'));
    expect(tabs.size).toBe(0);
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).rejects.toThrow(/Stale page observation/);
  });

  it('screenshots the tab of the session through the debugger', async () => {
    const { commands, dispatched } = await opened();
    const { screenshot } = await commands.run(command('screenshot'));
    expect(screenshot).toBe('iVBORw0KGgo=');
    expect(dispatched).toContain('Page.captureScreenshot');
  });
});

describe('the owner’s tabs', () => {
  it('refuses to act in a tab the owner dragged out of the group, and forgets it', async () => {
    const { commands, tabs, dispatched } = await opened();
    await commands.run(command('observe'));
    [...tabs.values()][0]!.groupId = -1; // The owner pulled it out of "buddi".
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).rejects.toThrow(/The owner took this tab/);
    expect(dispatched).toEqual([]);
    // Forgotten, not closed: the tab is still open and still theirs.
    await commands.run(command('close'));
    expect(tabs.size).toBe(1);
  });

  it('refuses input while the owner is looking at the tab', async () => {
    const { commands, tabs, dispatched } = await opened();
    await commands.run(command('observe'));
    [...tabs.values()][0]!.active = true;
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).rejects.toThrow(/only acts in background tabs/);
    expect(dispatched).toEqual([]);
  });

  it('acts in an active tab whose window is not focused', async () => {
    const { commands, tabs, windows } = await opened();
    await commands.run(command('observe'));
    [...tabs.values()][0]!.active = true;
    windows.get(1)!.focused = false;
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).resolves.toEqual({});
  });

  it('opens a new tab rather than navigating one the owner has taken', async () => {
    const { commands, tabs } = await opened();
    [...tabs.values()][0]!.groupId = -1;
    await commands.run(command('navigate', { url: 'https://example.test/second' }));
    expect(tabs.size).toBe(2);
    expect([...tabs.values()][0]!.url).toBe('https://example.test/');
  });

  it('forgets sessions and refs when the socket ends, and leaves the tabs open', async () => {
    const { commands, tabs } = await opened();
    await commands.run(command('observe'));
    commands.reset();
    expect(tabs.size).toBe(1);
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).rejects.toThrow(/Stale page observation/);
  });
});

describe('what a ref is bound to', () => {
  it('refuses a ref whose page has moved on, and an untargeted scroll after it', async () => {
    const { commands, tabs, dispatched } = await opened();
    await commands.run(command('observe'));
    [...tabs.values()][0]!.url = 'https://example.test/elsewhere';
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).rejects.toThrow(/has changed since that observation/);
    await expect(commands.run(command('scroll', { direction: 'down' }))).rejects.toThrow(/has changed since that observation/);
    expect(dispatched).toEqual([]);
  });

  it('refuses a scroll before the first observation', async () => {
    const { commands } = await opened();
    await expect(commands.run(command('scroll', { direction: 'down' }))).rejects.toThrow(/Stale page observation/);
  });

  it('refuses a tab that is no longer http', async () => {
    const { commands, tabs } = await opened();
    await commands.run(command('observe'));
    [...tabs.values()][0]!.url = 'chrome://settings';
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).rejects.toThrow(/http and https/);
  });
});

describe('what the page answers', () => {
  it('reads the main frame by its id, whatever order the frames answered in', async () => {
    const second: FrameResult = { url: 'https://example.test/frame', title: '', scroll: { x: 0, y: 0 },
      tree: '- button "Only here" [ref=l1]', elements: [{ id: 'l1', role: 'button', name: 'Only here' }] };
    const { commands } = await opened([{ frameId: 9, result: second }, { frameId: 0, result: structuredClone(PAGE) }]);
    const { observation } = await commands.run(command('observe'));
    expect(observation!.url).toBe('https://example.test/');
    expect(observation!.tree.startsWith('Frame 0 (https://example.test/)')).toBe(true);
    expect(observation!.targets![0]).toMatchObject({ ref: 'e1', name: 'Sign in' });
  });

  it('has no observation to give when the main frame did not answer', async () => {
    const { commands } = await opened([{ frameId: 9, result: structuredClone(PAGE) }]);
    await expect(commands.run(command('observe'))).rejects.toThrow(/The page did not answer/);
  });

  it('strips the refs it had no room to number instead of leaving them in the tree', async () => {
    const many: FrameResult = { url: 'https://example.test/', title: 'Many', scroll: { x: 0, y: 0 },
      tree: Array.from({ length: 245 }, (_, i) => `- link "Row ${i + 1}" [ref=l${i + 1}]`).join('\n'),
      elements: Array.from({ length: 245 }, (_, i) => ({ id: `l${i + 1}`, role: 'link', name: `Row ${i + 1}` })) };
    const { commands } = await opened([{ frameId: 0, result: many }]);
    const { observation } = await commands.run(command('observe'));
    expect(observation!.targets).toHaveLength(240);
    expect(observation!.tree).toContain('- link "Row 240" [ref=e240]');
    expect(observation!.tree).toContain('- link "Row 241"');
    expect(observation!.tree).not.toMatch(/\[ref=l\d+\]/);
  });

  it('calls a debugger that will not attach a precondition failure', async () => {
    const { commands, failures } = await opened();
    await commands.run(command('observe'));
    failures.attach = 'Another debugger is already attached';
    const failure = await commands.run(command('click', { target: { ref: 'e1' } })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PreconditionError);
    expect(String((failure as Error).message)).toMatch(/Close DevTools on it/);
  });
});

describe('cancelling', () => {
  it('stops before the next step and reports whether anything was dispatched', async () => {
    const { commands, dispatched } = await opened();
    await commands.run(command('observe'));
    const cancel = new Cancellation();
    cancel.cancel();
    await expect(commands.run(command('click', { target: { ref: 'e1' } }), cancel)).rejects.toBeInstanceOf(CancelledError);
    expect(cancel.dispatched).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it('detaches the debugger even when the command is cancelled mid-flight', async () => {
    const { commands, chrome, dispatched } = await opened();
    await commands.run(command('observe'));
    const cancel = new Cancellation();
    // The tab dies just as the first input event goes out.
    chrome.debugger.sendCommand = async () => { cancel.cancel(); throw new Error('the tab went away'); };
    await expect(commands.run(command('click', { target: { ref: 'e1' } }), cancel)).rejects.toThrow();
    expect(cancel.dispatched).toBe(true);
    expect(dispatched).toContain('detach');
  });
});

describe('waiting for what the input started', () => {
  it('waits for the navigation a click starts, instead of returning on the old page', async () => {
    const { commands, chrome, tabs } = await opened();
    await commands.run(command('observe'));
    const tab = [...tabs.values()][0]!;
    let loaded = false;
    // A real click that submits leaves `status` at `complete` for a moment and
    // only then starts loading the next page.
    chrome.debugger.sendCommand = async () => {
      setTimeout(() => { tab.status = 'loading'; tab.url = 'https://example.test/next'; }, 20);
      setTimeout(() => { tab.status = 'complete'; loaded = true; }, 260);
      return {};
    };
    await commands.run(command('click', { target: { ref: 'e1' } }));
    expect(loaded).toBe(true);
    expect(tab.url).toBe('https://example.test/next');
  });
});

/*
 * The owner's own hand: a screencast out of the tab and their pointer and keys
 * back into it. The fake chrome plays Chrome's side of the debugger, so what is
 * under test is the throttle, the acks, the mapping, and what is refused.
 */
describe('the screencast', () => {
  // The throttle holds a frame back on a timer; nothing else here waits on one.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const frame = (n: number) => ({ data: `frame-${n}`, sessionId: n, metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 40 } });

  async function casting() {
    const frames: FrameMessage[] = [];
    let clock = 1_000;
    const fake = await opened(undefined, { onFrame: (f) => frames.push(f), now: () => clock });
    await fake.commands.run(command('screencast.start', { maxWidth: 1280, maxHeight: 800 }));
    const paint = (n: number) => { for (const listener of fake.events) listener({ tabId: [...fake.tabs.keys()][0]! }, 'Page.screencastFrame', frame(n)); };
    return { ...fake, frames, paint, tick: (ms: number) => { clock += ms; } };
  }

  it('starts jpeg frames on the session tab and keeps the debugger attached', async () => {
    const { sent, dispatched, attachments } = await casting();
    expect(sent.find((call) => call.method === 'Page.startScreencast')!.params)
      .toMatchObject({ format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
    expect(attachments).toHaveLength(1);
    expect(dispatched).not.toContain('detach');
  });

  it('sends each frame with its metadata and acks it', async () => {
    const { frames, paint, sent } = await casting();
    paint(1);
    await Promise.resolve();
    expect(frames).toEqual([{ type: 'frame', session: 's1', data: 'frame-1', sessionId: 1,
      metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 40 } }]);
    expect(sent.filter((call) => call.method === 'Page.screencastFrameAck').map((call) => call.params)).toEqual([{ sessionId: 1 }]);
  });

  it('sends at most ten frames a second and acks the ones it drops, so Chrome keeps painting', async () => {
    const { frames, paint, sent, tick } = await casting();
    paint(1);
    tick(10);
    paint(2);
    tick(10);
    paint(3);
    await Promise.resolve();
    // One went out; the two that came too soon were acked, and the last is held.
    expect(frames.map((f) => f.data)).toEqual(['frame-1']);
    expect(sent.filter((call) => call.method === 'Page.screencastFrameAck')).toHaveLength(2);
    tick(100);
    await vi.advanceTimersByTimeAsync(100);
    // The page settled inside the window, so the owner still sees where it settled.
    expect(frames.map((f) => f.data)).toEqual(['frame-1', 'frame-3']);
    expect(sent.filter((call) => call.method === 'Page.screencastFrameAck')).toHaveLength(3);
  });

  it('shares its debugger with a command that runs while it is on, and detaches only at the end', async () => {
    const { commands, dispatched, attachments, frames, paint } = await casting();
    await commands.run(command('observe'));
    await commands.run(command('screenshot'));
    expect(attachments).toHaveLength(1);
    expect(dispatched).not.toContain('detach');
    paint(1);
    await Promise.resolve();
    expect(frames).toHaveLength(1);
    await commands.run(command('screencast.stop'));
    expect(dispatched).toContain('detach');
  });

  it('stops the screencast and detaches on stop, and answers a second stop all the same', async () => {
    const { commands, dispatched, sent, frames, paint } = await casting();
    await commands.run(command('screencast.stop'));
    expect(sent.some((call) => call.method === 'Page.stopScreencast')).toBe(true);
    expect(dispatched).toContain('detach');
    paint(1);
    await Promise.resolve();
    expect(frames).toEqual([]);
    await expect(commands.run(command('screencast.stop'))).resolves.toEqual({});
  });

  it('gives up the screencast when the socket ends', async () => {
    const { commands, dispatched, frames, paint } = await casting();
    commands.reset();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatched).toContain('detach');
    paint(1);
    await Promise.resolve();
    expect(frames).toEqual([]);
  });

  it('forgets the screencast when Chrome takes the debugger away', async () => {
    const { commands, detaches, tabs, frames, paint } = await casting();
    for (const listener of detaches) listener({ tabId: [...tabs.keys()][0]! }, 'target_closed');
    paint(1);
    await Promise.resolve();
    expect(frames).toEqual([]);
    await expect(commands.run(command('input', { kind: 'mouse', type: 'mousePressed', x: 1, y: 1 }), new Cancellation()))
      .rejects.toThrow(/No screencast is running/);
  });

  it('detaches when a cancel lands while it is starting', async () => {
    const fake = await opened();
    const cancel = new Cancellation();
    fake.chrome.debugger.sendCommand = async (_target: unknown, method: string) => { if (method === 'Page.startScreencast') cancel.cancel(); return {}; };
    await expect(fake.commands.run(command('screencast.start'), cancel)).rejects.toBeInstanceOf(CancelledError);
    expect(fake.dispatched).toContain('detach');
  });
});

describe('the owner’s input', () => {
  async function casting(owner = true) {
    const fake = await opened(undefined, { now: () => 1_000 });
    await fake.commands.run(command('screencast.start'));
    const input = (args: Record<string, unknown>) => fake.commands.run(command('input', args, owner));
    return { ...fake, input };
  }

  it('refuses input when no screencast is running', async () => {
    const { commands, dispatched } = await opened();
    await expect(commands.run(command('input', { kind: 'mouse', type: 'mousePressed', x: 3, y: 4 }, true)))
      .rejects.toThrow(/No screencast is running/);
    expect(dispatched).toEqual([]);
  });

  it('dispatches a click where the dashboard pointed', async () => {
    const { input, sent } = await casting();
    await input({ kind: 'mouse', type: 'mousePressed', x: 12, y: 34, button: 'left', clickCount: 2, modifiers: 2 });
    await input({ kind: 'mouse', type: 'mouseReleased', x: 12, y: 34, button: 'left', clickCount: 2 });
    const mouse = sent.filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => call.params);
    expect(mouse).toEqual([
      { type: 'mousePressed', x: 12, y: 34, button: 'left', buttons: 1, clickCount: 2, modifiers: 2 },
      { type: 'mouseReleased', x: 12, y: 34, button: 'left', buttons: 0, clickCount: 2, modifiers: 0 },
    ]);
  });

  it('turns a wheel into a mouseWheel and a key into a key event', async () => {
    const { input, sent } = await casting();
    await input({ kind: 'wheel', x: 5, y: 6, deltaX: 0, deltaY: -120 });
    await input({ kind: 'key', type: 'keyDown', key: 'Enter', code: 'Enter' });
    await input({ kind: 'key', type: 'char', key: 'a', code: 'KeyA', text: 'a' });
    expect(sent.at(-3)).toEqual({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 5, y: 6, deltaX: 0, deltaY: -120, modifiers: 0 } });
    expect(sent.at(-2)).toEqual({ method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 0, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 } });
    expect(sent.at(-1)).toEqual({ method: 'Input.dispatchKeyEvent', params: { type: 'char', key: 'a', code: 'KeyA', modifiers: 0, text: 'a' } });
  });

  it('keeps coordinates and deltas inside what a viewport can be', async () => {
    const { input, sent } = await casting();
    await input({ kind: 'mouse', type: 'mouseMoved', x: 9e9, y: Number.NaN });
    expect(sent.at(-1)!.params).toMatchObject({ x: 20_000, y: 0, clickCount: 0 });
  });

  it('refuses an event kind and a mouse type it does not dispatch', async () => {
    const { input, sent } = await casting();
    const before = sent.length;
    await expect(input({ kind: 'touch', type: 'touchStart' })).rejects.toBeInstanceOf(PreconditionError);
    await expect(input({ kind: 'mouse', type: 'contextMenu', x: 1, y: 1 })).rejects.toBeInstanceOf(PreconditionError);
    await expect(input({ kind: 'key', type: 'char', key: 'a', code: 'KeyA' })).rejects.toThrow(/no text in it/);
    expect(sent).toHaveLength(before);
  });

  it('types into the tab the owner is looking at, because the hands are theirs', async () => {
    const { input, tabs, sent } = await casting();
    [...tabs.values()][0]!.active = true;
    await input({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
    expect(sent.at(-1)!.method).toBe('Input.dispatchKeyEvent');
  });

  it('still refuses input that is not the owner’s while they are looking at the tab', async () => {
    const { input, tabs } = await casting(false);
    [...tabs.values()][0]!.active = true;
    await expect(input({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' }))
      .rejects.toThrow(/only acts in background tabs/);
  });

  it('refuses input into a tab the owner took out of the group, and ends the screencast', async () => {
    const { input, tabs, commands } = await casting();
    [...tabs.values()][0]!.groupId = -1;
    await expect(input({ kind: 'mouse', type: 'mousePressed', x: 1, y: 1 })).rejects.toThrow(/The owner took this tab/);
    await expect(commands.run(command('input', { kind: 'mouse', type: 'mousePressed', x: 1, y: 1 }, true)))
      .rejects.toThrow(/No screencast is running/);
  });
});
