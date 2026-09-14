/**
 * The finance sentinels, in the order they were added.
 *
 * Six deterministic watches, no model between the data and the finding. What
 * happens to a finding — whether it wakes an agent, whether it reaches the
 * owner tonight or on Sunday — is decided upstream by severity; nothing here
 * speaks to anybody.
 */
import type { Sentinel } from './types.js';
import { floorBreach } from './floor-breach.js';
import { minimumDue } from './minimum-due.js';
import { statementClosing } from './statement-closing.js';
import { staleBalance } from './stale-balance.js';
import { unmatchedReceipts } from './unmatched-receipts.js';
import { unprocessedArtifacts } from './unprocessed-artifacts.js';

export const financeSentinels: Sentinel[] = [
  floorBreach,
  minimumDue,
  statementClosing,
  staleBalance,
  unmatchedReceipts,
  unprocessedArtifacts,
];

export {
  floorBreach,
  minimumDue,
  statementClosing,
  staleBalance,
  unmatchedReceipts,
  unprocessedArtifacts,
};
export { DAILY, EVERY_6H, EVERY_12H } from './types.js';
export * from './helpers.js';
