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
export const FILES_ROUTE = '#/files';
/**
 * First run. Not a place on the rail: the wizard takes the whole window, and
 * the shell is what it hands the owner at the end.
 */
export const WELCOME_ROUTE = '#/welcome';

/** `#/welcome?step=model` — a deep link into one screen of the wizard. */
export function welcomeRoute(step?: string | null): string {
  return step ? `${WELCOME_ROUTE}?step=${encodeURIComponent(step)}` : WELCOME_ROUTE;
}

/** The step a welcome hash names, or null when the hash is not the wizard's. */
export function parseWelcomeRoute(hash: string): { step: string | null } | null {
  const match = /^#\/welcome(?:\?(.*))?$/.exec(hash);
  if (!match) return null;
  try {
    return { step: new URLSearchParams(match[1] ?? '').get('step') };
  } catch {
    return { step: null };
  }
}

/** One file in the library, by id. Authenticated dashboard links, never sharing links. */
export interface FileFilters { q?: string; origin?: string; family?: string }
export function fileRoute(artifactId?: string | null, filters: FileFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.origin) params.set('origin', filters.origin);
  if (filters.family) params.set('family', filters.family);
  const query = params.toString();
  return `${FILES_ROUTE}${artifactId ? `/${encodeURIComponent(artifactId)}` : ''}${query ? `?${query}` : ''}`;
}
export function parseFileRoute(hash: string): { artifactId?: string; filters: FileFilters } | null {
  const match = /^#\/files(?:\/([^/?]+))?(?:\?(.*))?$/.exec(hash);
  if (!match) return null;
  try {
    const params = new URLSearchParams(match[2] ?? '');
    const filters: FileFilters = {};
    if (params.get('q')) filters.q = params.get('q')!;
    if (params.get('origin')) filters.origin = params.get('origin')!;
    if (params.get('family')) filters.family = params.get('family')!;
    return { ...(match[1] ? { artifactId: decodeURIComponent(match[1]) } : {}), filters };
  } catch { return null; }
}

/** Stable owner-only links; the server's normal dashboard authentication applies. */
export function chatRoute(agentId: string, conversationId?: string | null, tab?: 'browser'): string {
  return `#/chat/${encodeURIComponent(agentId)}${conversationId ? `/${encodeURIComponent(conversationId)}` : ''}${tab ? `?tab=${tab}` : ''}`;
}

/**
 * `?tab=browser` is a landing instruction, not a piece of state: it says which
 * panel of the conversation the owner meant when they followed the link (the
 * Take over button on Telegram), and the page honours it once and then leaves
 * the canvas alone.
 */
export function parseChatRoute(hash: string): { agentId: string; conversationId?: string; tab?: string } | null {
  if (parseGroupChatRoute(hash)) return null;
  const match = /^#\/chat\/([^/?]+)(?:\/([^/?]+))?(?:\?(.*))?$/.exec(hash);
  if (!match) return null;
  try {
    const tab = new URLSearchParams(match[3] ?? '').get('tab');
    return {
      agentId: decodeURIComponent(match[1]!),
      ...(match[2] ? { conversationId: decodeURIComponent(match[2]) } : {}),
      ...(tab ? { tab } : {}),
    };
  } catch { return null; }
}

/** A group's chat: `#/chat/g/<groupId>[/<conversationId>]`. The `g` keeps it apart from an agent id. */
export function groupChatRoute(groupId: string, conversationId?: string | null): string {
  return `#/chat/g/${encodeURIComponent(groupId)}${conversationId ? `/${encodeURIComponent(conversationId)}` : ''}`;
}

export function parseGroupChatRoute(hash: string): { groupId: string; conversationId?: string } | null {
  const match = /^#\/chat\/g\/([^/?]+)(?:\/([^/?]+))?(?:\?.*)?$/.exec(hash);
  if (!match) return null;
  try {
    return { groupId: decodeURIComponent(match[1]!), ...(match[2] ? { conversationId: decodeURIComponent(match[2]) } : {}) };
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

/* ------------------------------------------------------------------ *
 * Plugin pages
 *
 * A plugin's screens are data (`docs/specs/plugin-pages.md`), and so are their
 * routes: `#/p/<plugin>/<page>` for a rail place, one more segment for the
 * item a list-detail is showing, and `#/settings/<plugin>[.<page>]` for a
 * settings tab. Nothing here knows a plugin by name — the descriptor says
 * which words go in the hash.
 * ------------------------------------------------------------------ */

/** The prefix every plugin place sits under, kept clear of the core places. */
export const PLUGIN_ROUTE = '#/p';

export function pluginPageRoute(plugin: string, page: string, item?: string | null): string {
  const base = `${PLUGIN_ROUTE}/${encodeURIComponent(plugin)}/${encodeURIComponent(page)}`;
  return item ? `${base}/${encodeURIComponent(item)}` : base;
}

export function parsePluginPageRoute(hash: string): { plugin: string; page: string; item?: string } | null {
  const match = /^#\/p\/([^/?]+)\/([^/?]+)(?:\/([^/?]+))?(?:\?.*)?$/.exec(hash);
  if (!match) return null;
  try {
    return {
      plugin: decodeURIComponent(match[1]!),
      page: decodeURIComponent(match[2]!),
      ...(match[3] ? { item: decodeURIComponent(match[3]) } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * A plugin's settings tab: `#/settings/p.<plugin>[.<page>]`.
 *
 * Always prefixed, even for a plugin with one page. Without the `p.` a plugin
 * called `memory` or `backup` would answer on a core section's own hash and
 * both would draw, stacked; with it, the two namespaces cannot meet at all and
 * nothing has to be reserved.
 */
export const PLUGIN_SETTINGS_PREFIX = 'p.';

export function pluginSettingsRoute(plugin: string, page: string): string {
  return `${SETTINGS_ROUTE}/${encodeURIComponent(pluginSettingsTab(plugin, page))}`;
}

export function parsePluginSettingsRoute(hash: string): { plugin: string; page: string } | null {
  const match = /^#\/settings\/p\.([^/?.]+)(?:\.([^/?.]+))?(?:\?.*)?$/.exec(hash);
  if (!match) return null;
  const plugin = decodeURIComponent(match[1]!);
  return { plugin, page: match[2] ? decodeURIComponent(match[2]) : plugin };
}

/** The tab id a plugin settings page answers to. */
export function pluginSettingsTab(plugin: string, page: string): string {
  return `${PLUGIN_SETTINGS_PREFIX}${plugin}${page === plugin ? '' : `.${page}`}`;
}

export function settingsRoute(section?: string): string {
  return section ? `${SETTINGS_ROUTE}/${section}` : SETTINGS_ROUTE;
}

/**
 * Settings → Proposals, optionally filtered to one plugin's rules:
 * `#/settings/proposals?plugin=<name>`. The name comes from wherever the
 * link was drawn (a plugin page's own scope), never from this file.
 */
export function proposalsRoute(plugin?: string | null): string {
  return `${settingsRoute('proposals')}${plugin ? `?plugin=${encodeURIComponent(plugin)}` : ''}`;
}

/** The plugin a proposals hash is filtered to, or null. */
export function parseProposalsFilter(hash: string): string | null {
  const match = /^#\/settings\/proposals\?(.*)$/.exec(hash);
  if (!match) return null;
  try {
    return new URLSearchParams(match[1]).get('plugin') || null;
  } catch {
    return null;
  }
}

/** The primary places, in rail order. */
export const PLACES = [
  { route: HOME_ROUTE, label: 'Home' },
  { route: CHAT_ROUTE, label: 'Chat' },
  { route: AGENTS_ROUTE, label: 'Agents' },
  { route: ACTIVITY_ROUTE, label: 'Activity' },
  { route: FILES_ROUTE, label: 'Files' },
  { route: SETTINGS_ROUTE, label: 'Settings' },
] as const;

/** The settings sections, in tab order. */
export const SETTINGS_SECTIONS = [
  { id: 'you', label: 'You' },
  { id: 'memory', label: 'Memory' },
  { id: 'proposals', label: 'Proposals' },
  { id: 'accounts', label: 'Model accounts' },
  { id: 'computer', label: 'Computer & browser' },
  { id: 'watchers', label: 'Watchers' },
  { id: 'backup', label: 'Backup' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'system', label: 'System' },
] as const;

/** Where the recovery banner sends the owner, and where a restore is started. */
export const BACKUP_ROUTE = settingsRoute('backup');

/**
 * The old monitoring hashes, and where each now lives. A conversation link
 * keeps its id; everything else is a page whose content moved.
 *
 * The mail hashes are here for a different reason: the Mail place and the
 * Email settings section are no longer compiled in at all — they are a
 * plugin's own pages now (`docs/specs/plugin-pages.md`) — and the routes they
 * used to answer to are in bookmarks, in the owner's history, and in every
 * "open in buddi" link Telegram has ever sent. So `#/email/<threadId>` is
 * still a conversation, and it still lands on the same one; it simply lands on
 * the page the email plugin contributes. This is the only place in
 * `packages/web` that names a plugin, and it names it as a *string from the
 * past* rather than as something the dashboard knows about.
 */
export function legacyRedirect(hash: string): string | null {
  const conversation = /^#\/conversations\/(.+)$/.exec(hash);
  if (conversation) return transcriptRoute(decodeURIComponent(conversation[1]!));
  const mail = /^#\/email(?:\/([^/?]+))?(?:\?.*)?$/.exec(hash);
  if (mail) {
    try {
      return pluginPageRoute('email', 'mail', mail[1] ? decodeURIComponent(mail[1]) : null);
    } catch {
      return pluginPageRoute('email', 'mail');
    }
  }
  if (hash === '#/settings/email') return pluginSettingsRoute('email', 'settings');
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
export function placeOf(hash: string): string {
  if (hash === '' || hash === '#' || hash === HOME_ROUTE) return HOME_ROUTE;
  if (hash.startsWith(CHAT_ROUTE)) return CHAT_ROUTE;
  if (hash.startsWith(AGENTS_ROUTE)) return AGENTS_ROUTE;
  if (hash.startsWith(ACTIVITY_ROUTE)) return ACTIVITY_ROUTE;
  if (hash.startsWith(FILES_ROUTE)) return FILES_ROUTE;
  if (hash.startsWith(SETTINGS_ROUTE)) return SETTINGS_ROUTE;
  // A plugin place: its own route *is* its place, so the rail marks the entry
  // the descriptor put there without core knowing what it is.
  const plugin = parsePluginPageRoute(hash);
  if (plugin) return pluginPageRoute(plugin.plugin, plugin.page);
  return HOME_ROUTE;
}
