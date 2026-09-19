/**
 * The shell.
 *
 * Chat is the landing route and owns the window: a conversation column driving
 * a canvas. The nine monitoring pages are unchanged and still reachable at the
 * routes they always had — they simply sit behind the rail now, because the
 * point of the dashboard is the work, not the instrumentation of the work.
 *
 * Routing is still the URL hash, so there are still no server routes and a
 * reload still lands where the owner was.
 */
import * as Toast from '@radix-ui/react-toast';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useCallback, useEffect, useState } from 'react';
import { api, chatApi } from './api';
import { ChatPage } from './chat/ChatPage';
import type { ChatAgent } from './chat/types';
import { CHAT_ROUTE, NAV, SECTIONS, chatRoute, parseChatRoute } from './routes';
import { AgentRail } from './shell/AgentRail';
import { Rail } from './shell/Rail';
import { groupAgents, useAttention } from './shell/roster';
import { applyTheme, readTheme, storeTheme, type ThemeChoice } from './theme';
import { Agents } from './views/Agents';
import { Providers } from './views/Providers';
import { Browser } from './views/Browser';
import { Approvals } from './views/Approvals';
import { Conversations } from './views/Conversations';
import { Events } from './views/Events';
import { Jobs } from './views/Jobs';
import { Missions } from './views/Missions';
import { Overview } from './views/Overview';
import { Offers } from './views/Offers';
import { Reminders } from './views/Reminders';
import { Sentinels } from './views/Sentinels';

export { NAV, SECTIONS };

/** The width below which the canvas stops being a column and becomes a sheet. */
export const NARROW_QUERY = '(max-width: 900px)';

/**
 * The width below which the *agent* rail lies down.
 *
 * Deliberately higher than the canvas breakpoint. Two 56px rails, a 320px
 * minimum conversation and a canvas need about a thousand pixels before any of
 * them has room to be read; below that the agent rail is the one that gives
 * way, because it is the cheapest to lay flat — a horizontal strip in the
 * conversation header keeps every face one tap away and every badge in sight,
 * which a menu would not.
 */
export const AGENT_RAIL_QUERY = '(max-width: 1080px)';

export function useHash(): [string, (next: string, replace?: boolean) => void] {
  const [hash, setHash] = useState(() => window.location.hash || CHAT_ROUTE);
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash || CHAT_ROUTE);
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

/** A media query as state, degrading to "wide" where `matchMedia` is absent. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let list: MediaQueryList;
    try {
      list = window.matchMedia(query);
    } catch {
      return undefined;
    }
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, [query]);
  return matches;
}

export function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [theme, setTheme] = useState<ThemeChoice>(() => readTheme());
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const choose = useCallback((choice: ThemeChoice) => {
    setTheme(choice);
    storeTheme(choice);
  }, []);
  return [theme, choose];
}

export function App(): JSX.Element {
  const [hash, navigate] = useHash();
  const [timezone, setTimezone] = useState('UTC');
  const [badges, setBadges] = useState<{ approvals: number; failed: number }>({ approvals: 0, failed: 0 });
  const [theme, setTheme] = useThemeChoice();
  const narrow = useMediaQuery(NARROW_QUERY);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [newConversation, setNewConversation] = useState(0);
  /*
   * The roster lives in the shell, because the rail that draws it does. One
   * selection, one order, one source of "who is waiting" — a second copy inside
   * the chat page would be a second thing to keep right.
   */
  const [agents, setAgents] = useState<ChatAgent[]>([]);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const attention = useAttention();
  const railNarrow = useMediaQuery(AGENT_RAIL_QUERY);

  useEffect(() => {
    let cancelled = false;
    chatApi
      .agents()
      .then((list) => {
        if (cancelled) return;
        setAgents(list.agents);
        setDefaultAgentId(list.defaultAgentId ?? null);
        setAgentId((current) => current ?? list.defaultAgentId ?? list.agents[0]?.id ?? null);
      })
      .catch(() => {
        /* No server, or no session. The rail is empty rather than broken. */
      });
    return () => {
      cancelled = true;
    };
  }, [hash]);

  const ordered = groupAgents(agents, defaultAgentId);
  const chatLocation = parseChatRoute(hash);
  const selectedAgentId = chatLocation?.agentId ?? agentId;
  useEffect(() => {
    if (chatLocation) setAgentId(chatLocation.agentId);
  }, [chatLocation?.agentId]);
  const selectAgent = (id: string): void => { setAgentId(id); navigate(chatRoute(id)); };
  const conversationOpened = useCallback((id: string, conversation: string, replace = true) => navigate(chatRoute(id, conversation), replace), [navigate]);

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

  const conversationId = /^#\/conversations\/(.+)$/.exec(hash)?.[1] ?? null;
  const section = conversationId ? '#/conversations' : hash || CHAT_ROUTE;
  const onChat = !!chatLocation || section === CHAT_ROUTE || section === '#' || section === '';

  return (
    <Tooltip.Provider delayDuration={400}>
      <Toast.Provider swipeDirection="right">
        <div className="wb">
          <Rail
            badges={badges}
            onNavigate={navigate}
            onChat={onChat}
            theme={theme}
            onTheme={setTheme}
            onNewConversation={() => {
              setNewConversation((count) => count + 1);
              navigate(selectedAgentId ? chatRoute(selectedAgentId, 'new') : CHAT_ROUTE);
            }}
          />

          {railNarrow ? null : (
            <AgentRail
              agents={ordered}
              currentId={selectedAgentId}
              attention={attention}
              onSelect={selectAgent}
            />
          )}

          {onChat ? (
            <ChatPage
              timezone={timezone}
              agents={ordered}
              agentId={selectedAgentId}
              requestedConversationId={chatLocation?.conversationId}
              onConversationOpened={conversationOpened}
              onSelectAgent={selectAgent}
              attention={attention}
              agentsInHeader={railNarrow}
              narrow={narrow}
              canvasOpen={canvasOpen}
              onOpenCanvas={() => setCanvasOpen(true)}
              onCloseCanvas={() => setCanvasOpen(false)}
              newConversationSignal={newConversation}
            />
          ) : (
            <main>
              <div>
                <p className="page-crumbs">
                  <a href={CHAT_ROUTE} onClick={goTo(navigate, CHAT_ROUTE)}>
                    ← Chat
                  </a>
                  <span>{timezone}</span>
                </p>
                <Section
                  hash={section}
                  conversationId={conversationId}
                  timezone={timezone}
                  navigate={navigate}
                />
              </div>
            </main>
          )}
        </div>
        <Toast.Viewport className="ui-toasts" />
      </Toast.Provider>
    </Tooltip.Provider>
  );
}

function goTo(navigate: (next: string) => void, route: string) {
  return (event: { preventDefault: () => void }): void => {
    event.preventDefault();
    navigate(route);
  };
}

function Section({
  hash,
  conversationId,
  timezone,
  navigate,
}: {
  hash: string;
  conversationId: string | null;
  timezone: string;
  navigate: (next: string) => void;
}): JSX.Element {
  switch (hash) {
    case '#/browser':
      return <Browser />;
    case '#/events':
      return <Events timezone={timezone} />;
    case '#/conversations':
      return (
        <Conversations
          timezone={timezone}
          selectedId={conversationId}
          onSelect={(id) => navigate(id ? `#/conversations/${id}` : '#/conversations')}
        />
      );
    case '#/missions':
      return <Missions timezone={timezone} />;
    case '#/approvals':
      return <Approvals timezone={timezone} />;
    case '#/jobs':
      return <Jobs timezone={timezone} />;
    case '#/offers':
      return <Offers timezone={timezone} />;
    case '#/reminders':
      return <Reminders timezone={timezone} />;
    case '#/sentinels':
      return <Sentinels timezone={timezone} />;
    case '#/agents':
      return <Agents />;
    case '#/providers':
      return <Providers />;
    default:
      return <Overview timezone={timezone} onNavigate={navigate} />;
  }
}
