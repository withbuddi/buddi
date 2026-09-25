/**
 * Missions: what is scheduled, when it next fires, how it behaves after the
 * machine has slept, and whether it spoke last time.
 *
 * Changing the misfire policy writes a *new schedule revision* — occurrences
 * already materialized keep their provenance, which is why the dashboard never
 * offers to edit one in place.
 */
import { useState } from 'react';
import { api, type MissionRow } from '../api';
import { fmtRelative, fmtTime, truncate } from '../format';
import { Button, Card, Code, Empty, ErrorBanner, Field, PageFrame, Panel, Pill, Section, Stack, StatePill, Table, Toolbar, useAsync, EmptyState } from '../ui';

const POLICIES = ['replay-all', 'coalesce', 'latest-only', 'skip-after-deadline'] as const;

export function Missions({ timezone, embedded, agentId }: { timezone: string; embedded?: boolean; agentId?: string }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.missions(), [], 30_000);
  const rows = (data?.missions ?? []).filter((m) => !agentId || m.agentId === agentId);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (work: Promise<unknown>): Promise<void> => {
    setFailure(null);
    try {
      await work;
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <PageFrame embedded={embedded} title="Missions" lede="Standing schedules. A disabled mission materializes nothing.">
      <ErrorBanner message={error ?? failure} />
      {!data || rows.length === 0 ? (
        <EmptyState icon="calendar" title="No missions yet">Run <code>buddi missions add-defaults</code> for the standard set.</EmptyState>
      ) : (
        <Stack>
          {rows.map((mission) => (
            <Mission key={mission.id} mission={mission} timezone={timezone} onRun={run} />
          ))}
        </Stack>
      )}
    </PageFrame>
  );
}

function Mission({
  mission,
  timezone,
  onRun,
}: {
  mission: MissionRow;
  timezone: string;
  onRun: (work: Promise<unknown>) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Card
      tone={mission.enabled ? 'good' : 'muted'}
      title={
        <>
          {mission.name} <span className="mono muted">{mission.id}</span>
        </>
      }
      meta={
        <>
          <Pill mono>{mission.agentId}</Pill>
          {mission.alwaysDeliver ? <Pill>always delivers</Pill> : null}
          {!mission.enabled ? <Pill tone="warning">disabled</Pill> : null}
        </>
      }
      actions={
        <>
          <Button size="sm" onClick={() => onRun(api.setMissionEnabled(mission.id, !mission.enabled))}>
            {mission.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Less' : 'More'}
          </Button>
        </>
      }
    >
      <p className="ui-card-meta">
        {mission.schedule ? (
          <>
            <span className="mono">{mission.schedule.cron}</span> {mission.schedule.timezone} · rev{' '}
            {mission.schedule.revision} · next{' '}
            {mission.nextRun ? `${fmtTime(mission.nextRun, timezone)} (${fmtRelative(mission.nextRun)})` : '—'}
          </>
        ) : (
          'no schedule — enqueued by hand or by a sentinel'
        )}
        <br />
        Last notification:{' '}
        {mission.lastNotification
          ? `${mission.lastNotification.kind === 'mission.delivered' ? 'delivered' : 'silent'} ${fmtRelative(
              mission.lastNotification.at,
            )}${mission.lastNotification.reason ? ` — ${mission.lastNotification.reason}` : ''}`
          : 'none'}
      </p>

      {open ? (
        <div className="ui-card-foot">
          {mission.schedule ? (
            <Toolbar>
              <Field inline label="Misfire policy">
                <select
                  value={mission.schedule.misfirePolicy}
                  onChange={(e) => onRun(api.setMisfirePolicy(mission.id, e.target.value))}
                >
                  {POLICIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
              <span className="muted">
                What a week asleep does: replay every instant, coalesce into one, keep only the latest, or skip past a
                deadline.
              </span>
            </Toolbar>
          ) : null}

          <Section title="Prompt">
            <Code>{mission.prompt}</Code>
          </Section>

          <Section title="Recent occurrences">
            <Panel flush>
              {mission.occurrences.length === 0 ? (
                <Empty>Never run.</Empty>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th>Scheduled</th>
                      <th>State</th>
                      <th>Finished</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mission.occurrences.map((o) => (
                      <tr key={o.id}>
                        <td className="nowrap">{fmtTime(o.scheduledAt, timezone)}</td>
                        <td>
                          <StatePill state={o.state} />
                        </td>
                        <td className="nowrap">{fmtTime(o.finishedAt, timezone)}</td>
                        <td className={o.error ? 'critical' : 'muted'}>
                          {o.error ? truncate(o.error, 120) : null}
                          {o.runConversationId ? (
                            <a href={`#/conversations/${o.runConversationId}`}>transcript</a>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
          </Section>
        </div>
      ) : null}
    </Card>
  );
}
