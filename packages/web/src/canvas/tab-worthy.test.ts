import { describe, expect, it } from 'vitest';
import { opensTab, rowOnlyTool } from './tab-worthy';
import { splitTabs } from './tab-order';
import type { Renderable } from './types';

describe('which results earn a tab', () => {
  it('opens one for a real view, and for the generic card only with content', () => {
    for (const renderer of ['table', 'tiles', 'story', 'document', 'diff', 'image', 'audio', 'preview', 'query', 'terminal'] as const) {
      expect(opensTab({ tool: 'shed.read', renderer, substantial: false })).toBe(true);
    }
    expect(opensTab({ tool: 'shed.read', renderer: 'structured', substantial: true })).toBe(true);
    expect(opensTab({ tool: 'shed.status', renderer: 'structured', substantial: false })).toBe(false);
  });

  it('keeps the platform’s doing-tools in their row, whatever they return', () => {
    for (const tool of ['secret.fill', 'secret.list', 'secrets.put', 'browser.act', 'browser.status', 'mission.report', 'owner.notify']) {
      expect(rowOnlyTool(tool)).toBe(true);
      expect(opensTab({ tool, renderer: 'table', substantial: true })).toBe(false);
    }
    expect(rowOnlyTool('owner.notify_later')).toBe(false);
    expect(rowOnlyTool('secretary.read')).toBe(false);
  });
});

describe('a new turn folds the last one away', () => {
  const tab = (id: string, at: string | null, extra: Partial<Renderable> = {}): Renderable => ({
    id, tool: 'shed.read', title: id, renderer: 'table', props: {}, at, source: 'descriptor', substantial: true, ...extra,
  });
  const turn = '2026-10-07T10:00:00.000Z';
  const items = [
    tab('old', '2026-10-07T09:00:00.000Z'),
    tab('kept', '2026-10-07T09:01:00.000Z'),
    tab('new', '2026-10-07T10:01:00.000Z'),
    tab('page', null, { source: 'browser', renderer: 'browser' as never, pinned: true }),
  ];

  it('keeps the Page, this turn’s tabs and what the owner opened; the rest go to the menu', () => {
    const { shown, hidden } = splitTabs(items, 'new', 3, { kept: Date.parse('2026-10-07T09:02:00.000Z') }, { turnStartedAt: turn });
    expect(shown.map((item) => item.id)).toEqual(['page', 'new', 'kept']);
    expect(hidden.map((item) => item.id)).toEqual(['old']);
  });

  it('folds nothing without a turn to measure against', () => {
    expect(splitTabs(items, 'new', 4).hidden).toEqual([]);
  });
});
