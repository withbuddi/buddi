/**
 * The shell.
 *
 * A rail of five places on the left, and the place on the right. Home is the
 * landing route: what needs you, then your team, then what is coming. Chat
 * owns a conversation column driving a canvas, exactly as before. The old
 * monitoring hashes still resolve: `legacyRedirect` sends each to the page
 * that now holds its content.
 *
 * Routing is the URL hash, so there are no server routes and a reload lands
 * where the owner was.
 */
import * as Toast from '@radix-ui/react-toast';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useCallback, useEffect, useState } from 'react';
import { AGENTS_CHANGED, api, chatApi, type VersionView } from './api';
import { ChatPage } from './chat/ChatPage';
import type { ChatAgent } from './chat/types';
import {
  ACTIVITY_ROUTE,
  AGENTS_ROUTE,
  CHAT_ROUTE,
  FILES_ROUTE,
  HOME_ROUTE,
  PLACES,
  SETTINGS_ROUTE,
  WELCOME_ROUTE,
  chatRoute,
  groupChatRoute,
  legacyRedirect,
  parseChatRoute,
  parseGroupChatRoute,
  parsePluginPageRoute,
  parseWelcomeRoute,
  placeOf,
} from './routes';
import { AgentRail } from './shell/AgentRail';
import { GroupSheet } from './shell/GroupSheet';
import { PluginPage } from './pages/PluginPage';
import { usePluginPages, type PluginPages } from './pages/usePages';
import { Files } from './views/Files';
import type { GroupView } from './chat/types';
import { Rail } from './shell/Rail';
import { useAsync } from './ui';
import { rememberDefaultAgent } from './shell/accent';
import { groupAgents, useAttention } from './shell/roster';
import { applyAppearance, useAppearance } from './appearance';
import type { ThemeChoice } from './theme';
import { Activity } from './views/Activity';
import { Agents } from './views/Agents';
import { Home } from './views/Home';
import { Settings } from './views/Settings';
import { NARROW_QUERY, useMediaQuery } from './useMediaQuery';
import { Meet } from './views/Meet';
import { MascotProvider } from './views/parts/Avatar';
import { RecoveryBanner, useRecovery } from './views/Recovery';

export { PLACES };

/** Kept on the shell for the callers that import them from here. */
export { NARROW_QUERY, useMediaQuery };

/**
 * The width below which the *agent* rail lies down.
 *
 * Deliberately higher than the canvas breakpoint. Two rails, a 320px minimum
 * conversation and a canvas need about a thousand pixels before any of them
 * has room to be read; below that the agent rail is the one that gives way.
 */
export const AGENT_RAIL_QUERY = '(max-width: 1080px)';

export function useHash(): [string, (next: string, replace?: boolean) => void] {
  const [hash, setHash] = useState(() => window.location.hash || HOME_ROUTE);
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash || HOME_ROUTE);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((next: string, replace = false) => {
    if (replace) window.history.replaceState(null, '', next);
    else window.location.hash = next;
    setHash(next);
  }, []);
  return [hash, navigate];
}


/**
 * The owner's theme, through the shared appearance store: the rail's menu and
 * Settings → Appearance change the same value.
 */
export function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [appearance, setAppearance] = useAppearance();
  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);
  const choose = useCallback((theme: ThemeChoice) => setAppearance({ theme }), [setAppearance]);
  return [appearance.theme, choose];
}

export function App(): JSX.Element {
  const [hash, navigate] = useHash();
  const [timezone, setTimezone] = useState('UTC');
  const [badges, setBadges] = useState<{ approvals: number; failed: number }>({ approvals: 0, failed: 0 });
  const [theme, setTheme] = useThemeChoice();
  const narrow = useMediaQuery(NARROW_QUERY);
  const [canvasOpen, setCanvasOpen] = useState(false);
  /*
   * The roster lives in the shell, because the rail that draws it does. One
   * selection, one order, one source of "who is waiting".
   */
  const [agents, setAgents] = useState<ChatAgent[]>([]);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  /** The owner's groups: a team of agents in one conversation (docs/groups.md). */
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [newGroup, setNewGroup] = useState(false);
  /** The group whose sheet is open for editing, if any. */
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const attention = useAttention();
  const railNarrow = useMediaQuery(AGENT_RAIL_QUERY);
  /*
   * Recovery is a property of the installation, not of a page, so the shell is
   * what reads it: a buddi restored from a backup says so wherever the owner
   * happens to be, and stops saying it the moment the checklist is finished.
   */
  const recovery = useRecovery();
  /*
   * The screens the installed plugins contribute. Read in the shell because
   * three things need them — the rail, the settings tabs and the place itself
   * — and an installation with none is served an empty list.
   */
  const pluginPages = usePluginPages();
  /*
   * Whether a newer buddi is known. Read once here, for the rail's dot and
   * Home's notice, rather than once by each. The supervisor asks the registry
   * once a day, so an hour between reads is plenty. A checkout never has one
   * to offer: it upgrades with git.
   */
  const version = useAsync<VersionView>(() => Promise.resolve().then(() => api.version()), [], 60 * 60_000).data;
  const update = version && !version.checkout && version.updateAvailable ? version : null;
  /** When each agent last spoke, for the roster's quiet line. */
  const [lastActivity, setLastActivity] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    const load = (): void => {
      api
        .conversations()
        .then((list) => {
          const latest = new Map<string, string>();
          for (const c of list.conversations) {
            const at = c.lastMessageAt ?? c.createdAt;
            const seen = latest.get(c.agentId);
            if (!seen || at > seen) latest.set(c.agentId, at);
          }
          setLastActivity(latest);
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [hash]);

  /*
   * First run, once per load.
   *
   * The wizard is offered only to an installation whose first run is still
   * `pending` *and* which has no model account. Both halves matter: a done or
   * skipped record never sees it again, a working install whose record predates
   * the wizard never sees it — which is what keeps a developer's live dashboard
   * out of a setup screen it passed long ago — and an `in-progress` record
   * belongs to an interview some other surface already claimed, which must not
   * be interrupted by a redirect. A web record that is in progress resumes
   * through the link, not through this. Replaced, not pushed, so Back does not
   * bounce.
   */
  const [firstRunChecked, setFirstRunChecked] = useState(false);
  useEffect(() => {
    if (firstRunChecked) return undefined;
    let cancelled = false;
    api
      .onboarding()
      .then((view) => {
        if (cancelled) return;
        setFirstRunChecked(true);
        if (view.state === 'pending' && view.needs.model && !parseWelcomeRoute(window.location.hash)) {
          navigate(WELCOME_ROUTE, true);
        }
      })
      .catch(() => {
        // No server, or an installation whose database has not migrated that
        // table. Either way the shell is what the owner gets.
        if (!cancelled) setFirstRunChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [firstRunChecked, navigate]);

  // The old hashes, sent where their content went. Replaced, not pushed, so
  // Back does not bounce between the two.
  useEffect(() => {
    const target = legacyRedirect(hash);
    if (target) navigate(target, true);
  }, [hash, navigate]);

  // The roster is re-read on every navigation, on a slow timer, and whenever
  // the window comes back into focus: an agent created by Agent Father joins
  // the rail without a reload.
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      chatApi
        .agents()
        .then((list) => {
          if (cancelled) return;
          setAgents(list.agents);
          rememberDefaultAgent(list.defaultAgentId ?? null);
          setDefaultAgentId(list.defaultAgentId ?? null);
          setAgentId((current) => current ?? list.defaultAgentId ?? list.agents[0]?.id ?? null);
        })
        .catch(() => {
          /* No server, or no session. The rail is empty rather than broken. */
        });
    };
    load();
    const timer = window.setInterval(load, 15_000);
    window.addEventListener('focus', load);
    window.addEventListener(AGENTS_CHANGED, load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
      window.removeEventListener(AGENTS_CHANGED, load);
    };
  }, [hash]);

  // Groups, on the same cadence as the roster they sit under.
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      chatApi.groups().then((list) => { if (!cancelled) setGroups(list.groups); }).catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [hash]);

  const ordered = groupAgents(agents, defaultAgentId);
  const chatLocation = parseChatRoute(hash);
  const groupLocation = parseGroupChatRoute(hash);
  const selectedGroup = groupLocation ? (groups.find((g) => g.id === groupLocation.groupId) ?? null) : null;
  const selectedAgentId = groupLocation ? null : (chatLocation?.agentId ?? agentId);
  useEffect(() => {
    if (chatLocation) setAgentId(chatLocation.agentId);
  }, [chatLocation?.agentId]);
  const selectAgent = (id: string): void => { setAgentId(id); navigate(chatRoute(id)); };
  const selectGroup = (id: string): void => navigate(groupChatRoute(id));
  const conversationOpened = useCallback(
    (id: string, conversation: string, replace = true) => navigate(groupLocation ? groupChatRoute(groupLocation.groupId, conversation) : chatRoute(id, conversation), replace),
    [navigate, groupLocation?.groupId],
  );

  useEffect(() => {
    api
      .session()
      .then((session) => setTimezone(session.timezone))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const refresh = (): void => {
      api
        .overview()
        .then((overview) =>
          setBadges({ approvals: overview.approvals.pending, failed: overview.jobs.failed ?? 0 }),
        )
        .catch(() => {});
    };
    refresh();
    const handle = window.setInterval(refresh, 20_000);
    return () => window.clearInterval(handle);
  }, []);

  const welcome = parseWelcomeRoute(hash);
  const place = placeOf(hash);
  const onChat = place === CHAT_ROUTE;
  const editingGroup = editingGroupId ? (groups.find((g) => g.id === editingGroupId) ?? null) : null;
  /*
   * One sheet, two jobs: making a group and changing one. Whatever it answers
   * goes straight into the roster this component holds, so the rail and the
   * room's header are right without a reload — an archived group leaves the
   * rail and the page goes back to the agents.
   */
  const groupSheet = newGroup ? (
    <GroupSheet
      agents={agents}
      onClose={() => setNewGroup(false)}
      onCreated={(group) => { setGroups((current) => [...current, group]); setNewGroup(false); navigate(groupChatRoute(group.id)); }}
    />
  ) : editingGroup ? (
    <GroupSheet
      agents={agents}
      group={editingGroup}
      onClose={() => setEditingGroupId(null)}
      onSaved={(group) => {
        setGroups((current) => current.map((g) => (g.id === group.id ? group : g)));
        setEditingGroupId(null);
      }}
      onArchived={(id) => {
        setGroups((current) => current.filter((g) => g.id !== id));
        setEditingGroupId(null);
        navigate(CHAT_ROUTE);
      }}
    />
  ) : null;

  // First run takes the whole window: no rail, no place, nothing to navigate
  // away to until the owner has met their assistant or set it aside.
  if (welcome) {
    return (
      <Tooltip.Provider delayDuration={400}>
        <Toast.Provider swipeDirection="right">
          <Meet navigate={navigate} timezone={timezone} />
          <Toast.Viewport className="ui-toasts" />
        </Toast.Provider>
      </Tooltip.Provider>
    );
  }

  return (
    <MascotProvider picture={agents.find((agent) => agent.id === defaultAgentId)?.picture}>
    <Tooltip.Provider delayDuration={400}>
      <Toast.Provider swipeDirection="right">
        {groupSheet}
        <div className="wb-shell">
        <RecoveryBanner active={recovery.data?.active === true} onNavigate={navigate} />
        <div className="wb">
          <Rail
            attention={badges.approvals + badges.failed}
            place={place}
            onNavigate={navigate}
            theme={theme}
            onTheme={setTheme}
            plugins={pluginPages.rail}
            updateAvailable={update !== null}
            version={version && !version.checkout ? { current: version.current, latest: version.latest, updateAvailable: version.updateAvailable } : version ? { current: version.current, updateAvailable: false } : undefined}
          />

          {onChat && !railNarrow ? (
            <AgentRail
              agents={ordered}
              currentId={selectedAgentId}
              attention={attention}
              onSelect={selectAgent}
              lastActivity={lastActivity}
              groups={groups}
              currentGroupId={selectedGroup?.id ?? null}
              onSelectGroup={selectGroup}
              onNewGroup={() => setNewGroup(true)}
            />
          ) : null}

          {onChat ? (
            <ChatPage
              timezone={timezone}
              agents={ordered}
              agentId={selectedGroup ? selectedGroup.coordinator : selectedAgentId}
              defaultAgentId={defaultAgentId}
              group={selectedGroup}
              onEditGroup={selectedGroup ? () => setEditingGroupId(selectedGroup.id) : undefined}
              requestedConversationId={groupLocation?.conversationId ?? chatLocation?.conversationId}
              requestedTab={chatLocation?.tab}
              onConversationOpened={conversationOpened}
              onSelectAgent={selectAgent}
              attention={attention}
              agentsInHeader={railNarrow}
              narrow={narrow}
              canvasOpen={canvasOpen}
              onOpenCanvas={() => setCanvasOpen(true)}
              onCloseCanvas={() => setCanvasOpen(false)}
            />
          ) : (
            <main
              data-ground={plainGround(place, hash) ? 'plain' : undefined}
              data-layout={place === SETTINGS_ROUTE ? 'split' : undefined}
            >
              <Place
                hash={hash}
                place={place}
                timezone={timezone}
                navigate={navigate}
                agents={agents}
                defaultAgentId={defaultAgentId}
                attention={attention}
                pluginPages={pluginPages}
                update={update}
              />
            </main>
          )}
        </div>
        </div>
        <Toast.Viewport className="ui-toasts" />
      </Toast.Provider>
    </Tooltip.Provider>
    </MascotProvider>
  );
}

/**
 * The dense places keep the flat ground whatever the owner chose: Settings,
 * Activity, Files and every plugin page (mail, tables). No gradient is drawn
 * behind data. Home and Agents sit on the quiet page gradient.
 */
export function plainGround(_place: string, hash: string): boolean {
  // The kit draws every built-in page on the page's field; a plugin's own
  // screen is its data, and keeps the flat ground.
  return parsePluginPageRoute(hash) !== null;
}

export interface PlaceProps {
  hash: string;
  /**
   * The screens the installed plugins contribute, read once by the shell.
   * Optional so every other view keeps its signature; Settings is the one
   * that draws the extra tabs.
   */
  pluginPages?: PluginPages;
  timezone: string;
  navigate: (next: string, replace?: boolean) => void;
  agents: ChatAgent[];
  /** The agent the page opens on, as `/api/chat/agents` says; orders the roster with the front desk and the maker. */
  defaultAgentId?: string | null;
  attention: ReturnType<typeof useAttention>;
  /** A newer buddi the installation can upgrade to, when one is known. Home says so. */
  update?: VersionView | null;
}

function Place({ place, pluginPages, ...props }: PlaceProps & { place: string; pluginPages: PluginPages }): JSX.Element {
  const withPages = { ...props, pluginPages };
  /*
   * A plugin's own place. The hash says which plugin and which page; the
   * descriptor says what is on it. When the descriptors have not arrived yet —
   * or name no such page — the owner gets Home rather than a blank window.
   */
  const located = parsePluginPageRoute(props.hash);
  if (located) {
    const page = pluginPages.find(located.plugin, located.page);
    if (page) {
      return (
        <PluginPage
          page={page}
          item={located.item ?? null}
          navigate={props.navigate}
          timezone={props.timezone}
          siblings={pluginPages.all.filter((p) => p.plugin === located.plugin)}
        />
      );
    }
    if (pluginPages.all.length === 0) return <></>;
  }
  switch (place) {
    case AGENTS_ROUTE:
      return <Agents {...props} />;
    case ACTIVITY_ROUTE:
      return <Activity {...props} />;
    case SETTINGS_ROUTE:
      return <Settings {...withPages} />;
    case FILES_ROUTE:
      return <Files {...props} />;
    default:
      return <Home {...props} />;
  }
}
