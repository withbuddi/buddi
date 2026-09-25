/**
 * Accepting an agent a plugin proposes: the one road, wherever it is offered.
 *
 * The Plugins page's Accept button, the Email settings page's "Create @mail"
 * line and Home's card all do the same thing: `POST /api/plugins/<plugin>/
 * agents/<id>/accept`, which invokes the gated `platform.accept_plugin_agent`
 * as the owner and answers with an approval. The card is drawn where it was
 * asked for, and nothing is written until the owner approves it there.
 */
import { useState } from 'react';
import { api, ApiError, type ApprovalRow } from '../../api';
import { Button, Empty, ErrorBanner, Notice, Spacer, Stack, Toolbar, useAsync } from '../../ui';
import { ApprovalCard, useDecide } from './ApprovalCard';

/** Start the accept, and hold the approval it produced. */
export function useAcceptPluginAgent(plugin: string | undefined, agent: string): {
  accept: () => void;
  busy: boolean;
  approvalId: string | null;
  failure: string | null;
  clear: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const accept = (): void => {
    if (!plugin) return;
    setBusy(true);
    setFailure(null);
    api
      .acceptPluginAgent(plugin, agent)
      .then((answer) => setApprovalId(answer.approvalId ?? null))
      .catch((error: unknown) => setFailure(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  return { accept, busy, approvalId, failure, clear: () => setApprovalId(null) };
}

/**
 * The approval the accept produced, drawn where it was asked for.
 *
 * The very card Home draws, from the same route: a decision made here and a
 * decision made there are the same row, and the same race.
 */
export function AcceptApproval({
  id,
  onDecided,
}: {
  id: string;
  onDecided: (outcome?: { decision: 'approve' | 'reject'; state?: string }) => void;
}): JSX.Element {
  const action = useAsync<ApprovalRow>(() => api.approval(id), [id]);
  const { busy, note, failure, decide } = useDecide((outcome) => onDecided(outcome));
  if (action.error) return <ErrorBanner message={action.error} />;
  if (!action.data) return <Empty>Loading the approval…</Empty>;
  return (
    <Stack gap="sm">
      <ApprovalCard
        action={action.data}
        timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
        busy={busy === id}
        onDecide={(actionId, decision, scope, choices) => {
          void decide(actionId, decision, scope, choices);
        }}
      />
      {note ? <Notice tone="good" role="status">{note}</Notice> : null}
      <ErrorBanner message={failure} />
    </Stack>
  );
}

/**
 * One offer: a line, and the button that starts the accept. `onDismiss`, when
 * given, puts "Not now" to the left of it; `onDone` is told once the approval
 * has been decided either way, so the caller can read again.
 */
export function AgentOffer({
  plugin,
  agent,
  text,
  label,
  onDismiss,
  onDone,
}: {
  plugin: string;
  agent: string;
  text: string;
  label: string;
  onDismiss?: () => void;
  onDone?: () => void;
}): JSX.Element {
  const offer = useAcceptPluginAgent(plugin, agent);
  return (
    <Stack gap="sm">
      <Toolbar>
        <span>{text}</span>
        <Spacer />
        {onDismiss ? (
          <Button variant="ghost" disabled={offer.busy || offer.approvalId !== null} onClick={onDismiss}>
            Not now
          </Button>
        ) : null}
        <Button variant="accent" disabled={offer.busy || offer.approvalId !== null} onClick={offer.accept}>
          {label}
        </Button>
      </Toolbar>
      <ErrorBanner message={offer.failure} />
      {offer.approvalId ? (
        <AcceptApproval
          id={offer.approvalId}
          onDecided={() => {
            offer.clear();
            onDone?.();
          }}
        />
      ) : null}
    </Stack>
  );
}
