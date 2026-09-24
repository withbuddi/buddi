/**
 * Settings' own list: the sections in four groups, beside the rail.
 *
 * Laid out the way a Mac's System Settings is — a column of entries, each an
 * icon and a word, the open one tinted the way the rail tints its open place —
 * so a fifth plugin is one more row rather than a tab strip that runs off the
 * page. The last group is the plugins': "All plugins", then one entry per
 * settings page the installed plugins contribute, alphabetical, drawn from the
 * descriptors alone. Nothing here knows a plugin by name.
 *
 * Below the shell's narrow width the column would crowd the section out, so
 * it folds into one menu at the top of the section: the open one on its face,
 * the same groups inside.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useRef, type KeyboardEvent } from 'react';
import { pageIcon } from '../pages/icons';
import type { PluginPageDescriptor } from '../pages/types';
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, pluginSettingsRoute, pluginSettingsTab, settingsRoute, type SettingsGroup } from '../routes';
import { Icon, type IconName } from '../ui';

export interface SettingsEntry {
  /** What the hash names after `#/settings/`: a core id, or a plugin's `p.` tab id. */
  id: string;
  route: string;
  label: string;
  icon: IconName;
  group: SettingsGroup;
}

const SECTION_ICONS: Record<(typeof SETTINGS_SECTIONS)[number]['id'], IconName> = {
  you: 'person',
  appearance: 'sun',
  memory: 'notebook',
  proposals: 'bulb',
  accounts: 'key',
  computer: 'monitor',
  secrets: 'key',
  watchers: 'eye',
  backup: 'archive',
  system: 'chip',
  plugins: 'plug',
};

/**
 * Every entry, in list order: the core sections, then the plugins' settings
 * pages sorted by the title each descriptor gives, under Plugins.
 */
export function settingsEntries(pluginSettings: readonly PluginPageDescriptor[]): SettingsEntry[] {
  const core: SettingsEntry[] = SETTINGS_SECTIONS.map((section) => ({
    id: section.id,
    route: settingsRoute(section.id),
    label: section.label,
    icon: SECTION_ICONS[section.id],
    group: section.group,
  }));
  const plugins: SettingsEntry[] = [...pluginSettings]
    .sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
      || a.plugin.localeCompare(b.plugin)
      || a.id.localeCompare(b.id))
    .map((page) => ({
      id: pluginSettingsTab(page.plugin, page.id),
      route: pluginSettingsRoute(page.plugin, page.id),
      label: page.title,
      icon: pageIcon(page.icon),
      group: 'plugins',
    }));
  return [...core, ...plugins];
}

/** The entries under each group's label, in the groups' own order; an empty group is left out. */
export function groupEntries(entries: readonly SettingsEntry[]): Array<{ id: SettingsGroup; label: string; entries: SettingsEntry[] }> {
  return SETTINGS_GROUPS
    .map((group) => ({ id: group.id, label: group.label, entries: entries.filter((entry) => entry.group === group.id) }))
    .filter((group) => group.entries.length > 0);
}

interface NavProps {
  entries: readonly SettingsEntry[];
  /** The open entry's id. */
  active: string;
  /** A count beside an entry, by id, where that section already keeps one. */
  counts?: Readonly<Record<string, number>>;
  navigate: (route: string) => void;
}

function countLabel(label: string, count: number | undefined): string {
  return count ? `${label}, ${count} open` : label;
}

/**
 * The column. A nav landmark whose links are one stop on Tab — the open one —
 * with Up and Down (and Home, End) moving between them and Enter opening one.
 */
export function SettingsNav({ entries, active, counts = {}, navigate }: NavProps): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const groups = groupEntries(entries);
  const tabStop = entries.some((entry) => entry.id === active) ? active : entries[0]?.id;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const links = [...(ref.current?.querySelectorAll<HTMLAnchorElement>('a.settings-nav-link') ?? [])];
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (at === -1) return;
    const move = (to: number): void => {
      event.preventDefault();
      links[Math.max(0, Math.min(links.length - 1, to))]?.focus();
    };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(links.length - 1);
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const route = links[at]!.getAttribute('href');
      if (route) navigate(route);
    }
  };

  return (
    <nav className="settings-nav" aria-label="Settings sections" ref={ref} onKeyDown={onKeyDown}>
      {groups.map((group) => (
        <div key={group.id} className="settings-nav-group" role="group" aria-labelledby={`settings-nav-${group.id}`}>
          <div className="settings-nav-label" id={`settings-nav-${group.id}`}>{group.label}</div>
          {group.entries.map((entry) => {
            const on = entry.id === active;
            const count = counts[entry.id];
            return (
              <a
                key={entry.id}
                className="settings-nav-link"
                href={entry.route}
                data-active={on ? 'true' : undefined}
                aria-current={on ? 'page' : undefined}
                aria-label={count ? countLabel(entry.label, count) : undefined}
                tabIndex={entry.id === tabStop ? 0 : -1}
                onClick={(e) => { e.preventDefault(); navigate(entry.route); }}
              >
                <Icon name={entry.icon} className="settings-nav-icon" />
                <span className="settings-nav-text">{entry.label}</span>
                {count ? <span className="ui-badge settings-nav-count" aria-hidden="true">{count > 99 ? '99+' : count}</span> : null}
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/**
 * The same list as one menu, for a window too narrow for the column: the open
 * section on the button, every group inside it.
 */
export function SettingsMenu({ entries, active, counts = {}, navigate }: NavProps): JSX.Element {
  const groups = groupEntries(entries);
  const current = entries.find((entry) => entry.id === active) ?? entries[0];
  return (
    <nav className="settings-menu" aria-label="Settings sections">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="settings-menu-trigger" aria-label={`Settings section: ${current?.label ?? ''}`}>
            {current ? <Icon name={current.icon} className="settings-nav-icon" /> : null}
            <span className="settings-nav-text">{current?.label}</span>
            <Icon name="chevron-down" className="settings-menu-chevron" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="ui-menu settings-menu-list" align="start" sideOffset={6}>
            <DropdownMenu.RadioGroup value={active} onValueChange={(id) => {
              const entry = entries.find((e) => e.id === id);
              if (entry) navigate(entry.route);
            }}>
              {groups.map((group, index) => (
                <DropdownMenu.Group key={group.id}>
                  {index > 0 ? <DropdownMenu.Separator className="ui-menu-sep" /> : null}
                  <DropdownMenu.Label className="ui-menu-label">{group.label}</DropdownMenu.Label>
                  {group.entries.map((entry) => {
                    const count = counts[entry.id];
                    return (
                      <DropdownMenu.RadioItem
                        key={entry.id}
                        value={entry.id}
                        className="ui-menu-item settings-menu-item"
                        data-active={entry.id === active ? 'true' : undefined}
                        aria-label={count ? countLabel(entry.label, count) : undefined}
                      >
                        <span className="settings-menu-entry">
                          <Icon name={entry.icon} className="settings-nav-icon" />
                          <span className="settings-nav-text">{entry.label}</span>
                        </span>
                        {count ? <span className="ui-badge settings-nav-count" aria-hidden="true">{count > 99 ? '99+' : count}</span> : null}
                      </DropdownMenu.RadioItem>
                    );
                  })}
                </DropdownMenu.Group>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </nav>
  );
}
