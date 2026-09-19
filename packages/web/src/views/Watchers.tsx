/**
 * Watchers: the plain-code checks a plugin ships and core runs on a schedule.
 * Nothing to configure here. This page says what is installed, in words, when
 * each last ran, and whether it failed. What they found lives under Activity.
 */
import { api } from '../api';
import { fmtRelative, fmtTime } from '../format';
import { ACTIVITY_ROUTE } from '../routes';
import { Empty, ErrorBanner, List, ListRow, Notice, PageFrame, Panel, Pill, useAsync } from '../ui';

export function Watchers({ timezone, embedded }: { timezone: string; embedded?: boolean }): JSX.Element {
  const { data, error } = useAsync(() => api.sentinels(), [], 30_000);
  const failing = (data?.runs ?? []).filter((r) => r.lastError);
  return (
    <PageFrame embedded={embedded} title="Watchers">
      <ErrorBanner message={error} />
      <Notice>
        Watchers are small checks that run on their own, with no model involved. An urgent finding wakes an agent, which verifies it before it tells you. The rest waits for the weekly recap.{' '}
        <a href={`${ACTIVITY_ROUTE}/alerts`}>See what they found</a>
      </Notice>
      {failing.length > 0 ? (
        <Notice tone="warning">{failing.length === 1 ? 'One watcher failed on its last run.' : `${failing.length} watchers failed on their last run.`}</Notice>
      ) : null}
      <Panel flush>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.installed.length === 0 ? (
          <Empty>No watchers are installed. Plugins bring their own.</Empty>
        ) : (
          <List>
            {data.installed.map((w) => {
              const run = data.runs.find((r) => r.sentinelId === w.id);
              return (
                <ListRow
                  key={w.id}
                  lead={<Pill tone={run?.lastError ? 'critical' : run ? 'good' : undefined}>{run?.lastError ? 'failed' : run ? 'ok' : 'never ran'}</Pill>}
                  title={w.description}
                  sub={`${w.id}, every ${everyText(w.every)}${run?.lastError ? `. ${run.lastError}` : ''}`}
                  side={run ? <span title={fmtTime(run.lastRunAt, timezone)}>{fmtRelative(run.lastRunAt)}</span> : null}
                />
              );
            })}
          </List>
        )}
      </Panel>
    </PageFrame>
  );
}

export function everyText(seconds: number): string {
  if (seconds % 86_400 === 0) { const d = seconds / 86_400; return d === 1 ? 'day' : `${d} days`; }
  if (seconds % 3_600 === 0) { const h = seconds / 3_600; return h === 1 ? 'hour' : `${h} hours`; }
  const m = Math.max(1, Math.round(seconds / 60)); return m === 1 ? 'minute' : `${m} minutes`;
}
