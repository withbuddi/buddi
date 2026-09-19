/**
 * Deterministic watchers: what is installed, when each last ran, what is open,
 * what resolved, and what is waiting for the weekly digest.
 */
import { api } from '../api';
import { fmtRelative, fmtTime, json } from '../format';
import { Code, Details, Empty, ErrorBanner, PageFrame, Panel, Pill, Table, useAsync } from '../ui';

export function Sentinels({ timezone, embedded }: { timezone: string; embedded?: boolean }): JSX.Element {
  const { data, error } = useAsync(() => api.sentinels(), [], 30_000);

  return (
    <PageFrame
      embedded={embedded}
      title="Sentinels"
      lede="Code, not prompts. A finding wakes the owner, waits for the digest, or stays quiet."
    >
      <ErrorBanner message={error} />

      <Panel title="Installed" flush>
        {!data || data.installed.length === 0 ? (
          <Empty>No sentinels are installed.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Sentinel</th>
                <th>Every</th>
                <th>Last run</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {data.installed.map((sentinel) => {
                const run = data.runs.find((r) => r.sentinelId === sentinel.id);
                return (
                  <tr key={sentinel.id}>
                    <td>
                      <span className="mono">{sentinel.id}</span>
                      <div className="sub">{sentinel.description}</div>
                    </td>
                    <td className="nowrap">{sentinel.every}s</td>
                    <td className="nowrap">{run ? `${fmtTime(run.lastRunAt, timezone)} (${fmtRelative(run.lastRunAt)})` : '—'}</td>
                    <td className={run?.lastError ? 'critical' : 'muted'}>{run?.lastError ?? 'none'}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>

      <Findings title="Open findings" findings={data?.open ?? []} timezone={timezone} />
      <Findings title="Resolved" findings={data?.resolved ?? []} timezone={timezone} />

      <Panel title="Waiting for the digest" flush>
        {!data || data.digest.length === 0 ? (
          <Empty>Nothing is queued for the weekly recap.</Empty>
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
                    <div className="sub">{item.detail}</div>
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

function Findings({
  title,
  findings,
  timezone,
}: {
  title: string;
  findings: Array<{
    key: string;
    sentinelId: string;
    severity: string;
    title: string;
    detail: string;
    data: unknown;
    firstSeenAt: string;
    lastSeenAt: string;
    resolvedAt: string | null;
  }>;
  timezone: string;
}): JSX.Element {
  return (
    <Panel title={title} flush>
      {findings.length === 0 ? (
        <Empty>None.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Finding</th>
              <th>Severity</th>
              <th>First seen</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((finding) => (
              <tr key={finding.key}>
                <td>
                  <strong>{finding.title}</strong>
                  <div className="sub">{finding.detail}</div>
                  <div className="sub mono">{finding.key}</div>
                  {finding.data ? (
                    <Details summary="evidence">
                      <Code>{json(finding.data)}</Code>
                    </Details>
                  ) : null}
                </td>
                <td>
                  <Severity severity={finding.severity} />
                </td>
                <td className="nowrap">{fmtTime(finding.firstSeenAt, timezone)}</td>
                <td className="nowrap">
                  {fmtTime(finding.lastSeenAt, timezone)}
                  <div className="sub">{fmtRelative(finding.lastSeenAt)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}
