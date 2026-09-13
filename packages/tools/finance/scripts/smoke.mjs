#!/usr/bin/env node
/**
 * End-to-end smoke test for the finance plugin against a real Postgres.
 *
 *   pnpm db:up && pnpm db:migrate && pnpm -r build
 *   node packages/tools/finance/scripts/smoke.mjs
 *
 * Registers the plugin manifest in a real ToolRegistry and drives it exactly
 * the way the agent will: every call goes through registry.invoke(), so tier
 * and argument validation are exercised too. It cleans up its own rows and
 * restores the preferences it touched.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

// Minimal .env loader: this package does not depend on dotenv.
try {
  for (const line of readFileSync(path.join(repoRoot, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env: rely on the ambient environment */
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}

const { createPool, ToolRegistry } = await import('@buddi/core');
const { manifest } = await import('../dist/index.js');

const ACCOUNT = 'Smoke Checking';
const ITEMS = ['Smoke Salary', 'Smoke Rent', 'Smoke Streaming'];

const registry = new ToolRegistry();
registry.register(manifest);

const pool = createPool(databaseUrl);
const ctx = {
  db: pool,
  ownerId: 'smoke',
  // Fixed clock so the projection is reproducible.
  now: () => new Date('2026-09-13T12:00:00Z'),
};

async function call(name, args) {
  const result = await registry.invoke(name, args, ctx);
  if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
  return result.output;
}

function show(label, value) {
  console.log(`\n--- ${label}\n${JSON.stringify(value, null, 2)}`);
}

async function cleanup() {
  await pool.query(
    `delete from finance.transactions where account_id in
       (select id from finance.accounts where name = $1)`,
    [ACCOUNT],
  );
  await pool.query(`delete from finance.recurring_items where name = any($1::text[])`, [ITEMS]);
  await pool.query(`delete from finance.accounts where name = $1`, [ACCOUNT]);
}

try {
  console.log(`tools registered: ${registry.list().map((t) => t.name).join(', ')}`);
  await cleanup();

  const { rows: savedPrefs } = await pool.query(`select key, value from finance.preferences`);

  await call('finance.set_preferences', { currency: 'EUR', safetyFloor: 200 });
  show('finance.get_preferences', await call('finance.get_preferences', {}));

  show(
    'finance.set_balance',
    await call('finance.set_balance', {
      account: ACCOUNT,
      balance: 900,
      asOf: '2026-09-13',
    }),
  );

  for (const item of [
    { kind: 'income', name: 'Smoke Salary', amount: 3200, cadence: 'monthly', anchorDate: '2026-09-28', category: 'salary' },
    { kind: 'charge', name: 'Smoke Rent', amount: 1200, cadence: 'monthly', anchorDate: '2026-10-01', category: 'housing' },
    { kind: 'charge', name: 'Smoke Streaming', amount: 40, cadence: 'monthly', anchorDate: '2026-09-15', category: 'subscriptions' },
  ]) {
    await call('finance.add_recurring', { ...item, account: ACCOUNT });
  }
  show('finance.list_recurring', await call('finance.list_recurring', {}));

  const baseline = await call('finance.project_cashflow', {
    horizonDays: 60,
    account: ACCOUNT,
  });
  show('finance.project_cashflow — 60 days, no hypothetical', baseline);

  const whatIf = await call('finance.project_cashflow', {
    horizonDays: 60,
    account: ACCOUNT,
    hypotheticals: [{ name: 'Considered purchase', amount: -800, date: '2026-09-20' }],
  });
  show('finance.project_cashflow — 60 days, with an 800 purchase on 2026-09-20', whatIf);

  console.log(
    `\nverdict: without the purchase min ${baseline.minBalance} on ${baseline.minBalanceDate} ` +
      `(breaches floor: ${baseline.breachesFloor}); with it min ${whatIf.minBalance} on ` +
      `${whatIf.minBalanceDate} (breaches floor: ${whatIf.breachesFloor}` +
      `${whatIf.firstBreachDate ? `, first on ${whatIf.firstBreachDate}` : ''}).`,
  );

  await cleanup();
  await pool.query(`delete from finance.preferences where key in ('currency', 'safety_floor')`);
  for (const row of savedPrefs) {
    await pool.query(
      `insert into finance.preferences (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [row.key, JSON.stringify(row.value)],
    );
  }
  console.log('\ncleanup: smoke rows removed, preferences restored');
} finally {
  await pool.end();
}
