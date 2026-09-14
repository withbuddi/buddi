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
import { Empty, ErrorBanner, StatePill, useAsync } from '../ui';

const POLICIES = ['replay-all', 'coalesce', 'latest-only', 'skip-after-deadline'] as const;

export function Missions({ timezone }: { timezone: string }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.missions(), [], 30_000);
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
    <>
      <h2>Missions</h2>
      <p className="lede">Standing schedules. A disabled mission materializes nothing.</p>
      <ErrorBanner message={error ?? failure} />
      {!data || data.missions.length === 0 ? (
        <Empty>No missions are registered (`buddi missions add-defaults`).</Empty>
      ) : (
        data.missions.map((mission) => (
          <Mission key={mission.id} mission={mission} timezone={timezone} onRun={run} />
        ))
      )}
    </>
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
    <div className="attention" style={{ borderLeftColor: mission.enabled ? 'var(--ok)' : 'var(--line)' }}>
      <div className="bar" style={{ marginBottom: 6 }}>
        <strong style={{ flex: '1 1 auto' }}>
          {mission.name} <span className="muted mono">{mission.id}</span>
        </strong>
        <span className="pill">{mission.agentId}</span>
        {mission.alwaysDeliver ? <span className="pill">always delivers</span> : null}
        <button onClick={() => onRun(api.setMissionEnabled(mission.id, !mission.enabled))}>
          {mission.enabled ? 'Disable' : 'Enable'}
        </button>
        <button onClick={() => setOpen((v) => !v)}>{open ? 'less' : 'more'}</button>
      </div>

      <div className="muted">
        {mission.schedule ? (
          <>
            <span className="mono">{mission.schedule.cron}</span> {mission.schedule.timezone} · rev{' '}
            {mission.schedule.revision} · next{' '}
            {mission.nextRun ? `${fmtTime(mission.nextRun, timezone)} (${fmtRelative(mission.nextRun)})` : '—'}
          </>
        ) : (
          'no schedule — enqueued by hand or by a sentinel'
        )}
      </div>
      <div className="muted">
        Last notification:{' '}
        {mission.lastNotification
          ? `${mission.lastNotification.kind === 'mission.delivered' ? 'delivered' : 'silent'} ${fmtRelative(
              mission.lastNotification.at,
            )}${mission.lastNotification.reason ? ` — ${mission.lastNotification.reason}` : ''}`
          : 'none'}
      </div>

      {open ? (
        <>
          {mission.schedule ? (
            <div className="bar" style={{ marginTop: 10 }}>
              <label className="muted" htmlFor={`p-${mission.id}`}>
                misfire policy
              </label>
              <select
                id={`p-${mission.id}`}
                value={mission.schedule.misfirePolicy}
                onChange={(e) => onRun(api.setMisfirePolicy(mission.id, e.target.value))}
              >
                {POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <span className="muted">
                what a week asleep does: replay every instant, coalesce into one, keep only the latest, or skip past a
                deadline.
              </span>
            </div>
          ) : null}

          <h3>Prompt</h3>
          <pre>{mission.prompt}</pre>

          <h3>Recent occurrences</h3>
          <div className="wrap">
            {mission.occurrences.length === 0 ? (
              <Empty>Never run.</Empty>
            ) : (
              <table>
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
                      <td>{fmtTime(o.scheduledAt, timezone)}</td>
                      <td>
                        <StatePill state={o.state} />
                      </td>
                      <td>{fmtTime(o.finishedAt, timezone)}</td>
                      <td className={o.error ? 'bad' : 'muted'}>
                        {o.error ? truncate(o.error, 120) : null}
                        {o.runConversationId ? (
                          <a href={`#/conversations/${o.runConversationId}`}>transcript</a>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
