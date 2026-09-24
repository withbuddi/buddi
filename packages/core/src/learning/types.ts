/**
 * Learning: buddi proposes, the owner keeps (docs/specs/learning.md).
 *
 * Everything an agent learns is a *proposal* with *provenance*. Nothing here
 * applies itself: a proposal is a row the owner reads, and keeping one is an
 * act the owner performs on a page. What a kept proposal becomes — a skill
 * file, a plugin's policy, a line in the agent file — is the kind's own job.
 */
import type { Pool } from 'pg';

/** The three kinds a proposal can be. Memory, the fourth kind, is the memory plugin's. */
export type ProposalKind = 'skill' | 'policy' | 'change';
export const PROPOSAL_KINDS: readonly ProposalKind[] = ['skill', 'policy', 'change'];

export type ProposalState = 'open' | 'kept' | 'discarded' | 'expired';

/**
 * Where untrusted text in a run came from.
 *
 * `web` a page or a search result, `mail` a message, `file` a document or a
 * command's output, `chat` somebody other than the owner speaking, `finding`
 * a watcher's data, `other` a tool that marked its own output untrusted
 * without declaring what it is.
 */
export type UntrustedKind = 'web' | 'mail' | 'file' | 'chat' | 'finding' | 'other';
export const UNTRUSTED_KINDS: readonly UntrustedKind[] = ['web', 'mail', 'file', 'chat', 'finding', 'other'];

/** One untrusted input that was in the run's context. */
export interface UntrustedSource {
  kind: UntrustedKind;
  /** The tool whose result carried it, `native-search`, or `prompt` for a fenced opening turn. */
  via: string;
  /** What it was, when the call said: a URL, a query, a message id, a path. */
  ref?: string;
}

/**
 * What the run knows about itself when a tool asks. Stamped on the tool
 * context by the runtime loop, per call, from the messages actually in the
 * run's context — never from what the model says about itself.
 */
export interface RunProvenance {
  /** The caller's run id, or the job's; null when the run was given neither. */
  runId: string | null;
  /** The owner turn this run answers, counted from the start of the conversation (1-based). */
  turn: number;
  /** The model step within this run (1-based). */
  step: number;
  sources: UntrustedSource[];
  /**
   * What those sources said, for finding echoes of it in a proposal. Never
   * stored with the proposal; only the matching sentences are.
   */
  texts?: string[];
}

/** What a proposal row records about where it came from. */
export interface ProposalProvenance {
  agent: string;
  conversation: string | null;
  runId: string | null;
  turn: number | null;
  step?: number | null;
  toolUseId?: string | null;
  sources: UntrustedSource[];
  /** Sentences of the proposal that also appear in that untrusted text (`echoes.ts`). */
  echoes?: string[];
}

/** `learning.propose_skill`: a procedure, written by the agent for itself. */
export interface SkillPayload {
  name: string;
  /** When it applies. */
  when: string;
  /** The steps, as the agent would follow them next time. The editable text. */
  body: string;
  why: string;
}

/** `learning.propose_policy`: a repeated decision, as a plugin's rule. */
export interface PolicyPayload {
  plugin: string;
  /**
   * What the rule matches, in the plugin's own terms. Drawn on the card as
   * key and value; a key ending in `Id` is the plugin's internal handle and
   * is not shown.
   */
  matcher: unknown;
  action: string;
  /** What the action needs beyond its name (a label, a category), in the plugin's terms. Not identifying. */
  params?: Record<string, unknown>;
  verdicts: unknown[];
  why: string;
}

/** `learning.propose_change`: a change to the proposing agent's own file. */
export interface ChangePayload {
  part: 'instructions' | 'tools';
  /** What the file says now, when it could be read. */
  before: string | null;
  /** What the agent proposes it says instead. The editable text. */
  proposed: string;
  why: string;
}

export type ProposalPayload = SkillPayload | PolicyPayload | ChangePayload;

export interface Proposal {
  id: string;
  kind: ProposalKind;
  agent: string;
  payload: Record<string, unknown>;
  provenance: ProposalProvenance;
  untrusted: boolean;
  state: ProposalState;
  createdAt: string;
  decidedAt: string | null;
  reason: string | null;
  fingerprint: string;
  toldAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A discarded proposal's fingerprint is remembered this long (§4). */
export const DISCARD_MEMORY_MS = 90 * DAY_MS;
/** A proposal nobody decided is expired after this long (§4). */
export const PROPOSAL_TTL_MS = 30 * DAY_MS;
/** Kept, discarded and expired proposals stay under the fold this long. */
export const PROPOSAL_FOLD_MS = 7 * DAY_MS;
/** How many sources a provenance keeps. A run that read more is marked either way. */
export const MAX_SOURCES = 25;

/**
 * What a plugin gives core so a kept policy becomes the plugin's own rule
 * (docs/specs/learning.md §2 item 3, §4). Core stores the proposal; the
 * plugin stores the rule. Registered as `PluginManifest.policies`.
 */
export interface PolicyHandlerContext {
  db: Pool;
  now: Date;
}

export type PolicyApplyResult =
  | { ok: true; note: string; ref?: string }
  | { ok: false; note: string };

export interface PolicyHandler {
  /** The owner kept it: write the rule the plugin's gate reads. `ok: false` leaves the card open with the note. */
  apply(proposal: Proposal, ctx: PolicyHandlerContext): Promise<PolicyApplyResult>;
  /** The owner discarded it (or took it back): undo whatever the plugin holds for it. */
  revoke?(proposal: Proposal, ctx: PolicyHandlerContext): Promise<{ note: string }>;
  /**
   * Move proposals the plugin held in its own tables before it proposed
   * through core. Run once per start; idempotent. Returns how many moved.
   */
  adopt?(ctx: PolicyHandlerContext): Promise<number>;
  /**
   * How many times the plugin's gate acted on a kept learned rule since
   * `since`: what the weekly digest reports as "stopped doing". Left out by a
   * plugin that does not record it, and the digest says "not measured yet".
   */
  applied?(ctx: PolicyHandlerContext, since: Date): Promise<number>;
}
