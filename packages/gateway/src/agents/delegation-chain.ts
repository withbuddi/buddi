/**
 * Who asked whom: a delegation's place in the conversation tree.
 *
 * `agent.delegate` writes `delegation.started` in the asking conversation the
 * moment the colleague's conversation exists, naming it; the event log is the
 * whole record of the tree, and this file reads it in both directions:
 *
 *  - **up** from a colleague's conversation to the one that asked, and on to
 *    the root — where the owner is, and where an approval raised anywhere
 *    under it must also be shown;
 *  - **down** from a conversation to every colleague conversation it opened,
 *    and theirs — the approvals the root's dock holds besides its own.
 *
 * And one state: whether the asking run is still paused on its colleague.
 * The tool writes `delegation.waiting` when the colleague stops on an
 * approval, and `delegation.finished` when the answer has gone back; the
 * newest of the two for a colleague's conversation is the answer.
 *
 * Every id here was written by the platform — the tool, the loop — never by a
 * model, so a chain read from it is one the installation vouches for.
 */
import type { Queryable } from '@buddi/core';
import { DELEGATION_WAITING } from '@buddi/runtime';

/** Far deeper than delegation allows (one level); a bound, not a policy. */
const MAX_DEPTH = 4;

/** One edge of the tree: `parent` asked `child` through one tool call. */
export interface DelegationLink {
  parentConversationId: string;
  parentAgentId: string;
  childConversationId: string;
  childAgentId: string;
  /** The asking call. Absent on a row written before it was recorded. */
  toolUseId: string | null;
  runId: string | null;
}

/** The edge above one conversation, or null when nobody delegated it. */
export async function parentLink(pool: Queryable, conversationId: string): Promise<DelegationLink | null> {
  const { rows } = await pool.query(
    `select conversation_id, payload from core.events
      where kind = 'delegation.started' and payload->>'conversationId' = $1::text
        and conversation_id is not null
      order by id asc limit 1`,
    [conversationId],
  );
  const row = rows[0];
  if (!row) return null;
  const p = (row.payload ?? {}) as Record<string, unknown>;
  return {
    parentConversationId: String(row.conversation_id),
    parentAgentId: String(p.from ?? ''),
    childConversationId: conversationId,
    childAgentId: String(p.agentId ?? p.to ?? ''),
    toolUseId: typeof p.toolUseId === 'string' ? p.toolUseId : null,
    runId: typeof p.runId === 'string' ? p.runId : null,
  };
}

/** Every edge from this conversation up to the root, nearest first. */
export async function ancestry(pool: Queryable, conversationId: string): Promise<DelegationLink[]> {
  const chain: DelegationLink[] = [];
  let current = conversationId;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const link = await parentLink(pool, current);
    if (!link || chain.some((l) => l.parentConversationId === link.parentConversationId)) break;
    chain.push(link);
    current = link.parentConversationId;
  }
  return chain;
}

/**
 * A conversation somewhere under this one, and the path to it: `toolUseId` is
 * the call *in this conversation* the work went out through, and `chain` the
 * agents from the one working there up to the one that asked here — for a
 * direct colleague, `[colleague, asker]`.
 */
export interface Descendant {
  conversationId: string;
  agentId: string;
  toolUseId: string | null;
  chain: string[];
}

/** Every conversation delegated from this one, at any depth. */
export async function descendants(pool: Queryable, conversationId: string, agentId: string): Promise<Descendant[]> {
  const found: Descendant[] = [];
  let frontier: Array<{ conversationId: string; toolUseId: string | null; chain: string[] }> = [
    { conversationId, toolUseId: null, chain: [agentId] },
  ];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const { rows } = await pool.query(
      `select conversation_id, payload from core.events
        where kind = 'delegation.started' and conversation_id = any($1::uuid[])
        order by id asc`,
      [frontier.map((f) => f.conversationId)],
    );
    const next: typeof frontier = [];
    for (const row of rows) {
      const p = (row.payload ?? {}) as Record<string, unknown>;
      const child = typeof p.conversationId === 'string' ? p.conversationId : null;
      const parent = frontier.find((f) => f.conversationId === String(row.conversation_id));
      if (!child || !parent || child === conversationId || found.some((d) => d.conversationId === child)) continue;
      const childAgent = String(p.agentId ?? p.to ?? '');
      const entry: Descendant = {
        conversationId: child,
        agentId: childAgent,
        // The call that left *this* conversation: the first hop's own id.
        toolUseId: parent.toolUseId ?? (typeof p.toolUseId === 'string' ? p.toolUseId : null),
        chain: [childAgent, ...parent.chain],
      };
      found.push(entry);
      next.push({ conversationId: child, toolUseId: entry.toolUseId, chain: entry.chain });
    }
    frontier = next;
  }
  return found;
}

/** An asking run paused on its colleague, and what it stopped on. */
export interface WaitingDelegation {
  link: DelegationLink;
  /** The approval the colleague is paused on now. */
  actionId: string;
  /** The action the asking run's own `run.finished` names; its resume carries it. */
  parentActionId: string;
}

/**
 * Whether the run that delegated this conversation is still waiting on it.
 *
 * The newest `delegation.waiting` or `delegation.finished` for the colleague's
 * conversation decides: a delegation that already answered is never resumed a
 * second time, whatever arrives late.
 */
export async function waitingDelegation(pool: Queryable, conversationId: string): Promise<WaitingDelegation | null> {
  const link = await parentLink(pool, conversationId);
  if (!link) return null;
  const { rows } = await pool.query(
    `select kind, payload from core.events
      where conversation_id = $1::uuid and kind in ($2, 'delegation.finished')
        and payload->>'conversationId' = $3::text
      order by id desc limit 1`,
    [link.parentConversationId, DELEGATION_WAITING, conversationId],
  );
  const row = rows[0];
  if (!row || row.kind !== DELEGATION_WAITING) return null;
  const p = (row.payload ?? {}) as Record<string, unknown>;
  if (typeof p.actionId !== 'string') return null;
  return {
    link,
    actionId: p.actionId,
    parentActionId: typeof p.parentActionId === 'string' ? p.parentActionId : p.actionId,
  };
}
