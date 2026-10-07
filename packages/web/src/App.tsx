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
import { setPluginCommands } from './chat/commands';
import * as Toast from '@radix-ui/react-toast';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AGENTS_CHANGED, STATUS_CHANGED, api, chatApi, type ConnectionSignal, type VersionView } from './api';
import { ChatPage } from './chat/ChatPage';
import type { ChatAgent } from './chat/types';
import {
  ACTIVITY_ROUTE,
  AGENTS_ROUTE,
  CHAT_ROUTE,
  FILES_ROUTE,
  HOME_ROUTE,
  NEW_GROUP_ROUTE,
  PLACES,
  SETTINGS_ROUTE,
  WELCOME_ROUTE,
  chatRoute,
  groupChatRoute,
  legacyRedirect,
  parseChatRoute,
  parseGroupChatRoute,
  parsePluginPageRoute,
  pluginRouteParams,
  parseWelcomeRoute,
  placeOf,
  tipsPageOf,
} from './routes';
import { AgentRail } from './shell/AgentRail';
import { AskDock, showsAskDock } from './shell/AskDock';
import { NotificationToasts, ToastStack, toastPlacement, useToastQueue } from './shell/NotificationToasts';
import { usePresence } from './shell/presence';
import { GroupSheet } from './shell/GroupSheet';
import { ClearGroupModal, DeleteGroupModal, MembersSheet, RenameGroupModal, type GroupAction } from './shell/GroupRoom';
import { GROUP_UNDO_SHOWN_MS, UndoToast } from './shell/UndoToast';
import { PluginPage } from './pages/PluginPage';
import { usePluginPages, type PluginPages } from './pages/usePages';
import { Files } from './views/Files';
import type { GroupView } from './chat/types';
import { CONNECTION_DOT, Rail } from './shell/Rail';
import { shownOnRail, useRailHidden } from './shell/railHidden';
import { useAsync } from './ui';
import { rememberDefaultAgent } from './shell/accent';
import { groupAgents, useAttention } from './shell/roster';
import { useSlashToComposer } from './shell/slash';
import { applyAppearance, useAppearance } from './appearance';
import type { ThemeChoice } from './theme';
import { Activity } from './views/Activity';
import { Agents } from './views/Agents';
import { Home } from './views/Home';
import { Settings } from './views/Settings';
import { NARROW_QUERY, useMediaQuery } from './useMediaQuery';
import { Meet } from './views/Meet';
import { MascotProvider } from './views/parts/Avatar';
import { useRecovery } from './views/Recovery';
import { BannerSlot, shellBanners } from './shell/BannerSlot';
import { RailStatus, StatusBar, linkKind, useLinkDown, type ShellStatus } from './shell/StatusBar';
import { useLostLink } from './shell/Unreachable';
import { useRestart } from './shell/Restarting';
import { buildDiffers } from './build';
import { BUILD_CHECK_MS, useAutoReload, useCheckOnReconnect } from './shell/freshness';
import { FORMATS_CHANGED, setDisplayFormats } from './format';
import type { OnboardingPhase } from './views/parts/WakesAfterRestart';

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

/** A phone: the footer status line folds into a dot on the rail. */
export const PHONE_QUERY = '(max-width: 720px)';

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

/** Pages already reported to the tips today, by this tab: page → day. */
const reportedPages = new Map<string, string>();

export function App(): JSX.Element {
  const [hash, navigate] = useHash();
  const [timezone, setTimezone] = useState('UTC');
  const [badges, setBadges] = useState<{ approvals: number; failed: number; paused: boolean; running: number; needs: number }>({ approvals: 0, failed: 0, paused: false, running: 0, needs: 0 });
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
  /** One of a group's own things, open from its room's ⋯ menu: Members, Rename, Clear, Delete. */
  const [groupAction, setGroupAction] = useState<{ kind: GroupAction; groupId: string } | null>(null);
  /** A group just deleted: ten seconds to take it back, where it stood in the rail. */
  const [deletedGroup, setDeletedGroup] = useState<{ group: GroupView; index: number; until: string } | null>(null);
  /** Bumped when a room's history is cleared, so its page starts again on a clean thread. */
  const [roomEpoch, setRoomEpoch] = useState(0);
  /** Undo came too late: the group is gone for good, and the page says so once. */
  const [restoreFailed, setRestoreFailed] = useState<string | null>(null);
  const attention = useAttention();
  /*
   * The corner buddi: a small chat with the front desk over any page but Home
   * and the chat, which have composers of their own. `/` on a page without a
   * composer opens it; with no front desk yet, `/` goes to Home as before.
   * Not during first run, which has nowhere else to go.
   */
  const frontDesk = agents.find((agent) => agent.id === defaultAgentId) ?? null;
  const askShown = frontDesk !== null && showsAskDock(hash);
  const [askOpen, setAskOpen] = useState(false);
  const openAsk = useCallback(() => setAskOpen(true), []);
  useEffect(() => {
    if (!askShown) setAskOpen(false);
  }, [askShown]);
  useSlashToComposer(navigate, parseWelcomeRoute(hash) === null, askShown ? openAsk : undefined);
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
  /* The rail pages the owner hid in Settings → Appearance stay off the rail (still open from Settings → Plugins). */
  const railHidden = useRailHidden();
  /*
   * Whether a newer buddi is known. Read once here, for the rail's dot and
   * Home's notice, rather than once by each. A checkout never has one to
   * offer: it upgrades with git. Read every five minutes, because the same
   * answer names the dashboard build the gateway serves (below).
   */
  const versionRead = useAsync<VersionView>(() => Promise.resolve().then(() => api.version()), [], BUILD_CHECK_MS);
  const version = versionRead.data;
  // …and again the moment the live stream is back: a restart onto a new build drops it.
  useCheckOnReconnect(versionRead.reload);
  const update = version && !version.checkout && version.updateAvailable ? version : null;
  /* The same read says which dashboard build is served; a different one than this page's means reload. */
  const stale = buildDiffers(version?.web);
  // Reload onto it by itself when the tab is hidden or the owner is idle with nothing in progress.
  useAutoReload(version?.web);
  /*
   * Connections that need the owner (a sign-in ran out, the tools changed):
   * the same dot on Settings, and a line on Home. One small read a minute.
   */
  const connectionSignals = useAsync(() => Promise.resolve().then(() => api.connectionSignals()), [], 60_000).data?.signals ?? [];
  /** Who is working in the open conversation, for the roster's accent dot. */
  const [workingAgentId, setWorkingAgentId] = useState<string | null>(null);
  const working = useMemo(() => new Set(workingAgentId ? [workingAgentId] : []), [workingAgentId]);
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
  const [onboarding, setOnboarding] = useState<OnboardingPhase>('unknown');
  useEffect(() => {
    if (firstRunChecked) return undefined;
    let cancelled = false;
    api
      .onboarding()
      .then((view) => {
        if (cancelled) return;
        setFirstRunChecked(true);
        setOnboarding(view.state === 'done' || view.state === 'skipped' ? 'done' : 'open');
        if (view.state === 'pending' && view.needs.model && !parseWelcomeRoute(window.location.hash)) {
          navigate(WELCOME_ROUTE, true);
        }
      })
      .catch(() => {
        // No server, or an installation whose database has not migrated that
        // table. Either way the shell is what the owner gets.
        if (!cancelled) { setFirstRunChecked(true); setOnboarding('open'); }
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
          setPluginCommands(list.commands);
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
  /*
   * The last chat that was not a group's room: where deleting the open
   * group goes back to. An agent's chat is always somewhere to stand.
   */
  const lastAgentChat = useRef<string | null>(null);
  if (chatLocation) lastAgentChat.current = hash;
  const selectAgent = (id: string): void => { setAgentId(id); navigate(chatRoute(id)); };
  const selectGroup = (id: string): void => navigate(groupChatRoute(id));
  const conversationOpened = useCallback(
    (id: string, conversation: string, replace = true) => navigate(groupLocation ? groupChatRoute(groupLocation.groupId, conversation) : chatRoute(id, conversation), replace),
    [navigate, groupLocation?.groupId],
  );

  /*
   * Signed in is what the session check says. Presence and the toasts wait
   * for it, and a 401 from either puts them back to sleep.
   */
  const [signedIn, setSignedIn] = useState(false);
  // The owner changed how times and dates read: the whole shell draws again,
  // in the zone the server now keeps (Settings → Profile may have moved it).
  const [, setFormatsDrawn] = useState(0);
  useEffect(() => {
    const redraw = (): void => {
      setFormatsDrawn((n) => n + 1);
      api.session().then((session) => setTimezone(session.timezone)).catch(() => {});
    };
    window.addEventListener(FORMATS_CHANGED, redraw);
    return () => window.removeEventListener(FORMATS_CHANGED, redraw);
  }, []);
  useEffect(() => {
    api
      .session()
      .then((session) => {
        // How the owner reads times and dates, before anything is drawn with it.
        setDisplayFormats({ timeFormat: session.timeFormat ?? null, dateFormat: session.dateFormat ?? null });
        setTimezone(session.timezone);
        setSignedIn(true);
      })
      .catch(() => {});
  }, []);
  const toasts = useToastQueue(signedIn);
  usePresence(signedIn, toasts.refresh, () => setSignedIn(false));

  /*
   * One read for the rail's badge, the footer's work and approvals, and the
   * paused queue's banner: every twenty seconds, and at once when this page
   * paused or resumed the queue.
   */
  useEffect(() => {
    const refresh = (): void => {
      api
        .overview()
        .then((overview) =>
          setBadges({
            approvals: overview.approvals.pending,
            failed: overview.jobs.failed ?? 0,
            paused: overview.paused,
            running: overview.running ?? 0,
            // The rail's badge is everything that needs the owner, by the gateway's one rule.
            needs: overview.needsYou?.total ?? overview.approvals.pending + (overview.jobs.failed ?? 0),
          }),
        )
        .catch(() => {});
    };
    refresh();
    const handle = window.setInterval(refresh, 20_000);
    window.addEventListener(STATUS_CHANGED, refresh);
    return () => { window.clearInterval(handle); window.removeEventListener(STATUS_CHANGED, refresh); };
  }, []);

  /* The focus that is on, for the footer; the owner menu switches it and says so. */
  const focusRead = useAsync(() => Promise.resolve().then(() => api.focus()), [], 60_000);
  const reloadFocus = useRef(focusRead.reload);
  reloadFocus.current = focusRead.reload;
  useEffect(() => {
    const reload = (): void => { void reloadFocus.current(); };
    window.addEventListener(STATUS_CHANGED, reload);
    return () => window.removeEventListener(STATUS_CHANGED, reload);
  }, []);
  /* Reconnecting while requests go unanswered; lost — the banner — after thirty seconds of it. */
  const linkDown = useLinkDown();
  const lost = useLostLink();
  /* A restart being waited for has the whole window (shell/Restarting.tsx): the banner and Reconnecting… defer to it. */
  const restarting = useRestart() !== null;
  const phone = useMediaQuery(PHONE_QUERY);

  // The tips learn which pages were opened: one report per page per day.
  useEffect(() => {
    if (!signedIn) return;
    if (hash === NEW_GROUP_ROUTE) {
      setNewGroup(true);
      navigate(CHAT_ROUTE, true);
      return;
    }
    const page = tipsPageOf(hash);
    const day = new Date().toDateString();
    if (!page || reportedPages.get(page) === day) return;
    reportedPages.set(page, day);
    void api.tipsSeenPage(page).catch(() => {});
  }, [hash, signedIn, navigate]);

  const status: ShellStatus = {
    link: linkKind(window.location.hostname, linkDown && !restarting),
    focus: focusRead.data?.focus ?? null,
    working: badges.running,
    paused: badges.paused,
    failed: badges.failed,
    approvals: badges.approvals,
    version: version ? { current: version.current, latest: version.latest, updateAvailable: !version.checkout && version.updateAvailable } : undefined,
    timezone,
  };
  const banners = shellBanners({ recovery: recovery.data?.active === true, lost: lost && !restarting, paused: badges.paused });

  const welcome = parseWelcomeRoute(hash);
  const place = placeOf(hash);
  const onChat = place === CHAT_ROUTE;
  const actedGroup = groupAction ? (groups.find((g) => g.id === groupAction.groupId) ?? null) : null;
  const savedGroup = (group: GroupView): void => setGroups((current) => current.map((g) => (g.id === group.id ? group : g)));
  const closeGroupAction = (): void => setGroupAction(null);
  /*
   * Making a group is the sheet; everything after is the room's menu. What
   * either answers goes straight into the roster this component holds, so
   * the rail and the room's header are right without a reload. A deleted
   * group leaves the rail at once and the page goes back to the chat the
   * owner was in before, with Undo while the server still keeps it.
   */
  const groupSheet = newGroup ? (
    <GroupSheet
      agents={agents}
      onClose={() => setNewGroup(false)}
      onCreated={(group) => { setGroups((current) => [...current, group]); setNewGroup(false); navigate(groupChatRoute(group.id)); }}
    />
  ) : actedGroup && groupAction?.kind === 'members' ? (
    <MembersSheet group={actedGroup} agents={agents} onClose={closeGroupAction} onSaved={savedGroup} />
  ) : actedGroup && groupAction?.kind === 'rename' ? (
    <RenameGroupModal group={actedGroup} onClose={closeGroupAction} onSaved={(group) => { savedGroup(group); closeGroupAction(); }} />
  ) : actedGroup && groupAction?.kind === 'clear' ? (
    <ClearGroupModal
      group={actedGroup}
      onClose={closeGroupAction}
      onCleared={() => { closeGroupAction(); setRoomEpoch((n) => n + 1); navigate(groupChatRoute(actedGroup.id), true); }}
    />
  ) : actedGroup && groupAction?.kind === 'delete' ? (
    <DeleteGroupModal
      group={actedGroup}
      agents={agents}
      onClose={closeGroupAction}
      onDeleted={(until) => {
        const index = groups.findIndex((g) => g.id === actedGroup.id);
        closeGroupAction();
        setGroups((current) => current.filter((g) => g.id !== actedGroup.id));
        setDeletedGroup({ group: actedGroup, index, until });
        navigate(lastAgentChat.current ?? CHAT_ROUTE);
      }}
    />
  ) : null;
  const undoDelete = (): void => {
    const gone = deletedGroup;
    if (!gone) return;
    setDeletedGroup(null);
    chatApi.restoreGroup(gone.group.id).then((group) => {
      setGroups((current) => {
        if (current.some((g) => g.id === group.id)) return current;
        const next = [...current];
        next.splice(Math.min(Math.max(gone.index, 0), next.length), 0, group);
        return next;
      });
      navigate(groupChatRoute(group.id));
    }).catch(() => setRestoreFailed(gone.group.name));
  };

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
        <BannerSlot banners={banners} onNavigate={navigate} />
        <div className="wb">
          <Rail
            attention={badges.needs}
            place={place}
            onNavigate={navigate}
            theme={theme}
            onTheme={setTheme}
            plugins={shownOnRail(pluginPages.rail, railHidden)}
            updateAvailable={update !== null}
            settingsDot={connectionSignals.length > 0 ? CONNECTION_DOT : undefined}
            stale={stale}
            timezone={timezone}
            version={version && !version.checkout ? { current: version.current, latest: version.latest, updateAvailable: version.updateAvailable } : version ? { current: version.current, updateAvailable: false } : undefined}
            status={phone ? <RailStatus status={status} onNavigate={navigate} /> : undefined}
          />

          {onChat && !railNarrow ? (
            <AgentRail
              agents={ordered}
              currentId={selectedAgentId}
              attention={attention}
              onSelect={selectAgent}
              lastActivity={lastActivity}
              working={working}
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
              key={`room-${roomEpoch}`}
              {...(selectedGroup ? { onGroupAction: (kind: GroupAction) => setGroupAction({ kind, groupId: selectedGroup.id }) } : {})}
              requestedConversationId={groupLocation?.conversationId ?? chatLocation?.conversationId}
              requestedTab={chatLocation?.tab}
              onConversationOpened={conversationOpened}
              onSelectAgent={selectAgent}
              onWorking={setWorkingAgentId}
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
                connectionSignals={connectionSignals}
                onboarding={onboarding}
              />
            </main>
          )}
        </div>
        {phone ? null : <StatusBar status={status} onNavigate={navigate} />}
        </div>
        {askShown && frontDesk ? (
          <AskDock agent={frontDesk} agents={agents} timezone={timezone} open={askOpen} onOpenChange={setAskOpen} navigate={navigate} />
        ) : null}
        <ToastStack placement={toastPlacement(askShown, askOpen)}>
          <NotificationToasts queue={toasts.queue} agents={agents} navigate={navigate} onDismiss={toasts.dismiss} />
          {deletedGroup ? (
            <UndoToast
              key={deletedGroup.group.id}
              title={`Deleted ${deletedGroup.group.name}`}
              body="Its history goes for good in a few seconds."
              duration={GROUP_UNDO_SHOWN_MS}
              onUndo={undoDelete}
              onGone={() => setDeletedGroup(null)}
            />
          ) : null}
          {restoreFailed ? (
            <UndoToast key={`late-${restoreFailed}`} title={`${restoreFailed} is gone for good`} body="Undo came too late to bring it back." duration={6_000} onGone={() => setRestoreFailed(null)} />
          ) : null}
          <Toast.Viewport className="ui-toasts" />
        </ToastStack>
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
  /** Connections that need the owner: Home says so under the greeting. */
  connectionSignals?: ConnectionSignal[];
  /** First run, as the shell read it once: done (or skipped), still open, or not read yet. */
  onboarding?: OnboardingPhase;
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
          params={pluginRouteParams(props.hash)}
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
      return <Agents {...withPages} />;
    case ACTIVITY_ROUTE:
      return <Activity {...props} />;
    case SETTINGS_ROUTE:
      return <Settings {...withPages} />;
    case FILES_ROUTE:
      return <Files {...props} />;
    default:
      return <Home {...withPages} />;
  }
}
