/**
 * "Which of my agents is waiting on me?"
 *
 * The dashboard's agent rail draws one face per installed agent, and a face
 * carries a badge only when that agent cannot get any further without the
 * owner. This module is the whole definition of that sentence, in one place,
 * so the rail never has to decide what counts.
 *
 * **Two states count, and nothing else.**
 *
 *  1. **A pending approval.** A run proposed a gated effect and stopped. It is
 *     literally suspended until a decision arrives: the strongest possible
 *     "needs you" an installation has. One raised inside a delegation counts
 *     for the colleague and for every agent that asked on the way down, since
 *     each of their runs is paused on it.
 *  2. **A held question.** The turn ended by calling `conversation.ask` — the
 *     agent declared that it cannot finish without an answer. The dashboard
 *     registers that tool for its interactive turns exactly as Telegram and the
 *     terminal do; what is new here is that the declaration is *recorded in the
 *     event log* rather than kept in memory, because a badge has to survive the
 *     reload the in-memory routing claim never had to.
 *
 * Activity is deliberately **not** a state. Forty triaged newsletters is not a
 * number on an agent's face: a dot that is always lit is a dot the owner learns
 * to stop reading, and that costs exactly the two states above, which are the
 * only ones worth interrupting anybody for. There are no unread counts here for
 * the same reason.
 *
 * Both states clear themselves. An approval leaves `pending` when it is decided
 * or expires; a question is cleared when the owner next writes to that agent,
 * and in any case stops counting after `PENDING_TTL_MS` — the same fifteen
 * minutes the routing claim lives for, because a question the owner walked away
 * from is not an obligation an hour later.
 */
import { listPendingActions, type Queryable } from '@buddi/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { PENDING_TTL_MS } from '../surfaces/pending-question.js';
import { streamLog, type LogRow } from './stream.js';
import { ancestry } from '../agents/delegation-chain.js';

/** The turn declared it is waiting for an answer. Payload: `{ agentId }`. */
export const QUESTION_ASKED = 'chat.question.asked';

/** The owner wrote to that agent again, so it is no longer holding. */
export const QUESTION_CLEARED = 'chat.question.cleared';

/** Pending approvals read in one pass. Far more than any owner should have. */
const APPROVAL_SCAN_LIMIT = 200;

/**
 * Log kinds that can change the answer. `action.created` opens an approval,
 * `approval.decided` and `approval.expired` close one, and the two question
 * kinds are this module's own. Nothing else moves the badge, which is what
 * keeps the attention stream quiet enough to be worth tailing.
 */
export const ATTENTION_KINDS: readonly string[] = [
  'action.created',
  'approval.decided',
  'approval.expired',
  QUESTION_ASKED,
  QUESTION_CLEARED,
];

/** One agent's claim on the owner. Absent from the list when it has none. */
export interface AgentAttention {
  agentId: string;
  /** Approvals of this agent's that are pending and unexpired. */
  approvals: number;
  /** When the oldest of them was proposed — "since when" for the tooltip. */
  oldestApprovalAt: string | null;
  /** Set when the agent's last turn ended by asking the owner something. */
  question: { at: string; conversationId: string | null } | null;
}

export interface AttentionSnapshot {
  at: string;
  agents: AgentAttention[];
}

/**
 * Who is waiting, right now.
 *
 * Only agents with something are returned: an empty list is the ordinary case
 * and the page draws nothing from it, rather than having to filter zeroes.
 */
export async function readAgentAttention(
  pool: Queryable,
  now: Date = new Date(),
): Promise<AttentionSnapshot> {
  const [approvals, questions] = await Promise.all([
    pendingByAgent(pool, now),
    heldQuestions(pool, now),
  ]);

  const agentIds = new Set<string>([...approvals.keys(), ...questions.keys()]);
  const agents = [...agentIds]
    .sort()
    .map((agentId): AgentAttention => {
      const approval = approvals.get(agentId);
      return {
        agentId,
        approvals: approval?.count ?? 0,
        oldestApprovalAt: approval?.oldestAt ?? null,
        question: questions.get(agentId) ?? null,
      };
    });

  return { at: now.toISOString(), agents };
}

async function pendingByAgent(
  pool: Queryable,
  now: Date,
): Promise<Map<string, { count: number; oldestAt: string }>> {
  const pending = await listPendingActions(pool, { now, limit: APPROVAL_SCAN_LIMIT });
  const byAgent = new Map<string, { count: number; oldestAt: string }>();
  const count = (agentId: string, at: string): void => {
    const seen = byAgent.get(agentId);
    if (seen === undefined) byAgent.set(agentId, { count: 1, oldestAt: at });
    else byAgent.set(agentId, { count: seen.count + 1, oldestAt: min(seen.oldestAt, at) });
  };
  for (const action of pending) {
    const at = action.createdAt.toISOString();
    count(action.agentId, at);
    // Raised inside a delegation: every agent up the chain is paused on it
    // too, and the one the owner was talking to is where they will look.
    if (!action.conversationId) continue;
    const chain = await ancestry(pool, action.conversationId).catch(() => []);
    for (const link of chain) if (link.parentAgentId && link.parentAgentId !== action.agentId) count(link.parentAgentId, at);
  }
  return byAgent;
}

function min(a: string, b: string): string {
  return a <= b ? a : b;
}

/**
 * The last thing each agent said about a question, inside the TTL window.
 *
 * `distinct on` over the log is the whole implementation: the newest of the two
 * kinds per agent wins, and it counts only when it is the `asked` one. A
 * question older than the window is simply not selected, so nothing has to
 * sweep and nothing can get stuck lit.
 */
async function heldQuestions(
  pool: Queryable,
  now: Date,
): Promise<Map<string, { at: string; conversationId: string | null }>> {
  const cutoff = new Date(now.getTime() - PENDING_TTL_MS);
  const { rows } = await pool.query(
    `select distinct on (payload->>'agentId')
            payload->>'agentId' as agent_id, kind, conversation_id, created_at
       from core.events
      where kind = any($1::text[])
        and created_at > $2
        and payload->>'agentId' is not null
      order by payload->>'agentId', id desc`,
    [[QUESTION_ASKED, QUESTION_CLEARED], cutoff],
  );

  const held = new Map<string, { at: string; conversationId: string | null }>();
  for (const row of rows) {
    if (String(row.kind) !== QUESTION_ASKED) continue;
    held.set(String(row.agent_id), {
      at: new Date(row.created_at).toISOString(),
      conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    });
  }
  return held;
}

/**
 * Is this agent currently holding a question?
 *
 * Asked before the surface writes a `cleared`, so an ordinary message does not
 * append a "nothing changed" row to the log on every single turn.
 */
export async function holdsQuestion(
  pool: Queryable,
  agentId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return (await heldQuestions(pool, now)).has(agentId);
}

/**
 * The attention stream: the same log, tailed without a conversation filter.
 *
 * It carries no payload worth parsing — one `attention` frame means "the answer
 * may have changed, ask again". That is deliberate: the snapshot is one small
 * query, and a stream that shipped its own projection would be a second place
 * for "what counts as waiting" to be decided.
 */
export async function streamAttention(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { pool: Pool; since?: string | undefined; now?: () => Date; pollMs?: number; pingMs?: number },
): Promise<void> {
  await streamLog(req, res, {
    ...opts,
    head: () => head(opts.pool),
    tail: (cursor, limit) => tail(opts.pool, cursor, limit),
    project: (row: LogRow) => ({ event: 'attention', data: { at: row.createdAt.toISOString() } }),
  });
}

async function head(pool: Pool): Promise<string> {
  const { rows } = await pool.query(
    `select coalesce(max(id), 0)::text as id from core.events where kind = any($1::text[])`,
    [ATTENTION_KINDS],
  );
  return String(rows[0]?.id ?? '0');
}

async function tail(pool: Pool, cursor: string, limit: number): Promise<LogRow[]> {
  const { rows } = await pool.query(
    `select id, kind, payload, created_at from core.events
      where id > $1::bigint and kind = any($2::text[])
      order by id asc
      limit $3`,
    [cursor, ATTENTION_KINDS, limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    payload: (r.payload ?? {}) as Record<string, unknown>,
    createdAt: new Date(r.created_at),
  }));
}
