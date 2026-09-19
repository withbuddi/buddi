/**
 * Approvals — the only page here that can cause an effect.
 *
 * What is rendered is the preview *the tool wrote* before the approval existed,
 * and the envelope the approval is bound to. Nothing is paraphrased, nothing is
 * model-written. Approve and Reject call the same core transition Telegram
 * calls, so a decision made here and a decision made on a phone are one race
 * with one winner.
 */
import { useState } from 'react';
import { api, type ApprovalRow } from '../api';
import { fmtRelative, fmtTime, json, short } from '../format';
import { Empty, ErrorBanner, Panel, StatePill, useAsync } from '../ui';
import { HostControls } from './HostControls';

export function Approvals({ timezone }: { timezone: string }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.approvals(), [], 10_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const decide = async (id: string, decision: 'approve' | 'reject', scope?: 'once' | 'conversation' | 'always'): Promise<void> => {
    setBusy(id);
    setFailure(null);
    setNote(null);
    try {
      const result = await api.decide(id, decision, scope);
      setNote(
        decision === 'reject'
          ? `Rejected ${result.action.tool}.`
          : result.execution?.state === 'succeeded'
            ? `Approved and done — ${result.action.tool}.`
            : `Approved — ${result.action.tool}: ${result.execution?.state ?? 'no execution'}${
                result.execution?.message ? ` (${result.execution.message})` : ''
              }`,
      );
      reload();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
      reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h2>Approvals</h2>
      <HostControls />
      <p className="lede">
        Nothing gated runs without one. The preview below is what the tool rendered, never model prose.
      </p>
      <ErrorBanner message={error ?? failure} />
      {note ? <div className="attention">{note}</div> : null}

      <h3>Waiting for you</h3>
      {!data || data.pending.length === 0 ? (
        <Empty>Nothing is waiting for your approval.</Empty>
      ) : (
        data.pending.map((action) => (
          <Pending
            key={action.id}
            action={action}
            timezone={timezone}
            busy={busy === action.id}
            onDecide={decide}
          />
        ))
      )}

      <Panel title="Recent">
        {!data || data.recent.length === 0 ? (
          <Empty>No actions have been created yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>State</th>
                <th>Asked by</th>
                <th>Decided</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((action) => (
                <tr key={action.id}>
                  <td>
                    {action.tool}
                    <div className="muted mono">{short(action.id)}</div>
                  </td>
                  <td>
                    <StatePill state={action.state} />
                  </td>
                  <td className="mono">{action.agentId}</td>
                  <td>
                    {action.decidedAt ? (
                      <>
                        {fmtTime(action.decidedAt, timezone)}
                        <div className="muted">via {action.decidedVia ?? '—'}</div>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {fmtTime(action.createdAt, timezone)}
                    <div className="muted">{fmtRelative(action.createdAt)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

function Pending({
  action,
  timezone,
  busy,
  onDecide,
}: {
  action: ApprovalRow;
  timezone: string;
  busy: boolean;
  onDecide: (id: string, decision: 'approve' | 'reject', scope?: 'once' | 'conversation' | 'always') => void;
}): JSX.Element {
  const [showEnvelope, setShowEnvelope] = useState(false);
  return (
    <div className="attention" style={{ borderLeftColor: 'var(--accent)' }}>
      <strong>{action.tool}</strong>{' '}
      <span className="pill">v{action.toolVersion}</span>{' '}
      <span className="muted">asked by {action.agentId}</span>
      <pre style={{ marginTop: 8 }}>{action.preview}</pre>
      <p className="muted" style={{ margin: '8px 0' }}>
        Expires {fmtTime(action.expiresAt, timezone)} ({fmtRelative(action.expiresAt)}) · policy v
        {action.policyVersion} · args {short(action.argsHash, 12)}
        {action.jobId ? ` · job ${short(action.jobId)}` : ''}
      </p>
      <div className="bar">
        <button className="primary" disabled={busy} onClick={() => onDecide(action.id, 'approve')}>
          {action.permissionScopes?.length ? 'Allow once' : 'Approve'}
        </button>
        {action.permissionScopes?.length ? <>
          <button disabled={busy} onClick={() => onDecide(action.id, 'approve', 'conversation')}>Auto: this conversation</button>
          <button disabled={busy} onClick={() => onDecide(action.id, 'approve', 'always')}>Always: this agent</button>
        </> : null}
        <button className="danger" disabled={busy} onClick={() => onDecide(action.id, 'reject')}>
          Reject
        </button>
        <button onClick={() => setShowEnvelope((v) => !v)}>
          {showEnvelope ? 'hide envelope' : 'show envelope'}
        </button>
      </div>
      {showEnvelope ? (
        <>
          <div className="muted">Envelope — everything that decides what the world will see.</div>
          <pre>{json(action.envelope)}</pre>
          <div className="muted">Canonical arguments</div>
          <pre>{json(action.canonicalArgs)}</pre>
        </>
      ) : null}
    </div>
  );
}
