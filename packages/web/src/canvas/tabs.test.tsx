/**
 * The tab strip: what earns a tab, and what happens when there are more tabs
 * than the strip has room for.
 *
 * Every fixture here is an invented plugin, as everywhere else in this
 * package. The rule under test is about the *shape* of a result — an array of
 * rows, a sentence, a receipt — so the tests need no plugin installed and name
 * no tool this repository ships.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Canvas, splitTabs } from './Canvas';
import { inspectToolCall, renderablesFrom } from './renderables';
import type { Renderable, ViewDescriptor } from './types';
import type { ChatMessage } from '../chat/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function toolPair(id: string, name: string, output: unknown, ok = true): ChatMessage[] {
  return [
    { id: `m-${id}-a`, role: 'assistant', at: '2026-09-14T09:00:00Z', blocks: [{ type: 'tool_use', id, name, input: {} }] },
    {
      id: `m-${id}-b`,
      role: 'user',
      at: '2026-09-14T09:00:01Z',
      blocks: [{ type: 'tool_result', toolUseId: id, name, ok, output }],
    },
  ];
}

function tabsFor(output: unknown, ok = true): Renderable[] {
  return renderablesFrom({ messages: toolPair('t', 'shed.thing', output, ok), descriptors: [] });
}

describe('what earns a tab', () => {
  it('inspects quiet and old calls even when no automatic tab was kept', () => {
    const messages = toolPair('old', 'shed.status', 'ready');
    expect(renderablesFrom({ messages, descriptors: [] })).toEqual([]);
    expect(inspectToolCall(messages, 'old')).toMatchObject({ id: 'old', substantial: false, props: { value: { input: {}, output: 'ready' } } });
    expect(inspectToolCall(messages, 'missing')).toBeNull();
  });
  it('durable resolved approval state overrides stale stream hints', () => {
    const messages = toolPair('gate', 'shed.run', { reason: 'approval-required', actionId: 'a1' });
    const result = messages[1]!.blocks[0]!;
    if (result.type === 'tool_result') result.approval = { id: 'a1', state: 'succeeded' };
    const panels = renderablesFrom({ messages, descriptors: [], awaiting: new Map([['gate', 'a1']]) });
    expect(panels.some(p => p.source === 'approval')).toBe(false);
  });
  it('gives no tab to an answer that is entirely prose', () => {
    // One agent asking another: the whole content is the colleague's reply,
    // which the conversation has already printed, word for word.
    expect(
      tabsFor({
        agent: 'orchardist',
        handle: 'pom',
        name: 'The Orchardist',
        conversationId: 'c-7fa1',
        text: 'The north field will not ripen before the frost; pick the south rows first and leave the rest.',
      }),
    ).toEqual([]);

    expect(tabsFor('The north field will not ripen before the frost.')).toEqual([]);
  });

  it('gives no tab to the acknowledgement of a write', () => {
    expect(tabsFor({ ok: true, recorded: 1 })).toEqual([]);
    expect(tabsFor({ ok: true, id: 'note-19', key: 'winter-plan' })).toEqual([]);
    expect(tabsFor({ ok: true, remindAt: '2026-09-20T08:00:00Z' })).toEqual([]);
    expect(tabsFor({ ok: true, note: 'Recorded.' })).toEqual([]);
  });

  it('gives no tab to a record of a few pairs', () => {
    // The bookkeeping either side of a run: who the owner is, and that the
    // thread is done. Four pairs each — a sentence, which the chat has said.
    expect(tabsFor({ name: 'Ada', timezone: 'Europe/Paris', locale: 'fr-FR', onboarded: false })).toEqual([]);
    expect(tabsFor({ ok: true, stage: 'done', agent: 'keeper', at: '2026-09-14T09:00:00Z' })).toEqual([]);
  });

  it('gives no tab to an empty result or to a shape nothing can draw', () => {
    expect(tabsFor({})).toEqual([]);
    expect(tabsFor(null)).toEqual([]);
    expect(tabsFor({ items: [] })).toEqual([]);
  });

  it('gives a tab to rows, to a list, and to a set of figures', () => {
    expect(tabsFor({ items: [{ name: 'Rake', count: 2 }, { name: 'Hoe', count: 1 }] })).toHaveLength(1);
    expect(tabsFor({ varieties: ['Bramley', 'Russet', 'Discovery'] })).toHaveLength(1);
    // Eight readings: past the point where a panel beats a paragraph.
    expect(
      tabsFor({
        celsius: 11,
        humidity: 62,
        windKph: 18,
        gustKph: 31,
        pressureHpa: 1004,
        rainMm: 2.4,
        cloudPercent: 80,
        readAt: '2026-09-14',
      }),
    ).toHaveLength(1);
  });

  it('gives a tab to a table of any size, however plain its rows', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      day: `2026-09-${String(index + 1).padStart(2, '0')}`,
      picked: index * 4,
    }));
    const tabs = tabsFor({ picking: rows });
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ substantial: true, renderer: 'structured' });
  });

  it('gives a tab to a result the plugin declared a view for', () => {
    const descriptors: ViewDescriptor[] = [
      { tool: 'shed.thing', renderer: 'keyvalue', title: 'Shed', map: { pairs: [{ label: 'Ready', value: { path: 'ready' } }] } },
    ];
    const tabs = renderablesFrom({ messages: toolPair('t', 'shed.thing', { ready: true }), descriptors });
    expect(tabs).toMatchObject([{ source: 'descriptor', renderer: 'keyvalue', title: 'Shed', substantial: true }]);
  });

  it('gives a tab to a result that carries a file', () => {
    // Two pairs, which would otherwise be quiet — but one of them is a file
    // the canvas can draw as itself.
    const tabs = tabsFor({ ok: true, artifactId: 'a-19', mime: 'image/png', filename: 'braids.png' });
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ substantial: true });
  });

  it('never hides a failure, whatever its shape', () => {
    // A failure keeps the tab it has always had — a reason is only readable in
    // full there — and stays unsubstantial, so it never takes the screen.
    const failed = tabsFor({ message: 'no location set' }, false);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ tone: 'critical', substantial: false, renderer: 'structured' });

    // …and the one it reported while returning successfully.
    expect(tabsFor({ ok: false, error: 'the shed is locked' })).toHaveLength(1);
  });

  it('keeps the tab of a decision waiting on the owner', () => {
    const renderables = renderablesFrom({
      messages: toolPair('gate', 'shed.order', { ok: false, reason: 'approval-required', actionId: 'act-3' }, false),
      descriptors: [],
    });
    expect(renderables).toMatchObject([{ source: 'approval', renderer: 'envelope' }]);
  });

  it('drops the noise from a run that called six tools to answer one question', () => {
    const messages = [
      ...toolPair('a', 'shed.note', { ok: true, recorded: 1 }),
      ...toolPair('b', 'shed.ask', { handle: 'pom', text: 'Pick the south rows first, then the north.' }),
      ...toolPair('c', 'shed.inventory', { items: [{ name: 'Rake', count: 2 }] }),
      ...toolPair('d', 'shed.remind', { ok: true }),
    ];
    const renderables = renderablesFrom({ messages, descriptors: [] });
    expect(renderables.map((item) => item.tool)).toEqual(['shed.inventory']);
  });
});

/* ------------------------------------------------------------------ */

/**
 * Open the menu the way a keyboard does. jsdom has no real pointer, and Radix
 * opens on pointer-down; Enter on the focused trigger is the same door.
 */
function open(trigger: HTMLElement): void {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
}

function fake(index: number, over: Partial<Renderable> = {}): Renderable {
  return {
    id: `r${index}`,
    tool: `shed.thing${index}`,
    title: `Thing ${index}`,
    renderer: 'structured',
    props: { value: { a: 1, b: 2, c: 3 } },
    at: '2026-09-14T09:00:00Z',
    source: 'fallback',
    substantial: true,
    ...over,
  };
}

describe('the strip holds what fits and names the rest', () => {
  const many = Array.from({ length: 12 }, (_, index) => fake(index));

  it('shows the most recent few and puts the rest behind one control', () => {
    render(<Canvas renderables={many} activeId="r11" onActivate={() => {}} timezone="UTC" maxTabs={5} />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Thing 7',
      'Thing 8',
      'Thing 9',
      'Thing 10',
      'Thing 11',
    ]);
    expect(screen.getByRole('button', { name: /7 more views/ })).toBeDefined();
  });

  it('keeps the tab being read on the strip however old it is', () => {
    render(<Canvas renderables={many} activeId="r0" onActivate={() => {}} timezone="UTC" maxTabs={5} />);
    const titles = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(titles).toContain('Thing 0');
    expect(titles).toHaveLength(5);
  });

  it('keeps a decision on the strip even when the conversation moved on', () => {
    const withGate = [fake(0, { source: 'approval', title: 'Approval', tone: 'warning' }), ...many.slice(1)];
    render(<Canvas renderables={withGate} activeId="r11" onActivate={() => {}} timezone="UTC" maxTabs={4} />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Approval',
      'Thing 9',
      'Thing 10',
      'Thing 11',
    ]);
  });

  it('says a failure is back there before the menu is opened', () => {
    const withFailure = [fake(0, { tone: 'critical', substantial: false }), ...many.slice(1)];
    render(<Canvas renderables={withFailure} activeId="r11" onActivate={() => {}} timezone="UTC" maxTabs={5} />);
    const more = screen.getByRole('button', { name: /7 more views/ });
    expect(more.getAttribute('data-tone')).toBe('critical');
  });

  it('shows every tab when they all fit', () => {
    render(<Canvas renderables={many.slice(0, 4)} activeId="r3" onActivate={() => {}} timezone="UTC" maxTabs={5} />);
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /more views/ })).toBeNull();
  });
});

describe('the split itself', () => {
  it('dismisses result tabs by button or Delete, but does not hide approvals or live controls', () => {
    const onClose = vi.fn();
    render(<Canvas renderables={[
      fake(0),
      fake(1, { source: 'approval' }),
      // Live: the session is stopped with its own controls, not by closing a tab.
      fake(2, { source: 'browser', renderer: 'browser', pinned: true }),
      // Over: ordinary history, and history can be put away.
      fake(3, { source: 'browser', renderer: 'browser' }),
    ]}
      activeId="r0" onActivate={vi.fn()} onClose={onClose} timezone="UTC" maxTabs={5} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Thing 0 tab' }));
    expect(onClose).toHaveBeenCalledWith('r0');
    expect(screen.queryByRole('button', { name: 'Close Thing 1 tab' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close Thing 2 tab' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close Thing 3 tab' }));
    expect(onClose).toHaveBeenCalledWith('r3');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Thing 0' }), { key: 'Delete' });
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Thing 2' }), { key: 'Delete' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
  it('shows a pinned pair even when the room is one', () => {
    const items = [fake(0, { source: 'approval' }), fake(1), fake(2)];
    const { shown, hidden } = splitTabs(items, 'r2', 1);
    expect(shown.map((item) => item.id)).toEqual(['r0', 'r2']);
    expect(hidden.map((item) => item.id)).toEqual(['r1']);
  });

  /*
   * A screen an agent is driving right now holds the strip: the page marks it
   * pinned while the session lives and clears the mark when it ends, and a
   * long run cannot push it behind the menu in between.
   */
  it('holds a pinned panel on the strip, and lets go once it is history', () => {
    const live = [fake(0, { source: 'browser', pinned: true }), fake(1), fake(2), fake(3)];
    expect(splitTabs(live, 'r3', 2).shown.map((item) => item.id)).toEqual(['r0', 'r3']);
    const ended = live.map((item) => (item.id === 'r0' ? { ...item, pinned: false } : item));
    expect(splitTabs(ended, 'r3', 2).shown.map((item) => item.id)).toEqual(['r2', 'r3']);
  });

  it('keeps the strip in the order the conversation made things', () => {
    const items = [fake(0), fake(1), fake(2), fake(3)];
    expect(splitTabs(items, 'r0', 3).shown.map((item) => item.id)).toEqual(['r0', 'r2', 'r3']);
  });
});

/**
 * Opening a Radix menu leaves jsdom's document in a state every later query
 * pays for, so this goes last: it is the same assertion wherever it sits, and
 * here it costs the rest of the file nothing.
 */
describe('the overflow menu', () => {
  const many = Array.from({ length: 12 }, (_, index) => fake(index));

  it('names what is hidden, and goes there when it is chosen', () => {
    const onActivate = vi.fn();
    render(<Canvas renderables={many} activeId="r11" onActivate={onActivate} timezone="UTC" maxTabs={5} />);

    open(screen.getByRole('button', { name: /7 more views/ }));
    const menu = screen.getByRole('menu');
    // Newest first: the menu is reached for to go back.
    expect(within(menu).getAllByRole('menuitem')[0]?.textContent).toContain('Thing 6');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(7);

    fireEvent.click(within(menu).getByRole('menuitem', { name: /Thing 2/ }));
    expect(onActivate).toHaveBeenCalledWith('r2');
    // Radix hides the rest of the document while a menu is open; put that back
    // before the next test renders into it.
    fireEvent.keyDown(menu, { key: 'Escape' });
  });
});
