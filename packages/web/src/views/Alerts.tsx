/**
 * Alerts: what the watchers found, and the two things an owner can do about
 * one. Ask the agent that answers for it, with the finding already in the
 * message; or snooze it, which keeps the watcher checking but stops the
 * finding from waking anyone until the fact itself changes.
 */
import { useState } from 'react';
import { api, type SentinelFinding } from '../api';
import { fmtRelative, fmtTime, json } from '../format';
import { chatRoute } from '../routes';
import { leaveDraft } from '../chat/ChatPage';
import { Button, ButtonLink, Code, Details, Empty, ErrorBanner, Notice, PageFrame, Panel, Pill, Table, Toolbar, useAsync } from '../ui';

export function Alerts({ timezone, embedded }: { timezone: string; embedded?: boolean }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.sentinels(), [], 30_000);
  const missions = useAsync(() => api.missions(), []);
  const [failure, setFailure] = useState<string | null>(null);
  // The agent that speaks for the watchers: whoever runs the wake mission.
  const askAgentId = missions.data?.missions.find((m) => m.id === 'sentinel-wake')?.agentId ?? null;

  const snooze = async (key: string, snoozed: boolean): Promise<void> => {
    setFailure(null);
    try { await api.snoozeAlert(key, snoozed); reload(); }
    catch (err) { setFailure(err instanceof Error ? err.message : String(err)); }
  };
  const open = (data?.open ?? []).filter((f) => !f.snoozedAt);
  const snoozed = (data?.open ?? []).filter((f) => f.snoozedAt);

  return (
    <PageFrame embedded={embedded} title="Alerts" lede="What the watchers found.">
      <ErrorBanner message={error ?? failure} />
      <Notice>
        An alert closes on its own once the fact behind it changes: record the payment, update the balance, and the watcher clears it on its next run. Snooze one you have decided to live with; it stays quiet until it resolves.
      </Notice>

      <Findings title="Open" findings={open} timezone={timezone} askAgentId={askAgentId} onSnooze={(key) => snooze(key, true)} empty="Nothing open. Your watchers are quiet." />
      {snoozed.length > 0 ? (
        <Findings title="Snoozed" findings={snoozed} timezone={timezone} askAgentId={askAgentId} onSnooze={(key) => snooze(key, false)} empty="" />
      ) : null}
      <Findings title="Resolved" findings={data?.resolved ?? []} timezone={timezone} empty="Nothing has resolved yet." />

      <Panel title="Waiting for the weekly recap" flush>
        {!data || data.digest.length === 0 ? (
          <Empty>Nothing is waiting for the recap.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Severity</th>
                <th>Noted</th>
              </tr>
            </thead>
            <tbody>
              {data.digest.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.title}
                    <Clamped text={item.detail} />
                  </td>
                  <td>
                    <Severity severity={item.severity} />
                  </td>
                  <td className="nowrap">{fmtTime(item.createdAt, timezone)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </PageFrame>
  );
}

function Severity({ severity }: { severity: string }): JSX.Element {
  return <Pill tone={severity === 'urgent' ? 'critical' : undefined}>{severity}</Pill>;
}

/** A detail that may run to forty file names: three lines, then a word to see the rest. */
function Clamped({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const long = text.length > 240 || text.split('\n').length > 3;
  return (
    <div className="sub alert-detail" data-clamp={long && !open ? 'true' : undefined}>
      {text}
      {long ? (
        <button type="button" className="wb-link alert-more" onClick={() => setOpen((v) => !v)}>{open ? 'Less' : 'More'}</button>
      ) : null}
    </div>
  );
}

function askText(finding: SentinelFinding): string {
  return `About this alert: "${finding.title}". ${finding.detail}\n\nWhat should I do about it, and what do you need from me to clear it?`;
}

function Findings({
  title,
  findings,
  timezone,
  askAgentId,
  onSnooze,
  empty,
}: {
  title: string;
  findings: SentinelFinding[];
  timezone: string;
  askAgentId?: string | null;
  onSnooze?: (key: string) => void;
  empty: string;
}): JSX.Element {
  const snoozedList = title === 'Snoozed';
  return (
    <Panel title={title} flush>
      {findings.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Finding</th>
              <th>Severity</th>
              <th>Since</th>
              {onSnooze ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {findings.map((finding) => (
              <tr key={finding.key}>
                <td>
                  <strong>{finding.title}</strong>
                  <Clamped text={finding.detail} />
                  {finding.data ? (
                    <Details summary="evidence">
                      <Code>{json(finding.data)}</Code>
                    </Details>
                  ) : null}
                </td>
                <td>
                  <Severity severity={finding.severity} />
                </td>
                <td className="nowrap">
                  {fmtTime(finding.firstSeenAt, timezone)}
                  <div className="sub" title={fmtTime(finding.lastSeenAt, timezone)}>last seen {fmtRelative(finding.lastSeenAt)}</div>
                </td>
                {onSnooze ? (
                  <td>
                    <Toolbar align="end">
                      {askAgentId ? (
                        <ButtonLink size="sm" href={chatRoute(askAgentId, 'new')} onClick={() => leaveDraft(askAgentId, askText(finding))}>
                          Ask about it
                        </ButtonLink>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => onSnooze(finding.key)}>
                        {snoozedList ? 'Wake' : 'Snooze'}
                      </Button>
                    </Toolbar>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}
