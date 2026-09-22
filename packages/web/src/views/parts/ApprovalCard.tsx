/**
 * One approval, waiting: what the tool wrote, what it will do, and the two
 * decisions. Drawn on Home and on the agent's page from the same rows the
 * Telegram buttons act on, so a decision anywhere is one race with one winner.
 */
import { useState } from 'react';
import { api, type ApprovalRow } from '../../api';
import { fmtRelative, fmtTime, json, short } from '../../format';
import { Button, Card, Code, Pill, Section, Toolbar } from '../../ui';
import { useOwnerChoices } from './OwnerChoices';

export type Decision = 'approve' | 'reject';
export type Scope = 'once' | 'conversation' | 'always';

/**
 * The shared decide call, and the sentence it produces for a status line.
 *
 * `onDone` is handed what the decision did — `approve`/`reject`, and the
 * execution's state when there was one — for the callers that have something
 * to do only when the effect actually happened. Callers that just reload
 * ignore the argument.
 */
export function useDecide(
  onDone: (outcome?: { decision: Decision; state?: string; result?: unknown }) => void,
): {
  busy: string | null;
  note: string | null;
  failure: string | null;
  decide: (id: string, decision: Decision, scope?: Scope, choices?: Record<string, string>) => Promise<void>;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const decide = async (
    id: string,
    decision: Decision,
    scope?: Scope,
    choices?: Record<string, string>,
  ): Promise<void> => {
    setBusy(id);
    setFailure(null);
    setNote(null);
    /*
     * Undefined until the server has actually decided. A failed call — the
     * gateway restarting, a 500 — must not read as "decided": a caller that
     * is holding something back until the effect happened would let it go on
     * a network blip, which is the one thing an approval exists to prevent.
     */
    let outcome: { decision: Decision; state?: string; result?: unknown } | undefined;
    try {
      // Only pass what there is: an approval that offered no controls makes
      // exactly the request it always made.
      const result = choices
        ? await api.decide(id, decision, scope, choices)
        : await api.decide(id, decision, scope);
      /*
       * The tool's own output travels with the decision. A page holding a
       * sentence to print — "Queued for 9:00", read out of the result — has
       * no other way to get it: the effect happened *here*, in the approval,
       * not in the call that proposed it.
       */
      outcome = {
        decision,
        ...(result.execution?.state ? { state: result.execution.state } : {}),
        ...(result.execution && 'result' in result.execution ? { result: result.execution.result } : {}),
      };
      setNote(
        decision === 'reject'
          ? `Rejected ${result.action.tool}.`
          : result.execution?.state === 'succeeded'
            ? `Approved and done: ${result.action.tool}.`
            : `Approved ${result.action.tool}: ${result.execution?.state ?? 'no execution'}${
                result.execution?.message ? ` (${result.execution.message})` : ''
              }`,
      );
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      // Always called — a list still reloads after a failure — but with
      // `undefined` when nothing was decided, and that is the bit that
      // matters to a caller waiting on the outcome.
      onDone(outcome);
    }
  };
  return { busy, note, failure, decide };
}

export function ApprovalCard({
  action,
  timezone,
  busy,
  onDecide,
  agentName,
}: {
  action: ApprovalRow;
  timezone: string;
  busy: boolean;
  onDecide: (id: string, decision: Decision, scope?: Scope, choices?: Record<string, string>) => void;
  agentName?: string;
}): JSX.Element {
  const [showEnvelope, setShowEnvelope] = useState(false);
  // The tool's own controls, above the buttons: they change what Approve
  // means, and the options on them are the action's, never this page's.
  const { values, controls } = useOwnerChoices(action.choices);
  /** The decision, carrying the controls only when the tool declared any. */
  const approve = (scope?: Scope): void =>
    values ? onDecide(action.id, 'approve', scope, values) : onDecide(action.id, 'approve', scope);
  return (
    <Card
      tone="accent"
      title={action.tool}
      meta={
        <>
          <Pill>v{action.toolVersion}</Pill>
          <span className="muted">asked by {agentName ?? action.agentId}</span>
        </>
      }
    >
      <Code>{action.preview}</Code>
      <p className="ui-card-meta">
        Expires {fmtTime(action.expiresAt, timezone)} ({fmtRelative(action.expiresAt)}). Policy v{action.policyVersion},
        args {short(action.argsHash, 12)}
        {action.jobId ? `, job ${short(action.jobId)}` : ''}.
      </p>
      {controls}
      <Toolbar>
        <Button variant="good" disabled={busy} onClick={() => approve()}>
          {action.permissionScopes?.length ? 'Allow once' : 'Approve'}
        </Button>
        {action.permissionScopes?.length ? (
          <>
            <Button disabled={busy} onClick={() => approve('conversation')}>
              Auto: this conversation
            </Button>
            <Button disabled={busy} onClick={() => approve('always')}>
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
          <Section title="Envelope: everything that decides what the world will see">
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
