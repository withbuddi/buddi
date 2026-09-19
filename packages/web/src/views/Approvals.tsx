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
import {
  Button,
  Card,
  Code,
  Empty,
  ErrorBanner,
  Notice,
  Page,
  PageHeader,
  Panel,
  Pill,
  Section,
  Stack,
  StatePill,
  Table,
  Toolbar,
  useAsync,
} from '../ui';
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
    <Page>
      <PageHeader
        title="Approvals"
        lede="Nothing gated runs without one. The preview below is what the tool rendered, never model prose."
      />
      <HostControls />
      <ErrorBanner message={error ?? failure} />
      {note ? (
        <Notice tone="good" role="status">
          {note}
        </Notice>
      ) : null}

      <Section title="Waiting for you">
        {!data || data.pending.length === 0 ? (
          <Empty>Nothing is waiting for your approval.</Empty>
        ) : (
          <Stack>
            {data.pending.map((action) => (
              <Pending
                key={action.id}
                action={action}
                timezone={timezone}
                busy={busy === action.id}
                onDecide={decide}
              />
            ))}
          </Stack>
        )}
      </Section>

      <Panel title="Recent" flush>
        {!data || data.recent.length === 0 ? (
          <Empty>No actions have been created yet.</Empty>
        ) : (
          <Table>
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
                    <div className="sub mono">{short(action.id)}</div>
                  </td>
                  <td>
                    <StatePill state={action.state} />
                  </td>
                  <td className="mono">{action.agentId}</td>
                  <td className="nowrap">
                    {action.decidedAt ? (
                      <>
                        {fmtTime(action.decidedAt, timezone)}
                        <div className="sub">via {action.decidedVia ?? '—'}</div>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="nowrap">
                    {fmtTime(action.createdAt, timezone)}
                    <div className="sub">{fmtRelative(action.createdAt)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </Page>
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
    <Card
      tone="accent"
      title={action.tool}
      meta={
        <>
          <Pill>v{action.toolVersion}</Pill>
          <span className="muted">asked by {action.agentId}</span>
        </>
      }
    >
      <Code>{action.preview}</Code>
      <p className="ui-card-meta">
        Expires {fmtTime(action.expiresAt, timezone)} ({fmtRelative(action.expiresAt)}) · policy v
        {action.policyVersion} · args {short(action.argsHash, 12)}
        {action.jobId ? ` · job ${short(action.jobId)}` : ''}
      </p>
      <Toolbar>
        <Button variant="good" disabled={busy} onClick={() => onDecide(action.id, 'approve')}>
          {action.permissionScopes?.length ? 'Allow once' : 'Approve'}
        </Button>
        {action.permissionScopes?.length ? (
          <>
            <Button disabled={busy} onClick={() => onDecide(action.id, 'approve', 'conversation')}>
              Auto: this conversation
            </Button>
            <Button disabled={busy} onClick={() => onDecide(action.id, 'approve', 'always')}>
              Always: this agent
            </Button>
          </>
        ) : null}
        <Button variant="danger" disabled={busy} onClick={() => onDecide(action.id, 'reject')}>
          Reject
        </Button>
        <Button variant="ghost" onClick={() => setShowEnvelope((v) => !v)} aria-expanded={showEnvelope}>
          {showEnvelope ? 'Hide envelope' : 'Show envelope'}
        </Button>
      </Toolbar>
      {showEnvelope ? (
        <div className="ui-card-foot">
          <Section title="Envelope — everything that decides what the world will see">
            <Code>{json(action.envelope)}</Code>
          </Section>
          <Section title="Canonical arguments">
            <Code>{json(action.canonicalArgs)}</Code>
          </Section>
        </div>
      ) : null}
    </Card>
  );
}
