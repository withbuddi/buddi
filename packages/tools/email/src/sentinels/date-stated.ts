/**
 * `email.date-stated` — a message names a day in the next fortnight.
 *
 * docs/specs/email.md §7: *«a message states a date within the next 14 days (a
 * deadline, an appointment, a due date), and no reminder exists for it»*.
 *
 * The reading is done at ingest, on the body that is already in hand
 * (`sources/inbox-poll.ts`); this tick does two things ingest cannot:
 *
 *  1. **catch-up.** Messages that landed before this watcher existed, or while
 *    it threw, are read here — bounded, oldest first, and stamped so nothing is
 *    read twice. The parser keeps every date it can resolve inside a year
 *    (`DATE_HORIZON_DAYS`), which is what makes this sweep worth running at
 *    all: a message read for the first time today may state a day that was
 *    months away when it was written and is now next week.
 *  2. **the finding.** A stored reading is a candidate; whether it is worth
 *    saying anything about depends on the owner's threshold, on the day being
 *    inside the fortnight §7 asks for — which is applied *here*, against the
 *    owner's clock, and nowhere else — and on whether a reminder for it
 *    already exists. None of the three was knowable at ingest.
 *
 * It never sets the reminder itself. A sentinel is deterministic code with no
 * judgement in it, and "is this really a deadline?" is a judgement: the finding
 * carries `suggestedAction: 'set-a-reminder'` and the agent calls
 * `reminder.set` once it has read the message and agrees.
 */
import type { Finding, Sentinel, SentinelContext, SentinelReport } from '@buddi/core/plugin';
import { localDateString } from '@buddi/core/plugin';
import { DATE_WINDOW_DAYS } from '../dates.js';
import {
  DATE_SCAN_BATCH,
  recordDates,
  remindersFor,
  scanMessageDates,
  skipDates,
  statedDatesBetween,
  unscannedMessages,
} from '../dates-store.js';
import { dateFinding, dateKey, loadWatcherSettings, type StatedDate } from '../watchers.js';
import { mailAgent } from './waiting-on-me.js';

/** Hourly. The scan is cheap and the catch-up is bounded. */
export const EVERY_HOUR = 60 * 60;

/** At most this many findings in one tick. */
export const MAX_DATE_FINDINGS = 20;

/** Days ahead a `YYYY-MM-DD` day is, from another one. Civil arithmetic. */
function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const at = new Date(Date.UTC(y as number, (m as number) - 1, (d as number) + days));
  return at.toISOString().slice(0, 10);
}

export function createDateStatedSentinel(): Sentinel {
  return {
    id: 'email.date-stated',
    description:
      'Reports a date stated in a message that falls in the next 14 days and has no reminder yet.',
    every: EVERY_HOUR,
    async run(ctx: SentinelContext): Promise<SentinelReport> {
      const settings = await loadWatcherSettings(ctx.buddi!.db);
      const now = ctx.buddi!.clock.now();

      // Catch-up first, so a date found this tick can raise its finding in the
      // same tick rather than waiting an hour for the next one.
      for (const message of await unscannedMessages(ctx.buddi!.db, DATE_SCAN_BATCH)) {
        if (message.ignored) {
          // A sender the owner silenced. Stamped, not read: see dates-store.ts.
          await skipDates(ctx.buddi!.db, message.id, now);
          continue;
        }
        try {
          await scanMessageDates(
            ctx.buddi!.db,
            { id: message.id, bodyText: message.bodyText, subject: message.subject },
            { at: message.at, timezone: ctx.buddi!.owner.timezone },
            now,
          );
        } catch {
          // One unreadable message must not cost the tick its findings. It is
          // stamped with no rows so the sweep moves on rather than looping.
          await recordDates(ctx.buddi!.db, message.id, [], now).catch(() => {});
        }
      }

      const today = localDateString(now, ctx.buddi!.owner.timezone);
      const hits = await statedDatesBetween(
        ctx.buddi!.db,
        today,
        addDays(today, DATE_WINDOW_DAYS),
        settings.dateConfidence,
      );
      if (hits.length === 0) return { findings: [] };

      // Which of these already have a reminder on their conversation for that
      // day. One query for the lot; a hit with no thread cannot be matched to a
      // reminder's context and is treated as uncovered.
      const threadIds = [...new Set(hits.map((h) => h.threadId).filter((id): id is string => id !== null))];
      const days = [...new Set(hits.map((h) => h.date))];
      const covered = await remindersFor(ctx.buddi!.schedule!, threadIds, days);

      const agentId = mailAgent(ctx);
      const findings: Finding[] = [];
      /*
       * Every uncovered hit is a fact that is still true, cap or no cap. Core
       * resolves what a run did not report, so a date pushed past the cap has
       * to be named here or it would read as dealt with — and come back as
       * news, once a tick, for as long as the backlog lasts.
       */
      const keys: string[] = [];
      for (const hit of hits) {
        if (hit.threadId !== null && covered.has(`${hit.threadId}|${hit.date}`)) continue;
        keys.push(dateKey(hit.messageId, hit.date));
        if (findings.length >= MAX_DATE_FINDINGS) continue;
        const stated: StatedDate = hit;
        const finding = dateFinding(stated);
        findings.push({ ...finding, ...(agentId ? { agentId } : {}) });
      }
      return { findings, keys };
    },
  };
}

export const dateStated: Sentinel = createDateStatedSentinel();
