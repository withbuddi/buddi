/**
 * Missions: what is scheduled, when it next fires, how it behaves after the
 * machine has slept, and whether it spoke last time.
 *
 * Changing the misfire policy writes a *new schedule revision* — occurrences
 * already materialized keep their provenance, which is why the dashboard never
 * offers to edit one in place.
 *
 * Run now starts one occurrence at once, run like a scheduled one (its report
 * or silence, through the owner's notifications). While one is queued or
 * running the row says "Running…" and the page looks again every few seconds;
 * then the row's last-run line says how it went.
 */
import { useEffect, useState } from 'react';
import { api, type MissionRow } from '../api';
import { fmtRelative, fmtTime, truncate } from '../format';
import { Button, Card, Code, Empty, ErrorBanner, Field, Notice, PageFrame, Panel, Pill, Section, Spacer, Stack, StatePill, Switch, Table, Toolbar, useAsync, EmptyState } from '../ui';

const POLICIES = ['replay-all', 'coalesce', 'latest-only', 'skip-after-deadline'] as const;

/** How often the page looks again while a run is queued or going. */
const RUNNING_POLL_MS = 3_000;

/** An occurrence is queued or running: Run now waits for it. */
export function missionBusy(mission: MissionRow): boolean {
  const latest = mission.occurrences[0];
  return latest?.state === 'pending' || latest?.state === 'claimed';
}

/** The row's last-run line, the same for a scheduled run and a Run now: running, failed, reported or silent. */
export function lastRunLine(mission: MissionRow): string {
  if (missionBusy(mission)) return 'Running…';
  const latest = mission.occurrences[0];
  if (latest?.state === 'failed') {
    return `Last run failed${latest.finishedAt ? ` ${fmtRelative(latest.finishedAt)}` : ''}${latest.error ? ` — ${truncate(latest.error, 120)}` : ''}`;
  }
  const told = mission.lastNotification;
  if (!told) return 'Last run: none';
  return `Last run ${told.kind === 'mission.delivered' ? 'reported' : 'stayed silent'} ${fmtRelative(told.at)}${told.reason ? ` — ${told.reason}` : ''}`;
}

export function Missions({ timezone, embedded, agentId }: { timezone: string; embedded?: boolean; agentId?: string }): JSX.Element {
  // Polled faster while a run is going, so "Running…" turns into its result without a reload.
  const [starting, setStarting] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const { data, error, reload } = useAsync(() => api.missions(), [], busy || starting.size > 0 ? RUNNING_POLL_MS : 30_000);
  const rows = (data?.missions ?? []).filter((m) => !agentId || m.agentId === agentId);
  const [failure, setFailure] = useState<string | null>(null);
  const anyBusy = rows.some(missionBusy);
  useEffect(() => setBusy(anyBusy), [anyBusy]);

  const run = async (work: Promise<unknown>): Promise<void> => {
    setFailure(null);
    try {
      await work;
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
  };

  const runNow = async (id: string): Promise<void> => {
    setStarting((s) => new Set(s).add(id));
    await run(api.runMission(id));
    setStarting((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  };

  return (
    <PageFrame embedded={embedded} title="Missions" lede="Standing schedules. A disabled mission materializes nothing.">
      <ErrorBanner message={error ?? failure} />
      {!data || rows.length === 0 ? (
        <EmptyState icon="calendar" title="No missions yet">Run <code>buddi missions add-defaults</code> for the standard set.</EmptyState>
      ) : (
        <Stack>
          {rows.map((mission) => (
            <Mission key={mission.id} mission={mission} timezone={timezone} onRun={run} starting={starting.has(mission.id)} onRunNow={() => void runNow(mission.id)} />
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
  starting,
  onRunNow,
}: {
  mission: MissionRow;
  timezone: string;
  onRun: (work: Promise<unknown>) => void;
  /** Run now was pressed and the gateway has not answered yet. */
  starting: boolean;
  onRunNow: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // Only a mission that is on can run now; an off one shows Enable instead.
  const runnable = mission.enabled && !mission.pausedReason;
  const running = starting || missionBusy(mission);
  return (
    <Card
      tone={mission.enabled && !mission.pausedReason ? 'good' : 'muted'}
      title={
        <>
          {mission.name} <span className="mono muted">{mission.id}</span>
        </>
      }
      meta={
        <>
          <Pill mono>{mission.agentId}</Pill>
          {mission.alwaysDeliver ? <Pill>always delivers</Pill> : null}
          {!mission.enabled ? <Pill tone="warning">{mission.endedAt ? 'ended' : 'disabled'}</Pill> : null}
          {mission.pausedReason ? <Pill tone="warning">{mission.pausedReason}</Pill> : null}
        </>
      }
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Less' : 'More'}
          </Button>
          <Button size="sm" onClick={() => onRun(api.setMissionEnabled(mission.id, !mission.enabled))}>
            {mission.enabled ? 'Disable' : 'Enable'}
          </Button>
          {runnable ? (
            <Button size="sm" variant="accent" disabled={running} onClick={onRunNow}>
              Run now
            </Button>
          ) : null}
        </>
      }
    >
      {mission.stillUsefulAskedAt ? (
        <Notice
          tone="warning"
          title="Still useful?"
          action={(
            <Toolbar align="end">
              <Button size="sm" onClick={() => onRun(api.answerStillUseful(mission.id, 'stop'))}>Stop</Button>
              <Button size="sm" variant="accent" onClick={() => onRun(api.keepMission(mission.id))}>Keep</Button>
            </Toolbar>
          )}
        >
          {`It has run ${mission.quietRuns ?? 'many'} times in a row without anything to tell you.`}
        </Notice>
      ) : null}
      {/* A mission that browses: where, in words, and the owner's switch for his Chrome. */}
      {mission.browser ? (
        <Toolbar>
          <span>
            <strong>{mission.browser === 'owner' ? 'Uses your Chrome' : 'Own browser'}</strong>
            <span className="muted">
              {mission.browser === 'owner'
                ? ' · it may open pages in your signed-in Chrome while you are away'
                : ' · it opens pages only in buddi’s browser, never your Chrome'}
            </span>
          </span>
          <Spacer />
          <Switch
            checked={mission.browser === 'owner'}
            label={`Let ${mission.name} use your Chrome`}
            onChange={(on) => onRun(api.setMissionChrome(mission.id, on))}
          />
        </Toolbar>
      ) : null}
      {mission.stopWhen || mission.endsAt ? (
        <p className="ui-card-meta">
          {mission.stopWhen ? `Stops itself when ${mission.stopWhen}. ` : ''}
          {mission.endedAt ? `Ended ${fmtTime(mission.endedAt, timezone)}.` : mission.endsAt ? `Ends ${fmtTime(mission.endsAt, timezone)}.` : ''}
        </p>
      ) : null}
      <p className="ui-card-meta">
        {mission.schedule ? (
          <>
            <span className="mono">{mission.schedule.cron}</span>{' '}
            {mission.schedule.timezoneExplicit === false ? (
              <span title={mission.schedule.timezone}>follows your timezone</span>
            ) : (
              mission.schedule.timezone
            )}{' '}
            · rev{' '}
            {mission.schedule.revision} · next{' '}
            {mission.nextRun ? `${fmtTime(mission.nextRun, timezone)} (${fmtRelative(mission.nextRun)})` : '—'}
          </>
        ) : (
          'no schedule — enqueued by hand or by a sentinel'
        )}
        <br />
        <span role="status" className={!running && mission.occurrences[0]?.state === 'failed' ? 'critical' : undefined}>
          {running ? 'Running…' : lastRunLine(mission)}
        </span>
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
                        <td className="nowrap">
                          {fmtTime(o.scheduledAt, timezone)} {o.manual ? <Pill>run now</Pill> : null}
                        </td>
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
