/**
 * Receipts — what was bought, as opposed to what the bank charged.
 *
 * A receipt is its own record, not an annotation on a transaction: it can
 * arrive before the charge posts, it can describe a charge that never appears,
 * and it carries line items the bank will never know about. It is linked to a
 * transaction when one matches, and stays unlinked otherwise rather than being
 * forced onto the nearest plausible row.
 */
import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import { normalizeMerchant } from '../merchant.js';
import { findReceiptTransaction } from './reconcile.js';
import { num, toDateString } from './shared.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');
const UUID = z.string().uuid();

const item = z.object({
  name: z.string().min(1).describe('The line as printed on the receipt.'),
  qty: z.number().optional().describe('Quantity, when the receipt states one.'),
  price: z.number().optional().describe('Line total, positive.'),
});

interface ReceiptRecord {
  id: string;
  merchant: string;
  merchantNorm: string;
  occurredOn: string;
  total: number;
  currency: string;
  items: unknown;
  artifactId: string | null;
  transactionId: string | null;
  notes: string | null;
}

function mapReceipt(row: Record<string, unknown>): ReceiptRecord {
  return {
    id: row.id as string,
    merchant: row.merchant as string,
    merchantNorm: (row.merchant_norm as string) ?? '',
    occurredOn: toDateString(row.occurred_on),
    total: num(row.total),
    currency: (row.currency as string) ?? 'USD',
    items: row.items ?? null,
    artifactId: (row.artifact_id as string | null) ?? null,
    transactionId: (row.transaction_id as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
  };
}

const RECEIPT_COLUMNS =
  'id, merchant, merchant_norm, occurred_on, total, currency, items, artifact_id, transaction_id, notes';

const recordInput = z.object({
  merchant: z.string().min(1).describe("Merchant as printed, e.g. 'Trader Joe's'."),
  occurredOn: DATE.describe('Date on the receipt, YYYY-MM-DD.'),
  total: z
    .number()
    .describe('Receipt total as printed — a positive number, even though it is money going out.'),
  items: z
    .array(item)
    .max(200)
    .optional()
    .describe('Line items, when they are legible. Omit rather than guessing at them.'),
  currency: z.string().min(3).max(3).optional().describe('ISO currency, default USD.'),
  artifactId: UUID.optional().describe('The stored document this receipt was read from.'),
  notes: z.string().min(1).optional().describe('Anything worth keeping that is not a line item.'),
});

export const recordReceipt: ToolDefinition<z.infer<typeof recordInput>, unknown> = {
  name: 'finance.record_receipt',
  description:
    "Record a receipt the owner sent — merchant, date, total, and the line items when they are legible. It does NOT create a transaction: the bank charge is the money, the receipt is the detail. After storing it, it looks for the charge it belongs to (same amount, same merchant, within three days either way, posted or still pending) and links them; if nothing matches it stays unlinked and finance.reconcile will try again later. Never invent a total or a line item — if part of the document is unreadable, say so and record only what is legible.",
  tier: 'auto',
  input: recordInput,
  async execute(input, ctx) {
    const merchantNorm = normalizeMerchant(input.merchant);
    const total = Math.abs(input.total);
    const match = await findReceiptTransaction(ctx.db, {
      occurredOn: input.occurredOn,
      total,
      merchantNorm,
    });

    const { rows } = await ctx.db.query(
      `insert into finance.receipts
         (merchant, merchant_norm, occurred_on, total, currency, items, artifact_id, transaction_id, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning ${RECEIPT_COLUMNS}`,
      [
        input.merchant,
        merchantNorm,
        input.occurredOn,
        total,
        input.currency ?? 'USD',
        input.items ? JSON.stringify(input.items) : null,
        input.artifactId ?? null,
        match?.id ?? null,
        input.notes ?? null,
      ],
    );

    let matchedTransaction: Record<string, unknown> | null = null;
    if (match) {
      const { rows: txRows } = await ctx.db.query(
        `select t.id, t.occurred_on, t.amount, t.description, t.status, a.name as account
           from finance.transactions t
           left join finance.accounts a on a.id = t.account_id
          where t.id = $1`,
        [match.id],
      );
      const tx = txRows[0];
      if (tx) {
        matchedTransaction = {
          id: tx.id as string,
          account: (tx.account as string | null) ?? null,
          occurredOn: toDateString(tx.occurred_on),
          amount: num(tx.amount),
          description: tx.description as string,
          status: tx.status as string,
        };
      }
    }

    return { receipt: mapReceipt(rows[0]), matchedTransaction };
  },
};

const listInput = z.object({
  unmatchedOnly: z
    .boolean()
    .optional()
    .describe('Default false. True lists only receipts with no transaction linked yet.'),
  limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
});

export const listReceipts: ToolDefinition<z.infer<typeof listInput>, unknown> = {
  name: 'finance.list_receipts',
  description:
    'List recorded receipts, newest first, with the transaction each one is linked to. Use unmatchedOnly to see the receipts that have no charge against them yet — a receipt with no charge is either a charge that has not posted or one that was never billed.',
  tier: 'auto',
  input: listInput,
  async execute(input, ctx) {
    const limit = input.limit ?? 50;
    const { rows } = await ctx.db.query(
      `select ${RECEIPT_COLUMNS.split(', ')
        .map((c) => `r.${c}`)
        .join(', ')},
              t.description as transaction_description,
              t.occurred_on as transaction_date,
              t.amount as transaction_amount,
              t.status as transaction_status
         from finance.receipts r
         left join finance.transactions t on t.id = r.transaction_id
        where ($1::boolean is not true or r.transaction_id is null)
        order by r.occurred_on desc, r.created_at desc
        limit $2`,
      [input.unmatchedOnly ?? false, limit],
    );
    return {
      count: rows.length,
      receipts: rows.map((row) => ({
        ...mapReceipt(row),
        transaction: row.transaction_id
          ? {
              id: row.transaction_id as string,
              description: row.transaction_description as string,
              occurredOn: toDateString(row.transaction_date),
              amount: num(row.transaction_amount),
              status: row.transaction_status as string,
            }
          : null,
      })),
    };
  },
};

const linkInput = z.object({
  receiptId: UUID.describe('The receipt to link.'),
  transactionId: UUID.describe('The transaction it belongs to.'),
});

export const linkReceipt: ToolDefinition<z.infer<typeof linkInput>, unknown> = {
  name: 'finance.link_receipt',
  description:
    'Link a receipt to a transaction by hand, when the automatic match missed it or got it wrong (a tip added at the till, a merchant name the bank writes unrecognisably). Overwrites whatever link the receipt had.',
  tier: 'auto',
  input: linkInput,
  async execute(input, ctx) {
    const { rows: txRows } = await ctx.db.query(
      `select t.id, t.occurred_on, t.amount, t.description, t.status, a.name as account
         from finance.transactions t
         left join finance.accounts a on a.id = t.account_id
        where t.id = $1`,
      [input.transactionId],
    );
    const tx = txRows[0];
    if (!tx) throw new Error(`unknown transaction: ${input.transactionId}`);

    const { rows } = await ctx.db.query(
      `update finance.receipts set transaction_id = $2 where id = $1
       returning ${RECEIPT_COLUMNS}`,
      [input.receiptId, input.transactionId],
    );
    if (!rows[0]) throw new Error(`unknown receipt: ${input.receiptId}`);

    return {
      receipt: mapReceipt(rows[0]),
      transaction: {
        id: tx.id as string,
        account: (tx.account as string | null) ?? null,
        occurredOn: toDateString(tx.occurred_on),
        amount: num(tx.amount),
        description: tx.description as string,
        status: tx.status as string,
      },
    };
  },
};
