/**
 * Deterministic watchers: what is installed, when each last ran, what is open,
 * what resolved, and what is waiting for the weekly digest.
 */
import { api } from '../api';
import { fmtRelative, fmtTime, json } from '../format';
import { Empty, ErrorBanner, Panel, useAsync } from '../ui';

export function Sentinels({ timezone }: { timezone: string }): JSX.Element {
  const { data, error } = useAsync(() => api.sentinels(), [], 30_000);

  return (
    <>
      <h2>Sentinels</h2>
      <p className="lede">Code, not prompts. A finding wakes the owner, waits for the digest, or stays quiet.</p>
      <ErrorBanner message={error} />

      <Panel title="Installed">
        {!data || data.installed.length === 0 ? (
          <Empty>No sentinels are installed.</Empty>
        ) : (
          <table>
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
                      <div className="muted">{sentinel.description}</div>
                    </td>
                    <td>{sentinel.every}s</td>
                    <td>{run ? `${fmtTime(run.lastRunAt, timezone)} (${fmtRelative(run.lastRunAt)})` : '—'}</td>
                    <td className={run?.lastError ? 'bad' : 'muted'}>{run?.lastError ?? 'none'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Findings title="Open findings" findings={data?.open ?? []} timezone={timezone} />
      <Findings title="Resolved" findings={data?.resolved ?? []} timezone={timezone} />

      <Panel title="Waiting for the digest">
        {!data || data.digest.length === 0 ? (
          <Empty>Nothing is queued for the weekly recap.</Empty>
        ) : (
          <table>
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
                    <div className="muted">{item.detail}</div>
                  </td>
                  <td>{item.severity}</td>
                  <td>{fmtTime(item.createdAt, timezone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
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
    <Panel title={title}>
      {findings.length === 0 ? (
        <Empty>None.</Empty>
      ) : (
        <table>
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
                  <div className="muted">{finding.detail}</div>
                  <div className="muted mono">{finding.key}</div>
                  {finding.data ? (
                    <details>
                      <summary className="muted">evidence</summary>
                      <pre>{json(finding.data)}</pre>
                    </details>
                  ) : null}
                </td>
                <td className={finding.severity === 'urgent' ? 'bad' : 'muted'}>{finding.severity}</td>
                <td>{fmtTime(finding.firstSeenAt, timezone)}</td>
                <td>
                  {fmtTime(finding.lastSeenAt, timezone)}
                  <div className="muted">{fmtRelative(finding.lastSeenAt)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
