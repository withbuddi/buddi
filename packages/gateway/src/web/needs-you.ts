/**
 * What needs the owner, counted once (docs/dashboard.md, "Needs you").
 *
 * Needs you holds only what the owner can act on, and every surface that
 * counts it — Home's counts line, the rail's badge, the lock screen, the MCP
 * overview — reads this one answer, so no two of them can disagree:
 *
 *   approvals      pending actions waiting for a yes or a no
 *   questions      agents holding a turn for the owner's answer (attention.ts)
 *   urgent         the watchers' decisions: urgent findings with their actions
 *   failed         failed jobs still asking (Retry · Dismiss)
 *   proposals      what agents propose to keep or discard
 *   asks           messages that carry an action (core `needsOwner`)
 *   agentsToSetUp  agents a plugin needs and nobody has, not already an approval
 *   signIns        connections whose sign-in ran out or whose tools need review,
 *                  not closed on Home for the sentence they say now
 *   recovery       1 while a restored installation has its checklist to finish
 *
 * Not here, by the owner's rule: a mission's report, an agent's plain
 * `owner.notify`, a reminder that fired, digests and learned lines. They reach
 * the owner on their channel and stay in Notifications → Recent.
 *
 * A source that cannot be read counts 0 rather than failing the read: a badge
 * that is one short is better than a Home that does not load.
 */
import { countJobsByState, countOpenAsks, countOpenProposals, listPendingActions, type ActionRecord } from '@buddi/core';
import type { ToolRegistry } from '@buddi/core';
import type { Pool } from 'pg';
import { readAlertDecisions } from './alerts.js';
import { readAgentAttention } from './attention.js';
import { isPendingAccept } from './agent-offers.js';
import { readHomeDismissed } from './read.js';

export interface NeedsYou {
  approvals: number;
  questions: number;
  urgent: number;
  failed: number;
  proposals: number;
  asks: number;
  agentsToSetUp: number;
  signIns: number;
  recovery: number;
  /** The sum: the rail's badge. */
  total: number;
}

export const NEEDS_YOU_KEYS = ['approvals', 'questions', 'urgent', 'failed', 'proposals', 'asks', 'agentsToSetUp', 'signIns', 'recovery'] as const;

export interface NeedsYouDeps {
  pool: Pool;
  registry: ToolRegistry;
  now: Date;
  /** The plugins' agent offers (agent-offers.ts); absent counts none. */
  agentOffers?: () => Promise<Array<{ plugin: string; agent: string }>>;
  /** The connections that need the owner; absent counts none. */
  signals?: () => Promise<Array<{ id: string; sentence: string }>>;
  /** Whether a restore's checklist is open; absent counts none. */
  recoveryActive?: () => Promise<boolean>;
}

const zero = <T>(fallback: T) => (): T => fallback;

/** The one count. */
export async function readNeedsYou(deps: NeedsYouDeps): Promise<NeedsYou> {
  const { pool, now } = deps;
  const [pending, attention, decisions, jobs, proposals, asks, offers, signals, recovering, dismissed] = await Promise.all([
    listPendingActions(pool, { now }).catch(zero<ActionRecord[]>([])),
    readAgentAttention(pool, now).catch(() => ({ at: now.toISOString(), agents: [] })),
    readAlertDecisions(pool, deps.registry, now).catch(() => []),
    countJobsByState(pool).catch(() => ({ failed: 0 })),
    countOpenProposals(pool).catch(() => 0),
    countOpenAsks(pool, now).catch(() => 0),
    deps.agentOffers ? deps.agentOffers().catch(() => []) : Promise.resolve([]),
    deps.signals ? deps.signals().catch(() => []) : Promise.resolve([]),
    deps.recoveryActive ? deps.recoveryActive().catch(() => false) : Promise.resolve(false),
    readHomeDismissed(pool).catch(() => ({}) as Record<string, string>),
  ]);
  const counts = {
    approvals: pending.length,
    questions: attention.agents.filter((a) => a.question !== null).length,
    urgent: decisions.length,
    failed: jobs.failed ?? 0,
    proposals,
    asks,
    // An offer whose accept is already waiting is counted once, as the approval.
    agentsToSetUp: offers.filter((o) => !pending.some((action) => isPendingAccept(action, o.plugin, o.agent))).length,
    signIns: signals.filter((s) => dismissed[`connection:${s.id}`] !== s.sentence).length,
    recovery: recovering ? 1 : 0,
  };
  return { ...counts, total: NEEDS_YOU_KEYS.reduce((sum, key) => sum + counts[key], 0) };
}
