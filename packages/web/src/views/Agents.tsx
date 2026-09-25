/**
 * Agents: the team, and one page per member.
 *
 * The index is the roster as people: a face, a name, what they do, whether
 * they can work right now. Beneath it the things the team schedules and
 * proposes, across everyone: missions, offers, reminders. One agent's page
 * holds the same things for that agent alone, plus how it is wired.
 */
import { useState } from 'react';
import type { PlaceProps } from '../App';
import { api, chatApi, type AgentsView, type DefaultAgentView } from '../api';
import type { ChatAgent } from '../chat/types';
import { fmtRelative, truncate } from '../format';
import { AGENTS_ROUTE, agentRoute, chatRoute, parseAgentRoute, settingsRoute } from '../routes';
import { ROLE_MAKER, cannotRunFix, cannotRunSentence, orderAgents, waitingText } from '../shell/roster';
import { Avatar, Button, ButtonLink, Empty, ErrorBanner, List, ListRow, Notice, PageHeader, Panel, Pill, Sheet, Tab, Tabs, Tag, Toolbar, useAsync, EmptyState } from '../ui';
import { Missions } from './Missions';
import { Offers } from './Offers';
import { Memory } from './Memory';
import { AgentSkills } from './parts/AgentSkills';
import { Reminders } from './Reminders';
import { AgentSetup } from './parts/AgentSetup';
import { accentAttrs, accentOf } from '../shell/accent';

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
  { id: 'memory', label: 'Memory' },
  { id: 'skills', label: 'Skills' },
  { id: 'setup', label: 'Setup' },
] as const;

export function Agents({ hash, timezone, navigate, agents, attention, defaultAgentId: shellDefault }: PlaceProps): JSX.Element {
  const location = parseAgentRoute(hash);
  const tab = /[?&]tab=([a-z]+)/.exec(hash)?.[1] ?? 'team';
  const go = (route: string) => (e: { preventDefault: () => void }): void => { e.preventDefault(); navigate(route); };
  const team = useAsync(() => api.agents(), []);
  const offers = useAsync(() => api.offers(), [], 20_000);
  const offerCount = offers.data?.offers.length ?? 0;
  const defaultAgentId = team.data?.default?.defaultAgentId ?? shellDefault ?? null;
  // A new agent is a conversation with the maker, found by its role: the same
  // door the profile's "Ask the maker to change this" opens, nothing made here.
  const maker = agents.find((a) => a.roles.includes(ROLE_MAKER));
  return (
    <div className="ui-page">
      <PageHeader
        title="Agents"
        lede="Your team. Each one is a file on this Mac — what it can reach is listed on its page."
        actions={maker ? <ButtonLink variant="accent" href={chatRoute(maker.id)} onClick={go(chatRoute(maker.id))}>Add an agent</ButtonLink> : null}
      />
      <Tabs>
        {INDEX_TABS.map((t) => (
          <Tab key={t.id} href={t.id === 'team' ? AGENTS_ROUTE : `${AGENTS_ROUTE}?tab=${t.id}`} active={tab === t.id} count={t.id === 'offers' ? offerCount : undefined} onClick={go(t.id === 'team' ? AGENTS_ROUTE : `${AGENTS_ROUTE}?tab=${t.id}`)}>
            {t.label}
          </Tab>
        ))}
      </Tabs>
      {tab === 'missions' ? <Missions timezone={timezone} embedded /> : null}
      {tab === 'offers' ? <Offers embedded /> : null}
      {tab === 'reminders' ? <Reminders timezone={timezone} embedded /> : null}
      {tab === 'team' ? <DefaultAgentPicker data={team.data} error={team.error} reload={team.reload} /> : null}
      {tab === 'team' ? (
        agents.length === 0 ? (
          <EmptyState icon="agents" title="No agents yet">Each agent is a file in the installation's agents folder.</EmptyState>
        ) : (
          <div className="agents-grid">
            {orderAgents(agents, defaultAgentId).map((agent) => {
              const waiting = waitingText(attention.get(agent.id));
              return (
                /*
                 * The kit's agent card. The name is the card's link, stretched
                 * over the whole card, so Talk can sit inside it without
                 * nesting one link in another. A card opens on Conversations;
                 * Setup is a tab away.
                 */
                <div key={agent.id} className="ui-card agent-card" data-interactive="true" {...accentAttrs(accentOf(agent))} data-unavailable={agent.available ? undefined : 'true'}>
                  <div className="agent-card-top" />
                  <div className="agent-card-face">
                    <Avatar id={agent.id} name={agent.name} size="xl" unavailable={!agent.available} face={agent} />
                  </div>
                  <div>
                    <div className="ui-card-title">
                      <a className="agent-card-link" href={agentRoute(agent.id, 'conversations')} onClick={go(agentRoute(agent.id, 'conversations'))}>{agent.name}</a>
                      <span className="agent-card-handle mono faint">@{agent.handle}</span>
                    </div>
                    <p className="ui-card-meta agent-card-desc">{agent.description}</p>
                  </div>
                  <div className="ui-row">
                    {agent.id === defaultAgentId ? <Tag>front desk</Tag> : null}
                    {/* The reason, not just the fact: "cannot run" alone sends
                        the owner hunting for what is missing. */}
                    {waiting ? <Pill tone="critical" dot>waiting for you</Pill> : agent.available ? <Pill tone="good" dot>ready</Pill> : <Pill tone="warning">{truncate(agent.unavailableReason ?? 'cannot run', 60)}</Pill>}
                    <Pill mono>{agent.model}</Pill>
                    <ButtonLink className="agent-card-talk" size="sm" href={chatRoute(agent.id)} onClick={go(chatRoute(agent.id))} aria-label={`Talk to ${agent.name}`}>Talk</ButtonLink>
                  </div>
                </div>
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
            agents={agents}
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

/**
 * Who answers when you name nobody.
 *
 * This is a fact about the installation, not about a persona, so it is a
 * choice made once at the head of the team rather than a checkbox buried in
 * five agents' pages. The choice is recorded and wins over whatever the files
 * say; when the files disagree the notice says so in the owner's words and
 * points at the picker directly below it, which is the fix.
 */
function DefaultAgentPicker({ data, error, reload }: { data: AgentsView | null | undefined; error: string | null | undefined; reload: () => void }): JSX.Element | null {
  const view: DefaultAgentView | undefined = data?.default;
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (error) return <ErrorBanner message={error} />;
  if (!view || view.choices.length === 0) return null;

  const current = view.defaultAgentId;
  const value = chosen ?? current ?? '';
  const dirty = value !== '' && value !== current;
  const problem = view.problem;
  const named = (ids: readonly string[]): string =>
    ids.map((id) => view.choices.find((c) => c.id === id)?.name ?? id).join(' and ');

  const save = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setNote(null);
    try {
      const result = await api.setDefaultAgent(value);
      setNote(result.note);
      setChosen(null);
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /* One compact row on the kit's panel: what it is, the choice, Save. */
  return (
    <Panel>
      <div className="ui-stack">
        <ErrorBanner message={failure} />
        {problem?.code === 'multiple-defaults' ? (
          <Notice tone="warning" role="status">
            {`Two agents claim default in their files: ${named(problem.agents)}. The one chosen here wins.`}
          </Notice>
        ) : problem?.code === 'no-default-agent' ? (
          <Notice tone="warning" role="status">
            No agent file claims the default and this installation has not recorded one. Choose who answers
            when you name nobody.
          </Notice>
        ) : null}
        {note ? <Notice tone="good" role="status">{note}</Notice> : null}
        <Toolbar>
          <div className="default-agent-text">
            <h3 className="default-agent-title">Default agent</h3>
            <span className="ui-field-hint">Where a chat that names nobody lands.</span>
          </div>
          <span className="ui-toolbar-spacer" />
          <select
            aria-label="Default agent"
            value={value}
            disabled={busy}
            onChange={(e) => setChosen(e.target.value)}
          >
            {value === '' ? <option value="">Choose an agent</option> : null}
            {view.choices.map((c) => (
              <option key={c.id} value={c.id} disabled={!c.available}>
                {c.name} @{c.handle}
                {c.available ? '' : ' (cannot run)'}
              </option>
            ))}
          </select>
          <Button variant="accent" disabled={busy || !dirty} onClick={() => void save()}>
            Save
          </Button>
        </Toolbar>
      </div>
    </Panel>
  );
}

function AgentPage({
  agentId,
  agent,
  agents,
  tab,
  timezone,
  navigate,
  attention,
}: {
  agentId: string;
  agent: ChatAgent | undefined;
  agents: ChatAgent[];
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
      {agent && !agent.available ? (
        <Notice tone="warning" role="status">
          {cannotRunSentence(agent)} <a href={settingsRoute(cannotRunFix(agent).section)}>{cannotRunFix(agent).label}</a>
        </Notice>
      ) : null}
      <Tabs>
        {AGENT_TABS.map((t) => (
          <Tab key={t.id} href={agentRoute(agentId, t.id)} active={tab === t.id} onClick={go(agentRoute(agentId, t.id))}>
            {t.label}
          </Tab>
        ))}
      </Tabs>
      {tab === 'conversations' ? <AgentConversations agentId={agentId} navigate={navigate} /> : null}
      {tab === 'missions' ? <Missions timezone={timezone} embedded agentId={agentId} /> : null}
      {tab === 'offers' ? <Offers embedded agentId={agentId} agentName={name} /> : null}
      {tab === 'reminders' ? <Reminders timezone={timezone} embedded agentId={agentId} /> : null}
      {tab === 'memory' ? <Memory embedded agents={agents} timezone={timezone} agentId={agentId} /> : null}
      {tab === 'skills' ? <AgentSkills agentId={agentId} agentName={name} /> : null}
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
        <EmptyState icon="chat" title="No conversations yet">Say hello, and the conversation shows up here.</EmptyState>
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
