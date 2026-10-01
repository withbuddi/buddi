/**
 * The banner slot: one strip at the top of the shell, only while something
 * matters.
 *
 * Not a permanent header. A restored buddi waiting on its checklist, a page
 * that lost buddi, a paused queue — each used to draw a banner of its own; now
 * they are candidates for this one strip, which shows the most important and
 * says how many more there are. Its one action sits on the right.
 */
import { api } from '../api';
import { BACKUP_ROUTE } from '../routes';
import { RECOVERY_BANNER } from '../views/Recovery';
import { Button, ButtonLink } from '../ui';

export interface Banner {
  id: string;
  /** Lower comes first: recovery 0, lost connection 1, a paused queue 2, anything else after. */
  priority: number;
  tone: 'warning' | 'critical';
  text: string;
  action?: { label: string; href?: string; onClick?: () => void };
}

export const BANNER_PRIORITY = { recovery: 0, lost: 1, paused: 2 } as const;

export const LOST_BANNER = 'Lost buddi. Retrying…';
export const PAUSED_BANNER = 'The queue is paused. Nothing is being claimed until you resume it.';

/** The shell's candidates, from what it already knows. */
export function shellBanners(state: { recovery: boolean; lost: boolean; paused: boolean }): Banner[] {
  const out: Banner[] = [];
  if (state.recovery) out.push({ id: 'recovery', priority: BANNER_PRIORITY.recovery, tone: 'warning', text: RECOVERY_BANNER, action: { label: 'Finish the checklist', href: BACKUP_ROUTE } });
  if (state.lost) out.push({ id: 'lost', priority: BANNER_PRIORITY.lost, tone: 'critical', text: LOST_BANNER });
  if (state.paused) out.push({ id: 'paused', priority: BANNER_PRIORITY.paused, tone: 'warning', text: PAUSED_BANNER, action: { label: 'Resume', onClick: () => { void api.setPaused(false).catch(() => {}); } } });
  return out;
}

export function BannerSlot({ banners, onNavigate }: { banners: Banner[]; onNavigate: (route: string) => void }): JSX.Element | null {
  if (banners.length === 0) return null;
  const ordered = [...banners].sort((a, b) => a.priority - b.priority);
  const top = ordered[0]!;
  const others = ordered.slice(1);
  const action = top.action;
  return (
    <div className="shell-banner" role="status" data-tone={top.tone} data-banner={top.id}>
      <span className="shell-banner-dot" aria-hidden="true" />
      <span className="shell-banner-text">{top.text}</span>
      {others.length > 0 ? (
        <span className="shell-banner-more" title={others.map((b) => b.text).join('\n')}>+{others.length} more</span>
      ) : null}
      {action?.href ? (
        <ButtonLink size="sm" href={action.href} onClick={(e) => { e.preventDefault(); onNavigate(action.href!); }}>{action.label}</ButtonLink>
      ) : action ? (
        <Button size="sm" onClick={action.onClick}>{action.label}</Button>
      ) : null}
    </div>
  );
}
