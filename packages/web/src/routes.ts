/**
 * Where the dashboard's routes live.
 *
 * Five places, in the order the rail reads them: Home, Chat, Agents, Activity,
 * Settings. Everything the old monitoring pages listed is reachable from one of
 * those, and the old hashes still resolve — a bookmark or a phone's back button
 * lands where it always did, just on the page that now owns that content.
 */
export const HOME_ROUTE = '#/';
export const CHAT_ROUTE = '#/chat';
export const AGENTS_ROUTE = '#/agents';
export const ACTIVITY_ROUTE = '#/activity';
export const SETTINGS_ROUTE = '#/settings';

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

export function agentRoute(agentId: string, tab?: string): string {
  return `${AGENTS_ROUTE}/${encodeURIComponent(agentId)}${tab ? `/${tab}` : ''}`;
}

export function parseAgentRoute(hash: string): { agentId: string; tab?: string } | null {
  const match = /^#\/agents\/([^/]+)(?:\/([a-z-]+))?$/.exec(hash);
  if (!match) return null;
  try {
    return { agentId: decodeURIComponent(match[1]!), ...(match[2] ? { tab: match[2] } : {}) };
  } catch { return null; }
}

export function transcriptRoute(conversationId: string): string {
  return `${ACTIVITY_ROUTE}/conversations/${encodeURIComponent(conversationId)}`;
}

export function settingsRoute(section?: string): string {
  return section ? `${SETTINGS_ROUTE}/${section}` : SETTINGS_ROUTE;
}

/** The primary places, in rail order. */
export const PLACES = [
  { route: HOME_ROUTE, label: 'Home' },
  { route: CHAT_ROUTE, label: 'Chat' },
  { route: AGENTS_ROUTE, label: 'Agents' },
  { route: ACTIVITY_ROUTE, label: 'Activity' },
  { route: SETTINGS_ROUTE, label: 'Settings' },
] as const;

/** The settings sections, in tab order. */
export const SETTINGS_SECTIONS = [
  { id: 'you', label: 'You' },
  { id: 'memory', label: 'Memory' },
  { id: 'accounts', label: 'Model accounts' },
  { id: 'computer', label: 'Computer & browser' },
  { id: 'watchers', label: 'Watchers' },
  { id: 'system', label: 'System' },
] as const;

/**
 * The old monitoring hashes, and where each now lives. A conversation link
 * keeps its id; everything else is a page whose content moved.
 */
export function legacyRedirect(hash: string): string | null {
  const conversation = /^#\/conversations\/(.+)$/.exec(hash);
  if (conversation) return transcriptRoute(decodeURIComponent(conversation[1]!));
  const map: Record<string, string> = {
    '#/overview': HOME_ROUTE,
    '#/approvals': HOME_ROUTE,
    '#/events': `${ACTIVITY_ROUTE}/events`,
    '#/jobs': `${ACTIVITY_ROUTE}/jobs`,
    '#/conversations': ACTIVITY_ROUTE,
    '#/missions': `${AGENTS_ROUTE}?tab=missions`,
    '#/offers': `${AGENTS_ROUTE}?tab=offers`,
    '#/reminders': `${AGENTS_ROUTE}?tab=reminders`,
    '#/providers': settingsRoute('accounts'),
    '#/browser': settingsRoute('computer'),
    '#/sentinels': settingsRoute('watchers'),
    '#/settings/sentinels': settingsRoute('watchers'),
  };
  return map[hash] ?? null;
}

/** Which place a hash belongs to, for the rail's "where am I". */
export function placeOf(hash: string): (typeof PLACES)[number]['route'] {
  if (hash === '' || hash === '#' || hash === HOME_ROUTE) return HOME_ROUTE;
  if (hash.startsWith(CHAT_ROUTE)) return CHAT_ROUTE;
  if (hash.startsWith(AGENTS_ROUTE)) return AGENTS_ROUTE;
  if (hash.startsWith(ACTIVITY_ROUTE)) return ACTIVITY_ROUTE;
  if (hash.startsWith(SETTINGS_ROUTE)) return SETTINGS_ROUTE;
  return HOME_ROUTE;
}
