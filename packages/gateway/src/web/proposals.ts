/**
 * Settings → Proposals: what the agents learned, waiting for the owner.
 *
 * One read and two writes. Keeping records `kept` and the (possibly
 * corrected) payload, then asks the kind's apply — which, until learning
 * steps 2–4 ship, answers honestly that nothing was applied yet. The page
 * says so on the card rather than pretending.
 */
import {
  APPLY,
  appendEvent,
  describeUntrustedSource,
  discardProposal,
  getProposal,
  keepProposal,
  keptNote,
  listClosedProposals,
  listOpenProposals,
  proposalTitle,
  type Proposal,
} from '@buddi/core';
import type { Pool } from 'pg';
import type { WriteDeps, WriteResult } from './write.js';

export interface ProposalView {
  id: string;
  kind: Proposal['kind'];
  agent: string;
  title: string;
  why: string;
  /** The text the owner may correct before keeping: a skill's steps, a change's proposed text. Null for a policy. */
  editable: string | null;
  payload: Record<string, unknown>;
  conversationId: string | null;
  turn: number | null;
  runId: string | null;
  untrusted: boolean;
  /** One line per untrusted source, in the order they entered the run. */
  sources: string[];
  state: Proposal['state'];
  createdAt: string;
  decidedAt: string | null;
  reason: string | null;
  /** For a kept proposal: what keeping did, or when it will. */
  note: string | null;
}

/** The field of the payload the editor writes, per kind. */
function editableField(kind: Proposal['kind']): 'body' | 'proposed' | null {
  return kind === 'skill' ? 'body' : kind === 'change' ? 'proposed' : null;
}

export function toProposalView(p: Proposal): ProposalView {
  const field = editableField(p.kind);
  return {
    id: p.id,
    kind: p.kind,
    agent: p.agent,
    title: proposalTitle(p),
    why: typeof p.payload.why === 'string' ? p.payload.why : '',
    editable: field && typeof p.payload[field] === 'string' ? (p.payload[field] as string) : null,
    payload: p.payload,
    conversationId: p.provenance.conversation ?? null,
    turn: p.provenance.turn ?? null,
    runId: p.provenance.runId ?? null,
    untrusted: p.untrusted,
    sources: (p.provenance.sources ?? []).map(describeUntrustedSource),
    state: p.state,
    createdAt: p.createdAt,
    decidedAt: p.decidedAt,
    reason: p.reason,
    note: p.state === 'kept' ? keptNote(p.kind) : null,
  };
}

export async function readProposals(
  pool: Pool,
  now: Date,
): Promise<{ open: ProposalView[]; closed: ProposalView[] }> {
  const [open, closed] = await Promise.all([listOpenProposals(pool), listClosedProposals(pool, { now })]);
  return { open: open.map(toProposalView), closed: closed.map(toProposalView) };
}

const DECIDED_ALREADY = 'That proposal was already decided.';

async function notOpen(deps: WriteDeps, id: string): Promise<WriteResult<never>> {
  const existing = await getProposal(deps.pool, id);
  return existing
    ? { ok: false, status: 409, body: { error: DECIDED_ALREADY } }
    : { ok: false, status: 404, body: { error: 'That proposal is no longer here.' } };
}

/**
 * Keep it, optionally with the owner's corrected text. Only the editable
 * field can change: the name, the part, the plugin and the matcher are what
 * the proposal *is*, and the fingerprint is built from them.
 */
export async function keepProposalFromWeb(
  deps: WriteDeps,
  id: string,
  text: string | undefined,
): Promise<WriteResult<{ proposal: ProposalView; applied: boolean; note: string }>> {
  const current = await getProposal(deps.pool, id);
  if (!current) return notOpen(deps, id);
  if (current.state !== 'open') return notOpen(deps, id);
  const field = editableField(current.kind);
  let payload: Record<string, unknown> | undefined;
  if (text !== undefined && field) {
    if (text.trim() === '') return { ok: false, status: 400, body: { error: 'The kept version cannot be empty.' } };
    if (text !== current.payload[field]) payload = { ...current.payload, [field]: text, edited: true };
  }
  const kept = await keepProposal(deps.pool, { id, now: deps.now(), ...(payload ? { payload } : {}) });
  if (!kept) return notOpen(deps, id);
  const outcome = await APPLY[kept.kind](kept);
  await appendEvent(
    deps.pool,
    'proposal.kept',
    { id: kept.id, kind: kept.kind, agent: kept.agent, title: proposalTitle(kept), edited: payload !== undefined, applied: outcome.applied },
  ).catch(() => undefined);
  return { ok: true, status: 200, body: { proposal: toProposalView(kept), applied: outcome.applied, note: outcome.note } };
}

export async function discardProposalFromWeb(
  deps: WriteDeps,
  id: string,
  reason: string | undefined,
): Promise<WriteResult<{ proposal: ProposalView }>> {
  const discarded = await discardProposal(deps.pool, { id, reason: reason ?? null, now: deps.now() });
  if (!discarded) return notOpen(deps, id);
  await appendEvent(
    deps.pool,
    'proposal.discarded',
    { id: discarded.id, kind: discarded.kind, agent: discarded.agent, title: proposalTitle(discarded), reason: discarded.reason },
  ).catch(() => undefined);
  return { ok: true, status: 200, body: { proposal: toProposalView(discarded) } };
}
