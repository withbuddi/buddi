/**
 * The rail: everything that is no longer the point.
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
import { SECTIONS } from '../routes';
import { nextTheme, themeLabel, type ThemeChoice } from '../theme';

export function Rail({
  badges,
  onNavigate,
  theme,
  onTheme,
  onNewConversation,
}: {
  badges: { approvals: number; failed: number };
  onNavigate: (route: string) => void;
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

      <RailButton label="New conversation" onClick={onNewConversation}>
        <PlusIcon />
      </RailButton>

      <DropdownMenu.Root>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <DropdownMenu.Trigger asChild>
              <button className="wb-icon-btn" aria-label="Monitoring sections">
                <ListIcon />
                {attention > 0 ? <span className="wb-rail-dot" aria-hidden="true" /> : null}
              </button>
            </DropdownMenu.Trigger>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="wb-tip" side="right" sideOffset={6}>
              Monitoring
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="wb-menu" side="right" align="start" sideOffset={8}>
            <DropdownMenu.Label className="wb-menu-label">Monitoring</DropdownMenu.Label>
            {SECTIONS.map((section) => (
              <DropdownMenu.Item
                key={section.route}
                className="wb-menu-item"
                onSelect={() => onNavigate(section.route)}
              >
                <span>{section.label}</span>
                {section.route === '#/approvals' && badges.approvals > 0 ? (
                  <span className="tnum" style={{ color: 'var(--critical)' }}>
                    {badges.approvals}
                  </span>
                ) : null}
                {section.route === '#/jobs' && badges.failed > 0 ? (
                  <span className="tnum" style={{ color: 'var(--critical)' }}>
                    {badges.failed}
                  </span>
                ) : null}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <div className="flex-1" />

      <RailButton label={`${themeLabel(theme)} — click to change`} onClick={() => onTheme(nextTheme(theme))}>
        <ThemeIcon choice={theme} />
      </RailButton>
    </nav>
  );
}

function RailButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button className="wb-icon-btn" aria-label={label} onClick={onClick}>
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="wb-tip" side="right" sideOffset={6}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function PlusIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function ListIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
      <path d="M3 4.5h10M3 8h10M3 11.5h10" />
    </svg>
  );
}

/** Sun, moon, or a screen — the three states, each drawn as itself. */
function ThemeIcon({ choice }: { choice: ThemeChoice }): JSX.Element {
  if (choice === 'light') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.1 3.1l1.1 1.1M11.8 11.8l1.1 1.1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1" />
      </svg>
    );
  }
  if (choice === 'dark') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
        <path d="M13 9.6A5.6 5.6 0 0 1 6.4 3a5.6 5.6 0 1 0 6.6 6.6Z" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
      <rect x="2" y="3" width="12" height="8" rx="1.2" />
      <path d="M6 13.5h4" />
    </svg>
  );
}
