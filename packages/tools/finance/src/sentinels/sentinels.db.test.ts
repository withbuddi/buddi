/**
 * DB-backed sentinel tests. Skipped unless DATABASE_URL is set.
 *
 * Same throwaway pattern as the tool tests: a database created for this run,
 * core plus finance migrations applied into it, dropped at the end. Core's
 * migrations are needed too — `unprocessed-artifacts` reads `core.artifacts`.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, runMigrations } from '@buddi/core';
import { manifest } from '../index.js';
import type { SentinelContext } from './types.js';
import { floorBreach } from './floor-breach.js';
import { minimumDue } from './minimum-due.js';
import { statementClosing } from './statement-closing.js';
import { staleBalance } from './stale-balance.js';
import { unmatchedReceipts } from './unmatched-receipts.js';
import { unprocessedArtifacts } from './unprocessed-artifacts.js';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_sentinels_test_${process.pid}`;
/** A Sunday; "today" for every case below. */
const NOW = new Date('2026-09-13T12:00:00Z');

suite('finance sentinels (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: SentinelContext;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [manifest]);
    ctx = { db: pool, now: () => NOW, timezone: 'UTC' };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query(
      `truncate finance.payment_events, finance.import_stagings, finance.receipts,
                finance.transactions, finance.recurring_items, finance.liabilities,
                finance.accounts, finance.preferences, core.artifacts restart identity cascade`,
    );
    await pool.query(
      `insert into finance.preferences (key, value) values
         ('currency', '"EUR"'::jsonb), ('safety_floor', '200'::jsonb)`,
    );
  });

  const accountId = async (
    name: string,
    balance: number,
    asOf = '2026-09-13',
    includeInCashflow = true,
  ): Promise<string> => {
    const { rows } = await pool.query(
      `insert into finance.accounts (name, balance, balance_as_of, include_in_cashflow)
       values ($1, $2, $3::date, $4) returning id`,
      [name, balance, asOf, includeInCashflow],
    );
    return String(rows[0].id);
  };

  const liabilityId = async (fields: {
    name: string;
    kind?: string;
    balance: number;
    creditLimit?: number | null;
    minimumPayment: number;
    dueDay: number;
    statementDay?: number | null;
  }): Promise<string> => {
    const { rows } = await pool.query(
      `insert into finance.liabilities
         (name, kind, balance, credit_limit, minimum_payment, due_day, statement_day)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        fields.name,
        fields.kind ?? 'credit_card',
        fields.balance,
        fields.creditLimit ?? null,
        fields.minimumPayment,
        fields.dueDay,
        fields.statementDay ?? null,
      ],
    );
    return String(rows[0].id);
  };

  /* ---------------- floor-breach ---------------- */

  describe('floor-breach', () => {
    it('is quiet with no accounts at all', async () => {
      expect(await floorBreach.run(ctx)).toEqual([]);
    });

    it('is quiet when the projection clears the floor', async () => {
      await accountId('Checking', 5000);
      await pool.query(
        `insert into finance.recurring_items (kind, name, amount, cadence, anchor_date)
         values ('charge', 'Rent', 900, 'monthly', '2026-09-20')`,
      );
      expect(await floorBreach.run(ctx)).toEqual([]);
    });

    it('is urgent when the floor breaks inside a week', async () => {
      await accountId('Checking', 1000);
      await pool.query(
        `insert into finance.recurring_items (kind, name, amount, cadence, anchor_date)
         values ('charge', 'Rent', 900, 'monthly', '2026-09-20')`,
      );
      const [finding, ...rest] = await floorBreach.run(ctx);
      expect(rest).toEqual([]);
      expect(finding?.severity).toBe('urgent');
      expect(finding?.key).toBe('floor-breach:2026-09-20');
      expect(finding?.agentId).toBe('finance-advisor');
      expect(finding?.detail).toContain('2026-09-20');
    });

    it('is info when the breach is out past the first week', async () => {
      await accountId('Checking', 1000);
      await pool.query(
        `insert into finance.recurring_items (kind, name, amount, cadence, anchor_date)
         values ('charge', 'Rent', 900, 'monthly', '2026-10-05')`,
      );
      const [finding] = await floorBreach.run(ctx);
      expect(finding?.severity).toBe('info');
      expect(finding?.key).toBe('floor-breach:2026-10-05');
    });

    it('ignores money that is not spendable', async () => {
      await accountId('Checking', 1000);
      await accountId('401k', 90_000, '2026-09-13', false);
      await pool.query(
        `insert into finance.recurring_items (kind, name, amount, cadence, anchor_date)
         values ('charge', 'Rent', 900, 'monthly', '2026-09-20')`,
      );
      const [finding] = await floorBreach.run(ctx);
      expect(finding?.severity).toBe('urgent');
    });
  });

  /* ---------------- minimum-due ---------------- */

  describe('minimum-due', () => {
    it('is urgent for an unpaid minimum inside three days', async () => {
      await liabilityId({ name: 'Amex Gold', balance: 1200, minimumPayment: 45, dueDay: 15 });
      const [finding, ...rest] = await minimumDue.run(ctx);
      expect(rest).toEqual([]);
      expect(finding?.severity).toBe('urgent');
      expect(finding?.key).toBe('minimum-due:Amex Gold:2026-09-15');
      expect(finding?.agentId).toBe('credit-coach');
    });

    it('is quiet when the due date is further out', async () => {
      await liabilityId({ name: 'Amex Gold', balance: 1200, minimumPayment: 45, dueDay: 28 });
      expect(await minimumDue.run(ctx)).toEqual([]);
    });

    it('is quiet once the payment is recorded for that due date', async () => {
      const id = await liabilityId({
        name: 'Amex Gold',
        balance: 1200,
        minimumPayment: 45,
        dueDay: 15,
      });
      await pool.query(
        `insert into finance.payment_events (liability_id, due_on, paid_on, amount, status)
         values ($1, '2026-09-15', '2026-09-12', 45, 'paid_on_time')`,
        [id],
      );
      expect(await minimumDue.run(ctx)).toEqual([]);
    });

    it('still speaks when only last cycle was paid', async () => {
      const id = await liabilityId({
        name: 'Amex Gold',
        balance: 1200,
        minimumPayment: 45,
        dueDay: 15,
      });
      await pool.query(
        `insert into finance.payment_events (liability_id, due_on, paid_on, amount, status)
         values ($1, '2026-08-15', '2026-08-14', 45, 'paid_on_time')`,
        [id],
      );
      expect(await minimumDue.run(ctx)).toHaveLength(1);
    });

    it('is quiet when an autopay we model covers it', async () => {
      const account = await accountId('Checking', 3000);
      await liabilityId({ name: 'Amex Gold', balance: 1200, minimumPayment: 45, dueDay: 15 });
      await pool.query(
        `insert into finance.recurring_items (kind, name, amount, cadence, anchor_date, account_id)
         values ('charge', 'Amex Gold autopay', 45, 'monthly', '2026-09-15', $1)`,
        [account],
      );
      expect(await minimumDue.run(ctx)).toEqual([]);
    });

    it('still speaks when the autopay sits on an account the cash flow cannot see', async () => {
      const account = await accountId('Brokerage', 3000, '2026-09-13', false);
      await liabilityId({ name: 'Amex Gold', balance: 1200, minimumPayment: 45, dueDay: 15 });
      await pool.query(
        `insert into finance.recurring_items (kind, name, amount, cadence, anchor_date, account_id)
         values ('charge', 'Amex Gold autopay', 45, 'monthly', '2026-09-15', $1)`,
        [account],
      );
      expect(await minimumDue.run(ctx)).toHaveLength(1);
    });

    it('ignores an inactive liability and one with no minimum', async () => {
      await pool.query(
        `insert into finance.liabilities (name, kind, balance, minimum_payment, due_day, active)
         values ('Old Card', 'credit_card', 100, 25, 15, false)`,
      );
      await liabilityId({ name: 'Free Card', balance: 100, minimumPayment: 0, dueDay: 15 });
      expect(await minimumDue.run(ctx)).toEqual([]);
    });
  });

  /* ---------------- statement-closing ---------------- */

  describe('statement-closing', () => {
    it('reports a card over 30% closing inside three days', async () => {
      await liabilityId({
        name: 'Amex Gold',
        balance: 700,
        creditLimit: 1000,
        minimumPayment: 45,
        dueDay: 28,
        statementDay: 15,
      });
      const [finding] = await statementClosing.run(ctx);
      expect(finding?.severity).toBe('info');
      expect(finding?.key).toBe('statement:Amex Gold:2026-09-15');
      expect(finding?.agentId).toBe('credit-coach');
    });

    it('is quiet under 30%', async () => {
      await liabilityId({
        name: 'Amex Gold',
        balance: 200,
        creditLimit: 1000,
        minimumPayment: 45,
        dueDay: 28,
        statementDay: 15,
      });
      expect(await statementClosing.run(ctx)).toEqual([]);
    });
  });

  /* ---------------- stale-balance ---------------- */

  describe('stale-balance', () => {
    it('reports only cash-flow accounts older than two weeks', async () => {
      await accountId('Checking', 900, '2026-08-20');
      await accountId('Savings', 5000, '2026-09-10');
      await accountId('401k', 90_000, '2026-01-01', false);
      const findings = await staleBalance.run(ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.key).toBe('stale:Checking:2026-08-20');
      expect(findings[0]?.severity).toBe('info');
    });
  });

  /* ---------------- unmatched-receipts ---------------- */

  describe('unmatched-receipts', () => {
    it('collapses stale unmatched receipts into one finding', async () => {
      await pool.query(
        `insert into finance.receipts (merchant, merchant_norm, occurred_on, total, currency)
         values ('Lidl', 'lidl', '2026-09-01', 42, 'EUR'),
                ('Fnac', 'fnac', '2026-08-28', 99, 'EUR'),
                ('Shell', 'shell', '2026-09-12', 60, 'EUR')`,
      );
      const [finding, ...rest] = await unmatchedReceipts.run(ctx);
      expect(rest).toEqual([]);
      expect(finding?.key).toBe('unmatched-receipts:2026-08-28:2');
      expect(finding?.detail).toContain('Fnac');
      expect(finding?.detail).not.toContain('Shell');
    });

    it('is quiet once a receipt is linked to its charge', async () => {
      const { rows } = await pool.query(
        `insert into finance.transactions
           (occurred_on, amount, description, source, dedup_hash)
         values ('2026-09-01', -42, 'LIDL', 'manual', 'hash-1') returning id`,
      );
      await pool.query(
        `insert into finance.receipts
           (merchant, merchant_norm, occurred_on, total, currency, transaction_id)
         values ('Lidl', 'lidl', '2026-09-01', 42, 'EUR', $1)`,
        [rows[0].id],
      );
      expect(await unmatchedReceipts.run(ctx)).toEqual([]);
    });
  });

  /* ---------------- unprocessed-artifacts ---------------- */

  describe('unprocessed-artifacts', () => {
    const artifact = async (sha: string, createdAt: string): Promise<string> => {
      const { rows } = await pool.query(
        `insert into core.artifacts
           (kind, mime, filename, size_bytes, sha256, storage_path, created_by, created_at)
         values ('document', 'application/pdf', $1 || '.pdf', 100, $1, 'artifacts/' || $1, 'owner', $2::timestamptz)
         returning id`,
        [sha, createdAt],
      );
      return String(rows[0].id);
    };

    it('reports a day-old file nothing references', async () => {
      await artifact('aaa', '2026-09-10T09:00:00Z');
      await artifact('bbb', '2026-09-13T11:00:00Z'); // too recent
      const [finding, ...rest] = await unprocessedArtifacts.run(ctx);
      expect(rest).toEqual([]);
      expect(finding?.key).toBe('unprocessed-artifacts:2026-09-10:1');
      expect(finding?.severity).toBe('info');
      expect(finding?.detail).toContain('aaa.pdf');
    });

    it('is quiet once a transaction, a receipt or a staging references it', async () => {
      const one = await artifact('aaa', '2026-09-10T09:00:00Z');
      const two = await artifact('bbb', '2026-09-10T09:00:00Z');
      const three = await artifact('ccc', '2026-09-10T09:00:00Z');
      await pool.query(
        `insert into finance.transactions
           (occurred_on, amount, description, source, dedup_hash, artifact_id)
         values ('2026-09-10', -10, 'X', 'statement', 'hash-2', $1)`,
        [one],
      );
      await pool.query(
        `insert into finance.receipts (merchant, merchant_norm, occurred_on, total, artifact_id)
         values ('Lidl', 'lidl', '2026-09-10', 10, $1)`,
        [two],
      );
      const account = await accountId('Checking', 100);
      await pool.query(
        `insert into finance.import_stagings (account_id, source, artifact_id, rows, summary)
         values ($1, 'statement', $2, '[]'::jsonb, '{}'::jsonb)`,
        [account, three],
      );
      expect(await unprocessedArtifacts.run(ctx)).toEqual([]);
    });
  });

  /* ---------------- the manifest ---------------- */

  it('ships every sentinel on the manifest with a sane cadence', () => {
    expect(manifest.sentinels.map((s) => s.id)).toEqual([
      'finance.floor-breach',
      'finance.minimum-due',
      'finance.statement-closing',
      'finance.stale-balance',
      'finance.unmatched-receipts',
      'finance.unprocessed-artifacts',
    ]);
    for (const sentinel of manifest.sentinels) {
      expect(sentinel.every).toBeGreaterThanOrEqual(3600);
      expect(sentinel.description.length).toBeGreaterThan(20);
    }
  });
});
