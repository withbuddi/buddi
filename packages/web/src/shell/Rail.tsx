/**
 * The rail: the five places, and where you are.
 *
 * Home, Chat, Agents, Activity, Settings — each a drawn icon with its word
 * under it, so the rail is read rather than guessed. The current place is
 * filled and accented and marked on the rail's own edge. Home carries the one
 * badge in the rail: the count of things waiting on the owner, which is the
 * reason to go there.
 *
 * Icons are drawn, not typed: no emoji stands in for a place here.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { ACTIVITY_ROUTE, AGENTS_ROUTE, CHAT_ROUTE, FILES_ROUTE, HOME_ROUTE, PLACES, SETTINGS_ROUTE } from '../routes';
import { nextTheme, themeLabel, type ThemeChoice } from '../theme';

export function Rail({
  attention,
  place,
  onNavigate,
  theme,
  onTheme,
}: {
  /** Things waiting on the owner: approvals plus failed jobs. */
  attention: number;
  place: string;
  onNavigate: (route: string) => void;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
}): JSX.Element {
  return (
    <nav className="rail" aria-label="Places">
      <a className="rail-mark" href={HOME_ROUTE} onClick={(e) => { e.preventDefault(); onNavigate(HOME_ROUTE); }} aria-label="buddi home">
        b
      </a>

      {PLACES.map((entry) => (
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

      <div className="rail-spacer" />

      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button className="rail-link" aria-label={`Theme: ${themeLabel(theme)}`} onClick={() => onTheme(nextTheme(theme))}>
            <span className="rail-icon"><ThemeIcon choice={theme} /></span>
            <span className="rail-label">Theme</span>
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="ui-tip" side="right" sideOffset={8}>
            <span className="ui-tip-title">{themeLabel(theme)}</span>
            <span className="ui-tip-hint">Click to change</span>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </nav>
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

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const ICONS: Record<string, JSX.Element> = {
  // Files: two sheets, the front one with a folded corner — the shape a
  // person reads as documents at a glance.
  [FILES_ROUTE]: (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" {...stroke}>
      <path d="M7.5 2.8h5.2L16.5 6.6v8.6a1.2 1.2 0 0 1-1.2 1.2H7.5a1.2 1.2 0 0 1-1.2-1.2V4a1.2 1.2 0 0 1 1.2-1.2z" />
      <path d="M12.7 2.8v3.8h3.8" />
      <path d="M4.4 6.2v9.4a1.6 1.6 0 0 0 1.6 1.6h6.6" />
    </svg>
  ),
  [HOME_ROUTE]: (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" {...stroke}>
      <path d="M3.5 9.2 10 3.6l6.5 5.6" />
      <path d="M5.2 8.4v7.4a1 1 0 0 0 1 1h2.6v-4.6h2.4v4.6h2.6a1 1 0 0 0 1-1V8.4" />
    </svg>
  ),
  [CHAT_ROUTE]: (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" {...stroke}>
      <path d="M17 10.6a4.9 4.9 0 0 1-4.9 4.9H7.8L3.6 18l.9-3A4.9 4.9 0 0 1 3 11V8.2A4.9 4.9 0 0 1 7.9 3.3h4.2A4.9 4.9 0 0 1 17 8.2Z" />
      <path d="M7 8.3h6M7 11.3h3.6" />
    </svg>
  ),
  [AGENTS_ROUTE]: (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" {...stroke}>
      <circle cx="7.5" cy="7" r="2.8" />
      <path d="M2.8 16.2a4.7 4.7 0 0 1 9.4 0" />
      <circle cx="14" cy="7.8" r="2.2" />
      <path d="M13.2 12.5a3.9 3.9 0 0 1 4.3 3.7" />
    </svg>
  ),
  [ACTIVITY_ROUTE]: (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" {...stroke}>
      <path d="M2.8 10.5h3.4l2-5.2 3.4 9.8 2.2-4.6h3.4" />
    </svg>
  ),
  [SETTINGS_ROUTE]: (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" {...stroke}>
      <path d="M3 5.5h14M3 10h14M3 14.5h14" />
      <circle cx="7.5" cy="5.5" r="1.7" fill="var(--surface)" />
      <circle cx="12.5" cy="10" r="1.7" fill="var(--surface)" />
      <circle cx="6.5" cy="14.5" r="1.7" fill="var(--surface)" />
    </svg>
  ),
};

/** Sun, moon, or a screen: the three states, each drawn as itself. */
function ThemeIcon({ choice }: { choice: ThemeChoice }): JSX.Element {
  if (choice === 'light') {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" {...stroke}>
        <circle cx="10" cy="10" r="3.6" />
        <path d="M10 2.2v1.8M10 16v1.8M2.2 10H4M16 10h1.8M4.5 4.5l1.3 1.3M14.2 14.2l1.3 1.3M15.5 4.5l-1.3 1.3M5.8 14.2l-1.3 1.3" />
      </svg>
    );
  }
  if (choice === 'dark') {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" {...stroke}>
        <path d="M16.4 12A6.9 6.9 0 0 1 8 3.6a6.9 6.9 0 1 0 8.4 8.4Z" />
      </svg>
    );
  }
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" {...stroke}>
      <rect x="2.8" y="4" width="14.4" height="9.6" rx="1.6" />
      <path d="M7.4 16.8h5.2" />
    </svg>
  );
}
