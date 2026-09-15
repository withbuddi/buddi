/**
 * The rail: where you are, and everything that is no longer the point.
 *
 * Four marks, top to bottom: the workbench itself, a new conversation, the
 * monitoring pages, and the theme. Each is a drawn icon with a tooltip and —
 * for the two that are places rather than actions — a filled, accented state
 * when you are standing in it, so the rail answers "where am I" without being
 * read.
 *
 * The nine monitoring pages still exist and still work; they have simply
 * stopped being what the dashboard opens on. They live one click away behind a
 * menu, with the two counts that would make you want them — approvals waiting,
 * jobs failed — shown as a dot on the rail so "one click away" never means
 * "out of sight".
 *
 * Icons are drawn, not typed: no emoji stands in for a section here.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { CHAT_ROUTE, SECTIONS } from '../routes';
import { nextTheme, themeLabel, type ThemeChoice } from '../theme';

export function Rail({
  badges,
  onNavigate,
  onChat,
  theme,
  onTheme,
  onNewConversation,
}: {
  badges: { approvals: number; failed: number };
  onNavigate: (route: string) => void;
  /** True when the workbench, rather than a monitoring page, is on screen. */
  onChat?: boolean;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  onNewConversation: () => void;
}): JSX.Element {
  const attention = badges.approvals + badges.failed;

  return (
    <nav className="wb-rail" aria-label="Sections">
      <span className="wb-rail-mark" aria-hidden="true">
        b
      </span>

      <RailButton
        label="Workbench"
        hint="The conversation and its canvas"
        active={onChat === true}
        onClick={() => onNavigate(CHAT_ROUTE)}
      >
        <ChatIcon />
      </RailButton>

      <RailButton label="New conversation" hint="Start again with a clear canvas" onClick={onNewConversation}>
        <PlusIcon />
      </RailButton>

      <DropdownMenu.Root>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <DropdownMenu.Trigger asChild>
              <button
                className="wb-icon-btn"
                data-active={onChat === false ? 'true' : undefined}
                aria-label="Monitoring sections"
              >
                <GaugeIcon />
                {attention > 0 ? <span className="wb-rail-dot" aria-hidden="true" /> : null}
              </button>
            </DropdownMenu.Trigger>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="wb-tip" side="right" sideOffset={8}>
              <span className="wb-tip-title">Monitoring</span>
              <span className="wb-tip-hint">
                {attention > 0 ? `${attention} thing${attention === 1 ? '' : 's'} want you` : 'Nine pages of instrumentation'}
              </span>
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="wb-menu" side="right" align="start" sideOffset={10}>
            <DropdownMenu.Label className="wb-menu-label">Monitoring</DropdownMenu.Label>
            {SECTIONS.map((section) => (
              <DropdownMenu.Item
                key={section.route}
                className="wb-menu-item"
                onSelect={() => onNavigate(section.route)}
              >
                <span>{section.label}</span>
                {section.route === '#/approvals' && badges.approvals > 0 ? (
                  <span className="wb-count" data-tone="critical">
                    {badges.approvals}
                  </span>
                ) : null}
                {section.route === '#/jobs' && badges.failed > 0 ? (
                  <span className="wb-count" data-tone="critical">
                    {badges.failed}
                  </span>
                ) : null}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <div className="flex-1" />

      <RailButton
        label={`Theme: ${themeLabel(theme)}`}
        hint="Click to change"
        onClick={() => onTheme(nextTheme(theme))}
      >
        <ThemeIcon choice={theme} />
      </RailButton>
    </nav>
  );
}

function RailButton({
  label,
  hint,
  active,
  onClick,
  children,
}: {
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          className="wb-icon-btn"
          data-active={active ? 'true' : undefined}
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          onClick={onClick}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="wb-tip" side="right" sideOffset={8}>
          <span className="wb-tip-title">{label}</span>
          {hint ? <span className="wb-tip-hint">{hint}</span> : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** A conversation: a speech bubble with something said in it. */
function ChatIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" {...stroke}>
      <path d="M15.5 9.8a4.7 4.7 0 0 1-4.7 4.7H6.9L3 16.4l.9-2.7A4.7 4.7 0 0 1 2.5 10V7.2A4.7 4.7 0 0 1 7.2 2.5h3.6a4.7 4.7 0 0 1 4.7 4.7Z" />
      <path d="M6 7.5h6M6 10.4h3.6" />
    </svg>
  );
}

function PlusIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" {...stroke}>
      <path d="M9 3.6v10.8M3.6 9h10.8" />
    </svg>
  );
}

/** Instrumentation: a dial with a needle. */
function GaugeIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" {...stroke}>
      <path d="M2.6 12.6a7 7 0 1 1 12.8 0" />
      <path d="M9 12.2 12 7.4" />
      <circle cx="9" cy="12.6" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Sun, moon, or a screen — the three states, each drawn as itself. */
function ThemeIcon({ choice }: { choice: ThemeChoice }): JSX.Element {
  if (choice === 'light') {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" {...stroke}>
        <circle cx="9" cy="9" r="3.4" />
        <path d="M9 1.3v1.7M9 15v1.7M1.3 9H3M15 9h1.7M3.5 3.5l1.2 1.2M13.3 13.3l1.2 1.2M14.5 3.5l-1.2 1.2M4.7 13.3l-1.2 1.2" />
      </svg>
    );
  }
  if (choice === 'dark') {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" {...stroke}>
        <path d="M14.8 10.8A6.3 6.3 0 0 1 7.2 3.2a6.3 6.3 0 1 0 7.6 7.6Z" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" {...stroke}>
      <rect x="2.4" y="3.4" width="13.2" height="9" rx="1.4" />
      <path d="M6.6 15.2h4.8" />
    </svg>
  );
}
