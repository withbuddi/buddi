/**
 * The shell: a left nav and one view at a time.
 *
 * Routing is the URL hash, so the page needs no server routes and a reload
 * lands where the owner was. `#/conversations/<id>` is the only nested route.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Agents } from './views/Agents';
import { Approvals } from './views/Approvals';
import { Conversations } from './views/Conversations';
import { Events } from './views/Events';
import { Jobs } from './views/Jobs';
import { Missions } from './views/Missions';
import { Overview } from './views/Overview';
import { Reminders } from './views/Reminders';
import { Sentinels } from './views/Sentinels';

export const NAV = [
  { route: '#/', label: 'Overview' },
  { route: '#/events', label: 'Events' },
  { route: '#/conversations', label: 'Conversations' },
  { route: '#/missions', label: 'Missions' },
  { route: '#/approvals', label: 'Approvals' },
  { route: '#/jobs', label: 'Jobs' },
  { route: '#/reminders', label: 'Reminders' },
  { route: '#/sentinels', label: 'Sentinels' },
  { route: '#/agents', label: 'Agents' },
] as const;

export function useHash(): [string, (next: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((next: string) => {
    window.location.hash = next;
  }, []);
  return [hash, navigate];
}

export function App(): JSX.Element {
  const [hash, navigate] = useHash();
  const [timezone, setTimezone] = useState('UTC');
  const [badges, setBadges] = useState<{ approvals: number; failed: number }>({ approvals: 0, failed: 0 });

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
        .then((o) => setBadges({ approvals: o.approvals.pending, failed: o.jobs.failed ?? 0 }))
        .catch(() => {});
    };
    refresh();
    const handle = window.setInterval(refresh, 20_000);
    return () => window.clearInterval(handle);
  }, []);

  const conversationId = /^#\/conversations\/(.+)$/.exec(hash)?.[1] ?? null;
  const section = conversationId ? '#/conversations' : (hash || '#/');

  return (
    <div className="shell">
      <nav className="side">
        <h1>buddi</h1>
        <p className="tz">{timezone}</p>
        {NAV.map((item) => (
          <a
            key={item.route}
            href={item.route}
            className={section === item.route ? 'active' : ''}
            onClick={(e) => {
              e.preventDefault();
              navigate(item.route);
            }}
          >
            <span>{item.label}</span>
            {item.route === '#/approvals' && badges.approvals > 0 ? (
              <span className="badge">{badges.approvals}</span>
            ) : null}
            {item.route === '#/jobs' && badges.failed > 0 ? <span className="badge">{badges.failed}</span> : null}
          </a>
        ))}
      </nav>
      <main>
        <View hash={section} conversationId={conversationId} timezone={timezone} navigate={navigate} />
      </main>
    </div>
  );
}

function View({
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
