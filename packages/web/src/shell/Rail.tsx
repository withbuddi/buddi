/**
 * The rail: the places, and where you are.
 *
 * Home, Chat, Agents, Activity, Files, then whatever the plugins add, and
 * Settings last — each a drawn icon with its word under it, so the rail is
 * read rather than guessed. The current place is filled and accented and
 * marked on the rail's own edge. Home carries the one badge in the rail: the
 * count of things waiting on the owner, which is the reason to go there.
 * Settings carries a dot, without a number, when a newer buddi is ready.
 *
 * Under a hairline at the foot, the owner's initial: a small menu with Focus
 * (Do not disturb or Urgent only, for a while; a moon on the initial while
 * one is on), the quick theme switch, the way to Appearance, Install the app
 * (while the browser offers an install and this is not the installed app),
 * and the running version. Running
 * as an installed app, which has no reload button of its own, it also has
 * Reload; after an upgrade, in any mode, that reads Reload to update, with the
 * accent and a dot on the initial.
 *
 * Icons are drawn, not typed: no emoji stands in for a place here.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useState, type ReactNode } from 'react';
import { api, type FocusDuration, type FocusMode, type FocusState } from '../api';
import { isStandalone } from '../build';
import { inBuddiApp } from '../views/parts/KeepClose';
import { ACTIVITY_ROUTE, AGENTS_ROUTE, CHAT_ROUTE, FILES_ROUTE, HOME_ROUTE, PLACES, SETTINGS_ROUTE, pluginPageRoute, settingsRoute } from '../routes';
import type { PluginPageDescriptor } from '../pages/types';
import { pageIcon } from '../pages/icons';
import type { ThemeChoice } from '../theme';
import { Icon, Mark, Segment, useAsync } from '../ui';
import { installApp, useInstallPrompt } from '../views/parts/KeepClose';
import { useLock } from './lock';
import { fmtClock } from '../format';

/** What the Settings dot says when a connection needs the owner (the rail's, and Connections' in the settings nav). */
export const CONNECTION_DOT = 'a connection needs you';

export function Rail({
  attention,
  place,
  onNavigate,
  theme,
  onTheme,
  plugins = [],
  updateAvailable = false,
  settingsDot,
  version,
  stale = false,
  reload,
  timezone,
  status,
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
  /** A newer buddi is ready to install: Settings gets a dot. */
  updateAvailable?: boolean;
  /** Something else in Settings needs the owner (a connection): the same dot, with this label. */
  settingsDot?: string | undefined;
  /** The running version, and the newer one when the daily check found it. */
  version?: RailVersion | undefined;
  /** The gateway serves a newer dashboard build than this page: offer the reload. */
  stale?: boolean;
  /** How the page reloads; the browser's own by default. */
  reload?: () => void;
  /** The owner's zone, for when a focus ends; the browser's when absent. */
  timezone?: string | undefined;
  /** On a phone, the footer status line folded into a dot, under Settings. */
  status?: ReactNode;
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
        dot={updateAvailable ? 'a newer buddi is ready' : settingsDot}
        onClick={() => onNavigate(SETTINGS_ROUTE)}
      >
        {ICONS[SETTINGS_ROUTE]}
      </RailLink>

      {status}

      <OwnerMenu theme={theme} onTheme={onTheme} onNavigate={onNavigate} version={version} stale={stale} reload={reload} timezone={timezone} />
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
export interface RailVersion { current: string; latest?: string | undefined; updateAvailable: boolean }

function OwnerMenu({
  theme,
  onTheme,
  onNavigate,
  version,
  stale,
  reload = () => window.location.reload(),
  timezone,
}: {
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  onNavigate: (route: string) => void;
  version?: RailVersion | undefined;
  stale: boolean;
  reload?: () => void;
  timezone?: string | undefined;
}): JSX.Element {
  const owner = useAsync(() => api.owner(), []);
  const lock = useLock();
  const focusView = useAsync(() => api.focus(), [], 60_000);
  const focus = focusView.data?.focus ?? null;
  const switchFocus = (mode: FocusMode, duration?: FocusDuration): void => {
    void api.setFocus(mode, duration).finally(() => focusView.reload());
  };
  const name = owner.data?.preferredName?.trim() || null;
  const initial = (name ?? 'You').slice(0, 1).toUpperCase();
  // An installed app has no reload button of its own, and neither does buddi.app's window.
  const [standalone] = useState(() => isStandalone() || inBuddiApp());
  const [hint] = useState(reloadHint);
  // The browser offered an install, and this is not already the app.
  const install = useInstallPrompt();
  const who = name ? `You: ${name}` : 'You';
  const focusWords = focus ? `${FOCUS_LABELS[focus.mode]} ${focusUntilLabel(focus, timezone)}` : null;
  const label = [who, focusWords, stale ? 'reload to update' : null].filter(Boolean).join(', ');
  return (
    <div className="rail-owner">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="rail-owner-btn" aria-label={label}>
            <span className="rail-owner-face" aria-hidden="true">{initial}</span>
            {stale ? <span className="ui-badge rail-dot" data-kind="dot" data-testid="owner-dot" aria-hidden="true" /> : null}
            {focus ? <span className="rail-focus" data-testid="owner-focus" aria-hidden="true"><Icon name="moon" size={10} /></span> : null}
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
            <FocusMenu focus={focus} timezone={timezone} onSwitch={switchFocus} />
            <DropdownMenu.Separator className="ui-menu-sep" />
            <DropdownMenu.Label className="ui-menu-label">Theme</DropdownMenu.Label>
            <div className="rail-owner-theme">
              <Segment label="Theme" options={THEMES} value={theme} onChange={onTheme} />
            </div>
            <DropdownMenu.Separator className="ui-menu-sep" />
            {/* With a PIN: Lock now, its shortcut on the right. Without one: where to set it up. */}
            {lock.pin ? (
              <DropdownMenu.Item className="ui-menu-item rail-owner-reload" onSelect={() => lock.lockNow()}>
                <span>Lock now</span>
                <kbd className="rail-owner-kbd">{lock.shortcut}</kbd>
              </DropdownMenu.Item>
            ) : (
              <DropdownMenu.Item className="ui-menu-item" onSelect={() => onNavigate(settingsRoute('lock'))}>
                Set up a lock screen…
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item className="ui-menu-item" onSelect={() => onNavigate(settingsRoute('appearance'))}>
              Change appearance
            </DropdownMenu.Item>
            {install ? (
              <DropdownMenu.Item className="ui-menu-item" onSelect={() => { void installApp(install); }}>
                Install the app
              </DropdownMenu.Item>
            ) : null}
            {standalone || stale ? (
              <DropdownMenu.Item className="ui-menu-item rail-owner-reload" data-update={stale ? 'true' : undefined} onSelect={() => reload()}>
                <span>{stale ? 'Reload to update' : 'Reload'}</span>
                {hint ? <kbd className="rail-owner-kbd">{hint}</kbd> : null}
              </DropdownMenu.Item>
            ) : null}
            {version ? (
              <>
                <DropdownMenu.Separator className="ui-menu-sep" />
                {/* The version, where an owner looks for it: under their own name. A
                    newer one is a line they can click; otherwise it is a quiet fact. */}
                <DropdownMenu.Item
                  className="ui-menu-item rail-owner-version"
                  data-update={version.updateAvailable ? 'true' : undefined}
                  onSelect={() => onNavigate(settingsRoute('system'))}
                >
                  <span className="mono">buddi {version.current}</span>
                  {version.updateAvailable && version.latest ? <span className="rail-owner-update">A newer buddi is ready: {version.latest}</span> : null}
                </DropdownMenu.Item>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

export const FOCUS_LABELS: Record<FocusMode, string> = {
  normal: 'Off',
  'urgent-only': 'Urgent only',
  'do-not-disturb': 'Do not disturb',
};

const FOCUS_DURATIONS: ReadonlyArray<{ value: FocusDuration; label: string }> = [
  { value: '1h', label: 'For 1 hour' },
  { value: '3h', label: 'For 3 hours' },
  { value: 'tomorrow', label: 'Until tomorrow morning' },
  { value: 'indefinite', label: 'Until I turn it off' },
];

/** "until 21:30" today, "until Tue 08:00" later, "until you turn it off". */
export function focusUntilLabel(focus: FocusState, timezone?: string, now: Date = new Date()): string {
  if (!focus.until) return 'until you turn it off';
  const end = new Date(focus.until);
  const zone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: zone, dateStyle: 'short' }).format(d);
  const time = fmtClock(end, zone);
  if (day(end) === day(now)) return `until ${time}`;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(end);
  return `until ${weekday} ${time}`;
}

/**
 * Focus, one level in: what is on and until when, then each mode with its
 * durations, and Turn off while one is on. What a mode lets through is in
 * Settings → Notifications; here it is one click.
 */
function FocusMenu({
  focus,
  timezone,
  onSwitch,
}: {
  focus: FocusState | null;
  timezone?: string | undefined;
  onSwitch: (mode: FocusMode, duration?: FocusDuration) => void;
}): JSX.Element {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="ui-menu-item rail-owner-focus">
        <span>Focus</span>
        <span className="rail-owner-kbd">{focus ? FOCUS_LABELS[focus.mode] : 'Off'}</span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent className="ui-menu rail-owner-menu" sideOffset={6}>
          <p className="ui-menu-empty" role="status">
            {focus ? `${FOCUS_LABELS[focus.mode]} ${focusUntilLabel(focus, timezone)}${focus.by === 'schedule' ? ', from a schedule' : ''}.` : 'No focus is on.'}
          </p>
          {(['do-not-disturb', 'urgent-only'] as const).map((mode) => (
            <DropdownMenu.Group key={mode}>
              <DropdownMenu.Separator className="ui-menu-sep" />
              <DropdownMenu.Label className="ui-menu-label">{FOCUS_LABELS[mode]}</DropdownMenu.Label>
              {FOCUS_DURATIONS.map((d) => (
                <DropdownMenu.Item
                  key={d.value}
                  className="ui-menu-item"
                  aria-label={`${FOCUS_LABELS[mode]} ${d.label.toLowerCase()}`}
                  onSelect={() => onSwitch(mode, d.value)}
                >
                  {d.label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Group>
          ))}
          {focus ? (
            <>
              <DropdownMenu.Separator className="ui-menu-sep" />
              <DropdownMenu.Item className="ui-menu-item" onSelect={() => onSwitch('normal')}>Turn off</DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

/** The reload shortcut on a desktop keyboard; none on a phone or tablet. */
function reloadHint(): string | null {
  const agent = window.navigator.userAgent;
  if (/iPhone|iPad|Android|Mobile/.test(agent)) return null;
  return /Mac/.test(agent) ? '⌘R' : 'Ctrl+R';
}

function RailLink({
  label,
  href,
  active,
  badge,
  dot,
  onClick,
  children,
}: {
  label: string;
  href: string;
  active: boolean;
  badge: number;
  /** A mark without a count, and what it means, for the accessible name. */
  dot?: string;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <a
      className="rail-link"
      href={href}
      data-active={active ? 'true' : undefined}
      aria-current={active ? 'page' : undefined}
      aria-label={badge > 0 ? `${label}, ${badge} waiting` : dot ? `${label}, ${dot}` : label}
      onClick={(e) => { e.preventDefault(); onClick(); }}
    >
      <span className="rail-icon">
        {children}
        {badge > 0 ? <span className="rail-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span> : null}
        {badge === 0 && dot ? <span className="ui-badge rail-dot" data-kind="dot" data-testid="rail-dot" aria-hidden="true" /> : null}
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
