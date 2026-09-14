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
import { Empty, ErrorBanner, Panel, useAsync } from '../ui';

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
    <>
      <h2>Conversations</h2>
      <p className="lede">Every run, newest first — interactive turns, scheduled missions and source-started work alike.</p>
      <ErrorBanner message={error} />
      <div className="wrap">
        {!data || data.conversations.length === 0 ? (
          <Empty>Nothing has run yet.</Empty>
        ) : (
          <table>
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
                <tr key={c.id} className="clickable" onClick={() => onSelect(c.id)}>
                  <td className="mono">{c.agentId}</td>
                  <td>{c.opening ? truncate(c.opening, 90) : <span className="muted">(no opening text)</span>}</td>
                  <td className="num">{c.messageCount}</td>
                  <td className="num">{c.runs}</td>
                  <td className="num muted">
                    {fmtNumber(c.usage.input)} in / {fmtNumber(c.usage.output)} out
                  </td>
                  <td>
                    {fmtTime(c.lastMessageAt ?? c.createdAt, timezone)}
                    <div className="muted">{fmtRelative(c.lastMessageAt ?? c.createdAt)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
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
    <>
      <h2>
        <button onClick={onBack} style={{ marginRight: '10px' }}>
          ← back
        </button>
        Transcript
      </h2>
      <p className="lede mono">{id}</p>
      <ErrorBanner message={error} />
      {!transcript ? (
        <Empty>Loading…</Empty>
      ) : (
        <>
          <div className="cards">
            <div className="card">
              <div className="k">Agent</div>
              <div className="v">{transcript.agentId}</div>
            </div>
            <div className="card">
              <div className="k">Runs</div>
              <div className="v">{transcript.runs.length}</div>
            </div>
            <div className="card">
              <div className="k">Tokens</div>
              <div className="v">
                {fmtNumber(transcript.usage.input)} / {fmtNumber(transcript.usage.output)}
              </div>
              <div className="n">input / output</div>
            </div>
            <div className="card">
              <div className="k">Started</div>
              <div className="v" style={{ fontSize: '14px' }}>
                {fmtTime(transcript.createdAt, timezone)}
              </div>
            </div>
          </div>

          {transcript.runs.length > 0 ? (
            <Panel title="Runs">
              <table>
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
                      <td>
                        {fmtTime(run.startedAt, timezone)}
                        {run.resumed ? <span className="pill" style={{ marginLeft: 6 }}>resumed</span> : null}
                      </td>
                      <td>{fmtTime(run.finishedAt, timezone)}</td>
                      <td className="num">{run.turns ?? '—'}</td>
                      <td>
                        {run.stopped ?? '—'}
                        {run.actionId ? <div className="muted mono">action {short(run.actionId)}</div> : null}
                      </td>
                      <td className="num muted">
                        {fmtNumber(run.usage.input)} / {fmtNumber(run.usage.output)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ) : null}

          <h3>Messages</h3>
          {transcript.messages.map((message) => (
            <div className="msg" key={message.id}>
              <div className="who">
                {message.role} · {fmtTime(message.createdAt, timezone)}
              </div>
              <div className="body">
                {message.blocks.length === 0 ? <span className="muted">(empty)</span> : null}
                {message.blocks.map((block, i) => (
                  <Block key={i} block={block} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function Block({ block }: { block: TranscriptBlock }): JSX.Element {
  if (block.type === 'text') return <div className="text">{block.text}</div>;
  if (block.type === 'tool_use') {
    return (
      <div className="tool">
        <div className="name mono">→ {block.name}</div>
        <pre>{json(block.input)}</pre>
      </div>
    );
  }
  if (block.type === 'tool_result') {
    return (
      <div className={`tool ${block.isError ? 'err' : ''}`}>
        <div className="name mono">← {block.isError ? 'error' : 'result'}</div>
        <pre>{block.content ?? ''}</pre>
      </div>
    );
  }
  return (
    <div className="tool">
      <div className="name mono">{block.type}</div>
      <pre>{json(block.ref)}</pre>
    </div>
  );
}
