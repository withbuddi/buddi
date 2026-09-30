/**
 * `envelope` — a gated action, shown whole before anyone approves it.
 *
 * The rule this view exists to keep: **what is approved is what is shown**.
 * Every field of the envelope is printed, in the envelope's own words, with
 * nothing summarised away and the args hash and policy version visible — so
 * "approve" means approving a specific, identified thing, not a paraphrase of
 * one. The preview is the tool's own text and is never re-rendered through a
 * model.
 *
 * Approve and Reject call the same routes the CLI and Telegram call, so the
 * decision is the one atomic transition it is everywhere else.
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type ApprovalRow } from '../../api';
import { fmtTime } from '../../format';
import { humanise } from '../resolve';
import { fmtValue } from '../format';
import { ErrorBanner, Pill, StatePill } from '../../ui';
import { useOwnerChoices } from '../../views/parts/OwnerChoices';
import type { EnvelopeProps } from '../types';

export function Envelope({
  props,
  timezone = 'UTC',
  onDecided,
}: {
  props: EnvelopeProps;
  timezone?: string;
  onDecided?: (action: ApprovalRow) => void;
}): JSX.Element {
  const [action, setAction] = useState<ApprovalRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAction(null);
    setError(null);
    api
      .approval(props.approvalId)
      .then((row) => {
        if (!cancelled) setAction(row);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [props.approvalId]);

  // The tool's own controls. Declared on the action, defaults preselected, and
  // sent with the decision — the Code preview above stays exactly the tool's
  // text and says nothing about them.
  const { values, controls } = useOwnerChoices(action?.choices);

  const decide = (decision: 'approve' | 'reject', permissionScope?: 'once' | 'conversation' | 'always'): void => {
    setBusy(decision);
    setError(null);
    (values && decision === 'approve'
      ? api.decide(props.approvalId, decision, permissionScope, values)
      : api.decide(props.approvalId, decision, permissionScope))
      .then((result) => {
        setAction(result.action);
        onDecided?.(result.action);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(null));
  };

  if (error && !action) return <p className="wb-empty">{error}</p>;
  if (!action) return <p className="wb-empty">Loading the envelope…</p>;

  const pending = action.state === 'pending';
  const reusable = action.permissionScopes?.includes('always');
  const fields = envelopeFields(action);
  const longPreview = (action.preview ?? '').split('\n').length > 12 || (action.preview ?? '').length > 900;

  const decided = [action.decidedBy ? `by ${action.decidedBy}` : '', action.decidedVia ? `via ${action.decidedVia}` : ''].filter(Boolean).join(' ');

  return (
    <div className="wb-approval">
      <div className="envelope">
        <dl className="envelope-head">
          <dt>Action</dt>
          <dd className="wb-approval-action">{action.tool.split('.').map((part) => humanise(part)).join(' · ')}</dd>
          <dt>Status</dt>
          <dd>
            {pending ? <Pill tone="warning" dot>waiting for you</Pill> : <StatePill state={action.state} />}
            {!pending && decided ? <span className="wb-hint"> {decided}</span> : null}
          </dd>
          <dt>{pending ? 'Expires' : 'Decided'}</dt>
          <dd>{fmtTime(pending ? action.expiresAt : action.decidedAt, timezone)}</dd>
        </dl>
        <div className="envelope-body" data-clamp={longPreview && !showAll ? 'true' : undefined}>
          {action.preview || '(this tool wrote no preview)'}
          {longPreview && !showAll ? (
            <button type="button" className="wb-doc-more" onClick={() => setShowAll(true)}>Show the whole preview</button>
          ) : null}
        </div>
      </div>

      <ErrorBanner message={error} />

      {pending ? controls : null}

      {pending ? (
        <div className="wb-approval-decide">
          <p className="wb-hint">{reusable ? 'Auto and Always also approve later calls to this tool in that scope; you can take it back on the agent\'s Access page.' : 'This runs the action exactly as shown above.'}</p>
          <div className="wb-approval-buttons">
            <button className="ui-btn" data-variant="danger" disabled={busy !== null} onClick={() => decide('reject')}>
              {busy === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
            {reusable ? <>
              <button className="ui-btn" disabled={busy !== null} onClick={() => decide('approve', 'conversation')}>Auto: this conversation</button>
              <button className="ui-btn" disabled={busy !== null} onClick={() => decide('approve', 'always')}>Always: this agent</button>
            </> : null}
            <button className="ui-btn" data-variant="good" disabled={busy !== null} onClick={() => decide('approve')}>
              {busy === 'approve' ? 'Approving…' : reusable ? 'Allow once' : 'Approve'}
            </button>
          </div>
        </div>
      ) : null}

      <details className="ui-details">
        <summary>The envelope, field by field</summary>
        <dl className="ui-kv">
          <div className="contents">
            <dt>Tool</dt>
            <dd className="mono">{action.tool}</dd>
          </div>
          {fields.map((field) => (
            <div key={field.label} className="contents">
              <dt>{field.label}</dt>
              <dd className={field.mono ? 'mono' : undefined}>{field.value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

/**
 * Every field, flattened — the envelope's own keys first, then the identity of
 * the decision itself. Nothing is dropped: an unknown key the server grew last
 * week still appears, because the alternative is approving something unseen.
 */
export function envelopeFields(action: ApprovalRow): Array<{ label: string; value: string; mono?: boolean }> {
  const fields: Array<{ label: string; value: string; mono?: boolean }> = [];
  const envelope = action.envelope;
  if (envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope)) {
    for (const [key, value] of Object.entries(envelope as Record<string, unknown>)) {
      fields.push({ label: humanise(key), value: flatten(value) });
    }
  } else if (envelope !== null && envelope !== undefined) {
    fields.push({ label: 'Envelope', value: flatten(envelope) });
  }

  const args = action.canonicalArgs;
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      const label = `Argument · ${humanise(key)}`;
      if (!fields.some((field) => field.label === label)) fields.push({ label, value: flatten(value) });
    }
  }

  fields.push(
    { label: 'Action id', value: action.id, mono: true },
    { label: 'Tool version', value: action.toolVersion, mono: true },
    { label: 'Agent', value: action.agentId, mono: true },
    { label: 'Args hash', value: action.argsHash, mono: true },
    { label: 'Policy version', value: String(action.policyVersion) },
  );
  if (action.conversationId) fields.push({ label: 'Conversation', value: action.conversationId, mono: true });
  if (action.jobId) fields.push({ label: 'Job', value: action.jobId, mono: true });
  return fields;
}

function flatten(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map((item) => flatten(item)).join(', ') || '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return fmtValue(value, 'text', null);
}

function stateTone(state: string): string {
  if (state === 'approved' || state === 'executed') return 'good';
  if (state === 'rejected' || state === 'expired') return 'critical';
  return 'warning';
}
