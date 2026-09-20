/**
 * The phase names a long backup or restore reports as it goes.
 *
 * Constants rather than free strings because they are read by something that is
 * not this process: the supervisor forwards them to the dashboard, where a
 * renamed phase is a progress bar that silently stops moving.
 */
export const PHASE = {
  /** The pre-restore copy of the target, taken before anything is touched. */
  snapshot: 'snapshot',
  /** Dumping or loading tables. */
  database: 'database',
  /** Artifacts and the private directories. */
  files: 'files',
  /** Writing or unpacking the tar. */
  archive: 'archive',
  /** Checksums and the manifest. */
  verify: 'verify',
  /** A file step failed and the target was put back as it was. */
  rolledBack: 'rolled-back',
} as const;

export type Phase = (typeof PHASE)[keyof typeof PHASE];
