/**
 * Where the dashboard's routes live now.
 *
 * Chat is `#/` — the landing route, and the thing the dashboard is for. The
 * monitoring pages keep the routes they always had, so a bookmark or a reload
 * still lands where the owner was; they are simply reached from a rail rather
 * than owning the left third of the screen.
 */
export const CHAT_ROUTE = '#/';

/** Stable owner-only links; the server's normal dashboard authentication applies. */
export function chatRoute(agentId: string, conversationId?: string | null): string {
  return `#/chat/${encodeURIComponent(agentId)}${conversationId ? `/${encodeURIComponent(conversationId)}` : ''}`;
}

export function parseChatRoute(hash: string): { agentId: string; conversationId?: string } | null {
  const match = /^#\/chat\/([^/]+)(?:\/([^/]+))?$/.exec(hash);
  if (!match) return null;
  try {
    return { agentId: decodeURIComponent(match[1]!), ...(match[2] ? { conversationId: decodeURIComponent(match[2]) } : {}) };
  } catch { return null; }
}

/** The secondary nav, in the order it reads. */
export const SECTIONS = [
  { route: '#/providers', label: 'Providers' },
  { route: '#/browser', label: 'Browser' },
  { route: '#/overview', label: 'Overview' },
  { route: '#/events', label: 'Events' },
  { route: '#/conversations', label: 'Conversations' },
  { route: '#/missions', label: 'Missions' },
  { route: '#/approvals', label: 'Approvals' },
  { route: '#/jobs', label: 'Jobs' },
  { route: '#/offers', label: 'Offers' },
  { route: '#/reminders', label: 'Reminders' },
  { route: '#/sentinels', label: 'Sentinels' },
  { route: '#/agents', label: 'Agents' },
] as const;

/** Kept for the pages that still want a flat list including chat. */
export const NAV = [{ route: CHAT_ROUTE, label: 'Chat' }, ...SECTIONS] as const;
