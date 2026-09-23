/**
 * What keeping a proposal does, per kind — and, in this build, what it does
 * not do yet.
 *
 * Step 1 of the learning spec records the owner's decision and the (possibly
 * corrected) payload. The apply side is later work, and each kind has its own
 * named function here so that work has one place to land:
 *
 *  - `applyKeptSkill`   — step 2: write a versioned skill file under the agent.
 *  - `applyKeptPolicy`  — step 3: hand the policy to its plugin's apply.
 *  - `applyKeptChange`  — step 4: Agent Father's update with the diff as the
 *                          approved envelope.
 *
 * Each answers honestly. None pretends to have applied anything: a card that
 * said "applied" over a stub would be the exact drift this feature exists to
 * prevent.
 */
import type { Proposal, ProposalKind } from './types.js';

export interface ApplyOutcome {
  applied: boolean;
  /** One line for the card: what happened, or when it will. */
  note: string;
}

export async function applyKeptSkill(_proposal: Proposal): Promise<ApplyOutcome> {
  return { applied: false, note: keptNote('skill') };
}

export async function applyKeptPolicy(_proposal: Proposal): Promise<ApplyOutcome> {
  return { applied: false, note: keptNote('policy') };
}

export async function applyKeptChange(_proposal: Proposal): Promise<ApplyOutcome> {
  return { applied: false, note: keptNote('change') };
}

export const APPLY: Record<ProposalKind, (proposal: Proposal) => Promise<ApplyOutcome>> = {
  skill: applyKeptSkill,
  policy: applyKeptPolicy,
  change: applyKeptChange,
};

/** The card's line for a kept proposal of this kind, without calling anything. */
export function keptNote(kind: ProposalKind): string {
  switch (kind) {
    case 'skill':
      return 'Kept; written as a skill file when learning step 2 ships.';
    case 'policy':
      return 'Kept; applied by its plugin when learning step 3 ships.';
    case 'change':
      return 'Kept; applied through Agent Father when learning step 4 ships.';
  }
}
