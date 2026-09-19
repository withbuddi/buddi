/**
 * Recent runs and their transcripts — the persona's own words, the tool calls
 * it made and what came back, and what each run cost in tokens.
 *
 * A tool result is shown as stored: the dashboard never re-renders it through a
 * model, and never hides an error.
 */
import { useEffect, useState } from 'react';
import { api, type ConversationSummary, type Transcript, type TranscriptBlock } from '../api';
import { fmtNumber, fmtRelative, fmtTime, json, short, truncate } from '../format';
import {
  Button,
  ButtonLink,
  Code,
  Empty,
  ErrorBanner,
  Page,
  PageHeader,
  Panel,
  Pill,
  Section,
  Stack,
  Stat,
  Stats,
  Table,
  useAsync,
} from '../ui';
import { chatRoute } from '../routes';

export function Conversations({
  timezone,
  selectedId,
  onSelect,
}: {
  timezone: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}): JSX.Element {
  const { data, error } = useAsync(() => api.conversations(), []);

  if (selectedId) return <TranscriptView id={selectedId} timezone={timezone} onBack={() => onSelect(null)} />;

  return (
    <Page>
      <PageHeader
        title="Conversations"
        lede="Every run, newest first — interactive turns, scheduled missions and source-started work alike."
      />
      <ErrorBanner message={error} />
      <Panel flush>
        {!data || data.conversations.length === 0 ? (
          <Empty>Nothing has run yet.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Opened with</th>
                <th className="num">Messages</th>
                <th className="num">Runs</th>
                <th className="num">Tokens</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {data.conversations.map((c: ConversationSummary) => (
                <tr key={c.id} data-clickable="true" onClick={() => onSelect(c.id)}>
                  <td className="mono">
                    <a href={chatRoute(c.agentId, c.id)} onClick={(event) => event.stopPropagation()} title="Open this conversation in chat">
                      {c.agentId} ↗
                    </a>
                  </td>
                  <td>{c.opening ? truncate(c.opening, 90) : <span className="muted">(no opening text)</span>}</td>
                  <td className="num">{c.messageCount}</td>
                  <td className="num">{c.runs}</td>
                  <td className="num muted nowrap">
                    {fmtNumber(c.usage.input)} in / {fmtNumber(c.usage.output)} out
                  </td>
                  <td className="nowrap">
                    {fmtTime(c.lastMessageAt ?? c.createdAt, timezone)}
                    <div className="sub">{fmtRelative(c.lastMessageAt ?? c.createdAt)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </Page>
  );
}

function TranscriptView({
  id,
  timezone,
  onBack,
}: {
  id: string;
  timezone: string;
  onBack: () => void;
}): JSX.Element {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .conversation(id)
      .then((t) => {
        if (!cancelled) setTranscript(t);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <Page>
      <PageHeader
        before={
          <Button size="sm" onClick={onBack}>
            ← Back
          </Button>
        }
        title="Transcript"
        lede={<span className="mono">{id}</span>}
        actions={
          transcript ? (
            <ButtonLink size="sm" href={chatRoute(transcript.agentId, id)}>
              Open in chat ↗
            </ButtonLink>
          ) : null
        }
      />
      <ErrorBanner message={error} />
      {!transcript ? (
        <Empty>Loading…</Empty>
      ) : (
        <>
          <Stats>
            <Stat label="Agent" value={transcript.agentId} size="sm" />
            <Stat label="Runs" value={transcript.runs.length} />
            <Stat
              label="Tokens"
              value={`${fmtNumber(transcript.usage.input)} / ${fmtNumber(transcript.usage.output)}`}
              note="input / output"
            />
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
                      <td className="nowrap">
                        {fmtTime(run.startedAt, timezone)} {run.resumed ? <Pill>resumed</Pill> : null}
                      </td>
                      <td className="nowrap">{fmtTime(run.finishedAt, timezone)}</td>
                      <td className="num">{run.turns ?? '—'}</td>
                      <td>
                        {run.stopped ?? '—'}
                        {run.actionId ? <div className="sub mono">action {short(run.actionId)}</div> : null}
                      </td>
                      <td className="num muted nowrap">
                        {fmtNumber(run.usage.input)} / {fmtNumber(run.usage.output)}
                      </td>
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
                    {message.role} · {fmtTime(message.createdAt, timezone)}
                  </header>
                  <div className="transcript-body">
                    {message.blocks.length === 0 ? <span className="muted">(empty)</span> : null}
                    {message.blocks.map((block, i) => (
                      <Block key={i} block={block} />
                    ))}
                  </div>
                </article>
              ))}
            </Stack>
          </Section>
        </>
      )}
    </Page>
  );
}

function Block({ block }: { block: TranscriptBlock }): JSX.Element {
  if (block.type === 'text') return <div className="transcript-text">{block.text}</div>;
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
