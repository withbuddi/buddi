/**
 * Targets, from both ends: the ref the model copied, and the role and name it
 * wrote instead. Chrome is a fake here; what is under test is which element a
 * command lands on and what it refuses.
 */
import { describe, expect, it } from 'vitest';
import { BrowserCommands } from './commands.js';
import type { WorkerChrome } from './chrome.js';
import { PreconditionError, type Command } from './protocol.js';
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

function fakeChrome(frames: Array<{ frameId: number; result: FrameResult | null }> = [{ frameId: 0, result: structuredClone(PAGE) }]) {
  const located: string[] = [];
  const dispatched: string[] = [];
  const tabs = new Map<number, { id: number; url: string; title: string; status: string }>();
  let nextTabId = 100;
  const chrome = {
    storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
    tabs: {
      async create({ url }: { url: string }) {
        const tab = { id: (nextTabId += 1), url, title: 'Example', status: 'complete' };
        tabs.set(tab.id, tab);
        return tab;
      },
      async update(id: number, { url }: { url?: string }) { const tab = tabs.get(id)!; if (url) tab.url = url; return tab; },
      async get(id: number) { const tab = tabs.get(id); if (!tab) throw new Error('no such tab'); return tab; },
      async remove(ids: number[]) { for (const id of ids) tabs.delete(id); },
      async query() { return [...tabs.values()]; },
      async group() { return 7; },
    },
    tabGroups: { async update() { return {}; }, async get() { return {}; } },
    scripting: {
      async executeScript(injection: { target: { frameIds?: number[]; allFrames?: boolean }; files?: string[] }) {
        if (injection.files) return [];
        if (injection.target.frameIds) {
          located.push(String(injection.target.frameIds[0]));
          return [{ frameId: injection.target.frameIds[0]!, result: { ok: true, point: { x: 10, y: 20 } } }];
        }
        return frames;
      },
    },
    debugger: {
      async attach() {}, async detach() {},
      async sendCommand(_target: unknown, method: string) { dispatched.push(method); return { data: 'iVBORw0KGgo=' }; },
    },
    runtime: { getManifest: () => ({ version: '0.1.0' }), onMessage: { addListener() {} }, async sendMessage() { return undefined; } },
  } as unknown as WorkerChrome;
  return { chrome, located, dispatched, tabs };
}

const command = (name: Command['name'], args: Record<string, unknown> = {}): Command => ({ id: 'c1', name, session: 's1', args });

async function opened(frames?: Array<{ frameId: number; result: FrameResult | null }>) {
  const fake = fakeChrome(frames);
  const commands = new BrowserCommands(fake.chrome, { uuid: () => 'fixed-uuid-value' });
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
    expect(dispatched).toEqual(['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
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
