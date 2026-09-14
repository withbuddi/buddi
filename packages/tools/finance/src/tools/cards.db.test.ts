/**
 * DB-backed tests for card ledgers: transactions and recurring items that live
 * on a liability rather than on cash. Skipped unless DATABASE_URL is set.
 *
 * Like the other DB suites, this never touches the developer's data: it creates
 * a throwaway database, migrates this plugin into it, and drops it at the end.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry, createPool, migrate } from '@buddi/core';
import type { ToolContext } from '@buddi/core';
import { manifest } from '../index.js';
import { statementClosing } from '../sentinels/statement-closing.js';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_finance_cards_test_${process.pid}`;

const CARD = 'NFCU Mastercard Platinum 9012';

suite('card ledgers (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: ToolContext;
  let dir: string;
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
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-finance-cards-'));

    await call('finance.set_preferences', { currency: 'USD', safetyFloor: 0 });
    await call('finance.set_balance', { account: 'Checking', balance: 2000 });
    await call('finance.set_liability', {
      name: CARD,
      kind: 'credit_card',
      balance: 1000,
      creditLimit: 5000,
      minimumPayment: 40,
      dueDay: 18,
      statementDay: 21,
      apr: 24.99,
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /* ---------------- the schema's own rule ---------------- */

  describe('a row lives on exactly one ledger', () => {
    const ledgerIds = async (): Promise<{ account: string; liability: string }> => {
      const { rows: a } = await pool.query(`select id from finance.accounts limit 1`);
      const { rows: l } = await pool.query(`select id from finance.liabilities limit 1`);
      return { account: String(a[0].id), liability: String(l[0].id) };
    };

    it('refuses a transaction on neither ledger', async () => {
      await expect(
        pool.query(
          `insert into finance.transactions (occurred_on, amount, description, source, dedup_hash)
           values ('2026-09-01', -10, 'nowhere', 'manual', 'ledger-neither')`,
        ),
      ).rejects.toThrow(/transactions_ledger_check/);
    });

    it('refuses a transaction on both ledgers at once', async () => {
      const ids = await ledgerIds();
      await expect(
        pool.query(
          `insert into finance.transactions
             (account_id, liability_id, occurred_on, amount, description, source, dedup_hash)
           values ($1, $2, '2026-09-01', -10, 'both', 'manual', 'ledger-both')`,
          [ids.account, ids.liability],
        ),
      ).rejects.toThrow(/transactions_ledger_check/);
    });

    it('refuses a recurring item billed to a card AND drawn from an account', async () => {
      const ids = await ledgerIds();
      await expect(
        pool.query(
          `insert into finance.recurring_items
             (kind, name, amount, cadence, anchor_date, account_id, liability_id)
           values ('charge', 'both', 10, 'monthly', '2026-09-01', $1, $2)`,
          [ids.account, ids.liability],
        ),
      ).rejects.toThrow(/recurring_items_ledger_check/);
    });

    it('still allows a recurring item with no ledger at all — it hits the cash', async () => {
      const item = await call('finance.add_recurring', {
        kind: 'charge',
        name: 'Unattached charge',
        amount: 12,
        cadence: 'monthly',
        anchorDate: '2026-09-28',
      });
      expect(item).toMatchObject({ account: null, billedTo: null });
      await call('finance.remove_recurring', { name: 'Unattached charge' });
    });

    it('refuses a staging on neither ledger', async () => {
      await expect(
        pool.query(
          `insert into finance.import_stagings (source, rows, summary)
           values ('statement', '[]'::jsonb, '{}'::jsonb)`,
        ),
      ).rejects.toThrow(/import_stagings_ledger_check/);
    });

    it('refuses a tool call naming both, or neither', async () => {
      expect(
        await refusal('finance.record_transaction', {
          account: 'Checking',
          liability: CARD,
          occurredOn: '2026-09-01',
          amount: -10,
          description: 'both',
        }),
      ).toMatch(/exactly one/);
      expect(
        await refusal('finance.record_transaction', {
          occurredOn: '2026-09-01',
          amount: -10,
          description: 'neither',
        }),
      ).toMatch(/exactly one/);
    });

    it('refuses a card that was never recorded', async () => {
      expect(
        await refusal('finance.record_transaction', {
          liability: 'A card nobody recorded',
          occurredOn: '2026-09-01',
          amount: -10,
          description: 'ghost',
        }),
      ).toMatch(/unknown liability/);
    });
  });

  /* ---------------- recording on a card ---------------- */

  describe('record_transaction on a liability', () => {
    it('records a charge on the card, not on the cash', async () => {
      const recorded = await call('finance.record_transaction', {
        liability: CARD,
        occurredOn: '2026-09-03',
        amount: -348,
        description: 'GEICO auto insurance',
        category: 'insurance',
      });
      expect(recorded).toMatchObject({
        recorded: true,
        ledger: 'liability',
        account: null,
        liability: CARD,
      });
      const { rows } = await pool.query(
        `select account_id, liability_id from finance.transactions where id = $1`,
        [recorded.id],
      );
      expect(rows[0].account_id).toBeNull();
      expect(rows[0].liability_id).not.toBeNull();
    });

    it('is a no-op when the same charge is recorded twice', async () => {
      expect(
        await call('finance.record_transaction', {
          liability: CARD,
          occurredOn: '2026-09-03',
          amount: -348,
          description: 'GEICO auto insurance',
          category: 'insurance',
        }),
      ).toMatchObject({ recorded: false, duplicate: true });
    });

    it('does not collapse the same line on a different ledger', async () => {
      expect(
        await call('finance.record_transaction', {
          account: 'Checking',
          occurredOn: '2026-09-03',
          amount: -348,
          description: 'GEICO auto insurance',
        }),
      ).toMatchObject({ recorded: true, ledger: 'account' });
    });
  });

  /* ---------------- importing a card statement ---------------- */

  describe('import to a liability', () => {
    it('imports the card export and skips it on a second pass', async () => {
      const file = path.join(dir, 'card.csv');
      const header = 'date,amount,description,category';
      await writeFile(
        file,
        [
          header,
          '2026-09-05,-52.40,LIDL #883,groceries',
          '2026-09-10,500.00,PAYMENT THANK YOU,payment',
          '2026-09-11,-31.20,INTEREST CHARGE ON PURCHASES,interest',
        ].join('\n'),
        'utf8',
      );

      expect(await call('finance.import_csv', { path: file, liability: CARD })).toMatchObject({
        ledger: 'liability',
        liability: CARD,
        account: null,
        imported: 3,
        skipped: 0,
        unparseable: 0,
      });
      expect(await call('finance.import_csv', { path: file, liability: CARD })).toMatchObject({
        imported: 0,
        skipped: 3,
      });

      const { rows } = await pool.query(
        `select count(*)::int as n from finance.transactions where liability_id is not null`,
      );
      expect(rows[0].n).toBe(4); // the GEICO charge plus these three
    });

    it('stages and commits a card statement onto the card', async () => {
      const staged = await call('finance.stage_import', {
        liability: CARD,
        source: 'statement',
        rows: [{ date: '2026-09-12', amount: -18.75, description: 'SHELL 4412' }],
      });
      expect(staged).toMatchObject({ ledger: 'liability', liability: CARD, account: null });
      expect(staged.summary).toMatchObject({ rows: 1, newRows: 1 });

      const committed = await call('finance.commit_import', { stagingId: staged.stagingId });
      expect(committed).toMatchObject({ liability: CARD, inserted: 1, skipped: 0 });
    });
  });

  /* ---------------- recurring items billed to a card ---------------- */

  describe('a recurring charge billed to the card', () => {
    it('is listed with billedTo and kept out of the cash monthly net', async () => {
      await call('finance.add_recurring', {
        kind: 'charge',
        name: 'GEICO auto insurance',
        amount: 348,
        cadence: 'monthly',
        anchorDate: '2026-09-18',
        liability: CARD,
        category: 'insurance',
      });
      await call('finance.add_recurring', {
        kind: 'charge',
        name: 'NFCU Mastercard payment',
        amount: 200,
        cadence: 'monthly',
        anchorDate: '2026-09-15',
        account: 'Checking',
      });

      const listed = await call('finance.list_recurring', {});
      const geico = listed.items.find((i: any) => i.name === 'GEICO auto insurance');
      const payment = listed.items.find((i: any) => i.name === 'NFCU Mastercard payment');
      expect(geico).toMatchObject({ billedTo: CARD, account: null });
      expect(payment).toMatchObject({ billedTo: null, account: 'Checking' });
      expect(listed.cardBilledCount).toBe(1);
      // The card charge is not cash leaving this month; the payment is.
      expect(listed.monthlyNet).toBe(-200);
    });

    it('is absent from the cash-flow projection, while the payment is present', async () => {
      const projection = await call('finance.project_cashflow', {
        horizonDays: 30,
        includeBaseline: false,
      });
      const names = projection.days.flatMap((d: any) => d.events.map((e: any) => e.name));
      expect(names).toContain('NFCU Mastercard payment');
      expect(names).not.toContain('GEICO auto insurance');
    });
  });

  /* ---------------- the forecast ---------------- */

  describe('statement_forecast', () => {
    it('adds the charges due before the close and takes off the scheduled payment', async () => {
      const forecast = await call('finance.statement_forecast', { liability: CARD });
      expect(forecast).toMatchObject({
        status: 'ok',
        liability: CARD,
        hasForecast: true,
        closeDate: '2026-09-21',
        currentBalance: 1000,
        chargesBeforeClose: 348,
        paymentsBeforeClose: 200,
        forecastBalance: 1148,
        currency: 'USD',
      });
      expect(forecast.events.map((e: any) => e.name)).toEqual([
        'NFCU Mastercard payment',
        'GEICO auto insurance',
      ]);
    });

    it('is quoted by upcoming_statements', async () => {
      const upcoming = await call('finance.upcoming_statements', { days: 30 });
      const card = upcoming.statements.find((s: any) => s.name === CARD);
      expect(card).toMatchObject({
        statementDate: '2026-09-21',
        balance: 1000,
        forecastBalance: 1148,
        chargesBeforeClose: 348,
        paymentsBeforeClose: 200,
      });
    });

    it('is quoted by credit_plan', async () => {
      const plan = await call('finance.credit_plan', { monthlyBudget: 100 });
      const card = plan.allocations.find((a: any) => a.name === CARD);
      expect(card).toMatchObject({ forecastBalance: 1148, statementCloseDate: '2026-09-21' });
    });

    it('says plainly when the card has no closing day recorded', async () => {
      await call('finance.set_liability', {
        name: 'Synchrony Mattress Firm 9489',
        kind: 'credit_card',
        balance: 137.6,
        minimumPayment: 25,
        dueDay: 5,
      });
      const forecast = await call('finance.statement_forecast', {
        liability: 'Synchrony Mattress Firm 9489',
      });
      expect(forecast).toMatchObject({ hasForecast: false, forecastBalance: 137.6 });
      expect(forecast.message).toMatch(/no statement closing day/);
    });
  });

  /* ---------------- what the card has been doing ---------------- */

  describe('card_activity', () => {
    it('totals charges, payments and interest for the card', async () => {
      const activity = await call('finance.card_activity', { liability: CARD, months: 3 });
      expect(activity).toMatchObject({ status: 'ok', liability: CARD, currency: 'USD' });
      expect(activity.months.map((m: any) => m.month)).toEqual(['2026-07', '2026-08', '2026-09']);
      expect(activity.totals).toEqual({
        // 348 GEICO + 52.40 LIDL + 18.75 Shell; interest is on its own line.
        charges: 419.15,
        payments: 500,
        interest: 31.2,
        netBalanceChange: -49.65,
        count: 5,
      });
    });

    it('says plainly when nothing is recorded on the card yet', async () => {
      const activity = await call('finance.card_activity', {
        liability: 'Synchrony Mattress Firm 9489',
      });
      expect(activity.totals.count).toBe(0);
      expect(activity.message).toMatch(/no transactions are recorded/);
    });
  });

  /* ---------------- reads that have to know the difference ---------------- */

  describe('reads', () => {
    it('keeps card spend out of the monthly summary and reports it separately', async () => {
      const cash = await call('finance.summary', { month: '2026-09' });
      // The only cash row this month is the 348 recorded on Checking.
      expect(cash).toMatchObject({ expenses: -348, includeCardSpend: false });
      expect(cash.cardSpend).toMatchObject({ count: 5, countedInTotals: false });

      const withCards = await call('finance.summary', { month: '2026-09', includeCardSpend: true });
      expect(withCards.expenses).toBeLessThan(cash.expenses);
      expect(withCards.cardSpend.countedInTotals).toBe(true);
    });

    it('summarises one card when asked for it', async () => {
      const card = await call('finance.summary', { month: '2026-09', liability: CARD });
      expect(card).toMatchObject({ liability: CARD, income: 500, expenses: -450.35 });
    });

    it('leaves card charges out of the spending baseline unless asked', async () => {
      const withoutCards = await call('finance.spending_baseline', { months: 3 });
      expect(withoutCards.includeCardSpend).toBe(false);
      const withCards = await call('finance.spending_baseline', {
        months: 3,
        baselineOptions: { includeCardSpend: true },
      });
      expect(withCards.includeCardSpend).toBe(true);
    });
  });

  /* ---------------- receipts ---------------- */

  describe('receipts', () => {
    it('matches a receipt to the charge recorded on the card', async () => {
      const receipt = await call('finance.record_receipt', {
        merchant: 'Lidl',
        occurredOn: '2026-09-05',
        total: 52.4,
        currency: 'USD',
      });
      expect(receipt.matchedTransaction).toMatchObject({
        amount: -52.4,
        account: null,
        liability: CARD,
      });
      expect(receipt.receipt.transactionId).toBe(receipt.matchedTransaction.id);
    });
  });

  /* ---------------- the watch ---------------- */

  describe('statement-closing sentinel', () => {
    it('scores the balance the card is on course to report, not the one it shows', async () => {
      // 1000 on a 3400 limit is 29.4% — under the threshold, so the balance
      // alone would say nothing. The premium billed to the card lands before
      // the close and takes what the issuer will report to 1148, or 33.8%.
      const closing = 'Closing Test Card 4242';
      await call('finance.set_liability', {
        name: closing,
        kind: 'credit_card',
        balance: 1000,
        creditLimit: 3400,
        minimumPayment: 40,
        dueDay: 10,
        statementDay: 16,
      });
      await call('finance.add_recurring', {
        kind: 'charge',
        name: 'Closing Test premium',
        amount: 148,
        cadence: 'monthly',
        anchorDate: '2026-09-14',
        liability: closing,
      });

      const findings = await statementClosing.run({
        ...ctx,
        sentinelId: 'finance.statement-closing',
      } as any);
      const finding = findings.find((f) => f.key.includes(closing));
      expect(finding).toBeDefined();
      expect(finding?.data).toMatchObject({ balance: 1000, forecastBalance: 1148 });
      expect(finding?.detail).toContain('on course to report');

      // With the premium gone the card reports 1000 and the watch goes quiet.
      await call('finance.remove_recurring', { name: 'Closing Test premium' });
      const quiet = await statementClosing.run({
        ...ctx,
        sentinelId: 'finance.statement-closing',
      } as any);
      expect(quiet.find((f) => f.key.includes(closing))).toBeUndefined();
    });
  });
});
