/**
 * DB-backed tool tests. Skipped unless DATABASE_URL is set.
 *
 * They never touch the developer's data: the suite creates a throwaway
 * database, runs this plugin's migrations into it, and drops it at the end.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry, createPool, migrate } from '@buddi/core';
import type { ToolContext } from '@buddi/core';
import { manifest } from '../index.js';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_finance_test_${process.pid}`;

suite('finance tools (postgres)', () => {
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
    ctx = { db: pool, ownerId: 'test', now: () => new Date('2026-09-13T12:00:00Z') };
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-finance-'));
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('defaults preferences and round-trips updates', async () => {
    expect(await call('finance.get_preferences', {})).toEqual({
      currency: 'EUR',
      safetyFloor: 0,
    });
    expect(await call('finance.set_preferences', { currency: 'USD', safetyFloor: 200 })).toEqual({
      currency: 'USD',
      safetyFloor: 200,
    });
  });

  it('creates an account on first balance and lists it', async () => {
    const set = await call('finance.set_balance', { account: 'Checking', balance: 900 });
    expect(set).toMatchObject({ name: 'Checking', balance: 900, balanceAsOf: '2026-09-13' });
    const listed = await call('finance.list_accounts', {});
    expect(listed.accounts).toHaveLength(1);
    expect(listed.total).toBe(900);
  });

  it('adds, lists and deactivates recurring items', async () => {
    await call('finance.add_recurring', {
      kind: 'income',
      name: 'Salary',
      amount: 3200,
      cadence: 'monthly',
      anchorDate: '2026-09-28',
      account: 'Checking',
    });
    const gym = await call('finance.add_recurring', {
      kind: 'charge',
      name: 'Gym',
      amount: 30,
      cadence: 'monthly',
      anchorDate: '2026-09-05',
    });
    expect((await call('finance.list_recurring', {})).count).toBe(2);
    expect(await call('finance.remove_recurring', { id: gym.id })).toMatchObject({ removed: 1 });
    expect((await call('finance.list_recurring', {})).count).toBe(1);
    expect((await call('finance.list_recurring', { activeOnly: false })).count).toBe(2);
  });

  it('records a transaction once, however many times it is offered', async () => {
    const args = {
      account: 'Checking',
      occurredOn: '2026-09-10',
      amount: -12.5,
      description: 'Bakery',
      category: 'groceries',
    };
    expect(await call('finance.record_transaction', args)).toMatchObject({
      recorded: true,
      duplicate: false,
    });
    expect(await call('finance.record_transaction', args)).toMatchObject({
      recorded: false,
      duplicate: true,
    });
  });

  it('imports a CSV, skips rows already imported and summarises the month', async () => {
    const file = path.join(dir, 'bank.csv');
    await writeFile(
      file,
      ['Date;Libellé;Montant', '13/09/2026;SALAIRE;3 200,00', '15/09/2026;EDF;-89,90'].join('\n'),
      'utf8',
    );
    const first = await call('finance.import_csv', { path: file, account: 'Checking' });
    expect(first).toMatchObject({ imported: 2, skipped: 0, unparseable: 0 });
    const second = await call('finance.import_csv', { path: file, account: 'Checking' });
    expect(second).toMatchObject({ imported: 0, skipped: 2 });

    const sum = await call('finance.summary', { month: '2026-09' });
    expect(sum).toMatchObject({
      month: '2026-09',
      income: 3200,
      expenses: -102.4,
      net: 3097.6,
      count: 3,
    });
    expect(sum.byCategory.map((c: { category: string }) => c.category).sort()).toEqual([
      'groceries',
      'uncategorized',
    ]);
  });

  it('keeps genuine same-day duplicates and re-imports a grown file cleanly', async () => {
    const file = path.join(dir, 'duplicates.csv');
    const header = 'date,amount,description,category';
    const zelle = '2026-08-31,1000.00,Transfer from Zelle,Transfers';
    const other = '2026-08-31,-10.46,Cloudflare,Services';
    await writeFile(file, [header, zelle, other, zelle].join('\n'), 'utf8');

    // Three distinct rows, two of them identical: all three are real money.
    expect(await call('finance.import_csv', { path: file, account: 'Duplicates' })).toMatchObject({
      imported: 3,
      skipped: 0,
      unparseable: 0,
    });

    // Re-importing the untouched file is still a complete no-op.
    expect(await call('finance.import_csv', { path: file, account: 'Duplicates' })).toMatchObject({
      imported: 0,
      skipped: 3,
    });

    // A later export with one more identical row imports only the extra one.
    await writeFile(file, [header, zelle, other, zelle, zelle].join('\n'), 'utf8');
    expect(await call('finance.import_csv', { path: file, account: 'Duplicates' })).toMatchObject({
      imported: 1,
      skipped: 3,
    });

    const { rows } = await pool.query(
      `select count(*)::int as n from finance.transactions t
         join finance.accounts a on a.id = t.account_id
        where a.name = 'Duplicates' and t.description = 'Transfer from Zelle'`,
    );
    expect(rows[0].n).toBe(3);
  });

  it("carries the CSV's own category into the stored rows", async () => {
    const file = path.join(dir, 'categorised.csv');
    await writeFile(
      file,
      ['date,amount,description,category', '2026-08-02,-31.40,Filling station,Gas and Fuel'].join(
        '\n',
      ),
      'utf8',
    );
    await call('finance.import_csv', { path: file, account: 'Categorised' });
    const sum = await call('finance.summary', { month: '2026-08' });
    expect(sum.byCategory).toContainEqual({ category: 'Gas and Fuel', total: -31.4, count: 1 });
  });

  it('records a manual duplicate only when told it really happened twice', async () => {
    const args = {
      account: 'Checking',
      occurredOn: '2026-09-11',
      amount: -6.5,
      description: 'Coffee',
    };
    expect(await call('finance.record_transaction', args)).toMatchObject({ recorded: true });
    // Default occurrence is 0, so an offered repeat is still a no-op...
    expect(await call('finance.record_transaction', args)).toMatchObject({ duplicate: true });
    expect(await call('finance.record_transaction', { ...args, occurrence: 0 })).toMatchObject({
      duplicate: true,
    });
    // ...but a second, genuine coffee that day can be recorded explicitly.
    expect(await call('finance.record_transaction', { ...args, occurrence: 1 })).toMatchObject({
      recorded: true,
      duplicate: false,
    });
    expect(await call('finance.record_transaction', { ...args, occurrence: 1 })).toMatchObject({
      duplicate: true,
    });

    const { rows } = await pool.query(
      `select count(*)::int as n from finance.transactions where description = 'Coffee'`,
    );
    expect(rows[0].n).toBe(2);
  });

  it('refuses to read a path outside the working directory', async () => {
    const result = await registry.invoke(
      'finance.import_csv',
      { path: '../../../etc/passwd', account: 'Checking' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/escapes the working directory/);
  });

  it('projects cashflow from the stored balance and items', async () => {
    // Recurring items only: the baseline burn is measured separately below.
    const result = await call('finance.project_cashflow', {
      horizonDays: 60,
      includeBaseline: false,
    });
    expect(result).toMatchObject({
      startDate: '2026-09-13',
      startBalance: 900,
      currency: 'USD',
      safetyFloor: 200,
      breachesFloor: false,
      nextIncome: { name: 'Salary', amount: 3200, date: '2026-09-28' },
    });
    // Only days with events (plus the low point and the last day) are returned.
    expect(result.days.length).toBeLessThan(10);

    const whatIf = await call('finance.project_cashflow', {
      horizonDays: 60,
      includeBaseline: false,
      hypotheticals: [{ name: 'Laptop', amount: -800, date: '2026-09-20' }],
    });
    expect(whatIf.breachesFloor).toBe(true);
    expect(whatIf.minBalance).toBe(100);
    expect(whatIf.firstBreachDate).toBe('2026-09-20');
  });

  it('measures a spending baseline from whole months, keeping p2p apart', async () => {
    const baseline = await call('finance.spending_baseline', {});
    // Only August is a complete month with data in this fixture.
    expect(baseline).toMatchObject({ monthsUsed: 1, currency: 'USD' });
    expect(baseline.window).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    // Cloudflare (10.46) + the filling station (31.40); the Zelle rows are p2p.
    expect(baseline.avgMonthlyVariableOut).toBe(41.86);
    expect(baseline.dailyBurn).toBeGreaterThan(0);
    expect(baseline.p2p.avgMonthlyIn).toBe(3000);
    expect(baseline.p2p.avgMonthlyOut).toBe(0);
    expect(baseline.byCategory.map((c: { category: string }) => c.category).sort()).toEqual([
      'Gas and Fuel',
      'Services',
    ]);
    expect(baseline.sampleSize).toBe(2);
    expect(baseline.aggregation).toBe('median');
    expect(baseline.meanMonthlyVariableOut).toBe(41.86);
  });

  it('passes baselineOptions through to the pure baseline', async () => {
    const tuned = await call('finance.spending_baseline', {
      baselineOptions: { aggregation: 'mean', excludeCategories: ['Gas and Fuel'] },
    });
    expect(tuned.aggregation).toBe('mean');
    expect(tuned.excluded.byCategory).toEqual([
      { category: 'Gas and Fuel', count: 1, total: 31.4 },
    ]);
    expect(tuned.avgMonthlyVariableOut).toBe(10.46);

    // Dropping the only complete month with data empties the baseline.
    const dropped = await call('finance.spending_baseline', {
      baselineOptions: { excludeMonths: ['2026-08'] },
    });
    expect(dropped.monthsUsed).toBe(0);
    expect(dropped.excluded.byMonth).toBeGreaterThan(0);

    // And the projection accepts the same options.
    const projected = await call('finance.project_cashflow', {
      horizonDays: 60,
      baselineOptions: { aggregation: 'mean', excludeCategories: ['Gas and Fuel'] },
    });
    expect(projected.baseline).toMatchObject({ aggregation: 'mean', avgMonthlyVariableOut: 10.46 });

    // A malformed month is refused by the schema, not silently ignored.
    const bad = await registry.invoke(
      'finance.spending_baseline',
      { baselineOptions: { excludeMonths: ['2026-13'] } },
      ctx,
    );
    expect(bad.ok).toBe(false);
  });

  it('folds the baseline burn into the projection by default, without daily rows', async () => {
    const plain = await call('finance.project_cashflow', {
      horizonDays: 60,
      includeBaseline: false,
    });
    const withBurn = await call('finance.project_cashflow', { horizonDays: 60 });

    expect(withBurn.includeBaseline).toBe(true);
    expect(withBurn.baseline).toMatchObject({ monthsUsed: 1, avgMonthlyVariableOut: 41.86 });
    expect(withBurn.baseline.dailyBurn).toBeCloseTo(1.38, 2);
    // The burn lowers every balance but never shows up as an event.
    expect(withBurn.endBalance).toBeLessThan(plain.endBalance);
    expect(withBurn.minBalance).toBeLessThan(plain.minBalance);
    expect(withBurn.days.length).toBe(plain.days.length);
    for (const day of withBurn.days) {
      for (const e of day.events) expect(e.name).not.toMatch(/baseline/i);
    }

    // p2p is left out by default; asking for the net changes the outcome.
    const netP2P = await call('finance.project_cashflow', {
      horizonDays: 60,
      includeP2P: 'net',
    });
    expect(netP2P.baseline.p2pNetMonthly).toBe(3000);
    expect(netP2P.endBalance).toBeGreaterThan(withBurn.endBalance);
  });

  it('stores debts apart from cash and reports utilization and net worth', async () => {
    const card = await call('finance.set_liability', {
      name: 'Test Mastercard',
      kind: 'credit_card',
      balance: 4000,
      creditLimit: 10_000,
      minimumPayment: 120,
      dueDay: 18,
      apr: 24,
      paidFrom: 'Checking',
    });
    expect(card).toMatchObject({
      kind: 'credit_card',
      balance: 4000,
      utilization: 40,
      paidFrom: 'Checking',
      apr: 24,
    });

    // Upsert by name: the same name updates rather than duplicating.
    await call('finance.set_liability', {
      name: 'test mastercard',
      kind: 'credit_card',
      balance: 3500,
      minimumPayment: 110,
      dueDay: 18,
    });
    await call('finance.set_liability', {
      name: 'Test Loan',
      kind: 'loan',
      balance: 12_000,
      minimumPayment: 400,
      dueDay: 26,
    });

    const listed = await call('finance.list_liabilities', {});
    expect(listed.count).toBe(2);
    expect(listed.totalDebt).toBe(15_500);
    expect(listed.totalMinimumPayments).toBe(510);
    // The credit limit survives an update that omits it.
    expect(listed.liabilities.find((l: { kind: string }) => l.kind === 'credit_card'))
      .toMatchObject({ creditLimit: 10_000, utilization: 35, apr: 24 });

    // Cash totals never net debt out; net worth is reported alongside.
    const accounts = await call('finance.list_accounts', {});
    expect(accounts.totalLiabilities).toBe(15_500);
    expect(accounts.netWorth).toBe(
      Math.round((accounts.total - 15_500) * 100) / 100,
    );
    expect(accounts.total).toBeGreaterThan(0);

    // The projection start balance ignores debts entirely.
    const projection = await call('finance.project_cashflow', {
      horizonDays: 10,
      includeBaseline: false,
    });
    expect(projection.startBalance).toBe(accounts.total);
  });

  it('estimates a payoff, and asks for the APR when it is missing', async () => {
    const estimate = await call('finance.payoff_estimate', {
      name: 'Test Mastercard',
      monthlyPayment: 300,
    });
    expect(estimate.status).toBe('ok');
    expect(estimate.months).toBeGreaterThan(12);
    expect(estimate.totalInterest).toBeGreaterThan(0);

    const missing = await call('finance.payoff_estimate', {
      name: 'Test Loan',
      monthlyPayment: 400,
    });
    expect(missing.status).toBe('missing-apr');
    expect(missing.message).toMatch(/APR/);

    const tooSmall = await call('finance.payoff_estimate', {
      name: 'Test Mastercard',
      monthlyPayment: 10,
    });
    expect(tooSmall.status).toBe('never-pays-off');

    expect(await call('finance.remove_liability', { name: 'Test Loan' })).toMatchObject({
      removed: 1,
    });
    expect((await call('finance.list_liabilities', {})).count).toBe(1);
    expect((await call('finance.list_liabilities', { activeOnly: false })).count).toBe(2);
    expect(await call('finance.remove_liability', { name: 'Test Loan' })).toMatchObject({
      removed: 0,
    });
  });

  it('refuses invalid arguments at the registry boundary', async () => {
    const bad = await registry.invoke(
      'finance.add_recurring',
      { kind: 'income', name: 'X', amount: -5, cadence: 'monthly', anchorDate: '2026-09-01' },
      ctx,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('invalid-args');
  });
});
