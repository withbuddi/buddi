/**
 * Where the dashboard's routes live now.
 *
 * Chat is `#/` — the landing route, and the thing the dashboard is for. The
 * monitoring pages keep the routes they always had, so a bookmark or a reload
 * still lands where the owner was; they are simply reached from a rail rather
 * than owning the left third of the screen.
 */
export const CHAT_ROUTE = '#/';

/** The secondary nav, in the order it reads. */
export const SECTIONS = [
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
