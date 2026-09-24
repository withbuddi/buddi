/**
 * The rail: the places, and where you are.
 *
 * Home, Chat, Agents, Activity, Files, then whatever the plugins add, and
 * Settings last — each a drawn icon with its word under it, so the rail is
 * read rather than guessed. The current place is filled and accented and
 * marked on the rail's own edge. Home carries the one badge in the rail: the
 * count of things waiting on the owner, which is the reason to go there.
 *
 * Under a hairline at the foot, the owner's initial: a small menu with the
 * quick theme switch, the way to Appearance, and Replay first run.
 *
 * Icons are drawn, not typed: no emoji stands in for a place here.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { api } from '../api';
import { ACTIVITY_ROUTE, AGENTS_ROUTE, CHAT_ROUTE, FILES_ROUTE, HOME_ROUTE, PLACES, SETTINGS_ROUTE, WELCOME_ROUTE, pluginPageRoute, settingsRoute } from '../routes';
import type { PluginPageDescriptor } from '../pages/types';
import { pageIcon } from '../pages/icons';
import type { ThemeChoice } from '../theme';
import { Icon, Mark, Segment, useAsync } from '../ui';

export function Rail({
  attention,
  place,
  onNavigate,
  theme,
  onTheme,
  plugins = [],
}: {
  /** Things waiting on the owner: approvals plus failed jobs. */
  attention: number;
  place: string;
  onNavigate: (route: string) => void;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  /**
   * The rail pages the installed plugins contribute, in their own order. They
   * come *after* the core places: a plugin adds beside them, never inside
   * them, and the rail knows nothing about any of them but the descriptor.
   */
  plugins?: PluginPageDescriptor[];
}): JSX.Element {
  return (
    <nav className="rail" aria-label="Places">
      <a className="rail-mark" href={HOME_ROUTE} onClick={(e) => { e.preventDefault(); onNavigate(HOME_ROUTE); }} aria-label="buddi home">
        <Mark />
      </a>

      {PLACES.filter((entry) => entry.route !== SETTINGS_ROUTE).map((entry) => (
        <RailLink
          key={entry.route}
          label={entry.label}
          href={entry.route}
          active={place === entry.route}
          badge={entry.route === HOME_ROUTE ? attention : 0}
          onClick={() => onNavigate(entry.route)}
        >
          {ICONS[entry.route]}
        </RailLink>
      ))}

      {plugins.map((page) => {
        const route = pluginPageRoute(page.plugin, page.id);
        return (
          <RailLink
            key={route}
            label={page.title}
            href={route}
            active={place === route}
            badge={0}
            onClick={() => onNavigate(route)}
          >
            <Icon name={pageIcon(page.icon)} />
          </RailLink>
        );
      })}

      <div className="rail-spacer" />

      <RailLink
        label="Settings"
        href={SETTINGS_ROUTE}
        active={place === SETTINGS_ROUTE}
        badge={0}
        onClick={() => onNavigate(SETTINGS_ROUTE)}
      >
        {ICONS[SETTINGS_ROUTE]}
      </RailLink>

      <OwnerMenu theme={theme} onTheme={onTheme} onNavigate={onNavigate} />
    </nav>
  );
}

const THEMES: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/**
 * The owner's own corner: who this is, and the switches worth having one
 * click away. Everything else about appearance is in Settings.
 */
function OwnerMenu({
  theme,
  onTheme,
  onNavigate,
}: {
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  onNavigate: (route: string) => void;
}): JSX.Element {
  const owner = useAsync(() => api.owner(), []);
  const name = owner.data?.preferredName?.trim() || null;
  const initial = (name ?? 'You').slice(0, 1).toUpperCase();
  return (
    <div className="rail-owner">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="rail-owner-btn" aria-label={name ? `You: ${name}` : 'You'}>
            <span className="rail-owner-face" aria-hidden="true">{initial}</span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="ui-menu rail-owner-menu" side="right" align="end" sideOffset={10}>
            <div className="rail-owner-head">
              <span className="rail-owner-face" data-size="lg" aria-hidden="true">{initial}</span>
              <span className="rail-owner-who">
                <span className="rail-owner-name">{name ?? 'You'}</span>
                <span className="rail-owner-sub">On this Mac</span>
              </span>
            </div>
            <DropdownMenu.Separator className="ui-menu-sep" />
            <DropdownMenu.Label className="ui-menu-label">Theme</DropdownMenu.Label>
            <div className="rail-owner-theme">
              <Segment label="Theme" options={THEMES} value={theme} onChange={onTheme} />
            </div>
            <DropdownMenu.Separator className="ui-menu-sep" />
            <DropdownMenu.Item className="ui-menu-item" onSelect={() => onNavigate(settingsRoute('appearance'))}>
              Change appearance
            </DropdownMenu.Item>
            <DropdownMenu.Item className="ui-menu-item" onSelect={() => onNavigate(WELCOME_ROUTE)}>
              Replay first run
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function RailLink({
  label,
  href,
  active,
  badge,
  onClick,
  children,
}: {
  label: string;
  href: string;
  active: boolean;
  badge: number;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <a
      className="rail-link"
      href={href}
      data-active={active ? 'true' : undefined}
      aria-current={active ? 'page' : undefined}
      aria-label={badge > 0 ? `${label}, ${badge} waiting` : label}
      onClick={(e) => { e.preventDefault(); onClick(); }}
    >
      <span className="rail-icon">
        {children}
        {badge > 0 ? <span className="rail-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span> : null}
      </span>
      <span className="rail-label">{label}</span>
    </a>
  );
}

const ICONS: Record<string, JSX.Element> = {
  [FILES_ROUTE]: <Icon name="files" />,
  [HOME_ROUTE]: <Icon name="home" />,
  [CHAT_ROUTE]: <Icon name="chat" />,
  [AGENTS_ROUTE]: <Icon name="agents" />,
  [ACTIVITY_ROUTE]: <Icon name="activity" />,
  [SETTINGS_ROUTE]: <Icon name="settings" />,
};
