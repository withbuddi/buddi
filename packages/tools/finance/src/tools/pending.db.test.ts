/**
 * DB-backed tests for pending money, receipts and staged imports. Skipped
 * unless DATABASE_URL is set.
 *
 * Like the other DB suite, this never touches the developer's data: it creates
 * a throwaway database, migrates this plugin into it, and drops it at the end.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry, createPool, migrate } from '@buddi/core';
import type { ToolContext } from '@buddi/core';
import { manifest } from '../index.js';
import { testDatabaseUrl } from '@buddi/core/testing';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_finance_pending_test_${process.pid}`;

suite('pending, receipts and staged imports (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: ToolContext;
  const registry = new ToolRegistry();

  const call = async (name: string, args: unknown): Promise<any> => {
    const result = await registry.invoke(name, args, ctx);
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };

  /** Invoke expecting a refusal, and return the message. */
  const refusal = async (name: string, args: unknown): Promise<string> => {
    const result = await registry.invoke(name, args, ctx);
    if (result.ok) throw new Error(`${name} unexpectedly succeeded`);
    return result.message;
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl as string);
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);

    const testUrl = new URL(url.toString());
    testUrl.pathname = `/${TEST_DB}`;
    pool = createPool(testUrl.toString());
    await migrate(pool, { schema: manifest.schema, dir: manifest.migrationsDir });

    registry.register(manifest);
    ctx = {
      db: pool,
      ownerId: 'test',
      now: () => new Date('2026-09-13T12:00:00Z'),
      timezone: 'UTC',
    };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  describe('pending becomes posted', () => {
    it('supersedes a pending row with the posted row that replaced it', async () => {
      await call('finance.set_balance', { account: 'Checking', balance: 1000 });
      const pending = await call('finance.record_transaction', {
        account: 'Checking',
        occurredOn: '2026-09-10',
        amount: -42.5,
        description: 'POS DEBIT CARD1234 LIDL #883',
        status: 'pending',
      });
      expect(pending).toMatchObject({ recorded: true, status: 'pending' });

      // Nothing to match yet.
      const first = await call('finance.reconcile', {});
      expect(first).toMatchObject({ matched: 0, unmatched: 1 });

      const posted = await call('finance.record_transaction', {
        account: 'Checking',
        occurredOn: '2026-09-12',
        amount: -42.5,
        description: 'LIDL PARIS 11',
      });
      expect(posted).toMatchObject({ recorded: true, status: 'posted' });

      const second = await call('finance.reconcile', {});
      expect(second.matched).toBe(1);
      expect(second.unmatched).toBe(0);
      expect(second.pending.matched[0]).toMatchObject({
        pendingId: pending.id,
        postedId: posted.id,
        dayGap: 2,
      });

      const { rows } = await pool.query(
        `select superseded_by from finance.transactions where id = $1`,
        [pending.id],
      );
      expect(rows[0].superseded_by).toBe(posted.id);

      // The pending row is neither deleted nor matched a second time.
      const third = await call('finance.reconcile', {});
      expect(third).toMatchObject({ matched: 0, unmatched: 0 });
      const { rows: kept } = await pool.query(
        `select count(*)::int as n from finance.transactions where id = $1`,
        [pending.id],
      );
      expect(kept[0].n).toBe(1);
    });

    it('leaves a pending row alone when nothing matches it', async () => {
      await call('finance.record_transaction', {
        account: 'Checking',
        occurredOn: '2026-09-11',
        amount: -88.2,
        description: 'PENDING HOTEL DEPOSIT',
        status: 'pending',
      });
      // A posted row for a different merchant, same window, same account.
      await call('finance.record_transaction', {
        account: 'Checking',
        occurredOn: '2026-09-12',
        amount: -88.2,
        description: 'MONOPRIX LYON',
      });
      const report = await call('finance.reconcile', {});
      expect(report.matched).toBe(0);
      expect(report.unmatched).toBe(1);
    });
  });

  describe('summary', () => {
    it('counts posted money only, and folds pending in on request', async () => {
      await call('finance.record_transaction', {
        account: 'Summary',
        occurredOn: '2026-05-04',
        amount: -30,
        description: 'CARREFOUR MAY',
        category: 'groceries',
      });
      await call('finance.record_transaction', {
        account: 'Summary',
        occurredOn: '2026-05-06',
        amount: -70,
        description: 'DECATHLON MAY',
        category: 'sport',
        status: 'pending',
      });

      const posted = await call('finance.summary', { month: '2026-05' });
      expect(posted).toMatchObject({ expenses: -30, count: 1, includePending: false });
      expect(posted.pending).toMatchObject({ count: 1, total: -70, countedInTotals: false });

      const withPending = await call('finance.summary', {
        month: '2026-05',
        includePending: true,
      });
      expect(withPending).toMatchObject({ expenses: -100, count: 2, includePending: true });
    });

    it('never counts a superseded pending row', async () => {
      await call('finance.record_transaction', {
        account: 'Summary',
        occurredOn: '2026-04-02',
        amount: -25,
        description: 'POS PIN SPAR 4412',
        status: 'pending',
      });
      await call('finance.record_transaction', {
        account: 'Summary',
        occurredOn: '2026-04-04',
        amount: -25,
        description: 'SPAR AMSTERDAM',
      });
      await call('finance.reconcile', {});

      const april = await call('finance.summary', { month: '2026-04', includePending: true });
      expect(april.count).toBe(1);
      expect(april.expenses).toBe(-25);
    });
  });

  describe('projection', () => {
    it('applies pending charges inside the horizon as one-off events', async () => {
      await call('finance.set_balance', { account: 'Projection', balance: 500 });
      await call('finance.record_transaction', {
        account: 'Projection',
        occurredOn: '2026-09-20',
        amount: -100,
        description: 'AIRLINE HOLD',
        status: 'pending',
      });

      const withPending = await call('finance.project_cashflow', {
        account: 'Projection',
        horizonDays: 30,
        includeBaseline: false,
      });
      expect(withPending.includePending).toBe(true);
      expect(withPending.pendingEvents).toEqual([
        { name: 'AIRLINE HOLD (pending)', amount: -100, date: '2026-09-20' },
      ]);
      expect(withPending.endBalance).toBe(400);
      expect(withPending.minBalance).toBe(400);

      const without = await call('finance.project_cashflow', {
        account: 'Projection',
        horizonDays: 30,
        includeBaseline: false,
        includePending: false,
      });
      expect(without.pendingEvents).toEqual([]);
      expect(without.endBalance).toBe(500);
    });

    it('ignores a pending charge dated beyond the horizon', async () => {
      await call('finance.record_transaction', {
        account: 'Projection',
        occurredOn: '2026-12-24',
        amount: -250,
        description: 'FAR AWAY HOLD',
        status: 'pending',
      });
      const projected = await call('finance.project_cashflow', {
        account: 'Projection',
        horizonDays: 30,
        includeBaseline: false,
      });
      expect(projected.pendingEvents).toHaveLength(1);
      expect(projected.endBalance).toBe(400);
    });
  });

  describe('receipts', () => {
    it('matches a receipt to the charge on the same day', async () => {
      const tx = await call('finance.record_transaction', {
        account: 'Cards',
        occurredOn: '2026-06-10',
        amount: -63.4,
        description: 'TRADER JOES #22',
      });
      const result = await call('finance.record_receipt', {
        merchant: "Trader Joe's",
        occurredOn: '2026-06-10',
        total: 63.4,
        items: [{ name: 'Coffee', qty: 2, price: 11.98 }],
      });
      expect(result.matchedTransaction).toMatchObject({ id: tx.id, status: 'posted' });
      expect(result.receipt).toMatchObject({ merchantNorm: 'trader joes', total: 63.4 });
    });

    it('matches a receipt three days from the charge, and a pending charge', async () => {
      const tx = await call('finance.record_transaction', {
        account: 'Cards',
        occurredOn: '2026-06-14',
        amount: -21.75,
        description: 'MONOPRIX LYON 03',
        status: 'pending',
      });
      const result = await call('finance.record_receipt', {
        merchant: 'Monoprix',
        occurredOn: '2026-06-11',
        total: 21.75,
      });
      expect(result.matchedTransaction).toMatchObject({ id: tx.id, status: 'pending' });
    });

    it('leaves a receipt unmatched when the charge is four days away', async () => {
      await call('finance.record_transaction', {
        account: 'Cards',
        occurredOn: '2026-06-25',
        amount: -44.44,
        description: 'IKEA PARIS NORD',
      });
      const result = await call('finance.record_receipt', {
        merchant: 'IKEA',
        occurredOn: '2026-06-21',
        total: 44.44,
      });
      expect(result.matchedTransaction).toBeNull();

      const unmatched = await call('finance.list_receipts', { unmatchedOnly: true });
      expect(unmatched.receipts.map((r: any) => r.merchant)).toContain('IKEA');

      // Reconcile does not force it either — four days is four days.
      await call('finance.reconcile', {});
      const still = await call('finance.list_receipts', { unmatchedOnly: true });
      expect(still.receipts.map((r: any) => r.id)).toContain(result.receipt.id);
    });

    it('links a receipt by hand', async () => {
      const unmatched = await call('finance.list_receipts', { unmatchedOnly: true });
      const receipt = unmatched.receipts.find((r: any) => r.merchant === 'IKEA');
      const { rows } = await pool.query(
        `select id from finance.transactions where description = 'IKEA PARIS NORD'`,
      );
      const linked = await call('finance.link_receipt', {
        receiptId: receipt.id,
        transactionId: rows[0].id,
      });
      expect(linked.receipt.transactionId).toBe(rows[0].id);

      const after = await call('finance.list_receipts', { unmatchedOnly: true });
      expect(after.receipts.map((r: any) => r.id)).not.toContain(receipt.id);
    });

    it('links an outstanding receipt once its charge arrives', async () => {
      const receipt = await call('finance.record_receipt', {
        merchant: 'Gelateria Rossi',
        occurredOn: '2026-07-02',
        total: 8.5,
      });
      expect(receipt.matchedTransaction).toBeNull();

      const tx = await call('finance.record_transaction', {
        account: 'Cards',
        occurredOn: '2026-07-03',
        amount: -8.5,
        description: 'GELATERIA ROSSI ROMA',
      });
      const report = await call('finance.reconcile', {});
      expect(report.receipts.matched).toBeGreaterThanOrEqual(1);
      expect(
        report.receipts.detail.matched.some(
          (m: any) => m.receiptId === receipt.receipt.id && m.transactionId === tx.id,
        ),
      ).toBe(true);
    });
  });

  describe('staged imports', () => {
    const rows = [
      { date: '2026-08-03', amount: -12.5, description: 'CAFE DU COIN', category: 'eating out' },
      { date: '2026-08-04', amount: -200, description: 'EDF ELECTRICITY', category: 'utilities' },
      { date: '2026-08-05', amount: 1800, description: 'SALARY AUGUST', category: 'income' },
    ];

    it('stages rows without writing them, and counts duplicates', async () => {
      // One of the three is already in the ledger.
      await call('finance.record_transaction', {
        account: 'Statements',
        occurredOn: '2026-08-04',
        amount: -200,
        description: 'EDF ELECTRICITY',
        category: 'utilities',
      });

      const staged = await call('finance.stage_import', {
        account: 'Statements',
        source: 'statement',
        artifactId: '11111111-1111-4111-8111-111111111111',
        rows,
      });
      expect(staged.summary).toMatchObject({
        rows: 3,
        newRows: 2,
        duplicates: 1,
        totalIn: 1800,
        totalOut: -12.5,
        dateRange: { from: '2026-08-03', to: '2026-08-05' },
      });
      expect(staged.summary.byCategoryTop5).toEqual([
        { category: 'income', total: 1800 },
        { category: 'eating out', total: -12.5 },
      ]);

      // Nothing written yet: only the row recorded by hand exists.
      const { rows: count } = await pool.query(
        `select count(*)::int as n from finance.transactions t
           join finance.accounts a on a.id = t.account_id
          where a.name = 'Statements'`,
      );
      expect(count[0].n).toBe(1);

      const committed = await call('finance.commit_import', { stagingId: staged.stagingId });
      expect(committed).toMatchObject({ inserted: 2, skipped: 1, source: 'statement' });

      const { rows: after } = await pool.query(
        `select description, source, status, artifact_id from finance.transactions t
           join finance.accounts a on a.id = t.account_id
          where a.name = 'Statements' order by occurred_on`,
      );
      expect(after).toHaveLength(3);
      const salary = after.find((r) => r.description === 'SALARY AUGUST');
      expect(salary).toMatchObject({
        source: 'statement',
        status: 'posted',
        artifact_id: '11111111-1111-4111-8111-111111111111',
      });
    });

    it('refuses to commit the same staging twice', async () => {
      const staged = await call('finance.stage_import', {
        account: 'Statements',
        source: 'statement',
        rows: [{ date: '2026-08-09', amount: -9.99, description: 'NETFLIX' }],
      });
      await call('finance.commit_import', { stagingId: staged.stagingId });
      const message = await refusal('finance.commit_import', { stagingId: staged.stagingId });
      expect(message).toMatch(/already committed/);
    });

    it('keeps a staged pending row pending, and reconciles on commit', async () => {
      const staged = await call('finance.stage_import', {
        account: 'Statements',
        source: 'statement',
        rows: [
          {
            date: '2026-08-20',
            amount: -55,
            description: 'POS CARD1234 FNAC PARIS',
            status: 'pending',
          },
          { date: '2026-08-21', amount: -31, description: 'BOULANGERIE', status: 'pending' },
          { date: '2026-08-22', amount: -55, description: 'FNAC PARIS 12' },
        ],
      });
      expect(staged.summary.pending).toBe(2);

      const committed = await call('finance.commit_import', { stagingId: staged.stagingId });
      expect(committed).toMatchObject({ inserted: 3, pending: 2 });
      expect(committed.reconciled.pendingMatched).toBe(1);

      const { rows: fnac } = await pool.query(
        `select status, superseded_by from finance.transactions
          where description = 'POS CARD1234 FNAC PARIS'`,
      );
      expect(fnac[0].status).toBe('pending');
      expect(fnac[0].superseded_by).not.toBeNull();

      // The unmatched pending row survives untouched.
      const { rows: bread } = await pool.query(
        `select status, superseded_by from finance.transactions where description = 'BOULANGERIE'`,
      );
      expect(bread[0]).toMatchObject({ status: 'pending', superseded_by: null });
    });

    it('discards a staging, after which it cannot be committed', async () => {
      const staged = await call('finance.stage_import', {
        account: 'Statements',
        source: 'statement',
        rows: [{ date: '2026-08-11', amount: -17, description: 'BOOKSHOP' }],
      });
      const discarded = await call('finance.discard_import', { stagingId: staged.stagingId });
      expect(discarded).toMatchObject({ discarded: true, rows: 1 });

      const message = await refusal('finance.commit_import', { stagingId: staged.stagingId });
      expect(message).toMatch(/unknown staging/);

      const { rows: none } = await pool.query(
        `select count(*)::int as n from finance.transactions where description = 'BOOKSHOP'`,
      );
      expect(none[0].n).toBe(0);
    });

    it('refuses a staging that has expired', async () => {
      const staged = await call('finance.stage_import', {
        account: 'Statements',
        source: 'statement',
        rows: [{ date: '2026-08-12', amount: -5, description: 'KIOSK' }],
      });
      await pool.query(
        `update finance.import_stagings set expires_at = now() - interval '1 minute' where id = $1`,
        [staged.stagingId],
      );
      const message = await refusal('finance.commit_import', { stagingId: staged.stagingId });
      expect(message).toMatch(/expired/);

      const { rows: none } = await pool.query(
        `select count(*)::int as n from finance.transactions where description = 'KIOSK'`,
      );
      expect(none[0].n).toBe(0);
    });
  });
});
