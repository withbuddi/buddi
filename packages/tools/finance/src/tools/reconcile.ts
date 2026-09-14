/**
 * Reconciliation: pending rows that have since posted, and receipts that now
 * have a charge to sit against.
 *
 * Nothing is ever deleted here. A pending row that posted is *superseded* —
 * it keeps its place in the ledger and points at the row that replaced it, and
 * every read filters it out. That way a wrong match can be undone and the
 * history of what the bank showed at each moment survives.
 */
import type { ToolDefinition } from '@buddi/core';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  RECEIPT_WINDOW,
  SUPERSESSION_WINDOW,
  type MatchCandidate,
  bestMatch,
} from '../merchant.js';
import { num, toDateString } from './shared.js';

interface PendingRow extends MatchCandidate {
  accountId: string | null;
  /** The card this row lives on, when it is a card row rather than a cash one. */
  liabilityId: string | null;
  description: string;
}

interface ReceiptRow {
  id: string;
  merchant: string;
  merchantNorm: string;
  occurredOn: string;
  total: number;
}

export interface SupersessionResult {
  pendingId: string;
  postedId: string;
  description: string;
  amount: number;
  pendingDate: string;
  postedDate: string;
  dayGap: number;
}

export interface ReceiptMatchResult {
  receiptId: string;
  transactionId: string;
  merchant: string;
  total: number;
  receiptDate: string;
  transactionDate: string;
}

export interface ReconcileReport {
  pending: {
    examined: number;
    matched: SupersessionResult[];
    unmatched: { id: string; description: string; amount: number; occurredOn: string }[];
  };
  receipts: {
    examined: number;
    matched: ReceiptMatchResult[];
    unmatched: { id: string; merchant: string; total: number; occurredOn: string }[];
  };
}

/**
 * Match every visible pending row to the posted row that replaced it, and
 * every unmatched receipt to its charge. Idempotent: running it twice changes
 * nothing the second time, because a matched pending row stops being visible
 * and a matched receipt stops being unmatched.
 *
 * Exported so the import path can call it directly — every commit ends with a
 * reconcile, so a statement that carries both the pending line and the posted
 * one settles itself instead of double-counting.
 */
export async function runReconcile(db: Pool): Promise<ReconcileReport> {
  const { rows: pendingRows } = await db.query(
    `select id, account_id, liability_id, occurred_on, amount, description,
            coalesce(merchant_norm, '') as merchant_norm
       from finance.transactions
      where status = 'pending' and superseded_by is null
      order by occurred_on, created_at`,
  );

  const pending: PendingRow[] = pendingRows.map((r) => ({
    id: r.id as string,
    accountId: (r.account_id as string | null) ?? null,
    liabilityId: (r.liability_id as string | null) ?? null,
    occurredOn: toDateString(r.occurred_on),
    amount: num(r.amount),
    description: r.description as string,
    merchantNorm: r.merchant_norm as string,
  }));

  const matched: SupersessionResult[] = [];
  const unmatchedPending: ReconcileReport['pending']['unmatched'] = [];
  // One posted row can only be the settlement of one pending row: two pending
  // charges of the same amount at the same merchant must not collapse onto it.
  const claimed = new Set<string>();

  for (const p of pending) {
    const { rows: candidateRows } = await db.query(
      `select id, occurred_on, amount, coalesce(merchant_norm, '') as merchant_norm
         from finance.transactions
        where status = 'posted'
          and superseded_by is null
          and account_id is not distinct from $1::uuid
          and liability_id is not distinct from $4::uuid
          and occurred_on >= $2::date
          and occurred_on <= ($2::date + make_interval(days => $3::int))
        order by occurred_on`,
      // Same ledger, both halves: a pending charge on the Mastercard settles
      // against the Mastercard's posted row, never against a checking one.
      [p.accountId, p.occurredOn, SUPERSESSION_WINDOW.daysAfter, p.liabilityId],
    );
    const candidates: MatchCandidate[] = candidateRows
      .filter((r) => !claimed.has(r.id as string))
      .map((r) => ({
        id: r.id as string,
        occurredOn: toDateString(r.occurred_on),
        amount: num(r.amount),
        merchantNorm: r.merchant_norm as string,
      }));

    const match = bestMatch(p, candidates, SUPERSESSION_WINDOW);
    if (!match) {
      unmatchedPending.push({
        id: p.id,
        description: p.description,
        amount: p.amount,
        occurredOn: p.occurredOn,
      });
      continue;
    }
    claimed.add(match.candidate.id);
    await db.query(`update finance.transactions set superseded_by = $2 where id = $1`, [
      p.id,
      match.candidate.id,
    ]);
    matched.push({
      pendingId: p.id,
      postedId: match.candidate.id,
      description: p.description,
      amount: p.amount,
      pendingDate: p.occurredOn,
      postedDate: match.candidate.occurredOn,
      dayGap: match.dayDelta,
    });
  }

  const receipts = await matchReceipts(db);

  return {
    pending: { examined: pending.length, matched, unmatched: unmatchedPending },
    receipts,
  };
}

/**
 * Link every receipt that has no transaction yet to the charge it belongs to.
 * A receipt may match a pending charge as readily as a posted one — the paper
 * exists the moment the card is swiped.
 */
export async function matchReceipts(db: Pool): Promise<ReconcileReport['receipts']> {
  const { rows } = await db.query(
    `select id, merchant, coalesce(merchant_norm, '') as merchant_norm, occurred_on, total
       from finance.receipts
      where transaction_id is null
      order by occurred_on, created_at`,
  );
  const receipts: ReceiptRow[] = rows.map((r) => ({
    id: r.id as string,
    merchant: r.merchant as string,
    merchantNorm: r.merchant_norm as string,
    occurredOn: toDateString(r.occurred_on),
    total: num(r.total),
  }));

  const matched: ReceiptMatchResult[] = [];
  const unmatched: ReconcileReport['receipts']['unmatched'] = [];
  for (const receipt of receipts) {
    const match = await findReceiptTransaction(db, receipt);
    if (!match) {
      unmatched.push({
        id: receipt.id,
        merchant: receipt.merchant,
        total: receipt.total,
        occurredOn: receipt.occurredOn,
      });
      continue;
    }
    await db.query(`update finance.receipts set transaction_id = $2 where id = $1`, [
      receipt.id,
      match.id,
    ]);
    matched.push({
      receiptId: receipt.id,
      transactionId: match.id,
      merchant: receipt.merchant,
      total: receipt.total,
      receiptDate: receipt.occurredOn,
      transactionDate: match.occurredOn,
    });
  }
  return { examined: receipts.length, matched, unmatched };
}

/**
 * The charge a receipt belongs to, or undefined. A receipt total is written as
 * a positive number but describes money going out, so it is compared against
 * the outflow it would have been — on EITHER ledger: a receipt for something
 * paid by card matches the charge on the card exactly as one paid in cash
 * matches the account row, because the paper says nothing about which card or
 * account settled it. Transactions that already carry a receipt
 * are out of the running — one piece of paper, one charge.
 */
export async function findReceiptTransaction(
  db: Pool,
  receipt: { occurredOn: string; total: number; merchantNorm: string },
): Promise<MatchCandidate | undefined> {
  const { rows } = await db.query(
    `select t.id, t.occurred_on, t.amount, coalesce(t.merchant_norm, '') as merchant_norm
       from finance.transactions t
      where t.superseded_by is null
        and t.occurred_on >= ($1::date - make_interval(days => $2::int))
        and t.occurred_on <= ($1::date + make_interval(days => $3::int))
        and not exists (select 1 from finance.receipts r where r.transaction_id = t.id)
      order by t.occurred_on`,
    [receipt.occurredOn, RECEIPT_WINDOW.daysBefore, RECEIPT_WINDOW.daysAfter],
  );
  const candidates: MatchCandidate[] = rows.map((r) => ({
    id: r.id as string,
    occurredOn: toDateString(r.occurred_on),
    amount: num(r.amount),
    merchantNorm: r.merchant_norm as string,
  }));
  const match = bestMatch(
    {
      occurredOn: receipt.occurredOn,
      // Positive on the paper, negative in the ledger.
      amount: -Math.abs(receipt.total),
      merchantNorm: receipt.merchantNorm,
    },
    candidates,
    RECEIPT_WINDOW,
  );
  return match?.candidate;
}

const input = z.object({});

export const reconcile: ToolDefinition<z.infer<typeof input>, unknown> = {
  name: 'finance.reconcile',
  description:
    'Settle the ledger: every pending transaction that has since appeared as a posted one is marked as superseded by it (same ledger — the same cash account, or the same card — same amount to the cent, same merchant, posted within five days), and every receipt with no charge yet is linked to the transaction it belongs to. A superseded pending row is never deleted — it simply stops counting anywhere, so the money is not double-counted. Runs automatically at the end of every import; call it directly after recording pending rows by hand, or to report what is still outstanding. Returns what was matched and what is still pending or unlinked.',
  tier: 'auto',
  input,
  async execute(_args, ctx) {
    const report = await runReconcile(ctx.db);
    return {
      matched: report.pending.matched.length,
      unmatched: report.pending.unmatched.length,
      pending: report.pending,
      receipts: {
        matched: report.receipts.matched.length,
        unmatched: report.receipts.unmatched.length,
        detail: report.receipts,
      },
    };
  },
};
