/**
 * Policies a plugin learned, proposed through core (docs/specs/learning.md
 * §2 item 3).
 *
 * The model proposes a policy with `learning.propose_policy`; a plugin that
 * notices the owner deciding the same way — in its own code, not the model's
 * — calls `proposePolicy` here from inside the tool call that noticed. Both
 * land as the same kind of row in `core.proposals`, on the same inbox.
 *
 * The plugin says what it learned and from which inputs (`sources`); core
 * adds where the call stands — agent, conversation, run, turn — from the
 * context the runtime loop stamped, never from anything the plugin or the
 * model wrote about itself. A policy learned from mail is marked untrusted
 * because mail is: the sources name the messages (subject and sender), and
 * nothing of their bodies is stored.
 *
 * Keeping one calls the plugin's own `policies.apply`, discarding its
 * `policies.revoke` (`apply.ts`). Core stores the proposal; the plugin stores
 * the rule.
 */
import type { Queryable } from '../owner.js';
import type { ToolContext } from '../tools.js';
import { createProposal, type CreateProposalResult } from './store.js';
import { MAX_SOURCES, type PolicyPayload, type ProposalProvenance, type UntrustedSource } from './types.js';

export interface ProposePolicyInput {
  plugin: string;
  matcher: Record<string, unknown>;
  action: string;
  params?: Record<string, unknown>;
  verdicts: unknown[];
  why: string;
  /** The untrusted inputs it was learned from: for mail, one per message, by subject and sender. */
  sources: UntrustedSource[];
}

/** Where the call stands, from the tool context alone. */
export function pluginProvenance(
  ctx: Pick<ToolContext, 'agentId' | 'conversationId' | 'toolUseId' | 'provenance'> | null,
  plugin: string,
  sources: UntrustedSource[],
): ProposalProvenance {
  const run = ctx?.provenance?.();
  return {
    agent: ctx?.agentId ?? plugin,
    conversation: ctx?.conversationId ?? null,
    runId: run?.runId ?? null,
    turn: run?.turn ?? null,
    step: run?.step ?? null,
    toolUseId: ctx?.toolUseId ?? null,
    sources: sources.slice(0, MAX_SOURCES),
  };
}

/**
 * Propose a rule on the owner's inbox. `ctx` is the tool call that noticed,
 * or null for a proposal made outside a run (a plugin moving its old
 * proposals into core); the proposing agent is then the plugin itself.
 *
 * Returns what `createProposal` does: a new card, the one already waiting,
 * or a refusal because the owner discarded the same rule in the last 90 days.
 */
export async function proposePolicy(
  db: Queryable,
  ctx: Pick<ToolContext, 'agentId' | 'conversationId' | 'toolUseId' | 'provenance'> | null,
  input: ProposePolicyInput,
  now: Date,
): Promise<CreateProposalResult> {
  const provenance = pluginProvenance(ctx, input.plugin, input.sources);
  const payload: PolicyPayload = {
    plugin: input.plugin,
    matcher: input.matcher,
    action: input.action,
    ...(input.params ? { params: input.params } : {}),
    verdicts: input.verdicts,
    why: input.why,
  };
  return createProposal(db, {
    kind: 'policy',
    agent: provenance.agent,
    payload: payload as unknown as Record<string, unknown>,
    provenance,
    now,
  });
}
