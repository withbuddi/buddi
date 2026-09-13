/**
 * @buddi/tool-finance — the read-only finance plugin.
 *
 * Every tool is a read over plugin-owned data or a pure computation, so the
 * whole family is tier `auto`: it ships before the approval machinery exists.
 * The plugin owns the `finance` Postgres schema and ships its own migrations;
 * core never references these tables.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@buddi/core';
import { listAccounts, setBalance } from './tools/accounts.js';
import { spendingBaseline } from './tools/baseline.js';
import { projectCashflow } from './tools/cashflow.js';
import {
  listLiabilities,
  payoffEstimate,
  removeLiability,
  setLiability,
} from './tools/liabilities.js';
import { getPreferences, setPreferences } from './tools/preferences.js';
import { addRecurring, listRecurring, removeRecurring } from './tools/recurring.js';
import { importCsv, recordTransaction, summary } from './tools/transactions.js';

/** Absolute path to this plugin's migrations, resolved from the built file. */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export const manifest: PluginManifest = {
  name: 'finance',
  version: '0.1.0',
  schema: 'finance',
  migrationsDir: MIGRATIONS_DIR,
  tools: [
    setPreferences,
    getPreferences,
    setBalance,
    listAccounts,
    addRecurring,
    listRecurring,
    removeRecurring,
    recordTransaction,
    importCsv,
    summary,
    spendingBaseline,
    projectCashflow,
    setLiability,
    listLiabilities,
    removeLiability,
    payoffEstimate,
  ],
};

export default manifest;

export {
  setPreferences,
  getPreferences,
  setBalance,
  listAccounts,
  addRecurring,
  listRecurring,
  removeRecurring,
  recordTransaction,
  importCsv,
  summary,
  spendingBaseline,
  projectCashflow,
  setLiability,
  listLiabilities,
  removeLiability,
  payoffEstimate,
};

export * from './projection.js';
export * from './baseline.js';
export * from './amortization.js';
export * from './csv.js';
