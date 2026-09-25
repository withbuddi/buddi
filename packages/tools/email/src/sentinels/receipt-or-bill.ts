/**
 * `email.receipt-or-bill` — an order confirmation, a receipt, an invoice.
 *
 * docs/email.md §7: *«an order confirmation, receipt, invoice or bill
 * arrived; the finding offers to hand it to the agent holding the `overview`
 * role and to record it»*.
 *
 * The same two halves as `email.date-stated`, for the same reasons:
 *
 *  1. **catch-up.** Bodies nothing has classified yet are read here, bounded,
 *     oldest first, and stamped (`messages.receipts_scanned_at`) so no body is
 *     read twice and a mailbox with a decade of mail in it empties in a few
 *     ticks rather than a few weeks. A sender the owner has silenced is stamped
 *     without being read: this watcher is not a second door into the gate.
 *  2. **the finding.** A stored reading is a candidate; whether it is worth
 *     saying anything about depends on the owner's `receiptConfidence`, on the
 *     message being inside the fortnight, and on the conversation not being
 *     muted — none of which was knowable when the body was read.
 *
 * It never wakes anybody. A bill is a thing to file, and buddi filing it an
 * hour late costs nothing; a phone buzzing at a misread order confirmation
 * costs this watcher its welcome. Every finding is `info`.
 *
 * It also never records anything itself. "Is this really a bill, and whose?" is
 * a judgement, and a sentinel has none: the finding carries the two actions §7
 * asks for and the agent does them after it has read the message.
 */
import type { Finding, Sentinel, SentinelContext, SentinelReport } from '@buddi/core/plugin';
import {
  RECEIPT_SCAN_BATCH,
  receiptsSince,
  scanMessageReceipt,
  stampOldReceipts,
  unscannedReceipts,
} from '../receipts-store.js';
import {
  RECEIPT_WINDOW_DAYS,
  loadWatcherSettings,
  receiptFinding,
  type ReceiptHit,
} from '../watchers.js';

/** Hourly. The classifier is cheap and the catch-up is bounded. */
export const EVERY_HOUR = 60 * 60;

/** At most this many findings in one tick. */
export const MAX_RECEIPT_FINDINGS = 20;

/**
 * Who hears about money: whoever holds `overview`, else whoever holds `mail`.
 *
 * §7 names the `overview` role, and the fallback is the mail role rather than
 * nobody — a receipt is still worth a line in the recap on an installation
 * that has never set up an overview agent. `undefined` is a fine answer: core
 * gives the finding to the wake mission's own agent.
 */
export function receiptAgent(ctx: SentinelContext): string | undefined {
  return ctx.buddi!.owner.agentForRole('overview') ?? ctx.buddi!.owner.agentForRole('mail');
}

export function createReceiptOrBillSentinel(): Sentinel {
  return {
    id: 'email.receipt-or-bill',
    description:
      'Reports an order confirmation, receipt, invoice or bill that arrived in the last fortnight, with its ' +
      'total when one could be read, and offers to hand it on and record it.',
    every: EVERY_HOUR,
    async run(ctx: SentinelContext): Promise<SentinelReport> {
      const settings = await loadWatcherSettings(ctx.buddi!.db);
      const now = ctx.buddi!.clock.now();
      const since = new Date(now.getTime() - RECEIPT_WINDOW_DAYS * 86_400_000);

      /*
       * Catch-up first, so a receipt found this tick raises its finding in the
       * same tick rather than waiting an hour for the next one — and bounded
       * by the *window*, not only by the batch. A mailbox taking in more than
       * a batch an hour would otherwise have its sweep walking a decade of
       * backlog oldest-first for ever, and this watcher would be silent about
       * exactly the fortnight it exists for. What ages out unread is stamped
       * in one statement instead.
       */
      await stampOldReceipts(ctx.buddi!.db, since, now);
      let failed = 0;
      let firstError = '';
      for (const message of await unscannedReceipts(ctx.buddi!.db, since, RECEIPT_SCAN_BATCH)) {
        try {
          await scanMessageReceipt(ctx.buddi!.db, message, now);
        } catch (err) {
          /*
           * Nothing is stamped: the reading and the stamp are one statement
           * (`recordReceipt`), so a message that could not be stored is read
           * again next tick rather than marked read with nothing stored. It
           * cannot loop for ever — the window moves, and `stampOldReceipts`
           * takes it once it ages out.
           */
          failed += 1;
          if (firstError === '') firstError = err instanceof Error ? err.message : String(err);
        }
      }
      // Once per tick, not once per message: a broken column would otherwise
      // write two hundred identical lines an hour into the owner's log.
      if (failed > 0) {
        console.warn(
          `email.receipt-or-bill: ${failed} message(s) could not be read this tick: ${firstError}`,
        );
      }

      const hits = await receiptsSince(ctx.buddi!.db, since, settings.receiptConfidence);
      const agentId = receiptAgent(ctx);

      const keys: string[] = [];
      const findings: Finding[] = [];
      for (const hit of hits) {
        const shaped: ReceiptHit = hit;
        const finding = receiptFinding(shaped);
        keys.push(finding.key);
        if (findings.length >= MAX_RECEIPT_FINDINGS) continue;
        findings.push({ ...finding, ...(agentId ? { agentId } : {}) });
      }
      return { findings, keys };
    },
  };
}

export const receiptOrBill: Sentinel = createReceiptOrBillSentinel();
