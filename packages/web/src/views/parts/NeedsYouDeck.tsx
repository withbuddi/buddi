/**
 * "Needs you" as a deck: one message in front, read in full, and moved
 * through with Done. Behind it, two offset cards say there are more.
 *
 * Open goes where the list's row went, and Done does exactly what a click on
 * the row did (marks it seen here and on the server), then the next card is
 * in front. With focus anywhere in the deck, the arrows move, Enter opens,
 * and `d` or Delete marks done.
 */
import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { NotificationRow } from '../../api';
import type { ChatAgent } from '../../chat/types';
import { fmtRelative, notificationTitle } from '../../format';
import { AgentAvatar, Button, Empty, Icon } from '../../ui';
import { NeedsCard, NeedsFrom } from './NeedsCard';

export type NeedsYouView = 'deck' | 'list';

/** Where the owner's choice of deck or list is remembered, in this browser only. */
export const NEEDS_YOU_VIEW_KEY = 'buddi.needsYouView';

export function readNeedsYouView(): NeedsYouView {
  try {
    return window.localStorage.getItem(NEEDS_YOU_VIEW_KEY) === 'list' ? 'list' : 'deck';
  } catch {
    return 'deck';
  }
}

export function writeNeedsYouView(view: NeedsYouView): void {
  try {
    window.localStorage.setItem(NEEDS_YOU_VIEW_KEY, view);
  } catch {
    /* A browser that keeps nothing still shows the view; it just forgets it. */
  }
}

/**
 * Who a row is from, with the other agents it was folded across:
 * "Finance Advisor · also Mail Triage". Names, not ids — `nameOf` resolves
 * them the way the row's own agent is — and the list and the deck both say it.
 */
export function fromWithAlso(from: string, row: NotificationRow, nameOf: (id: string) => string): string {
  const also = (row.alsoFrom ?? []).filter((id) => id !== row.agentId).map(nameOf);
  return also.length === 0 ? from : `${from} · also ${also.join(', ')}`;
}

export function NeedsYouDeck({
  rows,
  agents,
  label,
  onOpen,
  onDone,
}: {
  /** The rows still to see, in order; a row leaves once it is done. */
  rows: readonly NotificationRow[];
  agents: readonly ChatAgent[];
  /** Who or what a row is from, as the list's second line says it. */
  label: (row: NotificationRow) => string;
  onOpen: (row: NotificationRow) => void;
  onDone: (row: NotificationRow) => void;
}): JSX.Element {
  const [index, setIndex] = useState(0);
  if (rows.length === 0) return <Empty mascot>Nothing needs you. Your agents are on it.</Empty>;

  // A done row leaves the list, so the same index is already the next one;
  // past the end it is the last.
  const at = Math.min(index, rows.length - 1);
  const row = rows[at]!;
  const many = rows.length > 1;
  const move = (step: number): void => setIndex((at + step + rows.length) % rows.length);
  const open = (): void => onOpen(row);
  const done = (): void => onDone(row);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    // A field or a button keeps its own keys; Enter on a button is that button.
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key === 'ArrowRight' && many) { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowLeft' && many) { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter' && !target.closest('button, a')) { event.preventDefault(); if (row.link || row.agentId) open(); }
    else if ((event.key === 'd' || event.key === 'Delete') && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); done(); }
  };

  return (
    <div
      className="home-deck"
      data-depth={Math.min(rows.length - 1, 2)}
      role="region"
      aria-label="Needs you, one at a time"
      aria-roledescription="deck"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <NeedsCard
        kind="request"
        tone="accent"
        title={notificationTitle(row)}
        time={row.state === 'held' ? 'today' : fmtRelative(row.createdAt)}
        from={<NeedsFrom face={row.agentId ? <AgentAvatar agents={agents} id={row.agentId} size="sm" /> : undefined}>{label(row)}</NeedsFrom>}
        lead={
          <span className="home-deck-nav">
            <Button size="sm" variant="ghost" aria-label="Previous" disabled={!many} onClick={() => move(-1)}>
              <Icon name="chevron-left" />
            </Button>
            <span className="home-deck-count" aria-live="polite">{at + 1} of {rows.length}</span>
            <Button size="sm" variant="ghost" aria-label="Next" disabled={!many} onClick={() => move(1)}>
              <Icon name="chevron-right" />
            </Button>
          </span>
        }
        actions={
          <>
            <Button onClick={done}>Done</Button>
            {/* An ask with no link opens its agent's conversation (Home's openRow). */}
            {row.link || row.agentId ? <Button variant="accent" onClick={open}>Open</Button> : null}
          </>
        }
      >
        {row.text || row.action ? (
          <div className="home-deck-body">
            {row.text ? <p className="home-deck-text">{row.text}</p> : null}
            {row.action ? <p className="home-deck-text"><strong>{row.action}</strong></p> : null}
          </div>
        ) : null}
      </NeedsCard>
    </div>
  );
}

/**
 * One request in the list view: the deck's card, compact. The title opens it
 * (and opening is seeing it); Done marks it seen without going anywhere.
 */
export function RequestCard({
  row,
  agents,
  label,
  onOpen,
  onDone,
}: {
  row: NotificationRow;
  agents: readonly ChatAgent[];
  label: (row: NotificationRow) => string;
  onOpen: (row: NotificationRow) => void;
  onDone: (row: NotificationRow) => void;
}): JSX.Element {
  const opens = Boolean(row.link || row.agentId);
  return (
    <NeedsCard
      kind="request"
      tone="accent"
      compact
      title={notificationTitle(row)}
      {...(opens ? { href: row.link ?? '#', onOpen: () => onOpen(row) } : {})}
      time={row.state === 'held' ? 'today' : fmtRelative(row.createdAt)}
      from={
        <NeedsFrom face={row.agentId ? <AgentAvatar agents={agents} id={row.agentId} size="sm" /> : undefined}>
          {row.action ? `${label(row)} · ${row.action}` : label(row)}
        </NeedsFrom>
      }
      actions={
        <>
          <Button size="sm" onClick={() => onDone(row)}>Done</Button>
          {opens ? <Button size="sm" variant="accent" onClick={() => onOpen(row)}>Open</Button> : null}
        </>
      }
    />
  );
}
