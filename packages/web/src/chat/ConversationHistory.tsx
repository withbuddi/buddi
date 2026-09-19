import { useEffect, useState } from 'react';
import { chatApi } from '../api';
import { chatRoute } from '../routes';
import { fmtTime } from '../format';
import type { ConversationListItem } from './types';

export function ConversationHistory({ agentId, currentId, timezone, onSelect, onNew }: {
  agentId: string; currentId: string | null; timezone: string;
  onSelect: (id: string) => void; onNew: () => void;
}): JSX.Element {
  const [items, setItems] = useState<ConversationListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setItems(null); setError(null);
    chatApi.conversations(agentId, 100).then(result => {
      if (!cancelled) setItems(result.conversations);
    }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [agentId, attempt]);
  return <section className="wb-history" aria-label="Past conversations">
    <div className="bar"><strong>Past conversations</strong><button className="wb-btn" onClick={onNew}>New conversation</button></div>
    {error ? <p role="alert">{error} <button className="wb-btn" onClick={() => setAttempt(n => n + 1)}>Retry</button></p>
      : items === null ? <p className="muted">Loading conversations…</p>
      : items.length === 0 ? <p className="muted">No conversations yet.</p>
      : <ul>{items.map(item => <li key={item.id}>
        <a href={chatRoute(agentId, item.id)} aria-current={item.id === currentId ? 'page' : undefined}
          onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onSelect(item.id); } }}>
          <span>{item.preview || item.opening || 'Untitled conversation'}</span>
          <small>{fmtTime(item.lastMessageAt ?? item.startedAt ?? item.createdAt ?? null, timezone)} · {item.messageCount} messages{item.id === currentId ? ' · Current' : ''}</small>
        </a>
      </li>)}</ul>}
    <a href="#/conversations">View all agents’ conversation records ↗</a>
    {items?.length === 100 ? <p className="muted">Showing the 100 most recent conversations.</p> : null}
  </section>;
}
