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
import { api, chatApi } from './api';
import { ChatPage } from './chat/ChatPage';
import type { ChatAgent } from './chat/types';
import {
  ACTIVITY_ROUTE,
  AGENTS_ROUTE,
  CHAT_ROUTE,
  HOME_ROUTE,
  PLACES,
  SETTINGS_ROUTE,
  chatRoute,
  legacyRedirect,
  parseChatRoute,
  placeOf,
} from './routes';
import { AgentRail } from './shell/AgentRail';
import { Rail } from './shell/Rail';
import { groupAgents, useAttention } from './shell/roster';
import { applyTheme, readTheme, storeTheme, type ThemeChoice } from './theme';
import { Activity } from './views/Activity';
import { Agents } from './views/Agents';
import { Home } from './views/Home';
import { Settings } from './views/Settings';

export { PLACES };

/** The width below which the canvas stops being a column and becomes a sheet. */
export const NARROW_QUERY = '(max-width: 900px)';

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
  /*
   * The roster lives in the shell, because the rail that draws it does. One
   * selection, one order, one source of "who is waiting".
   */
  const [agents, setAgents] = useState<ChatAgent[]>([]);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const attention = useAttention();
  const railNarrow = useMediaQuery(AGENT_RAIL_QUERY);

  // The old hashes, sent where their content went. Replaced, not pushed, so
  // Back does not bounce between the two.
  useEffect(() => {
    const target = legacyRedirect(hash);
    if (target) navigate(target, true);
  }, [hash, navigate]);

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

  const place = placeOf(hash);
  const onChat = place === CHAT_ROUTE;

  return (
    <Tooltip.Provider delayDuration={400}>
      <Toast.Provider swipeDirection="right">
        <div className="wb">
          <Rail
            attention={badges.approvals + badges.failed}
            place={place}
            onNavigate={navigate}
            theme={theme}
            onTheme={setTheme}
          />

          {onChat && !railNarrow ? (
            <AgentRail
              agents={ordered}
              currentId={selectedAgentId}
              attention={attention}
              onSelect={selectAgent}
            />
          ) : null}

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
            />
          ) : (
            <main>
              <Place
                hash={hash}
                place={place}
                timezone={timezone}
                navigate={navigate}
                agents={agents}
                attention={attention}
              />
            </main>
          )}
        </div>
        <Toast.Viewport className="ui-toasts" />
      </Toast.Provider>
    </Tooltip.Provider>
  );
}

export interface PlaceProps {
  hash: string;
  timezone: string;
  navigate: (next: string, replace?: boolean) => void;
  agents: ChatAgent[];
  attention: ReturnType<typeof useAttention>;
}

function Place({ place, ...props }: PlaceProps & { place: string }): JSX.Element {
  switch (place) {
    case AGENTS_ROUTE:
      return <Agents {...props} />;
    case ACTIVITY_ROUTE:
      return <Activity {...props} />;
    case SETTINGS_ROUTE:
      return <Settings {...props} />;
    default:
      return <Home {...props} />;
  }
}
