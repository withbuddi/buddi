/**
 * `email.retention` — the daily housekeeping pass.
 *
 * It is a *source* by shape, not by spirit: core's periodic contract is the
 * only thing in the system that says "run this every N seconds, record that it
 * ran, and surface the error if it did not", and this needs exactly that. What
 * it does not do is the other half of the source contract: it originates no
 * work. `enqueueRun` is never called, no agent is woken, nobody is told. It
 * reads the owner's retention setting, nulls out the bodies that have aged past
 * it in batches, and logs one line.
 *
 * It is deliberately not a sentinel: a sentinel returns *findings* for core to
 * decide about, and "the bodies are now gone" is not a finding — it is work.
 *
 * It lapses stale drafts too, for the same reason and on the same beat.
 */
import { lapseDueDrafts, lapseLogLine } from '../drafts.js';
import { purgeBodies, purgeLogLine, PURGE_BATCH } from '../retention.js';
import type { Source, SourceContext } from '../types.js';

/** Once a day. Retention is measured in days; checking more often buys nothing. */
export const RETENTION_EVERY_SECONDS = 86_400;

export const RETENTION_SOURCE_ID = 'email.retention';

export interface RetentionSourceOptions {
  /** Rows per statement. Defaults to `PURGE_BATCH` (500). */
  batchSize?: number;
  /** Overrides the owner's stored setting. Tests only. */
  retentionDays?: number;
  /** How long a live draft stands before it lapses. Tests only. */
  lapseDays?: number;
}

export function createRetentionSource(opts: RetentionSourceOptions = {}): Source {
  return {
    id: RETENTION_SOURCE_ID,
    description:
      'Daily housekeeping: purge the bodies of messages older than the retention window, keeping headers, snippets and triage decisions, and lapse drafts nobody has touched for a fortnight.',
    every: RETENTION_EVERY_SECONDS,

    async poll(ctx: SourceContext): Promise<void> {
      const log = ctx.buddi?.log ?? ctx.log ?? ((line: string) => console.error(line));
      const outcome = await purgeBodies(ctx.buddi!.db, ctx.buddi!.clock.now(), {
        batchSize: opts.batchSize ?? PURGE_BATCH,
        ...(opts.retentionDays !== undefined ? { retentionDays: opts.retentionDays } : {}),
      });
      log(purgeLogLine(outcome));
      // The draft lapse (docs/specs/email.md §8), in the plugin and on the same
      // daily beat. It is housekeeping of exactly the same shape: it originates
      // no run, wakes nobody, and is not a finding — a draft nobody touched for
      // a fortnight is work to tidy, not news to report.
      const lapsed = await lapseDueDrafts(ctx.buddi!.db, ctx.buddi!.clock.now(), {
        ...(opts.lapseDays !== undefined ? { days: opts.lapseDays } : {}),
      });
      log(lapseLogLine(lapsed));
    },
  };
}
