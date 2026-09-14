/**
 * The immutable action object and the approval state machine (ARCHITECTURE.md,
 * "Actions and approvals").
 *
 * Everything an approval is bound to is decided *before* the owner is asked:
 * the tool and its version, the canonical arguments, the effect envelope the
 * tool itself rendered, the hash of all three, an expiry, and the policy
 * version in force. Execution rechecks the hash, so "any meaningful edit
 * invalidates the approval" is a fact about the code, not a promise.
 */
import { createHash } from 'node:crypto';
// The narrow slice of `pg.Pool` core uses everywhere. Declared once, in
// `owner.ts`, so `@buddi/core` exports exactly one `Queryable`.
export type { Queryable } from '../owner.js';

/**
 * `pending -> approved -> executing -> succeeded | failed | unknown`, plus
 * `rejected` and `expired`. `unknown` is a timeout after dispatch: never
 * auto-failed and never auto-retried.
 */
export type ApprovalState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'unknown';

/** States from which nothing more will happen on its own. */
export const TERMINAL_STATES: readonly ApprovalState[] = [
  'rejected',
  'expired',
  'succeeded',
  'failed',
  'unknown',
];

/**
 * The policy version stamped on every action. Bump it when the classification
 * rules change: an action approved under older rules is still readable, and it
 * is visibly *older rules*.
 */
export const POLICY_VERSION = 1;

/** How long an approval request stands before it expires. */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a dispatched effect may run before it is recorded as `unknown`. */
export const DEFAULT_EFFECT_TIMEOUT_MS = 60_000;

export interface ActionRecord {
  id: string;
  tool: string;
  toolVersion: string;
  agentId: string;
  conversationId: string | null;
  jobId: string | null;
  canonicalArgs: unknown;
  envelope: unknown;
  argsHash: string;
  preview: string;
  expiresAt: Date;
  policyVersion: number;
  createdAt: Date;
  /** The approval row that always accompanies an action. */
  state: ApprovalState;
  decidedBy: string | null;
  decidedVia: string | null;
  decidedAt: Date | null;
  claimedBy: string | null;
  claimedAt: Date | null;
  outcome: unknown;
  updatedAt: Date;
}

export interface EffectAttemptRecord {
  id: string;
  actionId: string;
  attempt: number;
  startedAt: Date;
  finishedAt: Date | null;
  state: 'executing' | 'succeeded' | 'failed' | 'unknown';
  envelopeHash: string;
  result: unknown;
  error: string | null;
}

/* ------------------------------------------------------------------ *
 * Canonicalization and hashing
 * ------------------------------------------------------------------ */

/**
 * A value with object keys sorted, deterministically, all the way down.
 *
 * The hash an approval is bound to must not move because a tool rebuilt its
 * arguments in a different key order, and it *must* move when a value changes.
 * `undefined` members are dropped, exactly as JSON would.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = canonicalize(v);
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value) ?? null);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The hash execution rechecks: tool, tool version and canonical arguments
 * together. A tool upgraded under a standing approval fails the recheck, which
 * is the intended answer: the owner approved *that* code doing *that* thing.
 */
export function hashArgs(tool: string, toolVersion: string, args: unknown): string {
  return sha256(`${tool} ${toolVersion} ${canonicalJson(args)}`);
}

/** The envelope hash written to the ledger before dispatch. */
export function hashEnvelope(envelope: unknown): string {
  return sha256(canonicalJson(envelope));
}

/* ------------------------------------------------------------------ *
 * Row mapping
 * ------------------------------------------------------------------ */

export function toActionRecord(row: any): ActionRecord {
  return {
    id: String(row.id),
    tool: row.tool,
    toolVersion: row.tool_version,
    agentId: row.agent_id,
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    jobId: row.job_id === null || row.job_id === undefined ? null : String(row.job_id),
    canonicalArgs: parseJson(row.canonical_args),
    envelope: parseJson(row.envelope),
    argsHash: row.args_hash,
    preview: row.preview,
    expiresAt: new Date(row.expires_at),
    policyVersion: Number(row.policy_version),
    createdAt: new Date(row.created_at),
    state: row.state as ApprovalState,
    decidedBy: row.decided_by ?? null,
    decidedVia: row.decided_via ?? null,
    decidedAt: row.decided_at ? new Date(row.decided_at) : null,
    claimedBy: row.claimed_by ?? null,
    claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
    outcome: parseJson(row.outcome ?? null),
    updatedAt: new Date(row.updated_at),
  };
}

export function toAttemptRecord(row: any): EffectAttemptRecord {
  return {
    id: String(row.id),
    actionId: String(row.action_id),
    attempt: Number(row.attempt),
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : null,
    state: row.state,
    envelopeHash: row.envelope_hash,
    result: parseJson(row.result ?? null),
    error: row.error ?? null,
  };
}

/** `jsonb` comes back parsed from `pg`; tolerate a string for other drivers. */
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
