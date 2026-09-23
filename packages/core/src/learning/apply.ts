/**
 * What keeping a proposal does, per kind — and, in this build, what it does
 * not do yet.
 *
 * Step 1 of the learning spec records the owner's decision and the (possibly
 * corrected) payload. Each kind has its own named function here:
 *
 *  - `applyKeptSkill`   — built (step 2): write version n+1 of a skill file in
 *                          the agent's own skills directory (`skill-files.ts`).
 *  - `applyKeptPolicy`  — step 3: hand the policy to its plugin's apply.
 *  - `applyKeptChange`  — step 4: Agent Father's update with the diff as the
 *                          approved envelope.
 *
 * Each answers honestly. None pretends to have applied anything: a card that
 * said "applied" over a stub would be the exact drift this feature exists to
 * prevent.
 */
import { writeLearnedSkill } from './skill-files.js';
import type { Proposal, ProposalKind } from './types.js';

export interface ApplyOutcome {
  applied: boolean;
  /** One line for the card: what happened, or when it will. */
  note: string;
  /** True when applying was attempted and failed: nothing is on disk, and the keep should be undone. */
  failed?: boolean;
  /** A skill's current file and the version just written. */
  file?: string;
  version?: number;
}

/** What applying needs from the process it runs in. */
export interface ApplyDeps {
  now: Date;
  /** The agent's own skills directory, or null when it has none the owner may write (a shipped example). */
  skillsDirFor?: (agent: string) => string | null;
  /** Reload the catalog, so the next run loads what was written. Throws when the tree no longer loads. */
  reload?: () => void;
}

export async function applyKeptSkill(proposal: Proposal, deps: ApplyDeps): Promise<ApplyOutcome> {
  const dir = deps.skillsDirFor?.(proposal.agent) ?? null;
  if (!dir) {
    return { applied: false, failed: true, note: `${proposal.agent} has no skills directory of its own to write to.` };
  }
  let written;
  try {
    written = writeLearnedSkill(dir, proposal, deps.now);
  } catch (err) {
    return { applied: false, failed: true, note: `Not written: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    deps.reload?.();
  } catch (err) {
    // The file made the catalog refuse to load: put the directory back as it
    // was, and load that again. A kept skill must never cost the owner their agents.
    written.undo();
    try { deps.reload?.(); } catch { /* the load error is reported either way */ }
    return { applied: false, failed: true, note: `Not written: the catalog refused it (${err instanceof Error ? err.message : String(err)}).` };
  }
  return {
    applied: true,
    file: written.file,
    version: written.version,
    note: `Written as ${written.slug}.md, version ${written.version}; ${proposal.agent} loads it on its next run.`,
  };
}

export async function applyKeptPolicy(_proposal: Proposal, _deps: ApplyDeps): Promise<ApplyOutcome> {
  return { applied: false, note: keptNote('policy') };
}

export async function applyKeptChange(_proposal: Proposal, _deps: ApplyDeps): Promise<ApplyOutcome> {
  return { applied: false, note: keptNote('change') };
}

export const APPLY: Record<ProposalKind, (proposal: Proposal, deps: ApplyDeps) => Promise<ApplyOutcome>> = {
  skill: applyKeptSkill,
  policy: applyKeptPolicy,
  change: applyKeptChange,
};

/** The card's line for a kept proposal of this kind, without calling anything. */
export function keptNote(kind: ProposalKind): string {
  switch (kind) {
    case 'skill':
      return 'Kept; written as a skill file under the agent.';
    case 'policy':
      return 'Kept; applied by its plugin when learning step 3 ships.';
    case 'change':
      return 'Kept; applied through Agent Father when learning step 4 ships.';
  }
}
