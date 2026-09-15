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
import { api } from './api';
import { ChatPage } from './chat/ChatPage';
import { CHAT_ROUTE, NAV, SECTIONS } from './routes';
import { Rail } from './shell/Rail';
import { applyTheme, readTheme, storeTheme, type ThemeChoice } from './theme';
import { Agents } from './views/Agents';
import { Approvals } from './views/Approvals';
import { Conversations } from './views/Conversations';
import { Events } from './views/Events';
import { Jobs } from './views/Jobs';
import { Missions } from './views/Missions';
import { Overview } from './views/Overview';
import { Reminders } from './views/Reminders';
import { Sentinels } from './views/Sentinels';

export { NAV, SECTIONS };

/** The width below which the canvas stops being a column and becomes a sheet. */
export const NARROW_QUERY = '(max-width: 900px)';

export function useHash(): [string, (next: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash || CHAT_ROUTE);
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash || CHAT_ROUTE);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((next: string) => {
    window.location.hash = next;
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
  const onChat = section === CHAT_ROUTE || section === '#' || section === '';

  return (
    <Tooltip.Provider delayDuration={400}>
      <Toast.Provider swipeDirection="right">
        <div className="wb">
          <Rail
            badges={badges}
            onNavigate={navigate}
            theme={theme}
            onTheme={setTheme}
            onNewConversation={() => {
              setNewConversation((count) => count + 1);
              if (!onChat) navigate(CHAT_ROUTE);
            }}
          />

          {onChat ? (
            <ChatPage
              timezone={timezone}
              narrow={narrow}
              canvasOpen={canvasOpen}
              onOpenCanvas={() => setCanvasOpen(true)}
              onCloseCanvas={() => setCanvasOpen(false)}
              newConversationSignal={newConversation}
            />
          ) : (
            <main className="flex-1 min-w-0 overflow-auto">
              <div className="max-w-[1100px]">
                <p className="muted text-[12px] mb-2">
                  <a href={CHAT_ROUTE} onClick={goTo(navigate, CHAT_ROUTE)}>
                    ← Chat
                  </a>
                  <span className="ml-3">{timezone}</span>
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
        <Toast.Viewport className="wb-toasts" />
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
    case '#/reminders':
      return <Reminders timezone={timezone} />;
    case '#/sentinels':
      return <Sentinels timezone={timezone} />;
    case '#/agents':
      return <Agents />;
    default:
      return <Overview timezone={timezone} onNavigate={navigate} />;
  }
}
