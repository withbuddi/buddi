/**
 * The proposal store: `core.proposals` (migration 038).
 *
 * Every write is one statement guarded on state, so a double click, two tabs
 * or the expiry sweep racing the owner produce one decision and one "already
 * decided". Nothing here applies a proposal: `keepProposal` records that the
 * owner kept it, and what keeping *does* is `apply.ts`.
 */
import type { Queryable } from '../owner.js';
import { proposalFingerprint } from './fingerprint.js';
import {
  DISCARD_MEMORY_MS,
  PROPOSAL_FOLD_MS,
  PROPOSAL_TTL_MS,
  type Proposal,
  type ProposalKind,
  type ProposalProvenance,
  type ProposalState,
} from './types.js';

const COLUMNS =
  'id, kind, agent, payload, provenance, untrusted, state, created_at, decided_at, reason, fingerprint, told_at';

const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : new Date(value as string).toISOString();

export function toProposal(row: Record<string, unknown>): Proposal {
  return {
    id: String(row.id),
    kind: row.kind as ProposalKind,
    agent: String(row.agent),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    provenance: (row.provenance ?? { sources: [] }) as ProposalProvenance,
    untrusted: row.untrusted === true,
    state: row.state as ProposalState,
    createdAt: iso(row.created_at) as string,
    decidedAt: iso(row.decided_at),
    reason: (row.reason as string | null) ?? null,
    fingerprint: String(row.fingerprint),
    toldAt: iso(row.told_at),
  };
}

export interface CreateProposalInput {
  kind: ProposalKind;
  agent: string;
  payload: Record<string, unknown>;
  provenance: ProposalProvenance;
  now: Date;
}

export type CreateProposalResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; reason: 'recently-discarded' | 'already-open'; message: string; existing: Proposal };

/** The one line an agent reads when the owner already said no to this. */
export function discardedLine(existing: Proposal): string {
  const on = (existing.decidedAt ?? existing.createdAt).slice(0, 10);
  const until = new Date(new Date(existing.decidedAt ?? existing.createdAt).getTime() + DISCARD_MEMORY_MS)
    .toISOString()
    .slice(0, 10);
  return `The owner discarded this on ${on}${existing.reason ? ` ("${existing.reason}")` : ''}; do not propose it again before ${until}.`;
}

/**
 * Record a proposal, unless the owner discarded the same one in the last 90
 * days or the same one is already waiting.
 *
 * `untrusted` is derived here from the provenance, not passed in: the mark on
 * the card and the sources under it can never disagree.
 */
export async function createProposal(db: Queryable, input: CreateProposalInput): Promise<CreateProposalResult> {
  const fingerprint = proposalFingerprint(input.kind, input.agent, input.payload);
  const since = new Date(input.now.getTime() - DISCARD_MEMORY_MS);
  const prior = await db.query(
    `select ${COLUMNS} from core.proposals
      where fingerprint = $1
        and (state = 'open' or (state = 'discarded' and decided_at >= $2))
      order by (state = 'discarded') desc, decided_at desc nulls last
      limit 1`,
    [fingerprint, since],
  );
  if (prior.rows[0]) {
    const existing = toProposal(prior.rows[0]);
    return existing.state === 'discarded'
      ? { ok: false, reason: 'recently-discarded', message: discardedLine(existing), existing }
      : {
          ok: false,
          reason: 'already-open',
          message: `The same proposal is already waiting for the owner (${existing.id}); there is nothing to add.`,
          existing,
        };
  }
  const { rows } = await db.query(
    `insert into core.proposals (kind, agent, payload, provenance, untrusted, fingerprint, created_at)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
     on conflict (fingerprint) where state = 'open' do nothing
     returning ${COLUMNS}`,
    [
      input.kind,
      input.agent,
      JSON.stringify(input.payload),
      JSON.stringify(input.provenance),
      input.provenance.sources.length > 0,
      fingerprint,
      input.now,
    ],
  );
  if (rows[0]) return { ok: true, proposal: toProposal(rows[0]) };
  // Lost a race with an identical proposal: that one is the card.
  const again = await db.query(`select ${COLUMNS} from core.proposals where fingerprint = $1 and state = 'open'`, [fingerprint]);
  const existing = toProposal(again.rows[0]);
  return {
    ok: false,
    reason: 'already-open',
    message: `The same proposal is already waiting for the owner (${existing.id}); there is nothing to add.`,
    existing,
  };
}

export async function getProposal(db: Queryable, id: string): Promise<Proposal | null> {
  const { rows } = await db.query(`select ${COLUMNS} from core.proposals where id::text = $1`, [id]);
  return rows[0] ? toProposal(rows[0]) : null;
}

export async function listOpenProposals(db: Queryable, opts: { limit?: number } = {}): Promise<Proposal[]> {
  const { rows } = await db.query(
    `select ${COLUMNS} from core.proposals where state = 'open' order by created_at desc limit $1`,
    [opts.limit ?? 100],
  );
  return rows.map(toProposal);
}

export async function countOpenProposals(db: Queryable): Promise<number> {
  const { rows } = await db.query(`select count(*)::int as n from core.proposals where state = 'open'`);
  return Number(rows[0]?.n ?? 0);
}

/** Kept, discarded and expired in the last week: what the fold shows. */
export async function listClosedProposals(
  db: Queryable,
  opts: { now: Date; limit?: number },
): Promise<Proposal[]> {
  const { rows } = await db.query(
    `select ${COLUMNS} from core.proposals
      where state <> 'open' and decided_at >= $1
      order by decided_at desc limit $2`,
    [new Date(opts.now.getTime() - PROPOSAL_FOLD_MS), opts.limit ?? 100],
  );
  return rows.map(toProposal);
}

/**
 * The owner kept it. `payload` is their corrected version when they edited
 * one; the identifying fields may not change, because the fingerprint is
 * what the discard memory and the open-once index are keyed on.
 */
export async function keepProposal(
  db: Queryable,
  input: { id: string; payload?: Record<string, unknown>; now: Date },
): Promise<Proposal | null> {
  const { rows } = await db.query(
    `update core.proposals
        set state = 'kept', decided_at = $2, payload = coalesce($3::jsonb, payload)
      where id::text = $1 and state = 'open'
      returning ${COLUMNS}`,
    [input.id, input.now, input.payload ? JSON.stringify(input.payload) : null],
  );
  return rows[0] ? toProposal(rows[0]) : null;
}

export async function discardProposal(
  db: Queryable,
  input: { id: string; reason?: string | null; now: Date },
): Promise<Proposal | null> {
  const reason = (input.reason ?? '').trim().replace(/\s+/g, ' ').slice(0, 300) || null;
  const { rows } = await db.query(
    `update core.proposals
        set state = 'discarded', decided_at = $2, reason = $3
      where id::text = $1 and state = 'open'
      returning ${COLUMNS}`,
    [input.id, input.now, reason],
  );
  return rows[0] ? toProposal(rows[0]) : null;
}

/**
 * Undo a keep whose apply failed: the proposal is open again, as it was a
 * moment before, and the card stays in the inbox with the reason.
 */
export async function reopenProposal(db: Queryable, input: { id: string; payload?: Record<string, unknown> }): Promise<Proposal | null> {
  const { rows } = await db.query(
    `update core.proposals set state = 'open', decided_at = null, payload = coalesce($2::jsonb, payload)
      where id::text = $1 and state = 'kept'
      returning ${COLUMNS}`,
    [input.id, input.payload ? JSON.stringify(input.payload) : null],
  );
  return rows[0] ? toProposal(rows[0]) : null;
}

/** The reason a removed skill's proposal carries. */
export const REMOVED_REASON = 'removed by the owner';

/**
 * The owner removed what they had kept. The proposal becomes a discard as of
 * now, so the fingerprint rule applies: the same skill is refused for 90 days,
 * and the agent is told once, in its next run.
 */
export async function revokeKeptProposal(
  db: Queryable,
  input: { id: string; now: Date; reason?: string },
): Promise<Proposal | null> {
  const { rows } = await db.query(
    `update core.proposals set state = 'discarded', decided_at = $2, reason = $3, told_at = null
      where id::text = $1 and state = 'kept'
      returning ${COLUMNS}`,
    [input.id, input.now, input.reason ?? REMOVED_REASON],
  );
  return rows[0] ? toProposal(rows[0]) : null;
}

/** What the sweep writes on a proposal nobody decided. */
export const EXPIRED_REASON = 'not decided in 30 days';

/** Every open proposal older than 30 days, expired in one statement. */
export async function expireStaleProposals(db: Queryable, now: Date): Promise<Proposal[]> {
  const { rows } = await db.query(
    `update core.proposals
        set state = 'expired', decided_at = $1, reason = $2
      where state = 'open' and created_at < $3
      returning ${COLUMNS}`,
    [now, EXPIRED_REASON, new Date(now.getTime() - PROPOSAL_TTL_MS)],
  );
  return rows.map(toProposal);
}

/**
 * What the agent is told once in its next run: the proposals the owner
 * discarded, and the changes to its own file the owner kept (learning §4, step
 * 4). A kept skill or rule is not news to the agent in the same way: the skill
 * loads, the rule is the plugin's. Marked told in the same statement, as above.
 */
export async function takeUntoldDecisions(
  db: Queryable,
  input: { agent: string; now: Date; limit?: number },
): Promise<Proposal[]> {
  const { rows } = await db.query(
    `update core.proposals set told_at = $2
      where id in (
        select id from core.proposals
         where agent = $1 and told_at is null and decided_at >= $3
           and (state = 'discarded' or (state = 'kept' and kind = 'change'))
         order by decided_at desc limit $4
      )
      returning ${COLUMNS}`,
    [input.agent, input.now, new Date(input.now.getTime() - DISCARD_MEMORY_MS), input.limit ?? 5],
  );
  return rows.map(toProposal).sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
}

/** One kind's kept proposals over a window: how many, and up to three titles. */
export interface KeptTally {
  count: number;
  names: string[];
}

/** What the weekly digest reads from the proposals table. */
export interface LearningWeek {
  kept: Record<ProposalKind, KeptTally>;
  open: number;
}

/** A proposal's name without the kind's prefix, for a list of three. */
function shortName(p: Pick<Proposal, 'kind' | 'payload' | 'agent'>): string {
  switch (p.kind) {
    case 'skill':
      return String(p.payload.name ?? 'unnamed');
    case 'policy':
      return proposalTitle(p).replace(/^Rule for /, '');
    case 'change':
      return `${p.agent}'s ${p.payload.part === 'tools' ? 'tools' : 'instructions'}`;
  }
}

/**
 * Kept per kind since `since`, newest first, and how many are open now. A
 * skill the owner has since removed is not counted: the digest says what was
 * learned, and that was taken back.
 */
export async function readLearningWeek(db: Queryable, input: { since: Date }): Promise<LearningWeek> {
  const { rows } = await db.query(
    `select ${COLUMNS} from core.proposals
      where state = 'kept' and decided_at >= $1
      order by decided_at desc`,
    [input.since],
  );
  const kept: Record<ProposalKind, KeptTally> = {
    skill: { count: 0, names: [] },
    policy: { count: 0, names: [] },
    change: { count: 0, names: [] },
  };
  for (const row of rows) {
    const p = toProposal(row);
    const tally = kept[p.kind];
    tally.count += 1;
    if (tally.names.length < 3) tally.names.push(shortName(p));
  }
  return { kept, open: await countOpenProposals(db) };
}

/** What a proposal is about, in a few words: a skill's name, a policy's action, a change's part. */
export function proposalTitle(proposal: Pick<Proposal, 'kind' | 'payload'>): string {
  const p = proposal.payload;
  switch (proposal.kind) {
    case 'skill':
      return `Skill: ${String(p.name ?? 'unnamed')}`;
    case 'policy':
      return `Rule for ${String(p.plugin ?? 'a plugin')}: ${String(p.action ?? '')}`.trim();
    case 'change':
      return p.part === 'tools' ? 'Change to its own tools' : 'Change to its own instructions';
  }
}
