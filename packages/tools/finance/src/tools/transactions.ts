import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '@buddi/core';
import type { Pool } from 'pg';
import { z } from 'zod';
import { parseBankCsv } from '../csv.js';
import { normalizeMerchant } from '../merchant.js';
import { runReconcile } from './reconcile.js';
import {
  dedupHash,
  findAccount,
  findLiability,
  num,
  occurrenceIndexes,
  resolveLedger,
  today,
  toDateString,
} from './shared.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');

interface InsertResult {
  inserted: boolean;
  id?: string;
}

/** Where a row came from. A statement is a document the owner sent, not a file. */
export type TransactionSource = 'manual' | 'csv' | 'statement';

/**
 * Settled or not. A pending row is money the owner has already committed —
 * the card was swiped — but that the bank has not finalised; when it does, the
 * bank emits a second, posted row and `finance.reconcile` supersedes the
 * pending one so the same money is never counted twice.
 */
export type TransactionStatus = 'pending' | 'posted';

export interface InsertTransactionArgs {
  /** Exactly one of accountId / liabilityId, as the schema requires. */
  accountId: string | null;
  liabilityId?: string | null;
  /** The ledger's name — an account's or a liability's. It keys the dedup hash. */
  ledgerName: string;
  occurredOn: string;
  amount: number;
  description: string;
  category: string | null;
  source: TransactionSource;
  /** 0 for the first row with this account/date/amount/text, 1 for the next, … */
  occurrence: number;
  status?: TransactionStatus;
  /** The document this row was read from, when there was one. */
  artifactId?: string | null;
}

export async function insertTransaction(
  db: Pool,
  args: InsertTransactionArgs,
): Promise<InsertResult> {
  const hash = dedupHash(
    args.ledgerName,
    args.occurredOn,
    args.amount,
    args.description,
    args.occurrence,
  );
  const { rows } = await db.query(
    `insert into finance.transactions
       (account_id, liability_id, occurred_on, amount, description, category, source, dedup_hash,
        status, merchant_norm, artifact_id)
     values ($1, $11, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (dedup_hash) do nothing
     returning id`,
    [
      args.accountId,
      args.occurredOn,
      args.amount,
      args.description,
      args.category,
      args.source,
      hash,
      args.status ?? 'posted',
      normalizeMerchant(args.description),
      args.artifactId ?? null,
      args.liabilityId ?? null,
    ],
  );
  const row = rows[0];
  return row ? { inserted: true, id: row.id } : { inserted: false };
}

const recordShape = z.object({
  account: z
    .string()
    .min(1)
    .optional()
    .describe('Cash account name. Created if unknown. Exactly one of account or liability.'),
  liability: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The card or loan the row belongs to, e.g. 'NFCU Mastercard Platinum 9012' — use this for a purchase made ON a credit card, which moves no cash on the day. The liability must already exist (finance.set_liability). Exactly one of account or liability.",
    ),
  occurredOn: DATE.describe('Date of the transaction, YYYY-MM-DD.'),
  amount: z
    .number()
    .describe(
      'Signed amount. On a cash account: positive money in, negative money out. On a liability: NEGATIVE is a charge (it raises what is owed), POSITIVE is a payment or credit (it lowers it).',
    ),
  description: z.string().min(1).describe('What it was, as it should read in a recap.'),
  category: z.string().min(1).optional().describe("Free-form category, e.g. 'groceries'."),
  occurrence: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Only for a genuine repeat: 0 (default) is the first transaction with this account/date/amount/description, 1 the second identical one, and so on.',
    ),
  status: z
    .enum(['pending', 'posted'])
    .optional()
    .describe(
      "Default 'posted': the money has settled. Use 'pending' for a card authorisation the bank has not finalised — the owner has spent it, but a posted row for the same charge will follow, and reconciliation will supersede this one when it does.",
    ),
});

/** Exactly one ledger, checked the same way the schema checks it. */
const oneLedger = {
  check: (v: { account?: string; liability?: string }): boolean =>
    Boolean(v.account) !== Boolean(v.liability),
  message: 'provide exactly one of account (cash) or liability (card, loan)',
} as const;

const recordInput = recordShape.refine(oneLedger.check, { message: oneLedger.message });

export const recordTransaction: ToolDefinition<z.infer<typeof recordInput>, unknown> = {
  name: 'finance.record_transaction',
  description:
    "Record one transaction the owner mentions (source: manual), on a cash account OR on a card. Pass `account` for money moving through a checking or savings account; pass `liability` for a purchase made ON a credit card (the GEICO premium billed to the Mastercard, a dinner on the Amex) — that moves no cash on the day, so it belongs on the card and never on an account. On a card the sign is: negative = charge (raises what is owed), positive = payment or credit (lowers it). Re-recording the same ledger/date/amount/description is a no-op, so repeating a recap is safe; pass occurrence: 1 (then 2, …) only when the owner really paid the same amount to the same place twice on the same day. Pass status: 'pending' when the charge is an authorisation the bank has not settled: it counts as committed money in a projection, is left out of the monthly summary, and is superseded automatically once the posted row arrives.",
  tier: 'auto',
  input: recordInput,
  async execute(input, ctx) {
    const ledger = await resolveLedger(ctx.db, input);
    const result = await insertTransaction(ctx.db, {
      accountId: ledger.accountId,
      liabilityId: ledger.liabilityId,
      ledgerName: ledger.name,
      occurredOn: input.occurredOn,
      amount: input.amount,
      description: input.description,
      category: input.category ?? null,
      source: 'manual',
      occurrence: input.occurrence ?? 0,
      status: input.status ?? 'posted',
    });
    return {
      recorded: result.inserted,
      duplicate: !result.inserted,
      id: result.id ?? null,
      ledger: ledger.kind,
      account: ledger.kind === 'account' ? ledger.name : null,
      liability: ledger.kind === 'liability' ? ledger.name : null,
      occurredOn: input.occurredOn,
      amount: input.amount,
      description: input.description,
      status: input.status ?? 'posted',
      note:
        ledger.kind === 'liability'
          ? 'Recorded on the card: it raises or lowers what is owed and moves no cash today. The cash moves when the card is paid.'
          : undefined,
    };
  },
};

const contributionInput = z.object({
  account: z
    .string()
    .min(1)
    .describe(
      "The non-cashflow account receiving the money, e.g. 'Fidelity 401k'. It must already exist with a retirement/investment/hsa kind — record it first with finance.set_balance and a `kind`.",
    ),
  amount: z
    .number()
    .describe(
      'Money into the account as a positive number (a withdrawal is negative). This is the contribution itself, not a cash-flow movement.',
    ),
  occurredOn: DATE.optional().describe('Date of the contribution, YYYY-MM-DD. Defaults to today.'),
  description: z
    .string()
    .min(1)
    .optional()
    .describe("What it was, e.g. '401k payroll contribution' or 'employer match'."),
});

export const recordContribution: ToolDefinition<z.infer<typeof contributionInput>, unknown> = {
  name: 'finance.record_contribution',
  description:
    "Record a contribution to a retirement, investment or HSA account — a 401k payroll deduction, an employer match, an IRA transfer, a brokerage deposit. It books the movement against that account ONLY: because the account is outside the cash flow, the projection, the spending baseline and the cash total are untouched, so a contribution never reads as spending and never reads as spendable money. The account balance itself is a stated figure, not a running sum — use finance.set_balance when the owner tells you the new balance. For anything hitting a current or savings account, use finance.record_transaction instead.",
  tier: 'auto',
  input: contributionInput,
  async execute(input, ctx) {
    const account = await findAccount(ctx.db, input.account);
    if (!account) {
      throw new Error(
        `unknown account: ${input.account} — record it first with finance.set_balance and a kind (retirement, investment or hsa)`,
      );
    }
    if (account.includeInCashflow) {
      throw new Error(
        `${account.name} is a cash-flow account (kind ${account.kind}); use finance.record_transaction, or reclassify it with finance.update_account`,
      );
    }
    const occurredOn = input.occurredOn ?? today(ctx);
    const description = input.description ?? `${account.name} contribution`;
    // Contributions to the same account on the same day for the same amount are
    // genuinely common (two payrolls, a match alongside the deferral), so each
    // call takes the next free occurrence slot rather than silently collapsing.
    const { rows: sameDay } = await ctx.db.query(
      `select count(*)::int as n from finance.transactions
        where account_id = $1 and occurred_on = $2 and amount = $3 and description = $4`,
      [account.id, occurredOn, input.amount, description],
    );
    const result = await insertTransaction(ctx.db, {
      accountId: account.id,
      ledgerName: account.name,
      occurredOn,
      amount: input.amount,
      description,
      category: 'contribution',
      source: 'manual',
      occurrence: sameDay[0]?.n ?? 0,
    });
    return {
      recorded: result.inserted,
      id: result.id ?? null,
      account: account.name,
      accountKind: account.kind,
      includeInCashflow: account.includeInCashflow,
      occurredOn,
      amount: input.amount,
      description,
      note: 'Outside the cash flow: no effect on the projection, the baseline or the cash total.',
    };
  },
};

/** Reads stay inside the working directory unless given an absolute path; no network, ever. */
function resolveCsvPath(raw: string): string {
  if (raw.includes(' ')) throw new Error('invalid path');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new Error('import_csv reads local files only; URLs are not supported');
  }
  if (path.isAbsolute(raw)) return path.normalize(raw);
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, raw);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new Error(`relative path escapes the working directory: ${raw}`);
  }
  return resolved;
}

const importInput = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        'Local CSV file exported from the bank: an absolute path, or a path relative to the working directory. No URLs.',
      ),
    account: z
      .string()
      .min(1)
      .optional()
      .describe('Cash account these rows belong to. Created if unknown. Exactly one of account or liability.'),
    liability: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The card or loan these rows belong to, for a credit-card export. It must already exist (finance.set_liability). Exactly one of account or liability.',
      ),
  })
  .refine(oneLedger.check, { message: oneLedger.message });

export const importCsv: ToolDefinition<z.infer<typeof importInput>, unknown> = {
  name: 'finance.import_csv',
  description:
    'Import a bank CSV export into a cash account, or a card export into a liability (pass `liability` instead of `account`; on a card, negative is a charge and positive a payment or credit). Detects the date/amount/description/category columns, handles ; and , files and comma decimals, skips rows already imported, and returns how many rows were imported, skipped as duplicates, and could not be parsed. A row the export marks PENDING (in its own status column, or as a marker in the date column) is imported as pending, and the import ends by reconciling, so a pending line whose posted twin is in the same file settles immediately instead of being counted twice.',
  tier: 'auto',
  input: importInput,
  async execute(input, ctx) {
    const file = resolveCsvPath(input.path);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      throw new Error(
        `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const { rows, warnings } = parseBankCsv(text);
    const ledger = await resolveLedger(ctx.db, input);

    // Identical rows in one file are distinct transactions, so number them by
    // their position in the file before hashing.
    const occurrences = occurrenceIndexes(rows);

    let imported = 0;
    let skipped = 0;
    let pending = 0;
    for (const [i, row] of rows.entries()) {
      const result = await insertTransaction(ctx.db, {
        accountId: ledger.accountId,
        liabilityId: ledger.liabilityId,
        ledgerName: ledger.name,
        occurredOn: row.date,
        amount: row.amount,
        description: row.description,
        category: row.category ?? null,
        source: 'csv',
        occurrence: occurrences[i] ?? 0,
        status: row.status ?? 'posted',
      });
      if (result.inserted) {
        imported += 1;
        if (row.status === 'pending') pending += 1;
      } else skipped += 1;
    }

    // A statement export routinely carries both the pending authorisation and
    // the posted line that replaced it, so every import ends by settling them.
    const reconciled = await runReconcile(ctx.db);

    const dates = rows.map((r) => r.date).sort();
    return {
      file,
      ledger: ledger.kind,
      account: ledger.kind === 'account' ? ledger.name : null,
      liability: ledger.kind === 'liability' ? ledger.name : null,
      imported,
      skipped,
      pending,
      unparseable: warnings.length,
      warnings,
      range: dates.length > 0 ? { from: dates[0], to: dates[dates.length - 1] } : null,
      reconciled: {
        pendingMatched: reconciled.pending.matched.length,
        pendingOutstanding: reconciled.pending.unmatched.length,
        receiptsMatched: reconciled.receipts.matched.length,
      },
    };
  },
};

const summaryInput = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "expected YYYY-MM")
    .optional()
    .describe('Month to summarise, YYYY-MM. Defaults to the current month.'),
  includePending: z
    .boolean()
    .optional()
    .describe(
      'Default false: only settled (posted) money is summarised, because a pending charge may still change amount or vanish. True folds pending rows into the totals as well — say so when you report it.',
    ),
  account: z
    .string()
    .min(1)
    .optional()
    .describe('Limit to one cash account. Default: every ledger in scope.'),
  liability: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Summarise ONE card or loan instead of the cash: every charge, payment and credit recorded on it that month. Cannot be combined with `account`.',
    ),
  includeCardSpend: z
    .boolean()
    .optional()
    .describe(
      'Default false. Purchases made on a credit card are recorded on the card, not on the cash, and they are left out of these totals on purpose: that money reaches the cash when the card is paid, which is a separate row already counted. They are always reported under `cardSpend` so the answer can name them; true folds them into the totals as well, and double-counts against the card payment — only do it when the owner asked for total spend regardless of how it was paid, and say so.',
    ),
});

export const summary: ToolDefinition<z.infer<typeof summaryInput>, unknown> = {
  name: 'finance.summary',
  description:
    'Summarise recorded transactions for a month: total money in, total money out, net, a per-category breakdown, and the transaction count. Use it to explain where the money went; it never guesses — only recorded transactions count. Settled money only: pending authorisations are counted separately under `pending` and left out of the totals (pass includePending: true to fold them in), and a pending row that has since posted is never counted twice. Card purchases live on the card, not on the cash: they are reported under `cardSpend` and left out of the totals unless includeCardSpend is true, because the money reaches the cash as the card payment, which is its own row. Pass `liability` to summarise one card instead — its charges, payments and credits for the month.',
  tier: 'auto',
  input: summaryInput,
  async execute(input, ctx) {
    if (input.account && input.liability) {
      throw new Error('pass either account or liability, never both');
    }
    const month = input.month ?? ctx.now().toISOString().slice(0, 7);
    const start = `${month}-01`;
    const includePending = input.includePending ?? false;
    const includeCardSpend = input.includeCardSpend ?? false;

    let scopeAccountId: string | null = null;
    let scopeLiabilityId: string | null = null;
    let scope = 'all cash accounts';
    if (input.account) {
      const account = await findAccount(ctx.db, input.account);
      if (!account) throw new Error(`unknown account: ${input.account}`);
      scopeAccountId = account.id;
      scope = account.name;
    } else if (input.liability) {
      const liability = await findLiability(ctx.db, input.liability);
      if (!liability) throw new Error(`unknown liability: ${input.liability}`);
      scopeLiabilityId = liability.id;
      scope = liability.name;
    }

    // A superseded pending row is invisible everywhere: its posted twin is the
    // row that carries the money now.
    const { rows: scopedRows } = await ctx.db.query(
      `select amount, category, occurred_on, status, liability_id
         from finance.transactions
        where occurred_on >= $1::date
          and occurred_on < ($1::date + interval '1 month')
          and superseded_by is null
          and ($2::uuid is null or account_id = $2::uuid)
          and ($3::uuid is null or liability_id = $3::uuid)
        order by occurred_on`,
      [start, scopeAccountId, scopeLiabilityId],
    );

    // On a card ledger every row IS card activity; off it, card rows are the
    // spend that has not reached the cash yet.
    const onCard = (r: Record<string, unknown>): boolean =>
      scopeLiabilityId === null && r.liability_id !== null;
    const cardRows = scopedRows.filter(onCard);
    const cardSpendTotal = cardRows.reduce((sum, r) => sum + num(r.amount), 0);
    const allRows =
      includeCardSpend || scopeLiabilityId !== null
        ? scopedRows
        : scopedRows.filter((r) => !onCard(r));

    const rows = includePending
      ? allRows
      : allRows.filter((r) => (r.status as string) !== 'pending');
    const pendingRows = allRows.filter((r) => (r.status as string) === 'pending');
    const pendingTotal = pendingRows.reduce((sum, r) => sum + num(r.amount), 0);

    let income = 0;
    let expenses = 0;
    const byCategory = new Map<string, { total: number; count: number }>();
    for (const r of rows) {
      const amount = num(r.amount);
      if (amount >= 0) income += amount;
      else expenses += amount;
      const key = (r.category as string | null) ?? 'uncategorized';
      const entry = byCategory.get(key) ?? { total: 0, count: 0 };
      entry.total = Math.round((entry.total + amount) * 100) / 100;
      entry.count += 1;
      byCategory.set(key, entry);
    }

    const round = (n: number): number => Math.round(n * 100) / 100;
    const { rows: prefRows } = await ctx.db.query(
      `select value from finance.preferences where key = 'currency'`,
    );
    const currency =
      typeof prefRows[0]?.value === 'string' ? (prefRows[0].value as string) : 'EUR';

    return {
      month,
      currency,
      scope,
      account: input.account ? scope : null,
      liability: input.liability ? scope : null,
      includePending,
      includeCardSpend,
      /**
       * Purchases recorded on a card in this month. Counted in the totals only
       * when includeCardSpend is true; reported either way, because "you spent
       * X on the cards this month" is a real answer even though that money
       * leaves the cash later, as the card payment.
       */
      cardSpend: {
        count: cardRows.length,
        total: round(cardSpendTotal),
        countedInTotals: includeCardSpend || Boolean(input.liability),
      },
      /**
       * Committed but unsettled money in this month. Included in the totals
       * above only when includePending is true; reported either way so the
       * answer can mention it.
       */
      pending: {
        count: pendingRows.length,
        total: round(pendingTotal),
        countedInTotals: includePending,
      },
      income: round(income),
      expenses: round(expenses),
      net: round(income + expenses),
      count: rows.length,
      byCategory: [...byCategory.entries()]
        .map(([category, v]) => ({ category, total: v.total, count: v.count }))
        .sort((a, b) => a.total - b.total),
      first: rows[0] ? toDateString(rows[0].occurred_on) : null,
      last: rows.length > 0 ? toDateString(rows[rows.length - 1].occurred_on) : null,
    };
  },
};
