/**
 * The durable queue: what is waiting, what is running, what failed and is
 * waiting for a human. Retry and cancel are the same two verbs `buddi jobs`
 * offers, calling the same core functions.
 */
import { useState } from 'react';
import { api, type JobRow } from '../api';
import { fmtRelative, fmtTime, json, short, truncate } from '../format';
import { Button, Code, Empty, ErrorBanner, PageFrame, Panel, Section, Sheet, StatePill, Table, Toolbar, useAsync } from '../ui';

const STATES = ['pending', 'leased', 'suspended', 'failed', 'succeeded', 'cancelled'] as const;

export function Jobs({ timezone, embedded }: { timezone: string; embedded?: boolean }): JSX.Element {
  const [state, setState] = useState('');
  const [selected, setSelected] = useState<JobRow | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { data, error, reload } = useAsync(
    () => api.jobs(state ? { state } : {}),
    [state],
    10_000,
  );

  const act = async (work: Promise<unknown>): Promise<void> => {
    setFailure(null);
    try {
      await work;
      setSelected(null);
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <PageFrame
      embedded={embedded}
      title="Jobs"
      lede={`${data?.paused ? 'Paused: nothing is being claimed. ' : ''}Bounded retries with backoff; past the budget a job waits for you.`}
      actions={
        <Button size="sm" variant={data?.paused ? 'accent' : undefined} onClick={() => act(api.setPaused(!(data?.paused ?? false)))}>
          {data?.paused ? 'Resume the queue' : 'Pause the queue'}
        </Button>
      }
    >

      <Toolbar>
        <select aria-label="Job state" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">every state</option>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {s} ({data?.counts[s] ?? 0})
            </option>
          ))}
        </select>
      </Toolbar>

      <ErrorBanner message={error ?? failure} />

      <Panel flush>
        {!data || data.jobs.length === 0 ? (
          <Empty>No jobs match.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>State</th>
                <th className="num">Attempts</th>
                <th>Last error</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((job) => (
                <tr key={job.id}>
                  <td className="clickable" onClick={() => setSelected(job)}>
                    {job.kind}
                    <div className="sub mono">{short(job.id)}</div>
                  </td>
                  <td>
                    <StatePill state={job.state} />
                    {job.suspendedReason ? <div className="sub">{truncate(job.suspendedReason, 40)}</div> : null}
                  </td>
                  <td className="num">
                    {job.attempts}/{job.maxAttempts}
                  </td>
                  <td className={job.lastError ? 'critical' : 'muted'}>
                    {job.lastError ? truncate(job.lastError, 80) : '—'}
                  </td>
                  <td className="nowrap">
                    {fmtTime(job.updatedAt, timezone)}
                    <div className="sub">{fmtRelative(job.updatedAt)}</div>
                  </td>
                  <td>
                    <Toolbar align="end">
                      {['failed', 'cancelled', 'suspended'].includes(job.state) ? (
                        <Button size="sm" onClick={() => act(api.retryJob(job.id))}>
                          Retry
                        </Button>
                      ) : null}
                      {['pending', 'leased', 'suspended'].includes(job.state) ? (
                        <Button size="sm" variant="danger" onClick={() => act(api.cancelJob(job.id))}>
                          Cancel
                        </Button>
                      ) : null}
                    </Toolbar>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      {selected ? (
        <Sheet title={selected.kind} onClose={() => setSelected(null)}>
          <p className="muted mono">{selected.id}</p>
          <Section title="Payload">
            <Code>{json(selected.payload)}</Code>
          </Section>
          <Section title="Result">
            <Code>{json(selected.result)}</Code>
          </Section>
          {selected.conversationId ? (
            <p>
              <a href={`#/conversations/${selected.conversationId}`}>open the transcript</a>
            </p>
          ) : null}
        </Sheet>
      ) : null}
    </PageFrame>
  );
}
