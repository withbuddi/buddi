/**
 * The immutable action object and the approval state machine (docs/architecture.md,
 * "Actions and approvals").
 *
 * Everything an approval is bound to is decided *before* the owner is asked:
 * the tool and its version, the canonical arguments, the effect envelope the
 * tool itself rendered, the hash of all three, an expiry, and the policy
 * version in force. Execution rechecks the hash, so "any meaningful edit
 * invalidates the approval" is a fact about the code, not a promise.
 */
import { createHash } from 'node:crypto';
import type { OwnerChoice, Tier } from '../tools.js';
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
  | 'refused'
  | 'unknown';

/** States from which nothing more will happen on its own. */
export const TERMINAL_STATES: readonly ApprovalState[] = [
  'rejected',
  'expired',
  'succeeded',
  'failed',
  'refused',
  'unknown',
];

/**
 * The policy version stamped on every action. Bump it when the classification
 * rules change: an action approved under older rules is still readable, and it
 * is visibly *older rules*.
 */
export const POLICY_VERSION = 2;

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
  /** The controls the tool offered the owner. Empty for almost every action. */
  choices: OwnerChoice[];
  /**
   * The tier this call was recorded under — `gated` for every action this
   * build creates. Null on a row written before the column existed.
   *
   * It matters because `ToolDefinition.tierFor` makes the tier a property of
   * the call rather than of the tool: without this, nothing in the record says
   * which rule produced the approval the owner is reading.
   */
  tier: Tier | null;
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
  /** What the owner picked among `choices`, or null when they were never asked. */
  ownerChoices: Record<string, string> | null;
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

/**
 * Policy 2 binds the resolved effect as well as the tool's input references —
 * and, when the tool offered the owner anything, the list of options they were
 * offered.
 *
 * `choices` is folded in only when there are any. That is not an optimisation:
 * an approval created before this column existed hashes to exactly the value it
 * hashed to then, so nothing already waiting for the owner is invalidated by
 * the upgrade. When there *are* choices, they are inside the hash, so an
 * approval cannot be executed against a different menu than the one the owner
 * read.
 */
export function hashAction(
  tool: string,
  toolVersion: string,
  args: unknown,
  envelope: unknown,
  choices?: readonly OwnerChoice[] | null,
  /**
   * The tier the action was created under. Folded in only when present, for
   * the same reason `choices` is: a row from before the column existed hashes
   * to what it hashed to then.
   */
  tier?: Tier | null,
): string {
  const base = { tool, toolVersion, args, envelope };
  const withChoices = choices && choices.length > 0 ? { ...base, choices } : base;
  return sha256(canonicalJson(tier ? { ...withChoices, tier } : withChoices));
}

/* ------------------------------------------------------------------ *
 * Owner choices
 * ------------------------------------------------------------------ */

/** A submitted set of choices that named something nobody offered. */
export class InvalidChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidChoiceError';
  }
}

/**
 * The map an effect runs with, from what the tool declared and what the owner
 * submitted.
 *
 * This is the whole of "what is approved is what is shown" for choices, and it
 * lives here — in core, on the decision path every surface goes through —
 * rather than in any tool or any route:
 *
 *  - a key that was not declared is refused, so a surface cannot invent a
 *    control the preview never mentioned;
 *  - a value that is not one of that key's options is refused, so a surface
 *    cannot smuggle a value past the list the owner read;
 *  - a key the owner did not answer takes the declared default, so a CLI, an
 *    old client and a Telegram keyboard that ran out of room all resolve to the
 *    thing the preview says will happen.
 *
 * It throws rather than returning a result because every caller answers the
 * same way: refuse the decision, change nothing.
 */
export function resolveOwnerChoices(
  declared: readonly OwnerChoice[] | null | undefined,
  submitted: unknown,
): Record<string, string> {
  const list = declared ?? [];
  if (submitted !== undefined && submitted !== null) {
    if (typeof submitted !== 'object' || Array.isArray(submitted)) {
      throw new InvalidChoiceError('choices must be an object of key to value');
    }
  }
  const given = (submitted ?? {}) as Record<string, unknown>;
  const byKey = new Map(list.map((choice) => [choice.key, choice]));
  for (const [key, value] of Object.entries(given)) {
    const choice = byKey.get(key);
    if (!choice) {
      throw new InvalidChoiceError(
        `this approval offers no choice called ${JSON.stringify(key)}`,
      );
    }
    if (typeof value !== 'string' || !choice.options.includes(value)) {
      throw new InvalidChoiceError(
        `${JSON.stringify(String(value))} is not one of the options offered for ${JSON.stringify(key)}`,
      );
    }
  }
  const resolved: Record<string, string> = {};
  for (const choice of list) {
    const value = given[choice.key];
    resolved[choice.key] = typeof value === 'string' ? value : choice.default;
  }
  return resolved;
}

/**
 * A declared choice list, checked at the moment the action is recorded.
 *
 * A tool that declares a default outside its own options, or two controls with
 * one key, has written something the owner could not honestly be shown — and
 * the place to find that out is here, before anybody is asked, rather than at
 * execute time with an approval already granted.
 */
export function validateDeclaredChoices(choices: readonly OwnerChoice[]): OwnerChoice[] {
  const seen = new Set<string>();
  return choices.map((choice) => {
    const key = (choice.key ?? '').trim();
    if (key === '') throw new Error('a declared choice needs a key');
    if (seen.has(key)) throw new Error(`two declared choices share the key ${JSON.stringify(key)}`);
    seen.add(key);
    const options = [...(choice.options ?? [])];
    if (options.length === 0) throw new Error(`the choice ${JSON.stringify(key)} offers no options`);
    if (!options.includes(choice.default)) {
      throw new Error(
        `the default for ${JSON.stringify(key)} is not one of its options`,
      );
    }
    return { key, label: choice.label ?? key, options, default: choice.default };
  });
}

/* ------------------------------------------------------------------ *
 * Row mapping
 * ------------------------------------------------------------------ */

/** A stored tier, read defensively: anything else reads as "not recorded". */
function isTier(value: unknown): value is Tier {
  return value === 'auto' || value === 'draft' || value === 'gated' || value === 'session';
}

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
    // A row read from a build before the column existed has none, which is the
    // same thing as "this action offered the owner nothing to choose".
    choices: toChoiceList(parseJson(row.choices ?? null)),
    tier: isTier(row.tier) ? row.tier : null,
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
    ownerChoices: toChoiceMap(parseJson(row.owner_choices ?? null)),
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

/** A stored `choices` value, read defensively: a malformed one offers nothing. */
function toChoiceList(value: unknown): OwnerChoice[] {
  if (!Array.isArray(value)) return [];
  const out: OwnerChoice[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const choice = entry as Record<string, unknown>;
    if (typeof choice.key !== 'string' || !Array.isArray(choice.options)) continue;
    const options = choice.options.filter((o): o is string => typeof o === 'string');
    if (options.length === 0) continue;
    const fallback = options[0] as string;
    out.push({
      key: choice.key,
      label: typeof choice.label === 'string' ? choice.label : choice.key,
      options,
      default:
        typeof choice.default === 'string' && options.includes(choice.default)
          ? choice.default
          : fallback,
    });
  }
  return out;
}

/** A stored `owner_choices` value. Null means the owner was never asked. */
function toChoiceMap(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
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
