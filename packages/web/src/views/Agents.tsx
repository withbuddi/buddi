/**
 * Agents: the team, and one page per member.
 *
 * The index is the roster as people: a face, a name, what they do, whether
 * they can work right now. Beneath it the things the team schedules and
 * proposes, across everyone: missions, offers, reminders. One agent's page
 * holds the same things for that agent alone, plus how it is wired.
 */
import type { PlaceProps } from '../App';
import { chatApi } from '../api';
import type { ChatAgent } from '../chat/types';
import { fmtRelative, truncate } from '../format';
import { AGENTS_ROUTE, agentRoute, chatRoute, parseAgentRoute } from '../routes';
import { waitingText } from '../shell/roster';
import { Avatar, ButtonLink, Empty, List, ListRow, Panel, Pill, Sheet, Tab, Tabs, useAsync } from '../ui';
import { Missions } from './Missions';
import { Offers } from './Offers';
import { Reminders } from './Reminders';
import { AgentSetup } from './parts/AgentSetup';

const INDEX_TABS = [
  { id: 'team', label: 'Team' },
  { id: 'missions', label: 'Missions' },
  { id: 'offers', label: 'Offers' },
  { id: 'reminders', label: 'Reminders' },
] as const;

const AGENT_TABS = [
  { id: 'conversations', label: 'Conversations' },
  { id: 'missions', label: 'Missions' },
  { id: 'offers', label: 'Offers' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'setup', label: 'Setup' },
] as const;

export function Agents({ hash, timezone, navigate, agents, attention }: PlaceProps): JSX.Element {
  const location = parseAgentRoute(hash);
  const tab = /[?&]tab=([a-z]+)/.exec(hash)?.[1] ?? 'team';
  const go = (route: string) => (e: { preventDefault: () => void }): void => { e.preventDefault(); navigate(route); };
  return (
    <div className="ui-page">
      <header className="ui-page-head">
        <h2 className="ui-page-title">Agents</h2>
        <p className="ui-page-lede">The team you built. Each one runs on the account you gave it and asks before it does anything that leaves this machine.</p>
      </header>
      <Tabs>
        {INDEX_TABS.map((t) => (
          <Tab key={t.id} href={t.id === 'team' ? AGENTS_ROUTE : `${AGENTS_ROUTE}?tab=${t.id}`} active={tab === t.id} onClick={go(t.id === 'team' ? AGENTS_ROUTE : `${AGENTS_ROUTE}?tab=${t.id}`)}>
            {t.label}
          </Tab>
        ))}
      </Tabs>
      {tab === 'missions' ? <Missions timezone={timezone} embedded /> : null}
      {tab === 'offers' ? <Offers embedded /> : null}
      {tab === 'reminders' ? <Reminders timezone={timezone} embedded /> : null}
      {tab === 'team' ? (
        agents.length === 0 ? (
          <Empty>No agents are installed. Agent files live under the installation's agents directory.</Empty>
        ) : (
          <div className="team-grid">
            {agents.map((agent) => {
              const waiting = waitingText(attention.get(agent.id));
              return (
                <a key={agent.id} className="team-card" href={agentRoute(agent.id)} onClick={go(agentRoute(agent.id))} data-unavailable={agent.available ? undefined : 'true'}>
                  <Avatar id={agent.id} name={agent.name} size="xl" unavailable={!agent.available} face={agent} />
                  <span className="team-card-name">{agent.name}</span>
                  <span className="team-card-handle">@{agent.handle}</span>
                  <span className="team-card-desc">{agent.description}</span>
                  <span className="team-card-foot">
                    {waiting ? <Pill tone="critical">waiting for you</Pill> : agent.available ? <Pill tone="good">ready</Pill> : <Pill tone="warning">cannot run</Pill>}
                    <span className="muted">{agent.model}</span>
                  </span>
                </a>
              );
            })}
          </div>
        )
      ) : null}
      {location ? (
        <Sheet title={agents.find((a) => a.id === location.agentId)?.name ?? location.agentId} size="wide" onClose={() => navigate(AGENTS_ROUTE)}>
          <AgentPage
            agentId={location.agentId}
            agent={agents.find((a) => a.id === location.agentId)}
            tab={location.tab ?? 'conversations'}
            timezone={timezone}
            navigate={navigate}
            attention={attention}
          />
        </Sheet>
      ) : null}
    </div>
  );
}

function AgentPage({
  agentId,
  agent,
  tab,
  timezone,
  navigate,
  attention,
}: {
  agentId: string;
  agent: ChatAgent | undefined;
  tab: string;
  timezone: string;
  navigate: (route: string) => void;
  attention: PlaceProps['attention'];
}): JSX.Element {
  const go = (route: string) => (e: { preventDefault: () => void }): void => { e.preventDefault(); navigate(route); };
  const waiting = waitingText(attention.get(agentId));
  const name = agent?.name ?? agentId;
  return (
    <div className="ui-stack" data-gap="lg">
      <header className="agent-head">
        <Avatar id={agentId} name={name} size="xl" unavailable={agent ? !agent.available : false} face={agent} />
        <div className="agent-head-text">
          <p className="ui-page-lede">{agent?.description ?? 'This agent is not in the roster right now.'}</p>
          <div className="ui-row">
            {agent ? <span className="muted mono">@{agent.handle}</span> : null}
            {agent ? <span className="muted">{agent.model}</span> : null}
            {waiting ? <Pill tone="critical">{waiting}</Pill> : agent && !agent.available ? <Pill tone="warning">{agent.unavailableReason ?? 'cannot run'}</Pill> : null}
          </div>
        </div>
        <div className="ui-page-actions">
          <ButtonLink variant="accent" href={chatRoute(agentId)} onClick={go(chatRoute(agentId))}>Talk to {name}</ButtonLink>
        </div>
      </header>
      <Tabs>
        {AGENT_TABS.map((t) => (
          <Tab key={t.id} href={agentRoute(agentId, t.id)} active={tab === t.id} onClick={go(agentRoute(agentId, t.id))}>
            {t.label}
          </Tab>
        ))}
      </Tabs>
      {tab === 'conversations' ? <AgentConversations agentId={agentId} navigate={navigate} /> : null}
      {tab === 'missions' ? <Missions timezone={timezone} embedded agentId={agentId} /> : null}
      {tab === 'offers' ? <Offers embedded agentId={agentId} /> : null}
      {tab === 'reminders' ? <Reminders timezone={timezone} embedded agentId={agentId} /> : null}
      {tab === 'setup' ? <AgentSetup agentId={agentId} /> : null}
    </div>
  );
}

function AgentConversations({ agentId, navigate }: { agentId: string; navigate: (route: string) => void }): JSX.Element {
  const { data, error } = useAsync(() => chatApi.conversations(agentId, 50), [agentId]);
  if (error) return <Empty>{error}</Empty>;
  const rows = data?.conversations ?? [];
  return (
    <Panel flush>
      {!data ? (
        <Empty>Loading…</Empty>
      ) : rows.length === 0 ? (
        <Empty>No conversations yet.</Empty>
      ) : (
        <List>
          {rows.map((c) => (
            <ListRow
              key={c.id}
              href={chatRoute(agentId, c.id)}
              onClick={() => navigate(chatRoute(agentId, c.id))}
              title={truncate(c.preview || c.opening || 'Untitled conversation', 90)}
              sub={`${c.messageCount} message${c.messageCount === 1 ? '' : 's'}`}
              side={fmtRelative(c.lastMessageAt ?? c.startedAt ?? c.createdAt ?? null)}
            />
          ))}
        </List>
      )}
    </Panel>
  );
}
