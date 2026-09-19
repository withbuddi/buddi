/**
 * Home: the page the hub opens on.
 *
 * Three questions, in the order the owner asks them. What needs me? What is my
 * team up to? What is coming? Everything here is a door to somewhere else:
 * an approval decides in place, a face opens a conversation, a mission opens
 * the agent that runs it.
 */
import { useMemo } from 'react';
import { api, type ApprovalRow, type ConversationSummary, type MissionRow, type OfferRow, type Overview, type ReminderRow } from '../api';
import type { ChatAgent } from '../chat/types';
import { fmtMoney, fmtNumber, fmtRelative, fmtTime, truncate } from '../format';
import { agentRoute, chatRoute, ACTIVITY_ROUTE, AGENTS_ROUTE, settingsRoute, transcriptRoute } from '../routes';
import type { AgentAttention } from '../shell/roster';
import { waitingText } from '../shell/roster';
import {
  Avatar,
  Button,
  Empty,
  ErrorBanner,
  List,
  ListRow,
  Notice,
  Panel,
  Pill,
  Section,
  Stack,
  Stat,
  Stats,
  useAsync,
} from '../ui';
import { ApprovalCard, useDecide } from './parts/ApprovalCard';

export function Home({
  timezone,
  navigate,
  agents,
  attention,
}: {
  timezone: string;
  navigate: (route: string) => void;
  agents: ChatAgent[];
  attention: Map<string, AgentAttention>;
}): JSX.Element {
  const overview = useAsync<Overview>(() => api.overview(), [], 15_000);
  const approvals = useAsync(() => api.approvals(), [], 10_000);
  const missions = useAsync(() => api.missions(), [], 60_000);
  const reminders = useAsync(() => api.reminders(), [], 60_000);
  const conversations = useAsync(() => api.conversations(), [], 30_000);
  const offers = useAsync(() => api.offers(), [], 30_000);
  const { busy, note, failure, decide } = useDecide(() => { approvals.reload(); overview.reload(); });

  const data = overview.data;
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id;
  const go = (route: string) => (e: { preventDefault: () => void }): void => { e.preventDefault(); navigate(route); };

  const pending: ApprovalRow[] = approvals.data?.pending ?? [];
  const failedJobs = data?.jobs?.failed ?? 0;
  const urgent = data?.sentinels?.openUrgent ?? 0;
  const needs = pending.length + (failedJobs > 0 ? 1 : 0) + (urgent > 0 ? 1 : 0) + (data?.paused ? 1 : 0);

  const upcoming = useMemo(() => upcomingOf(missions.data?.missions ?? [], reminders.data?.reminders ?? []), [missions.data, reminders.data]);
  const lately: ConversationSummary[] = (conversations.data?.conversations ?? []).slice(0, 8);
  const onOffer: OfferRow[] = offers.data?.offers ?? [];

  return (
    <div className="home">
      <header className="home-hero">
        <p className="home-date">{fmtDay(data?.now, timezone)}</p>
        <h1 className="home-greeting">{greeting(data?.now, timezone)}</h1>
        <p className="home-lede">{needsSentence(needs, pending.length, failedJobs, urgent, data?.paused ?? false)}</p>
      </header>

      <ErrorBanner message={overview.error ?? approvals.error ?? failure} />
      {note ? <Notice tone="good" role="status">{note}</Notice> : null}

      {needs > 0 ? (
        <Section title="Needs you">
          <Stack>
            {data?.paused ? (
              <Notice tone="warning" title="The installation is paused.">
                Nothing is being claimed until you resume it.{' '}
                <Button size="sm" onClick={() => { void api.setPaused(false).then(() => overview.reload()); }}>Resume</Button>
              </Notice>
            ) : null}
            {pending.map((action) => (
              <ApprovalCard key={action.id} action={action} timezone={timezone} busy={busy === action.id} onDecide={decide} agentName={nameOf(action.agentId)} />
            ))}
            {failedJobs > 0 ? (
              <Notice tone="critical">
                <a href={`${ACTIVITY_ROUTE}/jobs`} onClick={go(`${ACTIVITY_ROUTE}/jobs`)}>
                  {failedJobs} failed job{failedJobs === 1 ? '' : 's'} waiting for a retry or a cancel.
                </a>
              </Notice>
            ) : null}
            {urgent > 0 ? (
              <Notice tone="critical">
                <a href={settingsRoute('sentinels')} onClick={go(settingsRoute('sentinels'))}>
                  {urgent} urgent finding{urgent === 1 ? '' : 's'} from your sentinels.
                </a>
              </Notice>
            ) : null}
            {(data?.sentinels?.errors ?? []).map((err) => (
              <Notice key={err.sentinelId} tone="warning">Sentinel {err.sentinelId} failed: {err.error}</Notice>
            ))}
            {(data?.mail ?? []).filter((m) => m.lastError).map((source) => (
              <Notice key={source.sourceId} tone="warning">Source {source.sourceId}: {source.lastError}</Notice>
            ))}
          </Stack>
        </Section>
      ) : null}

      <Section
        title="Your team"
        aside={<a href={AGENTS_ROUTE} onClick={go(AGENTS_ROUTE)}>All agents</a>}
      >
        {agents.length === 0 ? (
          <Empty>No agents yet. Add one under Agents.</Empty>
        ) : (
          <div className="home-team">
            {agents.map((agent) => {
              const waiting = waitingText(attention.get(agent.id));
              return (
                <a
                  key={agent.id}
                  className="home-face"
                  href={chatRoute(agent.id)}
                  onClick={go(chatRoute(agent.id))}
                  data-waiting={waiting ? 'true' : undefined}
                  data-unavailable={agent.available ? undefined : 'true'}
                >
                  <Avatar id={agent.id} name={agent.name} size="lg" unavailable={!agent.available} />
                  <span className="home-face-text">
                    <span className="home-face-name">{agent.name}</span>
                    <span className="home-face-status">
                      {waiting ? capitalise(waiting) : agent.available ? truncate(agent.description, 60) : agent.unavailableReason ?? 'Cannot run right now'}
                    </span>
                  </span>
                </a>
              );
            })}
          </div>
        )}
      </Section>

      {onOffer.length > 0 ? (
        <Section title="On offer">
          <div className="home-offers">
            {onOffer.map((offer) => (
              <a key={offer.id} className="home-offer" href={agentRoute(offer.agentId, 'offers')} onClick={go(agentRoute(offer.agentId, 'offers'))} title={offer.prompt}>
                <Avatar id={offer.agentId} name={nameOf(offer.agentId)} size="sm" />
                <span>{offer.label}</span>
              </a>
            ))}
          </div>
        </Section>
      ) : null}

      <div className="home-columns">
        <Section title="Coming up">
          <Panel flush>
            {upcoming.length === 0 ? (
              <Empty>Nothing scheduled. Missions and reminders will show here.</Empty>
            ) : (
              <List>
                {upcoming.map((item) => (
                  <ListRow
                    key={item.key}
                    href={item.route}
                    onClick={() => navigate(item.route)}
                    lead={<Avatar id={item.agentId} name={nameOf(item.agentId)} size="sm" />}
                    title={item.title}
                    sub={`${item.kind} for ${nameOf(item.agentId)}`}
                    side={fmtRelative(item.at)}
                  />
                ))}
              </List>
            )}
          </Panel>
        </Section>

        <Section title="Lately" aside={<a href={ACTIVITY_ROUTE} onClick={go(ACTIVITY_ROUTE)}>All activity</a>}>
          <Panel flush>
            {lately.length === 0 ? (
              <Empty>Nothing has run yet. Say hello to someone on your team.</Empty>
            ) : (
              <List>
                {lately.map((c) => (
                  <ListRow
                    key={c.id}
                    href={chatRoute(c.agentId, c.id)}
                    onClick={() => navigate(chatRoute(c.agentId, c.id))}
                    lead={<Avatar id={c.agentId} name={nameOf(c.agentId)} size="sm" />}
                    title={c.opening ? truncate(c.opening, 80) : 'Untitled conversation'}
                    sub={`${nameOf(c.agentId)}, ${c.messageCount} message${c.messageCount === 1 ? '' : 's'}`}
                    side={fmtRelative(c.lastMessageAt ?? c.createdAt)}
                  />
                ))}
              </List>
            )}
          </Panel>
        </Section>
      </div>

      {data?.finance?.available ? (
        <Section title="Money" aside={data.finance.upcoming.length > 0 ? <span className="muted">next 14 days below</span> : null}>
          <Stats>
            <Stat label="Cash" value={fmtMoney(data.finance.cashTotal, data.finance.currency)} note="spendable accounts" />
            <Stat label="Net worth" value={fmtMoney(data.finance.netWorth, data.finance.currency)} note="cash + held − debt" />
            <Stat label="Debt" value={fmtMoney(data.finance.totalDebt, data.finance.currency)} note="recorded liabilities" />
            <Stat
              label="Low point (14d)"
              value={fmtMoney(data.finance.minBalance, data.finance.currency)}
              note={data.finance.minBalanceDate ?? ''}
              tone={data.finance.breachesFloor ? 'critical' : undefined}
            />
          </Stats>
          {data.finance.upcoming.length > 0 ? (
            <Panel flush>
              <List>
                {data.finance.upcoming.flatMap((day) =>
                  day.events.map((event, i) => (
                    <ListRow
                      key={`${day.date}-${i}`}
                      title={event.name}
                      sub={i === day.events.length - 1 ? `${day.date}, balance after ${fmtMoney(day.balance, data.finance.currency)}` : day.date}
                      side={<span className={event.amount < 0 ? 'critical' : 'good'}>{fmtMoney(event.amount, data.finance.currency)}</span>}
                    />
                  )),
                )}
              </List>
            </Panel>
          ) : null}
        </Section>
      ) : null}

      {data?.jobs && data.missions ? (
        <p className="home-foot muted">
          {fmtNumber(data.jobs.pending ?? 0)} queued, {fmtNumber(data.jobs.leased ?? 0)} running, {fmtNumber(data.missions.enabled)} of {fmtNumber(data.missions.total)} missions on.{' '}
          {data.paused ? <Pill tone="warning">paused</Pill> : <Pill tone="good">running</Pill>}{' '}
          <a href={transcriptRoute('').replace(/\/conversations\/$/, '')} onClick={go(ACTIVITY_ROUTE)}>Activity</a>
          {' · '}
          <a href={settingsRoute('system')} onClick={go(settingsRoute('system'))}>System</a>
        </p>
      ) : null}
    </div>
  );
}

interface Upcoming { key: string; at: string; title: string; kind: 'Mission' | 'Reminder'; agentId: string; route: string }

function upcomingOf(missions: MissionRow[], reminders: ReminderRow[]): Upcoming[] {
  const items: Upcoming[] = [];
  for (const m of missions) {
    if (m.enabled && m.nextRun) items.push({ key: `m-${m.id}`, at: m.nextRun, title: m.name, kind: 'Mission', agentId: m.agentId, route: agentRoute(m.agentId, 'missions') });
  }
  for (const r of reminders) {
    if (r.state === 'pending') items.push({ key: `r-${r.id}`, at: r.dueAt, title: r.text, kind: 'Reminder', agentId: r.agentId, route: agentRoute(r.agentId, 'reminders') });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 8);
}

function hourIn(iso: string | undefined, timezone: string): number {
  try {
    const text = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).format(iso ? new Date(iso) : new Date());
    return Number(text);
  } catch {
    return new Date().getHours();
  }
}

export function greeting(iso: string | undefined, timezone: string): string {
  const hour = hourIn(iso, timezone);
  if (hour < 5) return 'Still up?';
  if (hour < 12) return 'Good morning.';
  if (hour < 18) return 'Good afternoon.';
  return 'Good evening.';
}

function fmtDay(iso: string | undefined, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: timezone }).format(iso ? new Date(iso) : new Date());
  } catch {
    return fmtTime(iso ?? null, timezone);
  }
}

export function needsSentence(needs: number, approvals: number, failed: number, urgent: number, paused: boolean): string {
  if (needs === 0) return 'Nothing needs you. Your agents are on it.';
  const parts: string[] = [];
  if (approvals > 0) parts.push(`${approvals} approval${approvals === 1 ? '' : 's'} waiting`);
  if (failed > 0) parts.push(`${failed} failed job${failed === 1 ? '' : 's'}`);
  if (urgent > 0) parts.push(`${urgent} urgent finding${urgent === 1 ? '' : 's'}`);
  if (paused) parts.push('the installation is paused');
  const list = parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${capitalise(list)}.`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
