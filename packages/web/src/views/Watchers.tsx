/**
 * Watchers: the plain-code checks a plugin ships and core runs on a schedule.
 * This page says what is installed, in words, when each last ran, whether it
 * failed — and carries the one control the owner has over it: a switch per
 * watcher. What they found lives under Activity.
 *
 * A watcher that is off does not run. It raises nothing, and it resolves
 * nothing either: what it already found stays where it is, so switching it back
 * on does not replay a week of news.
 */
import { useState } from 'react';
import { api, ApiError } from '../api';
import { fmtRelative, fmtTime } from '../format';
import { ACTIVITY_ROUTE } from '../routes';
import { Button, Empty, ErrorBanner, List, ListRow, Notice, PageFrame, Panel, Pill, useAsync } from '../ui';

export function Watchers({ timezone, embedded }: { timezone: string; embedded?: boolean }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.sentinels(), [], 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const installed = data?.installed ?? [];
  const failing = (data?.runs ?? []).filter((r) => r.lastError);
  const off = installed.filter((w) => !w.enabled);

  const toggle = (id: string, enabled: boolean): void => {
    setBusy(id);
    setFailed(null);
    api
      .setSentinelEnabled(id, enabled)
      .catch((err: unknown) => setFailed(err instanceof ApiError ? err.message : String(err)))
      .finally(() => {
        setBusy(null);
        reload();
      });
  };

  return (
    <PageFrame embedded={embedded} title="Watchers">
      <ErrorBanner message={error ?? failed} />
      <Notice>
        Watchers are small checks that run on their own, with no model involved. An urgent finding wakes an agent, which verifies it before it tells you. The rest waits for the weekly recap.{' '}
        <a href={`${ACTIVITY_ROUTE}/alerts`}>See what they found</a>
      </Notice>
      {failing.length > 0 ? (
        <Notice tone="warning">{failing.length === 1 ? 'One watcher failed on its last run.' : `${failing.length} watchers failed on their last run.`}</Notice>
      ) : null}
      {off.length > 0 ? (
        <Notice tone="warning">
          {off.length === 1 ? 'One watcher is off.' : `${off.length} watchers are off.`} A watcher that is off
          does not run, and what it already found stays as it was.
        </Notice>
      ) : null}
      <Panel flush>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : installed.length === 0 ? (
          <Empty>No watchers are installed. Plugins bring their own.</Empty>
        ) : (
          <List>
            {installed.map((w) => {
              const run = data.runs.find((r) => r.sentinelId === w.id);
              return (
                <ListRow
                  key={w.id}
                  lead={
                    <Pill tone={!w.enabled ? 'muted' : run?.lastError ? 'critical' : run ? 'good' : undefined}>
                      {!w.enabled ? 'off' : run?.lastError ? 'failed' : run ? 'ok' : 'never ran'}
                    </Pill>
                  }
                  title={w.description}
                  sub={`${w.id}, every ${everyText(w.every)}${run?.lastError ? `. ${run.lastError}` : ''}`}
                  side={
                    <>
                      <span title={run ? fmtTime(run.lastRunAt, timezone) : undefined}>
                        {run ? fmtRelative(run.lastRunAt) : 'never ran'}
                      </span>
                      <Button size="sm" disabled={busy === w.id} onClick={() => toggle(w.id, !w.enabled)}>
                        {w.enabled ? 'Turn off' : 'Turn on'}
                      </Button>
                    </>
                  }
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
