/**
 * The mail watchers, in the order docs/specs/email.md §13 builds them.
 *
 * Step 4 ships the first two of §7's six. The four that remain —
 * `email.promised-reply`, `email.receipt-or-bill`, `email.suspicious-sender`
 * and `email.unanswered-by-them` — are step 5's, and are specification, not
 * code that is switched off.
 *
 * Neither of these sends mail, and neither speaks: a finding becomes a report,
 * a draft or a reminder, and only after the agent that receives it has read the
 * conversation itself.
 */
import type { Sentinel } from '@buddi/core';
import { dateStated } from './date-stated.js';
import { waitingOnMe } from './waiting-on-me.js';

export const emailSentinels: Sentinel[] = [waitingOnMe, dateStated];

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
