/**
 * What a thread hands the owner to decide: offers (and the hand-offs among
 * them), the agent's question with its choices, and pending approvals.
 *
 * The full chat and the corner chat both draw these, and they must draw them
 * the same way — a dinner that needs approving from the Calendar page's corner
 * chat once sent the owner off to the full chat to tap Approve. So the logic
 * lives here once: the take-an-offer and answer-a-question calls, the list of
 * approvals still open, and the offer buttons. Each surface keeps its own
 * layout around them and uses the same ApprovalDock and QuestionPicker.
 */
import { useState } from 'react';
import { ApiError, api, chatApi } from '../api';
import { renderablesFrom } from '../canvas/renderables';
import { catalogueInstallRoute, chatRoute } from '../routes';
import type { DockedApproval } from './ApprovalDock';
import type { ChatAgent, ChatConversation, ChatOffer } from './types';

/** "@art, asked by @playground" — the chain, from the agent that raised it up. */
export function askedByLine(chain: readonly string[], agents: readonly ChatAgent[]): string {
  const handle = (id: string): string => `@${agents.find((agent) => agent.id === id)?.handle ?? id}`;
  const [raised, ...askers] = chain;
  if (raised === undefined) return '';
  return [handle(raised), ...askers.map((id) => `asked by ${handle(id)}`)].join(', ');
}

/**
 * Every approval this thread waits on, oldest first: the agent's own gated
 * calls (read from the transcript, or from `awaiting` before the transcript
 * has caught up) and a colleague's under one of its delegations.
 */
export function pendingApprovals(
  conversation: ChatConversation | null,
  agents: readonly ChatAgent[],
  awaiting?: ReadonlyMap<string, string>,
): DockedApproval[] {
  if (!conversation) return [];
  const own = renderablesFrom({ messages: conversation.messages, descriptors: [], ...(awaiting ? { awaiting: new Map(awaiting) } : {}) })
    .filter((item) => item.source === 'approval')
    .map((item) => ({ approvalId: (item.props as { approvalId: string }).approvalId, toolUseId: item.id }));
  return [...own, ...delegatedApprovals(conversation, agents)];
}

/** A colleague's approvals under this thread's delegations, decided here. */
export function delegatedApprovals(conversation: ChatConversation | null, agents: readonly ChatAgent[]): DockedApproval[] {
  return (conversation?.delegatedApprovals ?? []).map((item) => ({
    approvalId: item.approvalId,
    toolUseId: item.toolUseId ?? '',
    askedBy: askedByLine(item.chain, agents),
  }));
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
}

/**
 * Taking an offer and answering a question, for one thread.
 *
 * Taking an offer is the Telegram tap in a browser: the request names an id,
 * the server claims that row once and runs the prompt the agent wrote, and an
 * effect still comes back as the approval it always was. An install hand-off
 * opens the catalogue's sheet; a maker hand-off follows the new conversation.
 */
export function useThreadActions({
  conversation,
  conversationId,
  agentId,
  now,
  refresh,
  onRunStarted,
  onError,
  navigate,
}: {
  conversation: ChatConversation | null;
  conversationId: string | null;
  agentId: string | null;
  now: number;
  refresh: (conversationId: string) => Promise<void> | void;
  /** A run started in this thread (an offer taken here, a question answered). */
  onRunStarted: () => void;
  /** Something failed (null clears the last failure); `endedRun` when the run it started is off. */
  onError: (message: string | null, endedRun?: boolean) => void;
  navigate: (route: string) => void;
}): {
  openOffers: ChatOffer[];
  takingOffer: string | null;
  takeOffer: (id: string) => void;
  answeringQuestion: boolean;
  answerQuestion: (answer: string, optionId?: string) => void;
  skipQuestion: () => void;
} {
  const [takingOffer, setTakingOffer] = useState<string | null>(null);
  const [takenOffers, setTakenOffers] = useState<string[]>([]);
  const [answeringQuestion, setAnsweringQuestion] = useState(false);

  /*
   * The chips still on the table: not clicked, not expired. A page open all
   * afternoon holds an older answer than the server's, and a chip that can
   * only be refused is worse than none.
   */
  const openOffers = (conversation?.offers ?? []).filter(
    (offer) => !takenOffers.includes(offer.id) && Date.parse(offer.expiresAt) > now,
  );

  const takeOffer = (id: string): void => {
    const offer = openOffers.find((o) => o.id === id);
    if (offer?.handoff?.kind === 'install') {
      navigate(catalogueInstallRoute(offer.handoff.package));
      return;
    }
    onError(null);
    setTakingOffer(id);
    setTakenOffers((taken) => [...taken, id]);
    api
      .takeOffer(id, conversationId ?? undefined)
      .then((result) => {
        if (result.agentId && result.agentId !== agentId) {
          navigate(chatRoute(result.agentId, result.conversationId ?? null));
          return;
        }
        if (result.runId) onRunStarted();
        if (conversationId) void refresh(conversationId);
      })
      .catch((err: unknown) => {
        setTakenOffers((taken) => taken.filter((other) => other !== id));
        onError(errorText(err));
        if (conversationId) void refresh(conversationId);
      })
      .finally(() => setTakingOffer(null));
  };

  const settleQuestion = (body: { answer: string; optionId?: string; skipped?: boolean }): void => {
    const question = conversation?.question;
    if (!question) return;
    onError(null);
    setAnsweringQuestion(true);
    onRunStarted();
    chatApi
      .answerQuestion(question.id, body)
      .then(() => {
        if (conversationId) return refresh(conversationId);
        return undefined;
      })
      .catch((err: unknown) => onError(errorText(err), true))
      .finally(() => setAnsweringQuestion(false));
  };

  return {
    openOffers,
    takingOffer,
    takeOffer,
    answeringQuestion,
    answerQuestion: (answer, optionId) => settleQuestion({ answer, ...(optionId ? { optionId } : {}) }),
    skipQuestion: () => settleQuestion({ answer: '', skipped: true }),
  };
}

/** The offer chips under a turn, hand-offs included. */
export function OfferButtons({
  offers,
  disabled,
  onTake,
}: {
  offers: readonly ChatOffer[];
  disabled: boolean;
  onTake: (id: string) => void;
}): JSX.Element | null {
  if (offers.length === 0) return null;
  return (
    <div className="wb-offers" data-testid="chat-offers">
      {offers.map((offer) => (
        <button
          key={offer.id}
          type="button"
          className="ui-btn"
          disabled={disabled}
          title={offer.handoff?.kind === 'install' ? `Opens ${offer.handoff.title}'s install sheet` : offer.prompt}
          data-handoff={offer.handoff?.kind}
          onClick={() => onTake(offer.id)}
        >
          {offer.label}
        </button>
      ))}
    </div>
  );
}
