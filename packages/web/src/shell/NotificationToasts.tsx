/**
 * What buddi kept for the dashboard, said at the top right.
 *
 * A `now` message that arrives while the owner is here is `shown`: the page
 * draws it as a card here and tells buddi it was seen, which stops it going
 * to the channel ten minutes later. Three at most; the rest wait under
 * "and N more" and are marked seen only when they are drawn. Dismissing one
 * is the same as having seen it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type NotificationKind, type NotificationRow } from '../api';
import type { ChatAgent } from '../chat/types';
import { AgentAvatar } from '../ui';

/** How many cards are drawn before the rest fold into "and N more". */
export const TOASTS_DRAWN = 3;

/** A card's tone: what waits on the owner in the accent, news warm, a failure critical. */
export function toneOf(kind: NotificationKind): 'accent' | 'warm' | 'critical' | undefined {
  if (kind === 'approval' || kind === 'question') return 'accent';
  if (kind === 'watcher' || kind === 'reminder') return 'warm';
  if (kind === 'failure') return 'critical';
  return undefined;
}

/** A row the toast should draw: kept for the dashboard, and not seen yet. */
export function toastable(row: NotificationRow): boolean {
  return row.state === 'shown' && row.seenAt === null;
}

export interface ToastQueue {
  /** Newest first. */
  queue: NotificationRow[];
  refresh: () => void;
  dismiss: (id: string) => void;
}

export function useToastQueue(enabled: boolean): ToastQueue {
  const [queue, setQueue] = useState<NotificationRow[]>([]);
  const gone = useRef(new Set<string>());
  const marked = useRef(new Set<string>());

  const refresh = useCallback(() => {
    if (!enabled) return;
    api
      .notifications(20)
      .then(({ notifications }) => {
        const fresh = notifications.filter((row) => toastable(row) && !gone.current.has(row.id));
        setQueue((current) => {
          const known = new Set(current.map((row) => row.id));
          const added = fresh.filter((row) => !known.has(row.id));
          if (added.length === 0) return current;
          return [...current, ...added].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        });
      })
      .catch(() => { /* No server, or no session: nothing to say. */ });
  }, [enabled]);

  // Drawn is seen: tell buddi once per card, so it does not reach for the channel.
  useEffect(() => {
    for (const row of queue.slice(0, TOASTS_DRAWN)) {
      if (marked.current.has(row.id)) continue;
      marked.current.add(row.id);
      api.notificationSeen(row.id).catch(() => {});
    }
  }, [queue]);

  const dismiss = useCallback((id: string) => {
    gone.current.add(id);
    setQueue((current) => current.filter((row) => row.id !== id));
  }, []);

  return { queue, refresh, dismiss };
}

export function NotificationToasts({
  queue,
  agents,
  navigate,
  onDismiss,
}: {
  queue: readonly NotificationRow[];
  agents: readonly ChatAgent[];
  navigate: (route: string) => void;
  onDismiss: (id: string) => void;
}): JSX.Element | null {
  if (queue.length === 0) return null;
  const drawn = queue.slice(0, TOASTS_DRAWN);
  const more = queue.length - drawn.length;
  return (
    <section className="nt-toasts" aria-label="Notifications">
      {drawn.map((row) => (
        <div key={row.id} className="ui-toast nt-toast" data-tone={toneOf(row.kind)} role="status">
          {row.agentId ? <AgentAvatar agents={agents} id={row.agentId} size="sm" /> : null}
          <div className="nt-toast-main">
            <div className="ui-toast-title">{row.title}</div>
            {row.text ? <div className="ui-toast-body nt-toast-line">{firstLine(row.text)}</div> : null}
            {row.link ? (
              <a
                className="nt-toast-link"
                href={row.link}
                onClick={(e) => { e.preventDefault(); onDismiss(row.id); navigate(row.link!); }}
              >
                See
              </a>
            ) : null}
          </div>
          <button type="button" className="nt-toast-x" aria-label={`Dismiss ${row.title}`} onClick={() => onDismiss(row.id)}>
            ×
          </button>
        </div>
      ))}
      {more > 0 ? <p className="nt-toasts-more">and {more} more</p> : null}
    </section>
  );
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}
