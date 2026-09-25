/**
 * Activity: everything that ran, in one place.
 *
 * Conversations are the human-readable stream; jobs, events and approvals are
 * the same work seen from the queue, the log and the decisions. One page, four
 * tabs, so nobody has to know which table holds what they remember seeing.
 */
import { useEffect, useState } from 'react';
import type { PlaceProps } from '../App';
import { api, type ConversationSummary, type Transcript, type TranscriptBlock } from '../api';
import { Markdown } from '../chat/markdown';
import { fmtNumber, fmtRelative, fmtTime, json, short, truncate } from '../format';
import { ACTIVITY_ROUTE, chatRoute, transcriptRoute } from '../routes';
import { AgentAvatar, Button, ButtonLink, Code, Empty, ErrorBanner, List, ListRow, PageHeader, Panel, Pill, Section, Stack, Stat, StatePill, Stats, Tab, Table, Tabs, useAsync, EmptyState } from '../ui';
import { Alerts } from './Alerts';
import { Events } from './Events';
import { Jobs } from './Jobs';

const TABS = [
  { id: 'conversations', label: 'Conversations' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'events', label: 'Events' },
] as const;

export function Activity({ hash, timezone, navigate, agents }: PlaceProps): JSX.Element {
  const transcript = /^#\/activity\/conversations\/(.+)$/.exec(hash);
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id;
  if (transcript) {
    let id = transcript[1]!;
    try { id = decodeURIComponent(id); } catch { /* keep as typed */ }
    return <TranscriptView id={id} timezone={timezone} navigate={navigate} nameOf={nameOf} />;
  }
  const tab = /^#\/activity\/([a-z]+)/.exec(hash)?.[1] ?? 'conversations';
  const wantedState = /[?&]state=([a-z]+)/.exec(hash)?.[1];
  const go = (route: string) => (e: { preventDefault: () => void }): void => { e.preventDefault(); navigate(route); };
  return (
    <div className="ui-page">
      <PageHeader
        title="Activity"
        lede="Everything your agents ran, newest first."
        actions={<PauseAll />}
      />
      <QueueStats />
      <Tabs>
        {TABS.map((t) => {
          const href = t.id === 'conversations' ? ACTIVITY_ROUTE : `${ACTIVITY_ROUTE}/${t.id}`;
          return (
            <Tab key={t.id} href={href} active={tab === t.id} onClick={go(href)}>
              {t.label}
            </Tab>
          );
        })}
      </Tabs>
      {tab === 'conversations' ? <Conversations timezone={timezone} navigate={navigate} nameOf={nameOf} agents={agents} /> : null}
      {tab === 'jobs' ? <Jobs key={wantedState ?? ''} timezone={timezone} embedded initialState={wantedState} /> : null}
      {tab === 'approvals' ? <ApprovalHistory timezone={timezone} nameOf={nameOf} /> : null}
      {tab === 'alerts' ? <Alerts timezone={timezone} embedded /> : null}
      {tab === 'events' ? <Events timezone={timezone} embedded /> : null}
    </div>
  );
}

function Conversations({ timezone, navigate, nameOf, agents }: { timezone: string; navigate: (r: string) => void; nameOf: (id: string) => string; agents: PlaceProps['agents'] }): JSX.Element {
  const { data, error } = useAsync(() => api.conversations(), [], 30_000);
  return (
    <>
      <ErrorBanner message={error} />
      <Panel flush>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.conversations.length === 0 ? (
          <EmptyState icon="activity" title="Nothing has run yet">Conversations and runs show up here as your agents work.</EmptyState>
        ) : (
          <List>
            {data.conversations.map((c: ConversationSummary) => (
              <ListRow
                key={c.id}
                href={transcriptRoute(c.id)}
                onClick={() => navigate(transcriptRoute(c.id))}
                lead={<AgentAvatar agents={agents} id={c.agentId} size="sm" />}
                title={c.opening ? truncate(c.opening, 100) : 'Untitled conversation'}
                sub={`${nameOf(c.agentId)}, ${c.messageCount} message${c.messageCount === 1 ? '' : 's'}, ${c.runs} run${c.runs === 1 ? '' : 's'}, ${fmtNumber(c.usage.input)} in / ${fmtNumber(c.usage.output)} out`}
                side={<span title={fmtTime(c.lastMessageAt ?? c.createdAt, timezone)}>{fmtRelative(c.lastMessageAt ?? c.createdAt)}</span>}
              />
            ))}
          </List>
        )}
      </Panel>
    </>
  );
}

function ApprovalHistory({ timezone, nameOf }: { timezone: string; nameOf: (id: string) => string }): JSX.Element {
  const { data, error } = useAsync(() => api.approvals(), [], 10_000);
  const rows = [...(data?.pending ?? []), ...(data?.recent ?? [])];
  return (
    <>
      <ErrorBanner message={error} />
      <Panel flush>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : rows.length === 0 ? (
          <EmptyState icon="bell" title="No approvals yet">When an agent asks before acting, the request and your answer are kept here.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>State</th>
                <th>Asked by</th>
                <th>Decided</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((action) => (
                <tr key={action.id}>
                  <td>
                    {action.tool}
                    <div className="sub mono">{short(action.id)}</div>
                  </td>
                  <td><StatePill state={action.state} /></td>
                  <td>{nameOf(action.agentId)}</td>
                  <td className="nowrap">
                    {action.decidedAt ? (
                      <>
                        {fmtTime(action.decidedAt, timezone)}
                        <div className="sub">via {action.decidedVia ?? '—'}</div>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="nowrap">
                    {fmtTime(action.createdAt, timezone)}
                    <div className="sub">{fmtRelative(action.createdAt)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}

function TranscriptView({ id, timezone, navigate, nameOf }: { id: string; timezone: string; navigate: (r: string) => void; nameOf: (id: string) => string }): JSX.Element {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .conversation(id)
      .then((t) => { if (!cancelled) setTranscript(t); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [id]);

  const go = (route: string) => (e: { preventDefault: () => void }): void => { e.preventDefault(); navigate(route); };
  return (
    <div className="ui-page">
      <p className="page-crumbs">
        <a href={ACTIVITY_ROUTE} onClick={go(ACTIVITY_ROUTE)}>Activity</a>
      </p>
      <header className="ui-page-head">
        <div className="ui-page-head-row">
          <h2 className="ui-page-title">
            <Button size="sm" onClick={() => navigate(ACTIVITY_ROUTE)}>← Back</Button>
            <span>Transcript</span>
          </h2>
          {transcript ? (
            <div className="ui-page-actions">
              <ButtonLink size="sm" href={chatRoute(transcript.agentId, id)} onClick={go(chatRoute(transcript.agentId, id))}>Open in chat</ButtonLink>
            </div>
          ) : null}
        </div>
        <p className="ui-page-lede mono">{id}</p>
      </header>
      <ErrorBanner message={error} />
      {!transcript ? (
        <Empty>Loading…</Empty>
      ) : (
        <>
          <Stats>
            <Stat label="Agent" value={nameOf(transcript.agentId)} size="sm" />
            <Stat label="Runs" value={transcript.runs.length} />
            <Stat label="Tokens" value={`${fmtNumber(transcript.usage.input)} / ${fmtNumber(transcript.usage.output)}`} note="input / output" />
            <Stat label="Started" value={fmtTime(transcript.createdAt, timezone)} size="sm" />
          </Stats>

          {transcript.runs.length > 0 ? (
            <Panel title="Runs" flush>
              <Table>
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Finished</th>
                    <th className="num">Turns</th>
                    <th>Stopped</th>
                    <th className="num">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {transcript.runs.map((run, i) => (
                    <tr key={i}>
                      <td className="nowrap">{fmtTime(run.startedAt, timezone)} {run.resumed ? <Pill>resumed</Pill> : null}</td>
                      <td className="nowrap">{fmtTime(run.finishedAt, timezone)}</td>
                      <td className="num">{run.turns ?? '—'}</td>
                      <td>
                        {run.stopped ?? '—'}
                        {run.actionId ? <div className="sub mono">action {short(run.actionId)}</div> : null}
                      </td>
                      <td className="num muted nowrap">{fmtNumber(run.usage.input)} / {fmtNumber(run.usage.output)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Panel>
          ) : null}

          <Section title="Messages">
            <Stack>
              {transcript.messages.map((message) => (
                <article className="transcript-msg" key={message.id}>
                  <header className="transcript-who">
                    {/* The turn a resumed run opens with is a decided action
                        coming back, not the owner typing. */}
                    {message.speaker === APPROVAL_RESUME_SPEAKER ? 'approved action, result' : message.role}
                    , {fmtTime(message.createdAt, timezone)}
                  </header>
                  <div className="transcript-body">
                    {message.blocks.length === 0 ? <span className="muted">(empty)</span> : null}
                    {message.speaker === APPROVAL_RESUME_SPEAKER
                      ? message.blocks.map((block, i) => <ApprovedAction key={i} block={block} />)
                      : message.blocks.map((block, i) => <Block key={i} block={block} />)}
                  </div>
                </article>
              ))}
            </Stack>
          </Section>
        </>
      )}
    </div>
  );
}

/**
 * The turn a resumed run opens with, as what it is.
 *
 * The runtime delivers a decided action's outcome as a user turn — the
 * tool_use it answers was closed before the run suspended — so Activity, which
 * reads as a record of what the owner did, draws it as the tool result it is.
 */
const APPROVAL_RESUME_SPEAKER = 'approval:resume';

function ApprovedAction({ block }: { block: TranscriptBlock }): JSX.Element {
  return (
    <div className="transcript-tool">
      <div className="transcript-tool-name mono">← approved action</div>
      <Code>{block.type === 'text' ? (block.text ?? '') : json(block)}</Code>
    </div>
  );
}

function Block({ block }: { block: TranscriptBlock }): JSX.Element {
  if (block.type === 'text') return <div className="transcript-text"><Markdown text={block.text ?? ''} /></div>;
  if (block.type === 'thinking') {
    return (
      <details className="transcript-thinking">
        <summary>Thoughts</summary>
        <div className="transcript-thinking-text"><Markdown text={block.text ?? ''} /></div>
      </details>
    );
  }
  if (block.type === 'tool_use') {
    return (
      <div className="transcript-tool">
        <div className="transcript-tool-name mono">→ {block.name}</div>
        <Code>{json(block.input)}</Code>
      </div>
    );
  }
  if (block.type === 'tool_result') {
    return (
      <div className="transcript-tool" data-tone={block.isError ? 'critical' : undefined}>
        <div className="transcript-tool-name mono">← {block.isError ? 'error' : 'result'}</div>
        <Code>{block.content ?? ''}</Code>
      </div>
    );
  }
  return (
    <div className="transcript-tool">
      <div className="transcript-tool-name mono">{block.type}</div>
      <Code>{json(block.ref)}</Code>
    </div>
  );
}

/** The kit's header action: the whole queue paused or resumed at once. */
function PauseAll(): JSX.Element | null {
  const { data, reload } = useAsync(() => api.overview(), [], 10_000);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const flip = (): void => {
    setBusy(true);
    api.setPaused(!data.paused).then(reload, reload).finally(() => setBusy(false));
  };
  return (
    <Button size="sm" variant={data.paused ? 'accent' : undefined} disabled={busy} onClick={flip}>
      {data.paused ? 'Resume all' : 'Pause all'}
    </Button>
  );
}

/** The kit's figures over the tabs, from the queue's own counts. */
function QueueStats(): JSX.Element | null {
  const { data } = useAsync(() => api.overview(), [], 10_000);
  if (!data) return null;
  const count = (state: string): number => data.jobs[state] ?? 0;
  const running = count('leased');
  return (
    <Stats>
      <Stat label="Jobs done" value={fmtNumber(count('succeeded'))} />
      <Stat label="Failed" value={fmtNumber(count('failed'))} {...(count('failed') > 0 ? { tone: 'critical' as const } : {})} />
      <Stat label="Queued" value={fmtNumber(count('pending'))} note={`${running} running`} />
      <Stat label="Approvals" value={fmtNumber(data.approvals.pending)} note="waiting for you" />
    </Stats>
  );
}
