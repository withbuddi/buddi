/**
 * One thing that needs the owner, drawn one way wherever it comes from.
 *
 * Home's "Needs you" holds approvals, held questions, requests, sign-ins,
 * agents to set up, the restore, the tip, the passphrase, the update and the
 * errors of watchers and sources. Every one of them is this card: the kit's
 * Card (white surface, hairline, never a tinted fill), a small tone mark on
 * the left, the ask as its title with the time on the right, who it is from,
 * an optional body, and the actions at the bottom right.
 *
 * The rules the card keeps for its callers:
 *  - The tone is the mark's only: accent for what asks (approvals, requests,
 *    offers), warning for what went wrong or waits (the restore, a failing
 *    watcher), critical only for a real failure.
 *  - At most one accent button, last on the right. Secondary actions are
 *    default or ghost buttons; Reject is danger.
 *  - The way out, when there is one, is a ghost "Not now" at the left of the
 *    actions, never a ×. A card whose only way out is deciding (an approval,
 *    a question) passes no `dismiss`.
 */
import { useId, type ReactNode } from 'react';
import { Button, Card, Icon } from '../../ui';
import type { IconName } from '../../ui/Icon';

export type NeedsTone = 'accent' | 'warning' | 'critical';

export interface NeedsDismiss {
  onClick: () => void;
  /** The button's words: "Not now" unless the kind has a second way out ("Not this again"). */
  label?: string;
  /** How long it stays away, for the tooltip: "Tell me at the next version". */
  hint?: string;
  disabled?: boolean;
}

export function NeedsCard({
  tone = 'accent',
  icon,
  title,
  href,
  onOpen,
  from,
  time,
  dismiss,
  extraDismiss,
  lead,
  actions,
  compact,
  kind,
  children,
}: {
  tone?: NeedsTone;
  /** The kit icon for the kind; a dot when none. */
  icon?: IconName;
  /** The ask, in one line. */
  title: ReactNode;
  /** When given, the title is a link there (a request, a question): opening it is reading it. */
  href?: string;
  onOpen?: () => void;
  /** Who it is from: an agent's face and name, a plugin's page title, or "buddi". */
  from?: ReactNode;
  /** When it came, on the right of the title. */
  time?: ReactNode;
  /** The way out that is not a decision, as a ghost "Not now" at the left of the actions. */
  dismiss?: NeedsDismiss;
  /** A second ghost way out beside it (the tip's "Not this again"). */
  extraDismiss?: NeedsDismiss;
  /** Controls at the left of the actions after the way out (the deck's counter and arrows). */
  lead?: ReactNode;
  /** The decisions, on the right: secondary first, the one accent button last. */
  actions?: ReactNode;
  /** Smaller padding, for a list of many. */
  compact?: boolean;
  /** What it is, for styles and tests: `approval`, `request`, `tip`… */
  kind?: string;
  children?: ReactNode;
}): JSX.Element {
  const id = useId();
  const titleId = `${id}-title`;
  const out = (d: NeedsDismiss, fallback: string): JSX.Element => (
    <Button variant="ghost" size={compact ? 'sm' : undefined} title={d.hint} disabled={d.disabled} onClick={d.onClick}>
      {d.label ?? fallback}
    </Button>
  );
  const hasFoot = Boolean(dismiss || extraDismiss || lead || actions);
  return (
    <Card as="article" labelledBy={titleId} {...(compact ? { density: 'compact' as const } : {})}>
      <div className="needs-card" data-tone={tone} data-compact={compact ? 'true' : undefined} data-kind={kind}>
        <span className="needs-card-mark" aria-hidden="true">
          {icon ? <Icon name={icon} size={compact ? 14 : 16} /> : <i className="needs-card-dot" />}
        </span>
        <div className="needs-card-main">
          <div className="needs-card-head">
            <h3 className="needs-card-title" id={titleId}>
              {href || onOpen ? (
                <a
                  href={href ?? '#'}
                  onClick={(event) => {
                    if (!onOpen) return;
                    event.preventDefault();
                    onOpen();
                  }}
                >
                  {title}
                </a>
              ) : (
                title
              )}
            </h3>
            {time ? <span className="needs-card-time">{time}</span> : null}
          </div>
          {from ? <div className="needs-card-from">{from}</div> : null}
          {children ? <div className="needs-card-body">{children}</div> : null}
          {hasFoot ? (
            <div className="needs-card-actions">
              {dismiss || extraDismiss || lead ? (
                <div className="needs-card-out">
                  {dismiss ? out(dismiss, 'Not now') : null}
                  {extraDismiss ? out(extraDismiss, 'Not this again') : null}
                  {lead}
                </div>
              ) : null}
              {/* Right-aligned on its own line too when a phone wraps it. */}
              {actions ? <div className="needs-card-do">{actions}</div> : null}
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/** The "from" line's words beside a face: kept to one line, truncated on a phone. */
export function NeedsFrom({ face, children }: { face?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <>
      {face}
      <span className="needs-card-from-text">{children}</span>
    </>
  );
}
