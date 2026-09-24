/**
 * Settings' grouped list: the four groups in order, the plugins' pages joining
 * the last one from their descriptors alone, every old hash still opening its
 * section, the keyboard, and the menu the list folds into on a narrow window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api } from '../api';
import type { PluginPageDescriptor } from '../pages/types';
import type { PluginPages } from '../pages/usePages';
import { Settings } from './Settings';
import { SettingsMenu, SettingsNav, settingsEntries } from './SettingsNav';

// Every section reads from the gateway; here each read simply never answers,
// so what is under test is the list and which section it opened.
vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  const pending = new Proxy({ proposals: vi.fn(() => new Promise(() => {})) } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : () => new Promise(() => {})),
  });
  return { ...real, api: pending };
});

const page = (plugin: string, id: string, title: string, icon?: PluginPageDescriptor['icon']): PluginPageDescriptor => ({
  plugin, id, title, place: 'settings', body: [], ...(icon ? { icon } : {}),
});

const DESCRIPTORS = [
  page('zeta', 'settings', 'Zulu'),
  page('alpha', 'alpha', 'Alpha', 'mail'),
  page('mid', 'prefs', 'mike', 'key'),
];

function pages(settings: PluginPageDescriptor[] = DESCRIPTORS): PluginPages {
  return {
    all: settings,
    rail: [],
    settings,
    find: (plugin, id) => settings.find((p) => p.plugin === plugin && p.id === id),
  };
}

function renderSettings(hash: string, navigate = vi.fn(), settings?: PluginPageDescriptor[]) {
  return render(
    <Settings hash={hash} timezone="UTC" navigate={navigate} agents={[]} attention={{} as never} pluginPages={pages(settings)} />,
  );
}

const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'Settings sections' });

function narrowWindow(narrow: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query === '(max-width: 900px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => narrowWindow(false));
afterEach(() => vi.clearAllMocks());

describe('the settings list', () => {
  it('is a nav landmark of four groups, each under its kicker, in the owner’s order', () => {
    renderSettings('#/settings/you');
    const groups = within(nav()).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-labelledby') && document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent))
      .toEqual(['You', 'Models and access', 'Running', 'Plugins']);
    const names = (group: HTMLElement): string[] => within(group).getAllByRole('link').map((a) => a.textContent ?? '');
    expect(names(groups[0]!)).toEqual(['Profile', 'Appearance', 'Memory', 'Proposals']);
    expect(names(groups[1]!)).toEqual(['Model accounts', 'Computer & browser', 'Keys and secrets']);
    expect(names(groups[2]!)).toEqual(['Watchers', 'Backup', 'System']);
    expect(names(groups[3]!)[0]).toBe('All plugins');
    // No tab strip is left.
    expect(screen.queryByRole('tab')).toBeNull();
    expect(document.querySelector('.ui-tabs')).toBeNull();
  });

  it('draws every entry with an icon, and says Profile while the hash still says you', () => {
    renderSettings('#/settings/you');
    const profile = within(nav()).getByRole('link', { name: 'Profile' });
    expect(profile).toHaveAttribute('href', '#/settings/you');
    for (const link of within(nav()).getAllByRole('link')) expect(link.querySelector('svg[data-icon]')).not.toBeNull();
  });

  it('adds one entry per plugin settings page from the descriptors, alphabetical, after All plugins', () => {
    renderSettings('#/settings/you');
    const plugins = within(nav()).getAllByRole('group')[3]!;
    const links = within(plugins).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['All plugins', 'Alpha', 'mike', 'Zulu']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '#/settings/plugins',
      '#/settings/p.alpha',
      '#/settings/p.mid.prefs',
      '#/settings/p.zeta.settings',
    ]);
    // The descriptor's own icon, and the plug for one that names none.
    expect(links.map((a) => a.querySelector('svg')?.getAttribute('data-icon'))).toEqual(['plug', 'mail', 'key', 'plug']);
  });

  it('lists no plugin entries on an installation with none', () => {
    renderSettings('#/settings/you', vi.fn(), []);
    const plugins = within(nav()).getAllByRole('group')[3]!;
    expect(within(plugins).getAllByRole('link').map((a) => a.textContent)).toEqual(['All plugins']);
  });

  it('opens the section every existing hash names, marked as the current entry', () => {
    const cases: Array<[string, string]> = [
      ['#/settings', 'Profile'],
      ['#/settings/you', 'Profile'],
      ['#/settings/appearance', 'Appearance'],
      ['#/settings/proposals?plugin=alpha', 'Proposals'],
      ['#/settings/accounts', 'Model accounts'],
      ['#/settings/computer', 'Computer & browser'],
      ['#/settings/watchers', 'Watchers'],
      ['#/settings/backup', 'Backup'],
      ['#/settings/system', 'System'],
      ['#/settings/plugins', 'All plugins'],
      ['#/settings/p.alpha', 'Alpha'],
      ['#/settings/p.mid.prefs', 'mike'],
    ];
    for (const [hash, label] of cases) {
      const { unmount } = renderSettings(hash);
      const current = within(nav()).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
      expect(current.map((a) => a.textContent), hash).toEqual([label]);
      unmount();
    }
  });

  it('draws the section beside the list: Appearance on its hash, a plugin page on its own', () => {
    const { unmount } = renderSettings('#/settings/appearance');
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    unmount();
    renderSettings('#/settings/p.mid.prefs');
    expect(screen.queryByRole('heading', { name: 'Appearance' })).toBeNull();
  });

  it('goes where an entry points when it is clicked', () => {
    const navigate = vi.fn();
    renderSettings('#/settings/you', navigate);
    fireEvent.click(within(nav()).getByRole('link', { name: 'Zulu' }));
    expect(navigate).toHaveBeenCalledWith('#/settings/p.zeta.settings');
  });

  it('counts the open proposals beside Proposals', async () => {
    vi.mocked(api.proposals).mockResolvedValueOnce({ open: [{}, {}, {}], closed: [] } as never);
    renderSettings('#/settings/you');
    const link = await within(nav()).findByRole('link', { name: 'Proposals, 3 open' });
    expect(link).toHaveTextContent('3');
    expect(within(nav()).getByRole('link', { name: 'Memory' }).querySelector('.ui-badge')).toBeNull();
  });
});

describe('the list from the keyboard', () => {
  it('is one Tab stop, the open entry; Up and Down move, Home and End jump, Enter opens', () => {
    const navigate = vi.fn();
    const entries = settingsEntries(DESCRIPTORS);
    render(<SettingsNav entries={entries} active="memory" navigate={navigate} />);
    const links = screen.getAllByRole('link');
    expect(links.filter((a) => a.tabIndex === 0).map((a) => a.textContent)).toEqual(['Memory']);

    const memory = screen.getByRole('link', { name: 'Memory' });
    memory.focus();
    fireEvent.keyDown(memory, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveTextContent('Proposals');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveTextContent('Model accounts');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toHaveTextContent('Memory');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toHaveTextContent('Zulu');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveTextContent('Zulu');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toHaveTextContent('Profile');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('#/settings/appearance');
  });
});

describe('on a narrow window', () => {
  beforeEach(() => narrowWindow(true));

  it('folds the list into one menu at the top of the section, showing the open one', () => {
    renderSettings('#/settings/watchers');
    expect(screen.queryByRole('link', { name: 'Profile' })).toBeNull();
    const menu = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(menu).getByRole('button', { name: 'Settings section: Watchers' })).toBeInTheDocument();
  });

  it('holds the same groups as options, the open one checked, and goes where one is chosen', async () => {
    const navigate = vi.fn();
    render(<SettingsMenu entries={settingsEntries(DESCRIPTORS)} active="p.alpha" navigate={navigate} />);
    const trigger = screen.getByRole('button', { name: 'Settings section: Alpha' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    // By selector rather than by role: the open menu is large enough that a
    // role query over it is slow in jsdom, and what is checked is the same.
    const list = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="menu"]');
      expect(found).not.toBeNull();
      return found!;
    });
    const labels = [...list.querySelectorAll('.ui-menu-label')].map((l) => l.textContent);
    expect(labels).toEqual(['You', 'Models and access', 'Running', 'Plugins']);
    const options = [...list.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(options.map((o) => o.textContent)).toEqual([
      'Profile', 'Appearance', 'Memory', 'Proposals',
      'Model accounts', 'Computer & browser', 'Keys and secrets',
      'Watchers', 'Backup', 'System',
      'All plugins', 'Alpha', 'mike', 'Zulu',
    ]);
    const option = (label: string): HTMLElement => options.find((o) => o.textContent === label)!;
    expect(option('Alpha')).toHaveAttribute('aria-checked', 'true');
    expect(option('Backup')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(option('Backup'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('#/settings/backup'));
    // Radix registers each of the fourteen items as the menu opens, which jsdom
    // takes its time over (the canvas's overflow menu is slow the same way).
  }, 20_000);
});
