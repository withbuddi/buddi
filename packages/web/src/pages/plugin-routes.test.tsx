/**
 * Where a plugin's screens live: the hashes, the rail and the settings tabs.
 *
 * The acceptance test of the whole engine is "a second plugin gets a rail
 * entry and a settings tab with no change to `packages/web`", so this suite
 * hands the shell a descriptor and looks for the entry — and for the rule that
 * a plugin adds *beside* the core places, never inside them.
 */
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  PLACES,
  SETTINGS_SECTIONS,
  parsePluginPageRoute,
  parsePluginSettingsRoute,
  placeOf,
  pluginPageRoute,
  pluginSettingsRoute,
  pluginSettingsTab,
} from '../routes';
import { orderPages } from './usePages';
import { Rail } from '../shell/Rail';
import type { PluginPageDescriptor } from './types';

const board: PluginPageDescriptor = { plugin: 'demo', id: 'board', title: 'Demo board', place: 'rail', icon: 'chart', order: 10, body: [] };
const later: PluginPageDescriptor = { plugin: 'other', id: 'things', title: 'Things', place: 'rail', body: [] };
const tab: PluginPageDescriptor = { plugin: 'demo', id: 'settings', title: 'Demo', place: 'settings', body: [] };

describe('the routes', () => {
  it('builds and reads a plugin place, with and without an item', () => {
    expect(pluginPageRoute('demo', 'board')).toBe('#/p/demo/board');
    expect(pluginPageRoute('demo', 'board', 'a1')).toBe('#/p/demo/board/a1');
    expect(parsePluginPageRoute('#/p/demo/board')).toEqual({ plugin: 'demo', page: 'board' });
    expect(parsePluginPageRoute('#/p/demo/board/a1')).toEqual({ plugin: 'demo', page: 'board', item: 'a1' });
    expect(parsePluginPageRoute('#/settings/demo')).toBeNull();
  });

  it('keeps an item that needs escaping intact', () => {
    const route = pluginPageRoute('demo', 'board', 'a/1 b');
    expect(parsePluginPageRoute(route)).toEqual({ plugin: 'demo', page: 'board', item: 'a/1 b' });
  });

  it('gives a plugin place its own place on the rail', () => {
    expect(placeOf('#/p/demo/board/a1')).toBe('#/p/demo/board');
    // And leaves every core place exactly where it was.
    for (const place of PLACES) expect(placeOf(place.route)).toBe(place.route);
  });

  it('prefixes every plugin settings tab, whether or not the plugin has several pages', () => {
    expect(pluginSettingsRoute('demo', 'settings')).toBe('#/settings/p.demo.settings');
    expect(pluginSettingsRoute('demo', 'demo')).toBe('#/settings/p.demo');
    expect(pluginSettingsTab('demo', 'demo')).toBe('p.demo');
    expect(parsePluginSettingsRoute('#/settings/p.demo.settings')).toEqual({ plugin: 'demo', page: 'settings' });
    expect(parsePluginSettingsRoute('#/settings/p.demo')).toEqual({ plugin: 'demo', page: 'demo' });
    // A core section is not a plugin tab, whatever it is called.
    expect(parsePluginSettingsRoute('#/settings/memory')).toBeNull();
  });

  it('cannot collide with a core section — not even a plugin named after one', () => {
    const core = new Set<string>(SETTINGS_SECTIONS.map((section) => section.id));
    for (const section of SETTINGS_SECTIONS) {
      // The property, for a plugin called exactly like each core section.
      expect(core.has(pluginSettingsTab(section.id, section.id))).toBe(false);
      expect(core.has(pluginSettingsTab(section.id, 'other'))).toBe(false);
      expect(parsePluginSettingsRoute(`#/settings/${section.id}`)).toBeNull();
    }
  });
});

describe('the order of the extra entries', () => {
  it('sorts by `order`, then by the order they were registered', () => {
    const pages = [later, board, { ...tab }];
    expect(orderPages(pages, 'rail').map((p) => p.id)).toEqual(['things', 'board']);
    expect(orderPages(pages, 'settings').map((p) => p.id)).toEqual(['settings']);
  });
});

describe('the rail', () => {
  it('draws a plugin entry after the core places, with the icon the descriptor asked for', () => {
    render(
      <Tooltip.Provider>
        <Rail attention={0} place="#/p/demo/board" onNavigate={vi.fn()} theme="system" onTheme={vi.fn()} plugins={[board]} />
      </Tooltip.Provider>,
    );
    const links = screen.getAllByRole('link').map((el) => el.getAttribute('href'));
    expect(links[links.length - 1]).toBe('#/p/demo/board');
    const entry = screen.getByRole('link', { name: 'Demo board' });
    expect(entry).toHaveAttribute('aria-current', 'page');
    expect(entry.querySelector('svg')).not.toBeNull();
  });

  it('is exactly the rail it always was when no plugin contributes one', () => {
    render(
      <Tooltip.Provider>
        <Rail attention={0} place="#/" onNavigate={vi.fn()} theme="system" onTheme={vi.fn()} />
      </Tooltip.Provider>,
    );
    expect(screen.getAllByRole('link')).toHaveLength(PLACES.length + 1); // the places, plus the mark
  });
});
