/**
 * The durable queue: what is waiting, what is running, what failed and is
 * waiting for a human. Retry and cancel are the same two verbs `buddi jobs`
 * offers, calling the same core functions.
 */
import { useState } from 'react';
import { api, type JobRow } from '../api';
import { fmtRelative, fmtTime, json, short, truncate } from '../format';
import { Drawer, Empty, ErrorBanner, StatePill, useAsync } from '../ui';

const STATES = ['pending', 'leased', 'suspended', 'failed', 'succeeded', 'cancelled'] as const;

export function Jobs({ timezone }: { timezone: string }): JSX.Element {
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
    <>
      <h2>Jobs</h2>
      <p className="lede">
        {data?.paused ? 'PAUSED — nothing is being claimed. ' : ''}
        Bounded retries with backoff; past the budget a job waits for you.
      </p>

      <div className="bar">
        <select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">every state</option>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {s} ({data?.counts[s] ?? 0})
            </option>
          ))}
        </select>
        <button onClick={() => act(api.setPaused(!(data?.paused ?? false)))}>
          {data?.paused ? 'Resume the queue' : 'Pause the queue'}
        </button>
      </div>

      <ErrorBanner message={error ?? failure} />

      <div className="wrap">
        {!data || data.jobs.length === 0 ? (
          <Empty>No jobs match.</Empty>
        ) : (
          <table>
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
                    <div className="muted mono">{short(job.id)}</div>
                  </td>
                  <td>
                    <StatePill state={job.state} />
                    {job.suspendedReason ? <div className="muted">{truncate(job.suspendedReason, 40)}</div> : null}
                  </td>
                  <td className="num">
                    {job.attempts}/{job.maxAttempts}
                  </td>
                  <td className={job.lastError ? 'bad' : 'muted'}>
                    {job.lastError ? truncate(job.lastError, 80) : '—'}
                  </td>
                  <td>
                    {fmtTime(job.updatedAt, timezone)}
                    <div className="muted">{fmtRelative(job.updatedAt)}</div>
                  </td>
                  <td>
                    <div className="bar" style={{ margin: 0 }}>
                      {['failed', 'cancelled', 'suspended'].includes(job.state) ? (
                        <button onClick={() => act(api.retryJob(job.id))}>retry</button>
                      ) : null}
                      {['pending', 'leased', 'suspended'].includes(job.state) ? (
                        <button className="danger" onClick={() => act(api.cancelJob(job.id))}>
                          cancel
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected ? (
        <Drawer title={selected.kind} onClose={() => setSelected(null)}>
          <p className="muted mono">{selected.id}</p>
          <h3>Payload</h3>
          <pre>{json(selected.payload)}</pre>
          <h3>Result</h3>
          <pre>{json(selected.result)}</pre>
          {selected.conversationId ? (
            <p>
              <a href={`#/conversations/${selected.conversationId}`}>open the transcript</a>
            </p>
          ) : null}
        </Drawer>
      ) : null}
    </>
  );
}
