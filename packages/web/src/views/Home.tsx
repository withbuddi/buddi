/**
 * Home: the page the hub opens on.
 *
 * Three questions, in the order the owner asks them. What needs me? What is my
 * team up to? What is coming? Everything here is a door to somewhere else:
 * an approval decides in place, a face opens a conversation, a mission opens
 * the agent that runs it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApprovalRow, type ConversationSummary, type DigestRow, type DigestTally, type HomeBlock, type MissionRow, type AgentOfferRow, type OfferRow, type Overview, type ReminderRow, type VersionView } from '../api';
import type { ChatAgent } from '../chat/types';
import { fmtNumber, fmtRelative, fmtTime, truncate } from '../format';
import { agentRoute, chatRoute, ACTIVITY_ROUTE, AGENTS_ROUTE, settingsRoute, transcriptRoute } from '../routes';
import type { AgentAttention } from '../shell/roster';
import { orderAgents, waitingText } from '../shell/roster';
import { accentAttrs, accentOf } from '../shell/accent';
import {
  AgentAvatar,
  Avatar,
  Button,
  Empty,
  ErrorBanner,
  List,
  ListRow,
  Mascot,
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
import { DismissAll } from './parts/DismissOffers';
import { AgentOffer, isPendingAccept } from './parts/AgentOffer';

export function Home({
  timezone,
  navigate,
  agents,
  defaultAgentId,
  attention,
  update,
}: {
  timezone: string;
  navigate: (route: string) => void;
  agents: ChatAgent[];
  defaultAgentId?: string | null;
  attention: Map<string, AgentAttention>;
  /** A newer buddi, as the shell read it from `/version`. Never a checkout's. */
  update?: VersionView | null;
}): JSX.Element {
  const overview = useAsync<Overview>(() => api.overview(), [], 15_000);
  const approvals = useAsync(() => api.approvals(), [], 10_000);
  const missions = useAsync(() => api.missions(), [], 60_000);
  const reminders = useAsync(() => api.reminders(), [], 60_000);
  const conversations = useAsync(() => api.conversations(), [], 30_000);
  const offers = useAsync(() => api.offers(), [], 30_000);
  const proposals = useAsync(() => api.proposals(), [], 60_000);
  const agentOffers = useAsync(() => api.agentOffers(), [], 60_000);
  const owner = useAsync(() => api.owner(), []);
  // The same order as the rail and the Agents page: front desk first, the maker last.
  const team = useMemo(() => orderAgents(agents, defaultAgentId ?? null), [agents, defaultAgentId]);
  const { busy, note, failure, decide } = useDecide(() => { approvals.reload(); overview.reload(); });

  const data = overview.data;
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id;
  const go = (route: string) => (e: { preventDefault: () => void }): void => { e.preventDefault(); navigate(route); };

  const pending: ApprovalRow[] = approvals.data?.pending ?? [];
  const failedJobs = data?.jobs?.failed ?? 0;
  const urgent = data?.sentinels?.openUrgent ?? 0;
  const proposed = proposals.data?.open.length ?? 0;
  // An offer whose accept is already waiting is drawn once, as its card above.
  const toSetUp: AgentOfferRow[] = (agentOffers.data?.offers ?? []).filter(
    (offer) => !pending.some((action) => isPendingAccept(action, offer.plugin, offer.agent)),
  );
  const needs = pending.length + (failedJobs > 0 ? 1 : 0) + (urgent > 0 ? 1 : 0) + (data?.paused ? 1 : 0) + (proposed > 0 ? 1 : 0) + toSetUp.length;

  const upcoming = useMemo(() => upcomingOf(missions.data?.missions ?? [], reminders.data?.reminders ?? []), [missions.data, reminders.data]);
  const lately: ConversationSummary[] = (conversations.data?.conversations ?? []).slice(0, 5);
  const allOffers: OfferRow[] = offers.data?.offers ?? [];
  // Six, not eight and not all of them: a row of chips is read at a glance or
  // not at all, and the rest are one click away on a page built to hold them.
  const onOffer = allOffers.slice(0, HOME_OFFERS);
  const moreOffers = allOffers.length - onOffer.length;

  return (
    <>
      {/* The kit's hero: three short lines on the page's own field. */}
      <div className="home-band">
        <header className="home-hero">
          <div className="home-hero-text">
            <p className="home-date">{fmtDay(data?.now, timezone)}</p>
            <h1 className="home-greeting">{greeting(data?.now, timezone, owner.data?.preferredName || owner.data?.displayName)}</h1>
            <p className="home-lede">{needsSentence(needs, pending.length, failedJobs, urgent, data?.paused ?? false, proposed, toSetUp.length)}</p>
          </div>
          <Mascot size="lg" />
        </header>
      </div>
    <div className="home">
      {update && update.updateAvailable && !update.checkout && update.latest ? (
        <Notice tone="accent">
          A newer buddi is ready: <span className="mono">{update.latest}</span>.{' '}
          <a href={settingsRoute('system')} onClick={go(settingsRoute('system'))}>Upgrade from Settings → Version.</a>
        </Notice>
      ) : null}

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
                <a href={`${ACTIVITY_ROUTE}/jobs?state=failed`} onClick={go(`${ACTIVITY_ROUTE}/jobs?state=failed`)}>
                  {failedJobs} failed job{failedJobs === 1 ? '' : 's'}. See why, then retry or cancel them, one by one or all at once.
                </a>
              </Notice>
            ) : null}
            {urgent > 0 ? (
              <Notice tone="critical">
                <a href={`${ACTIVITY_ROUTE}/alerts`} onClick={go(`${ACTIVITY_ROUTE}/alerts`)}>
                  {urgent} urgent alert{urgent === 1 ? '' : 's'} from your watchers.
                </a>
              </Notice>
            ) : null}
            {/* An agent a plugin needs and nobody has yet: the plugin's line,
                the same accept the Plugins page runs, and a way to say no. */}
            {toSetUp.map((offer) => (
              <Panel key={`${offer.plugin}/${offer.agent}`}>
                <AgentOffer
                  plugin={offer.plugin}
                  agent={offer.agent}
                  text={offer.text}
                  label={`Create @${offer.handle}`}
                  handle={offer.handle}
                  onDismiss={() => { void api.dismissAgentOffer(offer.plugin, offer.agent).then(() => agentOffers.reload()); }}
                />
              </Panel>
            ))}
            {proposed > 0 ? (
              <Notice tone="accent">
                <a href={settingsRoute('proposals')} onClick={go(settingsRoute('proposals'))}>
                  {proposed} proposal{proposed === 1 ? '' : 's'} from your agents to keep or discard.
                </a>
              </Notice>
            ) : null}
            {(data?.sentinels?.errors ?? []).map((err) => (
              <Notice key={err.sentinelId} tone="warning">Watcher {err.sentinelId} failed: {err.error}</Notice>
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
          <Empty mascot>No agents yet. Add one under Agents.</Empty>
        ) : (
          <div className="home-team">
            {team.map((agent) => {
              const waiting = waitingText(attention.get(agent.id));
              return (
                <a
                  key={agent.id}
                  className="home-face"
                  {...accentAttrs(accentOf(agent))}
                  href={chatRoute(agent.id)}
                  onClick={go(chatRoute(agent.id))}
                  data-waiting={waiting ? 'true' : undefined}
                  data-unavailable={agent.available ? undefined : 'true'}
                >
                  <Avatar id={agent.id} name={agent.name} size="lg" unavailable={!agent.available} face={agent} />
                  <span className="home-face-text">
                    <span className="home-face-name">{agent.name}</span>
                    <span className="home-face-status">
                      {waiting ? capitalise(waiting) : agent.available ? truncate(agent.description, 60) : agent.unavailableReason ?? 'Cannot run right now.'}
                    </span>
                  </span>
                </a>
              );
            })}
          </div>
        )}
      </Section>

      {onOffer.length > 0 ? (
        <Section
          title="On offer"
          aside={
            <span className="ui-row">
              {moreOffers > 0 ? <a href={`${AGENTS_ROUTE}?tab=offers`} onClick={go(`${AGENTS_ROUTE}?tab=offers`)}>{moreOffers} more</a> : null}
              <DismissAll ids={allOffers.map((offer) => offer.id)} onDone={() => offers.reload()} />
            </span>
          }
        >
          <div className="home-offers">
            {onOffer.map((offer) => (
              <OfferChip
                key={offer.id}
                offer={offer}
                agents={agents}
                open={go(agentRoute(offer.agentId, 'offers'))}
                onDismissed={() => offers.reload()}
              />
            ))}
          </div>
        </Section>
      ) : null}

      {proposals.data?.digest?.latest ? (
        <LearnedThisWeek digest={proposals.data.digest.latest} go={go} />
      ) : null}

      <div className="home-columns">
        <Section title="Coming up" aside={<a href={`${AGENTS_ROUTE}?tab=missions`} onClick={go(`${AGENTS_ROUTE}?tab=missions`)}>All missions</a>}>
          <Panel flush>
            {upcoming.length === 0 ? (
              <Empty mascot>Nothing scheduled. Missions and reminders will show here.</Empty>
            ) : (
              <List>
                {upcoming.map((item) => (
                  <ListRow
                    key={item.key}
                    href={item.route}
                    onClick={() => navigate(item.route)}
                    lead={<AgentAvatar agents={agents} id={item.agentId} size="sm" />}
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
              <Empty mascot>Nothing has run yet. Say hello to someone on your team.</Empty>
            ) : (
              <List>
                {lately.map((c) => (
                  <ListRow
                    key={c.id}
                    href={chatRoute(c.agentId, c.id)}
                    onClick={() => navigate(chatRoute(c.agentId, c.id))}
                    lead={<AgentAvatar agents={agents} id={c.agentId} size="sm" />}
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

      {(data?.home ?? []).map((block) => (
        <HomeBlockView key={block.id} block={block} />
      ))}

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
    </>
  );
}

/** How many chips Home draws before it stops and says "N more". */
export const HOME_OFFERS = 6;

/** How long a thumb has to stay down for a touch to mean "not this one". */
export const LONG_PRESS_MS = 500;

/**
 * One chip: the offer, and the way out of it.
 *
 * The × appears on hover and on focus, so it is reachable with a keyboard and
 * invisible until it is wanted. A touch has neither, so a long press does the
 * same thing — the gesture a phone already uses for "I mean this one, not the
 * ordinary tap". A press that turns into a scroll or a short tap opens the
 * offer as it always did.
 */
function OfferChip({
  offer,
  agents,
  open,
  onDismissed,
}: {
  offer: OfferRow;
  agents: ChatAgent[];
  open: (e: { preventDefault: () => void }) => void;
  onDismissed: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressed = useRef(false);

  const dismiss = (): void => {
    if (busy) return;
    setBusy(true);
    void api.dismissOffer(offer.id).then(onDismissed).finally(() => setBusy(false));
  };
  const cancelPress = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  return (
    <span className="home-offer-chip">
      <a
        className="home-offer"
        href={agentRoute(offer.agentId, 'offers')}
        onClick={(e) => {
          // The long press already did something; the tap that ends it must
          // not also navigate.
          if (pressed.current) { pressed.current = false; e.preventDefault(); return; }
          open(e);
        }}
        title={offer.prompt}
        onTouchStart={() => {
          pressed.current = false;
          cancelPress();
          timer.current = setTimeout(() => { pressed.current = true; dismiss(); }, LONG_PRESS_MS);
        }}
        onTouchEnd={cancelPress}
        onTouchMove={cancelPress}
        onTouchCancel={cancelPress}
      >
        <AgentAvatar agents={agents} id={offer.agentId} size="sm" />
        <span>{offer.label}</span>
      </a>
      <button
        type="button"
        className="home-offer-x"
        aria-label={`Dismiss ${offer.label}`}
        disabled={busy}
        onClick={dismiss}
      >
        ×
      </button>
    </span>
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
  return items.sort((a, b) => a.at.localeCompare(b.at)).slice(0, 5);
}

function hourIn(iso: string | undefined, timezone: string): number {
  try {
    const text = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).format(iso ? new Date(iso) : new Date());
    return Number(text);
  } catch {
    return new Date().getHours();
  }
}

/** The time of day's greeting, by the owner's name when there is one: "Good evening, Amen." */
export function greeting(iso: string | undefined, timezone: string, name?: string | null): string {
  const hour = hourIn(iso, timezone);
  const to = name?.trim() ? `, ${name.trim()}` : '';
  if (hour < 5) return `Still up${to}?`;
  if (hour < 12) return `Good morning${to}.`;
  if (hour < 18) return `Good afternoon${to}.`;
  return `Good evening${to}.`;
}

function fmtDay(iso: string | undefined, timezone: string): string {
  try {
    const at = iso ? new Date(iso) : new Date();
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: timezone }).format(at);
    const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: timezone }).format(at);
    return `${weekday}, ${day}`;
  } catch {
    return fmtTime(iso ?? null, timezone);
  }
}

/** One kind's line on the digest card: the count, and up to three names. */
export function tallyLine(t: DigestTally, one: string, many: string): string | null {
  if (t.count === 0) return null;
  return `${t.count} ${t.count === 1 ? one : many}${t.names.length > 0 ? `: ${t.names.join('; ')}${t.count > t.names.length ? '; …' : ''}` : ''}`;
}

/** The latest weekly digest, until the next one replaces it. */
export function LearnedThisWeek({ digest, go }: { digest: DigestRow; go: (route: string) => (e: { preventDefault: () => void }) => void }): JSX.Element {
  const learned = [
    tallyLine(digest.memory, 'memory note', 'memory notes'),
    tallyLine(digest.skills, 'skill kept', 'skills kept'),
    tallyLine(digest.rules, 'rule kept', 'rules kept'),
    tallyLine(digest.changes, 'change to an agent kept', 'changes to agents kept'),
  ].filter((line): line is string => line !== null);
  const stopped =
    digest.stopped === null
      ? 'Not measured yet.'
      : digest.stopped.total > 0
        ? `Rules you kept acted ${digest.stopped.total} time${digest.stopped.total === 1 ? '' : 's'} (${Object.entries(digest.stopped.byPlugin)
            .filter(([, n]) => n > 0)
            .map(([plugin, n]) => `${plugin} ${n}`)
            .join(', ')}).`
        : 'No rule you kept acted this week.';
  return (
    <Section title="What buddi learned this week" aside={<span className="muted">{fmtRelative(digest.at)}</span>}>
      <Panel>
        <Stack divided>
          <div>
            <p className="ui-card-meta">Learned</p>
            {learned.length === 0 ? <p>Nothing new.</p> : <ul className="home-digest-list">{learned.map((line) => <li key={line}>{line}</li>)}</ul>}
          </div>
          <div>
            <p className="ui-card-meta">Proposes</p>
            <p>
              {digest.open > 0 ? (
                <a href={settingsRoute('proposals')} onClick={go(settingsRoute('proposals'))}>
                  {digest.open} proposal{digest.open === 1 ? '' : 's'} waiting for you to keep or discard.
                </a>
              ) : (
                'Nothing was waiting for you.'
              )}
            </p>
          </div>
          <div>
            <p className="ui-card-meta">Stopped doing</p>
            <p>{stopped}</p>
          </div>
        </Stack>
      </Panel>
    </Section>
  );
}

export function needsSentence(needs: number, approvals: number, failed: number, urgent: number, paused: boolean, proposals = 0, agentsToSetUp = 0): string {
  if (needs === 0) return 'Nothing needs you. Your agents are on it.';
  const parts: string[] = [];
  if (approvals > 0) parts.push(`${approvals} approval${approvals === 1 ? '' : 's'} waiting`);
  if (failed > 0) parts.push(`${failed} failed job${failed === 1 ? '' : 's'}`);
  if (urgent > 0) parts.push(`${urgent} urgent alert${urgent === 1 ? '' : 's'}`);
  if (paused) parts.push('the installation is paused');
  if (proposals > 0) parts.push(`${proposals} proposal${proposals === 1 ? '' : 's'} to review`);
  if (agentsToSetUp > 0) parts.push(`${agentsToSetUp === 1 ? 'an agent' : `${agentsToSetUp} agents`} to set up`);
  const list = parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${capitalise(list)}.`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A plugin's block. A sensitive one starts masked and is revealed for this
 * tab only; leaving the window masks it again, so a screen left unattended
 * shows the shape of the block and none of its figures.
 */
function HomeBlockView({ block }: { block: HomeBlock }): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const masked = block.sensitive === true && !revealed;
  useEffect(() => {
    if (!block.sensitive || !revealed) return undefined;
    const hide = (): void => { if (document.visibilityState === 'hidden') setRevealed(false); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('blur', hide);
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('blur', hide); };
  }, [block.sensitive, revealed]);

  const aside = (
    <span className="ui-row">
      {block.rows.length > 0 && block.rowsTitle && !masked ? <span className="muted">{block.rowsTitle.toLowerCase()} below</span> : null}
      {block.sensitive ? (
        <Button size="sm" variant="ghost" aria-pressed={!masked} onClick={() => setRevealed((v) => !v)}>
          {masked ? 'Show' : 'Hide'}
        </Button>
      ) : null}
    </span>
  );

  return (
    <Section title={block.title} aside={aside}>
      {block.note ? <Notice tone="warning">{block.note}</Notice> : null}
      {block.stats.length > 0 ? (
        <Stats>
          {block.stats.map((stat) => (
            <Stat key={stat.label} label={stat.label} value={masked ? '••••' : stat.value} note={masked ? undefined : stat.note} tone={masked ? undefined : stat.tone} />
          ))}
        </Stats>
      ) : null}
      {block.rows.length > 0 ? (
        masked ? (
          <p className="muted">{block.rows.length} item{block.rows.length === 1 ? '' : 's'} hidden.</p>
        ) : (
          <Panel flush>
            <List>
              {block.rows.map((row, i) => (
                <ListRow
                  key={`${row.title}-${i}`}
                  title={row.title}
                  sub={row.sub}
                  side={row.side ? <span className={row.tone === 'critical' ? 'critical' : row.tone === 'good' ? 'good' : undefined}>{row.side}</span> : undefined}
                />
              ))}
            </List>
          </Panel>
        )
      ) : null}
    </Section>
  );
}
