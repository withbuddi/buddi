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
import { renderablesFrom } from './renderables';
import type { Renderable } from './types';
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
  });

  it('gives no tab to an empty result or to a shape nothing can draw', () => {
    expect(tabsFor({})).toEqual([]);
    expect(tabsFor(null)).toEqual([]);
    expect(tabsFor({ items: [] })).toEqual([]);
  });

  it('gives a tab to rows, to a list, and to a set of figures', () => {
    expect(tabsFor({ items: [{ name: 'Rake', count: 2 }, { name: 'Hoe', count: 1 }] })).toHaveLength(1);
    expect(tabsFor({ varieties: ['Bramley', 'Russet', 'Discovery'] })).toHaveLength(1);
    expect(tabsFor({ celsius: 11, humidity: 62, readAt: '2026-09-14' })).toHaveLength(1);
  });

  it('never hides a failure, whatever its shape', () => {
    // The failure a tool reported by failing…
    const failed = tabsFor({ message: 'no location set' }, false);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ tone: 'critical', substantial: false });

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
  it('shows a pinned pair even when the room is one', () => {
    const items = [fake(0, { source: 'approval' }), fake(1), fake(2)];
    const { shown, hidden } = splitTabs(items, 'r2', 1);
    expect(shown.map((item) => item.id)).toEqual(['r0', 'r2']);
    expect(hidden.map((item) => item.id)).toEqual(['r1']);
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
