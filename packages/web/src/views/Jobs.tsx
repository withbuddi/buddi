/**
 * The durable queue: what is waiting, what is running, and — first, while
 * there are any — what failed and is waiting for a human.
 *
 * Failed jobs are decisions, not rows: grouped by what broke them ("Gemini
 * quota (429) · 4"), each group with one plain sentence on why and whether a
 * retry has a chance (the kit's Jobs.jsx; core/src/queue/failures.ts). Retry
 * puts them back in line; Dismiss keeps them on record and takes them out of
 * the footer's count, with Undo. A failed job older than 14 days is dismissed
 * on its own. Retry, cancel and dismiss are the verbs `buddi jobs` offers,
 * calling the same core functions.
 */
import { useEffect, useState } from 'react';
import { api, type FailureGroup, type JobRow } from '../api';
import { UndoToast } from '../shell/UndoToast';
import { fmtMoment, fmtRelative, fmtTime, json, short, truncate } from '../format';
import { Button, Code, Empty, ErrorBanner, Icon, PageFrame, Panel, Section, Sheet, StatePill, Table, Toolbar, useAsync } from '../ui';

const STATES = ['pending', 'leased', 'suspended', 'failed', 'succeeded', 'cancelled'] as const;
const PAGE = 50;
const UNDO_MS = 10_000;

type Toast = { id: number; title: string; body?: string; undo?: () => Promise<unknown> };

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

export function Jobs({ timezone, embedded, initialState }: { timezone: string; embedded?: boolean; initialState?: string }): JSX.Element {
  const [state, setState] = useState(initialState ?? '');
  const [selected, setSelected] = useState<JobRow | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  // "failed" is the decisions view: the groups are the list, there is no table under them.
  const failedView = state === 'failed';
  const { data, error, reload } = useAsync(
    () => api.jobs({ ...(state ? { state } : {}), ...(state ? {} : { dismissed: '0' }), limit: String(PAGE) }),
    [state],
    10_000,
  );
  const failures = useAsync(() => api.jobFailures(), [], 10_000);
  const [older, setOlder] = useState<{ jobs: JobRow[]; done: boolean; busy: boolean }>({ jobs: [], done: false, busy: false });
  useEffect(() => { setOlder({ jobs: [], done: false, busy: false }); }, [state]);
  const loadOlder = async (): Promise<void> => {
    setOlder((o) => ({ ...o, busy: true }));
    try {
      const page = await api.jobs({ ...(state ? { state } : { dismissed: '0' }), limit: String(PAGE), offset: String(PAGE + older.jobs.length) });
      setOlder((o) => ({ jobs: [...o.jobs, ...page.jobs], done: page.jobs.length < PAGE, busy: false }));
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
      setOlder((o) => ({ ...o, busy: false }));
    }
  };
  const seen = new Set((data?.jobs ?? []).map((j) => j.id));
  const rows = [...(data?.jobs ?? []), ...older.jobs.filter((j) => !seen.has(j.id))];
  const counts = data?.counts ?? {};
  const total = state ? (counts[state] ?? 0) : STATES.reduce((n, s) => n + (counts[s] ?? 0), 0);
  const more = !older.done && rows.length < total && (data?.jobs.length ?? 0) >= PAGE;

  const open = failures.data?.open ?? [];
  const dismissed = failures.data?.dismissed ?? [];
  const openCount = open.reduce((n, g) => n + g.count, 0);
  const dismissedCount = dismissed.reduce((n, g) => n + g.count, 0);

  const refresh = (): void => { reload(); failures.reload(); };
  const say = (t: Omit<Toast, 'id'>): void => setToast({ ...t, id: Date.now() });
  const attempt = async (work: () => Promise<void>): Promise<void> => {
    setFailure(null);
    try { await work(); }
    catch (err) { setFailure(err instanceof Error ? err.message : String(err)); }
    finally { refresh(); }
  };
  const act = async (work: Promise<unknown>): Promise<void> => {
    await attempt(async () => { await work; setSelected(null); });
  };

  const dismiss = (ids: string[] | 'all'): Promise<void> =>
    attempt(async () => {
      const { ids: done } = await api.dismissJobs(ids === 'all' ? { all: true } : { ids });
      if (done.length === 0) return;
      say({
        title: `Dismissed ${done.length === 1 ? 'it' : done.length}`,
        body: 'Kept under Dismissed, below.',
        undo: () => api.undismissJobs(done),
      });
    });
  const retry = (ids: string[], likelyFixed: boolean): Promise<void> =>
    attempt(async () => {
      const { jobs } = await api.retryJobs({ ids });
      if (jobs.length === 0) return;
      const one = jobs.length === 1;
      say({
        title: `Retrying ${one ? 'it' : jobs.length}`,
        body: likelyFixed
          ? `${one ? 'It runs' : 'They run'} as soon as a worker is free.`
          : `If what broke ${one ? 'it' : 'them'} hasn’t changed, ${one ? 'it' : 'they'} will fail the same way.`,
      });
    });

  return (
    <PageFrame
      embedded={embedded}
      title="Jobs"
      lede={`${data?.paused ? 'Paused: nothing is being claimed. ' : ''}Bounded retries with backoff; past the budget a job waits for you.`}
      actions={embedded ? undefined : (
        <Button size="sm" variant={data?.paused ? 'accent' : undefined} onClick={() => act(api.setPaused(!(data?.paused ?? false)))}>
          {data?.paused ? 'Resume the queue' : 'Pause the queue'}
        </Button>
      )}
    >
      <ErrorBanner message={error ?? failures.error ?? failure} />

      {open.length > 0 ? (
        <Panel
          flush
          title="Gave up"
          tool={String(openCount)}
          actions={openCount > 1 ? <Button size="sm" variant="ghost" onClick={() => void dismiss('all')}>Dismiss all</Button> : undefined}
        >
          <ul className="al-list">
            {open.map((g) => (
              <FailureRow key={g.key} group={g} timezone={timezone} onOpen={setSelected}
                onRetry={(ids) => void retry(ids, g.likelyFixed)} onDismiss={(ids) => void dismiss(ids)} />
            ))}
          </ul>
          <p className="al-recap">
            <span>These will not run again on their own. Dismissed jobs stay on record; any failed job older than 14 days is dismissed for you.</span>
          </p>
        </Panel>
      ) : failedView && failures.data ? (
        <Panel flush>
          <div className="al-empty">
            <Icon name="check" />
            <div>
              <p className="al-empty-title">No failed job needs you.</p>
              <p className="al-empty-line">{dismissedCount > 0 ? 'The ones you dismissed stay on record, below.' : 'Every job either ran or is still on its way.'}</p>
            </div>
          </div>
        </Panel>
      ) : null}

      {dismissedCount > 0 || failedView ? (
        <p className="al-quiet jb-quiet">
          {dismissedCount > 0 ? (
            <button type="button" className="wb-link" aria-expanded={showDismissed} onClick={() => setShowDismissed((v) => !v)}>
              {dismissedCount} dismissed
            </button>
          ) : null}
          {dismissedCount > 0 && failedView ? <span aria-hidden="true">·</span> : null}
          {failedView ? <button type="button" className="wb-link" onClick={() => setState('')}>Show the whole queue</button> : null}
        </p>
      ) : null}
      {showDismissed && dismissed.length > 0 ? (
        <Panel flush title="Dismissed">
          <ul className="al-list">
            {dismissed.map((g) => (
              <FailureRow key={g.key} group={g} timezone={timezone} dismissed onOpen={setSelected}
                onRetry={(ids) => void retry(ids, g.likelyFixed)} />
            ))}
          </ul>
        </Panel>
      ) : null}

      {failedView ? null : (
        <Panel
          flush
          title="Queue"
          actions={(
            <select aria-label="Job state" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">every state</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {s} ({counts[s] ?? 0})
                </option>
              ))}
            </select>
          )}
        >
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
                      {job.acknowledgedAt ? <div className="sub">dismissed</div> : null}
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
      )}
      {more && !failedView ? (
        <Toolbar>
          <span className="muted">{rows.length} of {total} shown.</span>
          <span className="ui-toolbar-spacer" />
          <Button disabled={older.busy} onClick={() => void loadOlder()}>{older.busy ? 'Loading…' : 'Load older'}</Button>
        </Toolbar>
      ) : null}

      {selected ? (
        <Sheet title={selected.kind} onClose={() => setSelected(null)}>
          <p className="muted mono">{selected.id}</p>
          {selected.lastError ? (
            <Section title="Last error">
              <Code>{selected.lastError}</Code>
            </Section>
          ) : null}
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
      {toast ? (
        <UndoToast
          key={toast.id}
          title={toast.title}
          {...(toast.body ? { body: toast.body } : {})}
          duration={UNDO_MS}
          {...(toast.undo ? { onUndo: () => { const undo = toast.undo!; void attempt(async () => { await undo(); }); } } : {})}
          onGone={() => setToast(null)}
        />
      ) : null}
    </PageFrame>
  );
}

/** What a job was for: its mission, else the start of what the agent was asked, else its kind. */
function jobWhat(j: FailureGroup['jobs'][number]): string {
  if (j.missionName) return j.missionName;
  const prompt = (j.job.payload as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt === 'string' && prompt.trim() !== '') return truncate(prompt.trim().split('\n')[0]!, 48);
  return j.job.kind === 'agent-run' ? 'Agent run' : j.job.kind;
}

/**
 * One cause: the label and count, why, the agents and when it gave up, then
 * Retry (accent when the cause has plausibly gone away) and Dismiss. Inside,
 * each job with its own Retry · Dismiss; a group of one names its job in the
 * line itself.
 */
function FailureRow({
  group,
  timezone,
  dismissed,
  onOpen,
  onRetry,
  onDismiss,
}: {
  group: FailureGroup;
  timezone: string;
  dismissed?: boolean;
  onOpen: (job: JobRow) => void;
  onRetry: (ids: string[]) => void;
  onDismiss?: (ids: string[]) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const many = group.jobs.length > 1;
  const ids = group.jobs.map((j) => j.job.id);
  const agents = group.agents.map((a) => a.name ?? a.id);
  const only = group.jobs[0];
  const auto = group.jobs.every((j) => j.job.acknowledgedBy === 'auto');
  const when = dismissed
    ? auto ? 'dismissed on its own after 14 days' : `dismissed ${fmtRelative(group.jobs[0]?.job.acknowledgedAt ?? group.lastAt)}`
    : `gave up ${fmtRelative(group.lastAt)}`;
  return (
    <li className="al-row" data-urgent={dismissed ? undefined : 'true'}>
      <div className="al-main">
        <p className="al-title">{many ? `${group.label} · ${group.count}` : group.label}</p>
        {dismissed ? null : <p className="al-line">{group.reason}</p>}
        <p className="al-sub">
          {agents.length > 0 ? <><span>{agents.join(', ')}</span><span aria-hidden="true">·</span></> : null}
          {!many && only ? (
            <>
              <button type="button" className="wb-link" onClick={() => onOpen(only.job)}>{jobWhat(only)}</button>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <span title={fmtTime(group.lastAt, timezone)}>{when}</span>
          {many ? (
            <>
              <span aria-hidden="true">·</span>
              <button type="button" className="wb-link al-toggle" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                {expanded ? 'Hide' : `Show the ${group.count}`}
              </button>
            </>
          ) : null}
        </p>
        {expanded && many ? (
          <ul className="al-items">
            {group.jobs.map((j) => (
              <li key={j.job.id} className="al-item jb-item">
                {j.agentName || j.agentId ? <span className="al-item-who">{j.agentName ?? j.agentId}</span> : null}
                <span className="al-item-note">
                  <button type="button" className="wb-link" onClick={() => onOpen(j.job)}>{jobWhat(j)}</button>
                  {' · '}{fmtMoment(new Date(j.job.updatedAt), timezone)} · tried {j.job.attempts} {plural(j.job.attempts, 'time')}
                </span>
                <span className="jb-item-acts">
                  <button type="button" className="wb-link" onClick={() => onRetry([j.job.id])}>Retry</button>
                  {onDismiss ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <button type="button" className="wb-link" onClick={() => onDismiss([j.job.id])}>Dismiss</button>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="al-actions">
        <Button size="sm" variant={group.likelyFixed && !dismissed ? 'accent' : undefined} onClick={() => onRetry(ids)}>
          {many ? 'Retry all' : 'Retry'}
        </Button>
        {onDismiss ? <Button size="sm" variant="ghost" onClick={() => onDismiss(ids)}>Dismiss</Button> : null}
      </div>
    </li>
  );
}
