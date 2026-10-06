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
import { inspectToolCall, renderablesFrom, subjectTabId } from './renderables';
import { selfClosed, subjectOf, tabStamp, timelineOf, versionHolding } from './tab-order';
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

/** Made a minute apart, in order: r0 at 09:00, r1 at 09:01, … */
function fake(index: number, over: Partial<Renderable> = {}): Renderable {
  return {
    id: `r${index}`,
    tool: `shed.thing${index}`,
    title: `Thing ${index}`,
    renderer: 'structured',
    props: { value: { a: 1, b: 2, c: 3 } },
    at: new Date(Date.UTC(2026, 8, 14, 9, index)).toISOString(),
    source: 'fallback',
    substantial: true,
    ...over,
  };
}

/** A call and its result, with arguments, at a given minute. */
function call(id: string, name: string, input: unknown, output: unknown, minute: number, ok = true): ChatMessage[] {
  const at = new Date(Date.UTC(2026, 8, 14, 9, minute)).toISOString();
  return [
    { id: `m-${id}-a`, role: 'assistant', at, blocks: [{ type: 'tool_use', id, name, input }] },
    { id: `m-${id}-b`, role: 'user', at, blocks: [{ type: 'tool_result', toolUseId: id, name, ok, output, ...(ok ? {} : { error: output }) }] },
  ];
}

const ROWS = { rows: [{ name: 'Rake', count: 2 }, { name: 'Hoe', count: 1 }] };

describe('a tab is known by its tool and its subject', () => {
  it('reads the subject from a file name, an account, a page, a site, or an id', () => {
    expect(subjectOf({ file: '/imports/savings.csv' }, null)).toBe('savings.csv');
    expect(subjectOf({ account: { name: 'Joint' } }, null)).toBe('Joint');
    expect(subjectOf({ pageId: 'p-12' }, null)).toBe('p-12');
    expect(subjectOf({ url: 'https://www.example.com/a?b' }, null)).toBe('example.com');
    expect(subjectOf({}, { filename: 'notes.md' })).toBe('notes.md');
    expect(subjectOf({ stagingId: 'abcdef123456', conversationId: 'c' }, null)).toBe('abcdef12');
    expect(subjectOf({ query: 'apples' }, { total: 3 })).toBeNull();
  });

  it('updates the tab a repeat call on the same subject already has, keeping the earlier result inside it', () => {
    const messages = [
      ...call('a', 'shed.stage', { file: 'savings.csv' }, ROWS, 0),
      ...call('b', 'shed.stage', { file: 'current.csv' }, ROWS, 1),
      ...call('c', 'shed.stage', { file: 'savings.csv' }, { rows: [{ name: 'Rake', count: 3 }, { name: 'Hoe', count: 1 }] }, 2),
    ];
    const tabs = renderablesFrom({ messages, descriptors: [] });
    expect(tabs.map((tab) => tab.title)).toEqual(['Shed · Stage · current.csv', 'Shed · Stage · savings.csv']);
    const savings = tabs[1]!;
    // Known by the first call, showing the newest, holding both.
    expect(savings.id).toBe(subjectTabId('a'));
    expect(savings.versions?.map((version) => version.id)).toEqual(['a', 'c']);
    expect(tabStamp(savings)).toBe('c');
    expect((savings.props as { value: typeof ROWS }).value.rows[0]!.count).toBe(3);
    expect(versionHolding(tabs, 'a')?.id).toBe(savings.id);
    // A different tool on the same subject is a different tab.
    const other = renderablesFrom({ messages: [...messages, ...call('d', 'shed.commit', { file: 'savings.csv' }, ROWS, 3)], descriptors: [] });
    expect(other.map((tab) => tab.title)).toContain('Shed · Commit · savings.csv');
  });

  it('groups by the whole subject and shortens only the title', () => {
    const long = 'quarterly-statement-for-the-joint-account-2026-';
    const messages = [
      ...call('a', 'shed.stage', { file: '/a/statement.csv' }, ROWS, 0),
      ...call('b', 'shed.stage', { file: '/b/statement.csv' }, ROWS, 1),
      ...call('c', 'shed.stage', { file: `${long}01.csv` }, ROWS, 2),
      ...call('d', 'shed.stage', { file: `${long}02.csv` }, ROWS, 3),
    ];
    const tabs = renderablesFrom({ messages, descriptors: [] });
    expect(tabs).toHaveLength(4);
    expect(tabs.slice(0, 2).map((tab) => tab.title)).toEqual(['Shed · Stage · statement.csv', 'Shed · Stage · statement.csv']);
    expect(tabs.every((tab) => (tab.versions ?? []).length === 1)).toBe(true);
    expect(tabs[2]!.title).toBe(tabs[3]!.title);
    expect(tabs[2]!.title.endsWith('…')).toBe(true);
  });

  it('steps back to the earlier result inside the tab', () => {
    const messages = [
      ...call('a', 'shed.stage', { file: 'savings.csv' }, { rows: [{ name: 'First', count: 1 }, { name: 'Hoe', count: 1 }] }, 0),
      ...call('c', 'shed.stage', { file: 'savings.csv' }, { rows: [{ name: 'Second', count: 1 }, { name: 'Hoe', count: 1 }] }, 2),
    ];
    const tabs = renderablesFrom({ messages, descriptors: [] });
    render(<Canvas renderables={tabs} activeId={tabs[0]!.id} onActivate={() => {}} timezone="UTC" />);
    expect(screen.getByText(/Latest · 2 of 2/)).toBeDefined();
    expect(screen.getByText('Second')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier result' }));
    expect(screen.getByText(/Earlier · 1 of 2/)).toBeDefined();
    expect(screen.getByText('First')).toBeDefined();
  });

  it('opens on the version whose chat row was clicked', () => {
    const messages = [
      ...call('a', 'shed.stage', { file: 'savings.csv' }, { rows: [{ name: 'First', count: 1 }, { name: 'Hoe', count: 1 }] }, 0),
      ...call('c', 'shed.stage', { file: 'savings.csv' }, { rows: [{ name: 'Second', count: 1 }, { name: 'Hoe', count: 1 }] }, 2),
    ];
    const [tab] = renderablesFrom({ messages, descriptors: [] });
    render(<Canvas renderables={[{ ...tab!, focus: 'a' }]} activeId={tab!.id} onActivate={() => {}} timezone="UTC" />);
    expect(screen.getByText('First')).toBeDefined();
  });

  it('tells apart two tabs with no subject by their clock', () => {
    render(<Canvas renderables={[fake(0, { title: 'Artifacts · Write' }), fake(1, { title: 'Artifacts · Write' })]} activeId="r1" onActivate={() => {}} timezone="UTC" />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Artifacts · Write · 09:01', 'Artifacts · Write · 09:00']);
  });
});

describe('tabs that close themselves', () => {
  const now = Date.UTC(2026, 8, 14, 10, 0);

  it('closes a staged result past its expiry', () => {
    const fresh = renderablesFrom({ messages: call('s', 'shed.stage', { file: 'a.csv' }, { ...ROWS, expiresAt: '2026-09-14T11:00:00Z' }, 0), descriptors: [] });
    const stale = renderablesFrom({ messages: call('s', 'shed.stage', { file: 'a.csv' }, { ...ROWS, expiresAt: '2026-09-14T09:30:00Z' }, 0), descriptors: [] });
    expect(selfClosed(fresh[0]!, now)).toBeNull();
    expect(selfClosed(stale[0]!, now)).toBe('gone');
  });

  it('parks a failure that produced no view, but not a subject whose earlier result is still good', () => {
    const failed = renderablesFrom({ messages: call('f', 'shed.work', {}, 'Busy', 0, false), descriptors: [] });
    expect(selfClosed(failed[0]!, now)).toBe('parked');
    const retried = renderablesFrom({
      messages: [...call('a', 'shed.stage', { file: 'a.csv' }, ROWS, 0), ...call('b', 'shed.stage', { file: 'a.csv' }, 'Busy', 1, false)],
      descriptors: [],
    });
    expect(retried).toHaveLength(1);
    expect(retried[0]!.tone).toBe('critical');
    expect(selfClosed(retried[0]!, now)).toBeNull();
  });

  it('keeps a parked failure off the strip, in the timeline with its dot', () => {
    const items = [fake(0), fake(1), fake(2, { tone: 'critical', substantial: false, parked: true })];
    const { shown, hidden } = splitTabs(items, 'r1');
    expect(shown.map((item) => item.id)).toEqual(['r1', 'r0']);
    expect(hidden.map((item) => item.id)).toEqual(['r2']);
    render(<Canvas renderables={items} activeId="r1" onActivate={() => {}} timezone="UTC" />);
    expect(screen.getByRole('button', { name: /1 more view/ }).getAttribute('data-tone')).toBe('critical');
  });
});

describe('the strip holds three, most recent first', () => {
  const many = Array.from({ length: 12 }, (_, index) => fake(index));

  it('shows the three most recent, newest first, and puts the rest behind one control', () => {
    render(<Canvas renderables={many} activeId="r11" onActivate={() => {}} timezone="UTC" />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Thing 11', 'Thing 10', 'Thing 9']);
    expect(screen.getByRole('button', { name: /9 more views/ })).toBeDefined();
  });

  it('moves the oldest into the list when a fourth opens', () => {
    expect(splitTabs(many.slice(0, 3), 'r2').shown.map((item) => item.id)).toEqual(['r2', 'r1', 'r0']);
    const { shown, hidden } = splitTabs(many.slice(0, 4), 'r3');
    expect(shown.map((item) => item.id)).toEqual(['r3', 'r2', 'r1']);
    expect(hidden.map((item) => item.id)).toEqual(['r0']);
  });

  it('puts a tab the owner looked at first, whatever its age', () => {
    const touched = { r0: Date.UTC(2026, 8, 14, 12, 0) };
    expect(splitTabs(many.slice(0, 5), 'r0', 3, touched).shown.map((item) => item.id)).toEqual(['r0', 'r4', 'r3']);
  });

  it('never shows more than three, even with room for five', () => {
    render(<Canvas renderables={many} activeId="r11" onActivate={() => {}} timezone="UTC" maxTabs={5} />);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('keeps the tab being read on the strip however old it is', () => {
    render(<Canvas renderables={many} activeId="r0" onActivate={() => {}} timezone="UTC" />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Thing 11', 'Thing 10', 'Thing 0']);
  });

  it('keeps a decision on the strip even when the conversation moved on', () => {
    const withGate = [fake(0, { source: 'approval', title: 'Approval', tone: 'warning' }), ...many.slice(1)];
    render(<Canvas renderables={withGate} activeId="r11" onActivate={() => {}} timezone="UTC" />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Thing 11', 'Thing 10', 'Approval']);
  });

  it('says a failure is back there before the menu is opened', () => {
    const withFailure = [fake(0, { tone: 'critical', substantial: false }), ...many.slice(1)];
    render(<Canvas renderables={withFailure} activeId="r11" onActivate={() => {}} timezone="UTC" />);
    expect(screen.getByRole('button', { name: /9 more views/ }).getAttribute('data-tone')).toBe('critical');
  });

  it('shows every tab when they all fit', () => {
    render(<Canvas renderables={many.slice(0, 3)} activeId="r2" onActivate={() => {}} timezone="UTC" />);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /more views/ })).toBeNull();
  });
});

describe('the split itself', () => {
  it('dismisses result tabs by button or Delete, but does not hide approvals or live controls', () => {
    const onClose = vi.fn();
    const items = [
      fake(0),
      fake(1, { source: 'approval' }),
      // Live: the session is stopped with its own controls, not by closing a tab.
      fake(2, { source: 'browser', renderer: 'browser', pinned: true }),
    ];
    const { unmount } = render(<Canvas renderables={items} activeId="r0" onActivate={vi.fn()} onClose={onClose} timezone="UTC" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Thing 0 tab' }));
    expect(onClose).toHaveBeenCalledWith('r0');
    expect(screen.queryByRole('button', { name: 'Close Thing 1 tab' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close Thing 2 tab' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Thing 0' }), { key: 'Delete' });
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Thing 2' }), { key: 'Delete' });
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();
    // Over: ordinary history, and history can be put away.
    render(<Canvas renderables={[fake(3, { source: 'browser', renderer: 'browser' })]} activeId="r3" onActivate={vi.fn()} onClose={onClose} timezone="UTC" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Thing 3 tab' }));
    expect(onClose).toHaveBeenCalledWith('r3');
  });

  it('shows a pinned pair even when the room is one', () => {
    const items = [fake(0, { source: 'approval' }), fake(1), fake(2)];
    const { shown, hidden } = splitTabs(items, 'r2', 1);
    expect(shown.map((item) => item.id)).toEqual(['r2', 'r0']);
    expect(hidden.map((item) => item.id)).toEqual(['r1']);
  });

  /*
   * A screen an agent is driving right now holds the strip, first: the page
   * marks it pinned while the session lives and clears the mark when it ends.
   */
  it('holds a pinned panel on the strip, and lets go once it is history', () => {
    const live = [fake(0, { source: 'browser', pinned: true }), fake(1), fake(2), fake(3)];
    expect(splitTabs(live, 'r3', 2).shown.map((item) => item.id)).toEqual(['r0', 'r3']);
    const ended = live.map((item) => (item.id === 'r0' ? { ...item, pinned: false } : item));
    expect(splitTabs(ended, 'r3', 2).shown.map((item) => item.id)).toEqual(['r3', 'r2']);
  });
});

describe('the timeline', () => {
  const items = [fake(0), fake(10), fake(40), fake(55), fake(58)];
  const now = Date.UTC(2026, 8, 14, 9, 59);

  it('groups Now / Earlier this turn / Earlier, newest first', () => {
    const groups = timelineOf(items, { now, turnStartedAt: '2026-09-14T09:30:00Z' });
    expect(groups.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ['Now', ['r58']],
      ['Earlier this turn', ['r55', 'r40']],
      ['Earlier', ['r10', 'r0']],
    ]);
  });

  it('leaves out an empty group, and has no turn before the owner spoke', () => {
    expect(timelineOf(items.slice(0, 2), { now, turnStartedAt: '2026-09-14T09:30:00Z' }).map((group) => group.label)).toEqual(['Earlier']);
    expect(timelineOf(items, { now, turnStartedAt: null }).map((group) => group.label)).toEqual(['Now', 'Earlier']);
  });
});

/**
 * Opening a Radix menu leaves jsdom's document in a state every later query
 * pays for, so these go last: they are the same assertions wherever they sit,
 * and here they cost the rest of the file nothing.
 */
describe('the tab menu', () => {
  const many = Array.from({ length: 6 }, (_, index) => fake(index));

  it('names what is hidden as a timeline, and goes there when it is chosen', () => {
    const onActivate = vi.fn();
    render(<Canvas renderables={many} activeId="r5" onActivate={onActivate} timezone="UTC"
      turnStartedAt="2026-09-14T09:02:00Z" now={() => Date.UTC(2026, 8, 14, 9, 6)} />);

    open(screen.getByRole('button', { name: /3 more views/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('group').map((group) => group.textContent?.split('Thing')[0])).toEqual(['Earlier this turn', 'Earlier']);
    // Newest first: the menu is reached for to go back.
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Thing 209:02', 'Thing 109:01', 'Thing 009:00']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Thing 1/ }));
    expect(onActivate).toHaveBeenCalledWith('r1');
    fireEvent.keyDown(menu, { key: 'Escape' });
  });

  it('closes all, or all but the tab in front', () => {
    const onCloseMany = vi.fn();
    const items = [fake(0), fake(1, { source: 'approval' }), fake(2), fake(3)];
    render(<Canvas renderables={items} activeId="r3" onActivate={vi.fn()} onCloseMany={onCloseMany} timezone="UTC" />);
    open(screen.getByRole('button', { name: /1 more view/ }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Close others' }));
    expect(onCloseMany).toHaveBeenLastCalledWith(['r0', 'r2']);
    open(screen.getByRole('button', { name: /1 more view/ }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Close all' }));
    // A decision waiting is never closed in bulk.
    expect(onCloseMany).toHaveBeenLastCalledWith(['r0', 'r2', 'r3']);
  });
});
