/**
 * Accepting an agent a plugin proposes: the one road, wherever it is offered.
 *
 * The Plugins page's Accept button, a plugin page's "Create @mail" line, Home,
 * Agents → Offers and Settings → Proposals all do the same thing: `POST
 * /api/plugins/<plugin>/agents/<id>/accept`. The owner's click is the
 * approval: the route records the gated `platform.accept_plugin_agent` action
 * and decides it as the owner in the same request, so what comes back is the
 * agent. There is no second card to find.
 *
 * The one card there is: when the gateway raised the accept itself (the first
 * mailbox saved), it is waiting in the approvals, and the offer draws that
 * card in place of its button. Approving it is the one click.
 */
import { useState } from 'react';
import { api, ApiError, type AgentOfferRow, type ApprovalRow } from '../../api';
import { Button, ButtonLink, ErrorBanner, Notice, Section, Spacer, Stack, Toolbar, useAsync } from '../../ui';
import { NeedsCard } from './NeedsCard';
import { chatRoute } from '../../routes';
import { ApprovalCard, useDecide } from './ApprovalCard';

/** An agent the accept produced, or found already there. */
export interface AcceptedAgent {
  id: string;
  handle: string;
  name: string;
}

/** Run the accept, and hold the agent it produced. */
export function useAcceptPluginAgent(
  plugin: string | undefined,
  agent: string,
  onAccepted?: (agent: AcceptedAgent) => void,
): {
  accept: () => void;
  busy: boolean;
  created: AcceptedAgent | null;
  failure: string | null;
} {
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<AcceptedAgent | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const accept = (): void => {
    if (!plugin) return;
    setBusy(true);
    setFailure(null);
    api
      .acceptPluginAgent(plugin, agent)
      .then((answer) => {
        setCreated(answer.agent);
        onAccepted?.(answer.agent);
      })
      .catch((error: unknown) => setFailure(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  return { accept, busy, created, failure };
}

/** The one line an accept ends on: the agent is there, and where to talk to it. */
export function AgentReady({ agent }: { agent: AcceptedAgent }): JSX.Element {
  return (
    <Notice tone="good" role="status">
      @{agent.handle} is ready. <a href={chatRoute(agent.id)}>Talk to @{agent.handle}</a>
    </Notice>
  );
}

/** Whether a pending action is the accept of this one proposal. */
export function isPendingAccept(action: ApprovalRow, plugin: string, agent: string): boolean {
  const args = action.canonicalArgs as { plugin?: unknown; agent?: unknown } | null;
  return (
    action.tool === 'platform.accept_plugin_agent' &&
    args?.plugin === plugin &&
    typeof args.agent === 'string' &&
    args.agent.toLowerCase() === agent.toLowerCase()
  );
}

/**
 * The accept already waiting for this proposal, when the gateway raised one.
 * A read that fails is "none": the button is still there, and a click decides
 * whatever is waiting on the server anyway.
 */
function usePendingAccept(plugin: string, agent: string): { action: ApprovalRow | null; reload: () => void } {
  const read = useAsync(() => api.approvals(), [plugin, agent], 15_000);
  const action = read.data?.pending.find((row) => isPendingAccept(row, plugin, agent)) ?? null;
  return { action, reload: read.reload };
}

/** The raised card, drawn where the offer is. Approving it creates the agent. */
function WaitingAccept({
  action,
  onDecided,
}: {
  action: ApprovalRow;
  onDecided: (outcome?: { decision: 'approve' | 'reject'; state?: string }) => void;
}): JSX.Element {
  const { busy, failure, decide } = useDecide((outcome) => onDecided(outcome));
  return (
    <Stack gap="sm">
      <ApprovalCard
        action={action}
        timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
        busy={busy === action.id}
        onDecide={(actionId, decision, scope, choices) => {
          void decide(actionId, decision, scope, choices);
        }}
      />
      <ErrorBanner message={failure} />
    </Stack>
  );
}

/**
 * One offer: a line, and the button that creates the agent. `onDismiss`, when
 * given, puts "Not now" to the left of it. Once the agent exists the row
 * becomes the "ready" line and stays so until the caller next reads: reading
 * again at once would take the line away before the owner saw it.
 */
export function AgentOffer({
  plugin,
  agent,
  text,
  label,
  handle,
  onDismiss,
  card,
}: {
  plugin: string;
  agent: string;
  text: string;
  label: string;
  /** The agent's handle, for the "ready" line after a card is approved. */
  handle?: string;
  onDismiss?: () => void;
  /** Draw it as Home's "Needs you" card, with the plugin's name on the "from" line. */
  card?: { from: string };
}): JSX.Element {
  const offer = useAcceptPluginAgent(plugin, agent);
  const waiting = usePendingAccept(plugin, agent);
  const [approved, setApproved] = useState<AcceptedAgent | null>(null);
  const ready = offer.created ?? approved;
  const said = handle ?? /@(\S+)/.exec(label)?.[1] ?? agent;
  if (ready && card) {
    return (
      <NeedsCard
        kind="offer"
        tone="accent"
        icon="check"
        title={`@${ready.handle} is ready`}
        from={card.from}
        actions={<ButtonLink variant="accent" href={chatRoute(ready.id)}>Talk to @{ready.handle}</ButtonLink>}
      />
    );
  }
  if (ready) return <AgentReady agent={ready} />;
  if (waiting.action) {
    const decided = (outcome?: { decision: 'approve' | 'reject'; state?: string }): void => {
      if (outcome?.decision === 'approve' && outcome.state === 'succeeded') {
        setApproved({ id: agent, handle: said, name: said });
      } else {
        waiting.reload();
      }
    };
    // The waiting approval is itself a "Needs you" card: drawn alone, not inside another.
    if (card) return <WaitingAccept action={waiting.action} onDecided={decided} />;
    return (
      <Stack gap="sm">
        <span>{text}</span>
        <WaitingAccept action={waiting.action} onDecided={decided} />
      </Stack>
    );
  }
  if (card) {
    return (
      <NeedsCard
        kind="offer"
        tone="accent"
        icon="agents"
        title={`Set up @${said}`}
        from={card.from}
        {...(onDismiss ? { dismiss: { onClick: onDismiss, disabled: offer.busy, hint: 'Hide this offer' } } : {})}
        actions={
          <Button variant="accent" disabled={offer.busy} onClick={offer.accept}>
            {label}
          </Button>
        }
      >
        <p>{text}</p>
        <ErrorBanner message={offer.failure} />
      </NeedsCard>
    );
  }
  return (
    <Stack gap="sm">
      <Toolbar>
        <span>{text}</span>
        <Spacer />
        {onDismiss ? (
          <Button variant="ghost" disabled={offer.busy} onClick={onDismiss}>
            Not now
          </Button>
        ) : null}
        <Button variant="accent" disabled={offer.busy} onClick={offer.accept}>
          {label}
        </Button>
      </Toolbar>
      <ErrorBanner message={offer.failure} />
    </Stack>
  );
}

/** The agents your plugins offer, as `/api/agent-offers` says: Home's list, read anywhere. */
export function useAgentOffers(): { offers: AgentOfferRow[]; reload: () => void } {
  const read = useAsync(() => api.agentOffers(), [], 60_000);
  return { offers: read.data?.offers ?? [], reload: read.reload };
}

/**
 * "From your plugins": every agent a plugin offers, each with Create and Not
 * now. The same rows Home shows under "Needs you", drawn where an owner goes
 * looking for them — Agents → Offers, Settings → Proposals. A no said here is
 * the same no Home hears. Nothing at all when there is nothing on offer.
 */
export function PluginAgentOffers({ offers, reload }: { offers: AgentOfferRow[]; reload: () => void }): JSX.Element | null {
  if (offers.length === 0) return null;
  return (
    <Section title="From your plugins" aside={`${offers.length} to decide`} panel>
      <Stack gap="sm" divided>
        {offers.map((offer) => (
          <AgentOffer
            key={`${offer.plugin}/${offer.agent}`}
            plugin={offer.plugin}
            agent={offer.agent}
            text={offer.text}
            label={`Create @${offer.handle}`}
            handle={offer.handle}
            onDismiss={() => { void api.dismissAgentOffer(offer.plugin, offer.agent).then(reload, reload); }}
          />
        ))}
      </Stack>
    </Section>
  );
}
