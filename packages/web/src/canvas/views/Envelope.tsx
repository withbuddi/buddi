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
import { ErrorBanner } from '../../ui';
import type { EnvelopeProps } from '../types';

export function Envelope({
  props,
  timezone = 'UTC',
  onDecided,
  compact = false,
  onOpenFull,
}: {
  props: EnvelopeProps;
  timezone?: string;
  onDecided?: (action: ApprovalRow) => void;
  /** In the conversation: the decision and one line, the rest on the Canvas. */
  compact?: boolean;
  onOpenFull?: () => void;
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

  const decide = (decision: 'approve' | 'reject', permissionScope?: 'once' | 'conversation' | 'always'): void => {
    setBusy(decision);
    setError(null);
    api
      .decide(props.approvalId, decision, permissionScope)
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

  return (
    <div>
      <div className="ui-stats" data-inline="true">
        <div>
          <div className="ui-stat-k">Tool</div>
          <div className="ui-stat-v mono">{action.tool}</div>
        </div>
        <div>
          <div className="ui-stat-k">State</div>
          <div className="ui-stat-v" data-tone={stateTone(action.state)}>
            {action.state}
          </div>
        </div>
        <div>
          <div className="ui-stat-k">{pending ? 'Expires' : 'Decided'}</div>
          <div className="ui-stat-v" data-size="sm">
            {fmtTime(pending ? action.expiresAt : action.decidedAt, timezone)}
          </div>
        </div>
      </div>

      <ErrorBanner message={error} />

      {pending ? (
        <div className="wb-row-wrap wb-block">
          <button
            className="ui-btn"
            data-variant="good"
            disabled={busy !== null}
            onClick={() => decide('approve')}
          >
            {busy === 'approve' ? 'Approving…' : reusable ? 'Allow once' : 'Approve'}
          </button>
          {reusable ? <>
            <button className="ui-btn" disabled={busy !== null} onClick={() => decide('approve', 'conversation')}>Auto: this conversation</button>
            <button className="ui-btn" disabled={busy !== null} onClick={() => decide('approve', 'always')}>Always: this agent</button>
          </> : null}
          <button
            className="ui-btn"
            data-variant="danger"
            disabled={busy !== null}
            onClick={() => decide('reject')}
          >
            {busy === 'reject' ? 'Rejecting…' : 'Reject'}
          </button>
          <span className="wb-hint">{reusable ? 'Auto-mode and Always also approve future calls to this tool within that scope. Host permissions can be revoked under Host execution.' : 'This runs the action exactly as printed above.'}</span>
        </div>
      ) : (
        <p className="muted">
          {action.state} {action.decidedBy ? `by ${action.decidedBy}` : ''}{' '}
          {action.decidedVia ? `via ${action.decidedVia}` : ''}
        </p>
      )}

      {compact ? (
        <p className="wb-approval-gist">
          {firstLine(action.preview)}{' '}
          {onOpenFull ? <button type="button" className="wb-link" onClick={onOpenFull}>See the full request on the Canvas</button> : null}
        </p>
      ) : null}

      {compact ? null : <h4 className="ui-stat-k wb-label">Preview</h4>}
      {compact ? null : <div className="wb-doc wb-block" data-clamp={longPreview && !showAll ? 'true' : undefined}>
        {action.preview || '(this tool wrote no preview)'}
        {longPreview && !showAll ? (
          <button type="button" className="wb-doc-more" onClick={() => setShowAll(true)}>Show the whole preview</button>
        ) : null}
      </div>}

      {compact ? null : <details className="ui-details wb-block">
        <summary>The envelope, field by field</summary>
        <dl className="ui-kv">
          {fields.map((field) => (
            <div key={field.label} className="contents">
              <dt>{field.label}</dt>
              <dd className={field.mono ? 'mono' : undefined}>{field.value}</dd>
            </div>
          ))}
        </dl>
      </details>}
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

/** The first sentence-ish of a preview, for the one-line form. */
function firstLine(preview: string | null | undefined): string {
  const line = (preview ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? 'This tool wrote no preview.';
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}
