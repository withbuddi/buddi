/**
 * The durable queue: what is waiting, what is running, what failed and is
 * waiting for a human. Retry and cancel are the same two verbs `buddi jobs`
 * offers, calling the same core functions.
 */
import { useEffect, useState } from 'react';
import { api, type JobRow } from '../api';
import { fmtRelative, fmtTime, json, short, truncate } from '../format';
import { Button, Code, Empty, ErrorBanner, PageFrame, Panel, Section, Sheet, StatePill, Table, Toolbar, useAsync } from '../ui';

const STATES = ['pending', 'leased', 'suspended', 'failed', 'succeeded', 'cancelled'] as const;
const PAGE = 50;

export function Jobs({ timezone, embedded, initialState }: { timezone: string; embedded?: boolean; initialState?: string }): JSX.Element {
  const [state, setState] = useState(initialState ?? '');
  const [selected, setSelected] = useState<JobRow | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { data, error, reload } = useAsync(
    () => api.jobs({ ...(state ? { state } : {}), limit: String(PAGE) }),
    [state],
    10_000,
  );
  const [older, setOlder] = useState<{ jobs: JobRow[]; done: boolean; busy: boolean }>({ jobs: [], done: false, busy: false });
  useEffect(() => { setOlder({ jobs: [], done: false, busy: false }); }, [state]);
  const loadOlder = async (): Promise<void> => {
    setOlder((o) => ({ ...o, busy: true }));
    try {
      const page = await api.jobs({ ...(state ? { state } : {}), limit: String(PAGE), offset: String(PAGE + older.jobs.length) });
      setOlder((o) => ({ jobs: [...o.jobs, ...page.jobs], done: page.jobs.length < PAGE, busy: false }));
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
      setOlder((o) => ({ ...o, busy: false }));
    }
  };
  const seen = new Set((data?.jobs ?? []).map((j) => j.id));
  const rows = [...(data?.jobs ?? []), ...older.jobs.filter((j) => !seen.has(j.id))];
  const total = state ? (data?.counts[state] ?? 0) : Object.values(data?.counts ?? {}).reduce((a, b) => a + b, 0);
  const more = !older.done && rows.length < total && (data?.jobs.length ?? 0) >= PAGE;

  /** The 38-at-once verbs: every failed job, retried or cancelled, one by one. */
  const [sweeping, setSweeping] = useState<string | null>(null);
  const sweep = async (verb: 'retry' | 'cancel'): Promise<void> => {
    setFailure(null);
    setSweeping(verb);
    try {
      const failed = (await api.jobs({ state: 'failed', limit: '500' })).jobs;
      for (const job of failed) await (verb === 'retry' ? api.retryJob(job.id) : api.cancelJob(job.id));
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setSweeping(null);
    }
  };

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
        {(data?.counts.failed ?? 0) > 0 ? (
          <>
            <span className="ui-toolbar-spacer" />
            <span className="muted">{data!.counts.failed} failed.</span>
            <Button size="sm" disabled={sweeping !== null} onClick={() => void sweep('retry')}>{sweeping === 'retry' ? 'Retrying…' : 'Retry all failed'}</Button>
            <Button size="sm" variant="danger" disabled={sweeping !== null} onClick={() => void sweep('cancel')}>{sweeping === 'cancel' ? 'Cancelling…' : 'Cancel all failed'}</Button>
          </>
        ) : null}
      </Toolbar>

      <ErrorBanner message={error ?? failure} />

      <Panel flush>
        {!data || rows.length === 0 ? (
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
              {rows.map((job) => (
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
                      {['pending', 'leased', 'suspended', 'failed'].includes(job.state) ? (
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
      {more ? (
        <Toolbar>
          <span className="muted">{rows.length} of {total} shown.</span>
          <span className="ui-toolbar-spacer" />
          <Button disabled={older.busy} onClick={() => void loadOlder()}>{older.busy ? 'Loading…' : 'Load older'}</Button>
        </Toolbar>
      ) : null}

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
