/**
 * The mail watchers, in the order docs/email.md §7 lists them.
 *
 * All six of §7 are here now: step 4 built `email.waiting-on-me` and
 * `email.date-stated`, and step 6 the four that remained —
 * `email.promised-reply`, `email.receipt-or-bill`, `email.suspicious-sender`
 * and `email.unanswered-by-them`.
 *
 * None of them sends mail, and none of them speaks: a finding becomes a report,
 * a draft or a reminder, and only after the agent that receives it has read the
 * conversation itself. Each appears on the Watchers page with its own switch,
 * which comes from core rather than from anything here.
 */
import type { Sentinel } from '@buddi/core/plugin';
import { dateStated } from './date-stated.js';
import { promisedReply } from './promised-reply.js';
import { receiptOrBill } from './receipt-or-bill.js';
import { suspiciousSender } from './suspicious-sender.js';
import { unansweredByThem } from './unanswered-by-them.js';
import { waitingOnMe } from './waiting-on-me.js';

export const emailSentinels: Sentinel[] = [
  waitingOnMe,
  dateStated,
  promisedReply,
  receiptOrBill,
  suspiciousSender,
  unansweredByThem,
];

export {
  createWaitingOnMeSentinel,
  mailAgent,
  waitingOnMe,
  EVERY_12H,
  MAX_WAITING_FINDINGS,
} from './waiting-on-me.js';
export {
  createDateStatedSentinel,
  dateStated,
  EVERY_HOUR,
  MAX_DATE_FINDINGS,
} from './date-stated.js';

/* ---- step 6 (docs/email.md §7) ---- */
export {
  createPromisedReplySentinel,
  promisedReply,
  MAX_PROMISED_FINDINGS,
} from './promised-reply.js';
export {
  createReceiptOrBillSentinel,
  receiptAgent,
  receiptOrBill,
  MAX_RECEIPT_FINDINGS,
} from './receipt-or-bill.js';
export {
  createSuspiciousSenderSentinel,
  suspiciousSender,
  MAX_SUSPICIOUS_FINDINGS,
} from './suspicious-sender.js';
export {
  createUnansweredByThemSentinel,
  unansweredByThem,
  EVERY_DAY,
  MAX_NUDGE_FINDINGS,
} from './unanswered-by-them.js';
