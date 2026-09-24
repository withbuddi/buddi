/**
 * The approval dock: a gated call, decided where the owner would type.
 *
 * While anything in this conversation waits for the owner, the composer's
 * place holds the oldest of it — what the tool is, the command or path it is
 * about, the workspace it runs in, the tool's own "remember" control — and
 * Approve and Reject. The canvas still has the whole request, field by field;
 * this is the decision and the one line that makes it an informed one.
 *
 * It is the question picker's sibling, and shares its frame for that reason:
 * the thread asks for something, and the answer goes in the same place.
 *
 * Two rules are the point of it:
 *
 * - **Only a click decides.** The text field says what to do *instead*, and
 *   Enter in it approves nothing. A decision is the button that names it.
 * - **The text is the owner speaking.** It is sent after the decision, down the
 *   same path as anything said while the agent works — there is no reason
 *   field on an approval, and inventing one would give the agent two places to
 *   look for what the owner said.
 *
 * Nothing here knows a tool by name: the subject line is read by shape
 * (`gist.ts`), and the workspace is whichever conventional field carries it.
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type ApprovalRow } from '../api';
import { fmtTime } from '../format';
import { labelFor } from '../canvas/renderables';
import { useOwnerChoices } from '../views/parts/OwnerChoices';
import { Button, ErrorBanner } from '../ui';
import { gistFor } from './gist';

export interface DockedApproval {
  approvalId: string;
  /** The call it gates: the canvas tab that holds the full request. */
  toolUseId: string;
  /**
   * Raised by a colleague under a delegation, not by this thread's agent:
   * who, and who asked it — "@art, asked by @playground". The row is the
   * colleague's own, so deciding it here is the one decision.
   */
  askedBy?: string;
}

/** The dock's element id, so a panel elsewhere can send the owner to it. */
export const APPROVAL_DOCK_ID = 'approval-dock';

/** Bring the dock into view and put the keyboard on it. */
export function focusApprovalDock(): void {
  const dock = document.getElementById(APPROVAL_DOCK_ID);
  if (!dock) return;
  dock.scrollIntoView?.({ block: 'nearest' });
  dock.focus();
}

type Scope = 'once' | 'conversation' | 'always';

/** The fields that name where a call runs, in the order they are tried. */
const WHERE_FIELDS = ['workspace', 'cwd', 'workdir', 'root'] as const;

export function ApprovalDock({
  approvals,
  timezone,
  now,
  version,
  onDecided,
  onSay,
  onOpenFull,
}: {
  /** Pending, oldest first. */
  approvals: readonly DockedApproval[];
  timezone: string;
  now: number;
  /** Changes whenever the transcript is read again: the current row is re-asked. */
  version?: unknown;
  onDecided: (action: ApprovalRow) => void;
  /** Deliver the owner's words, exactly as a message said mid-run would be. */
  onSay: (text: string) => void;
  onOpenFull: (toolUseId: string) => void;
}): JSX.Element | null {
  /*
   * Decided here, or found settled, but not yet gone from the transcript the
   * page holds. Skipped at once so the next one is up the moment a button is
   * clicked, not a refresh later.
   */
  const [settled, setSettled] = useState<readonly string[]>([]);
  const open = approvals.filter((item) => !settled.includes(item.approvalId));
  const current = open[0];
  if (!current) return null;
  const settle = (id: string): void => setSettled((done) => (done.includes(id) ? done : [...done, id]));
  return (
    <DockCard
      key={current.approvalId}
      item={current}
      count={open.length}
      timezone={timezone}
      now={now}
      version={version}
      onSettled={(action) => {
        settle(current.approvalId);
        if (action) onDecided(action);
      }}
      onSay={onSay}
      onOpenFull={() => onOpenFull(current.toolUseId)}
    />
  );
}

function DockCard({
  item,
  count,
  timezone,
  now,
  version,
  onSettled,
  onSay,
  onOpenFull,
}: {
  item: DockedApproval;
  count: number;
  timezone: string;
  now: number;
  version: unknown;
  /** It is no longer the owner's to decide; `action` when there is a row to say so. */
  onSettled: (action: ApprovalRow | null) => void;
  onSay: (text: string) => void;
  onOpenFull: () => void;
}): JSX.Element {
  const [action, setAction] = useState<ApprovalRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [instead, setInstead] = useState('');

  // Asked again whenever the transcript is: a tap on Telegram or in another
  // tab settles it there, and this is how the dock hears.
  useEffect(() => {
    let cancelled = false;
    api
      .approval(item.approvalId)
      .then((row) => {
        if (cancelled) return;
        setAction(row);
        if (row.state !== 'pending') onSettled(row);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // `onSettled` is a fresh closure every render; the row is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.approvalId, version]);

  // Past its time it cannot be approved, whatever the sweeper has got round to.
  const lapsed = action !== null && action.state === 'pending' && Date.parse(action.expiresAt) <= now;
  useEffect(() => {
    if (lapsed && action) onSettled({ ...action, state: 'expired' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lapsed]);

  const { values, controls } = useOwnerChoices(action?.choices);

  const decide = (decision: 'approve' | 'reject', scope?: Scope): void => {
    const said = instead.trim();
    setBusy(decision);
    setError(null);
    (values && decision === 'approve'
      ? api.decide(item.approvalId, decision, scope, values)
      : api.decide(item.approvalId, decision, scope))
      .then((result) => {
        onSettled(result.action);
        if (said) onSay(said);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : String(err));
        setBusy(null);
      });
  };

  const disabled = busy !== null || action === null || action.state !== 'pending';
  const reusable = action?.permissionScopes?.includes('always') ?? false;
  const subject = action ? gistFor(action.tool, action.canonicalArgs) ?? firstLine(action.preview) : null;
  const where = action ? whereOf(action) : null;

  return (
    <section id={APPROVAL_DOCK_ID} tabIndex={-1} className="wb-question" data-kind="approval" aria-label="Approval needed" data-testid="approval-dock">
      <div className="wb-question-head">
        <span className="wb-question-kicker">Needs your OK</span>
        {count > 1 ? <span className="wb-dock-count" data-testid="approval-dock-count">1 of {count}</span> : null}
        <strong>{action ? labelFor(action.tool) : 'Loading the request…'}</strong>
        {item.askedBy ? <span className="wb-dock-asker" data-testid="approval-dock-asker">{item.askedBy}</span> : null}
      </div>

      {subject || where ? (
        <div className="wb-dock-section wb-dock-subject">
          {subject ? <code className="wb-dock-gist">{subject}</code> : null}
          {where ? <span className="wb-dock-where">in <span className="mono">{where}</span></span> : null}
        </div>
      ) : null}

      {controls ? <div className="wb-dock-section">{controls}</div> : null}

      <ErrorBanner message={error} />

      <div className="wb-dock-section">
        <input
          className="wb-dock-instead"
          value={instead}
          onChange={(event) => setInstead(event.target.value)}
          // A decision is a click. Enter here must never be read as Approve.
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault();
          }}
          placeholder="Tell the agent what to do instead (optional)"
          aria-label="Tell the agent what to do instead (optional)"
          disabled={busy !== null}
        />
      </div>

      <div className="wb-dock-section wb-dock-actions">
        <span className="wb-dock-meta">
          {action ? <>Expires {fmtTime(action.expiresAt, timezone)} · </> : null}
          <button type="button" className="wb-link" onClick={onOpenFull}>See the full request on the Canvas</button>
        </span>
        {/* The kit's row: Reject quiet, the standing permissions plain, and
            the one-time yes in green, all at the small size. */}
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => decide('reject')}>
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </Button>
        {reusable ? (
          <>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => decide('approve', 'conversation')}>Auto: this conversation</Button>
            <Button size="sm" disabled={disabled} onClick={() => decide('approve', 'always')}>Always: this agent</Button>
          </>
        ) : null}
        <Button variant="good" size="sm" disabled={disabled} onClick={() => decide('approve')}>
          {busy === 'approve' ? 'Approving…' : reusable ? 'Allow once' : 'Approve'}
        </Button>
      </div>
    </section>
  );
}

/** Where the call runs, when its arguments or its envelope say. */
function whereOf(action: ApprovalRow): string | null {
  for (const source of [action.canonicalArgs, action.envelope]) {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const field of WHERE_FIELDS) {
      const value = (source as Record<string, unknown>)[field];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  }
  return null;
}

/** The first line of the tool's own preview, when the arguments have no subject. */
function firstLine(preview: string | null | undefined): string | null {
  const line = (preview ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}
