/**
 * unmatched-receipts — receipts that never found their charge.
 *
 * A receipt is allowed to arrive before the charge posts; a week later that is
 * no longer what is happening. Either the charge never posted, or the ledger
 * is missing it — both are worth one line, and one line for the whole set.
 */
import { num, today, toDateString } from '../tools/shared.js';
import {
  UNMATCHED_RECEIPT_DAYS,
  unmatchedReceiptsFinding,
  type UnmatchedReceipt,
} from './helpers.js';
import { DAILY, type Finding, type Sentinel, type SentinelContext } from './types.js';

export const unmatchedReceipts: Sentinel = {
  id: 'finance.unmatched-receipts',
  description:
    'Reports receipts that have gone more than a week without a matching transaction, as one digest line.',
  every: DAILY,
  async run(ctx: SentinelContext): Promise<Finding[]> {
    const day = today(ctx);
    const { rows } = await ctx.db.query(
      `select id, merchant, occurred_on, total, currency
         from finance.receipts
        where transaction_id is null and occurred_on < $1::date - $2::int
        order by occurred_on, merchant`,
      [day, UNMATCHED_RECEIPT_DAYS],
    );
    const receipts: UnmatchedReceipt[] = rows.map((r) => ({
      id: String(r.id),
      merchant: r.merchant as string,
      occurredOn: toDateString(r.occurred_on),
      total: num(r.total),
      currency: (r.currency as string) ?? 'USD',
    }));
    const finding: Finding | null = unmatchedReceiptsFinding(receipts, { today: day });
    return finding === null ? [] : [finding];
  },
};
