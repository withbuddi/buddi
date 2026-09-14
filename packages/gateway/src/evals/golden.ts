#!/usr/bin/env node
/**
 * The golden set — a regression test for the *prompts*, not the code.
 *
 * Everything here is real: the real catalog, the real tool registry, the real
 * delegation wiring, and the real provider with the credential from `.env`. A
 * scripted fake provider would test the harness and nothing else; what breaks
 * in practice is a persona edit that quietly stops the advisor projecting
 * before it answers, and only a real model can show that.
 *
 * The price of that is money and minutes, which is why this is gated behind an
 * explicit `pnpm eval` and never runs inside `pnpm test`. It is kept cheap on
 * purpose: eight questions against a nine-row fixture in a throwaway database,
 * asserting on the *shape of the run* — which tools were called, in what order,
 * with what arguments — rather than on the model's wording, which is allowed to
 * change. Where a case does assert on text it asserts on a number the fixture
 * fixes, or on a character that must never appear.
 *
 * The clock is pinned. Every date in an expectation is a date the fixture and
 * the pinned clock make deterministic.
 */
import path from 'node:path';
import {
  createPool,
  resolveProvider,
  runMigrations,
  type CatalogAgent,
  type ToolContext,
} from '@buddi/core';
import { createAnthropicProvider, createConversation, runAgent } from '@buddi/runtime';
import { config as loadDotenv } from 'dotenv';
import type { Pool } from 'pg';
import {
  createToolRegistry,
  installedManifests,
  loadGatewayCatalog,
  memoryPreambleFor,
  REPO_ROOT,
} from '../agents/catalog.js';
import { bindDelegation } from '../agents/delegation.js';

/** The instant every case runs at. A Sunday; "today" for every expectation. */
export const EVAL_NOW = new Date('2026-09-13T12:00:00Z');
export const EVAL_TIMEZONE = 'UTC';
export const OWNER_ID = 'owner';

/** What a surface that cannot render markdown tells the agent about itself. */
const PLAIN_TEXT_SUFFIX =
  'Surface: Telegram. Plain text only: no markdown, no bold, no headings, no tables, no code fences.';

/* ------------------------------------------------------------------ *
 * The fixture
 * ------------------------------------------------------------------ */

/**
 * Two accounts, four recurring items, two liabilities — small enough to hold
 * in your head, and chosen so every number an assertion looks for is unique:
 * cash totals 4600, debt totals 9200, and no pair of rows sums to either.
 */
export const FIXTURE_SQL = [
  `insert into finance.preferences (key, value) values
     ('currency', '"EUR"'::jsonb), ('safety_floor', '200'::jsonb)`,
  `insert into finance.accounts (name, kind, balance, balance_as_of) values
     ('Checking', 'cash', 1200, '2026-09-13'),
     ('Savings', 'savings', 3400, '2026-09-13')`,
  `insert into finance.recurring_items (kind, name, amount, cadence, anchor_date, account_id)
     select 'income', 'Salary', 2600, 'monthly', '2026-09-25', id from finance.accounts where name = 'Checking'`,
  `insert into finance.recurring_items (kind, name, amount, cadence, anchor_date, account_id)
     select 'charge', 'Rent', 1100, 'monthly', '2026-10-01', id from finance.accounts where name = 'Checking'`,
  `insert into finance.recurring_items (kind, name, amount, cadence, anchor_date, account_id)
     select 'charge', 'Internet', 45, 'monthly', '2026-09-18', id from finance.accounts where name = 'Checking'`,
  `insert into finance.recurring_items (kind, name, amount, cadence, anchor_date, account_id)
     select 'charge', 'Gym', 30, 'monthly', '2026-09-22', id from finance.accounts where name = 'Checking'`,
  `insert into finance.liabilities
     (name, kind, balance, credit_limit, minimum_payment, due_day, apr, statement_day)
   values ('Amex Gold', 'credit_card', 1200, 3000, 45, 20, 19.99, 15)`,
  `insert into finance.liabilities (name, kind, balance, minimum_payment, due_day, apr)
   values ('Car Loan', 'loan', 8000, 220, 5, 6.5)`,
];

/* ------------------------------------------------------------------ *
 * Case shape
 * ------------------------------------------------------------------ */

export interface ToolCall {
  name: string;
  input: any;
}

export interface TurnRecord {
  question: string;
  text: string;
  calls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
}

export interface GoldenCase {
  id: string;
  /** What regression this case exists to catch, in one line. */
  guards: string;
  agent: string;
  turns: { question: string; plainText?: boolean }[];
  /** Every failure, as a plain sentence. An empty array is a pass. */
  check(turns: TurnRecord[]): string[];
}

const called = (turn: TurnRecord | undefined, name: string): ToolCall[] =>
  (turn?.calls ?? []).filter((c) => c.name === name);

/** Digits only, so '4 600', '4,600' and '4600' all compare equal. */
const digits = (text: string): string => text.replace(/[\s,.]/g, '');

/* ------------------------------------------------------------------ *
 * The cases
 * ------------------------------------------------------------------ */

export const GOLDEN_CASES: GoldenCase[] = [
  {
    id: 'affordability-projects-first',
    guards:
      'An affordability question is answered from a projection with the purchase as a hypothetical.',
    agent: 'finance-advisor',
    turns: [{ question: 'Can I afford a 900 EUR laptop on 2026-09-25?' }],
    check([turn]) {
      const fails: string[] = [];
      const calls = called(turn, 'finance.project_cashflow');
      if (calls.length === 0) {
        fails.push('never called finance.project_cashflow');
        return fails;
      }
      const withHypothetical = calls.find(
        (c) => Array.isArray(c.input?.hypotheticals) && c.input.hypotheticals.length > 0,
      );
      if (!withHypothetical) {
        fails.push('projected without passing the purchase as a hypothetical');
      } else {
        const h = withHypothetical.input.hypotheticals[0];
        if (!(h.amount < 0)) fails.push(`hypothetical amount is not negative (${h.amount})`);
        if (h.date !== '2026-09-25') {
          fails.push(`hypothetical dated ${h.date}, expected 2026-09-25`);
        }
      }
      if (turn && turn.text.trim() === '') fails.push('answered with empty text');
      return fails;
    },
  },
  {
    id: 'new-date-new-projection',
    guards: 'A follow-up with a different date re-projects instead of reusing the first answer.',
    agent: 'finance-advisor',
    turns: [
      { question: 'Can I afford a 900 EUR laptop on 2026-09-25?' },
      { question: 'And if I wait until the 30th instead?' },
    ],
    check(turns) {
      const fails: string[] = [];
      const second = turns[1];
      const calls = called(second, 'finance.project_cashflow');
      if (calls.length === 0) {
        fails.push('the follow-up reused the first projection instead of running a new one');
        return fails;
      }
      const dates = calls.flatMap((c) =>
        (c.input?.hypotheticals ?? []).map((h: any) => String(h.date)),
      );
      if (!dates.includes('2026-09-30')) {
        fails.push(
          `the follow-up projected ${dates.join(', ') || 'no hypothetical'}, expected 2026-09-30`,
        );
      }
      return fails;
    },
  },
  {
    id: 'status-lists-liabilities',
    guards: 'A status reads the debts as well as the cash, each from its own tool.',
    agent: 'finance-advisor',
    turns: [{ question: 'Status — where do I stand?' }],
    check([turn]) {
      const fails: string[] = [];
      if (called(turn, 'finance.list_liabilities').length === 0) {
        fails.push('never called finance.list_liabilities');
      }
      if (called(turn, 'finance.list_accounts').length === 0) {
        fails.push('never called finance.list_accounts');
      }
      const text = turn?.text ?? '';
      if (!/amex/i.test(text)) fails.push('the status does not name the Amex Gold card');
      if (!/car loan/i.test(text)) fails.push('the status does not name the Car Loan');
      return fails;
    },
  },
  {
    id: 'stated-balance-is-recorded',
    guards: 'A balance the owner states is written to the ledger, not just acknowledged.',
    agent: 'finance-advisor',
    turns: [{ question: 'My checking account is at 1,450 EUR today.' }],
    check([turn]) {
      const fails: string[] = [];
      const calls = called(turn, 'finance.set_balance');
      if (calls.length === 0) {
        fails.push('never called finance.set_balance');
        return fails;
      }
      const call = calls[calls.length - 1] as ToolCall;
      if (!/check/i.test(String(call.input?.account ?? ''))) {
        fails.push(
          `set_balance named account "${call.input?.account}", expected the checking account`,
        );
      }
      if (Number(call.input?.balance) !== 1450) {
        fails.push(`set_balance recorded ${call.input?.balance}, expected 1450`);
      }
      return fails;
    },
  },
  {
    id: 'plain-text-has-no-markdown',
    guards: 'A plain-text surface hint suppresses every markdown character.',
    agent: 'finance-advisor',
    turns: [{ question: 'Give me a short overview of my accounts.', plainText: true }],
    check([turn]) {
      const fails: string[] = [];
      const text = turn?.text ?? '';
      if (text.includes('**')) fails.push('the reply contains ** (bold)');
      if (/^#{1,6}\s/m.test(text)) fails.push('the reply contains a # heading');
      if (text.includes('`')) fails.push('the reply contains a backtick');
      if (/^\s*\|.*\|/m.test(text)) fails.push('the reply contains a pipe table');
      return fails;
    },
  },
  {
    id: 'credit-question-delegates',
    guards:
      'A score question asked of the advisor is delegated to the credit coach, not answered in its voice.',
    agent: 'finance-advisor',
    turns: [
      {
        question:
          'Would paying 300 EUR on the Amex before its statement closes actually help my credit score?',
      },
    ],
    check([turn]) {
      const fails: string[] = [];
      const calls = called(turn, 'agent.delegate');
      if (calls.length === 0) {
        fails.push('never delegated; the advisor answered a credit-score question itself');
        return fails;
      }
      if (!calls.some((c) => String(c.input?.agent) === 'credit-coach')) {
        fails.push(
          `delegated to ${calls.map((c) => c.input?.agent).join(', ')}, expected credit-coach`,
        );
      }
      if (!/@credo/i.test(turn?.text ?? '')) {
        fails.push('the borrowed half is not attributed to @credo by handle');
      }
      return fails;
    },
  },
  {
    id: 'debt-is-never-cash',
    guards: 'A cash question reports cash only; liability balances never join the total.',
    agent: 'finance-advisor',
    turns: [{ question: 'How much cash do I have right now, in total?' }],
    check([turn]) {
      const fails: string[] = [];
      if (called(turn, 'finance.list_accounts').length === 0) {
        fails.push('never called finance.list_accounts');
      }
      const flat = digits(turn?.text ?? '');
      if (!flat.includes('4600')) fails.push('the reply does not state the 4600 cash total');
      if (flat.includes('13800')) fails.push('the reply adds the debts into the cash total (13800)');
      return fails;
    },
  },
  {
    id: 'no-tool-names-leak',
    guards: 'The owner never sees an internal dotted tool name.',
    agent: 'finance-advisor',
    turns: [{ question: 'What can you actually do for me? Keep it to three lines.' }],
    check([turn]) {
      const text = turn?.text ?? '';
      const leaked = text.match(/\b(?:finance|memory|artifacts|agent)\.[a-z_]+/g) ?? [];
      return leaked.length === 0
        ? []
        : [`the reply names its tools: ${[...new Set(leaked)].join(', ')}`];
    },
  },
];

/* ------------------------------------------------------------------ *
 * The runner
 * ------------------------------------------------------------------ */

export interface CaseResult {
  id: string;
  guards: string;
  failures: string[];
  inputTokens: number;
  outputTokens: number;
  ms: number;
  error?: string;
}

const ESC = '\u001b[';
const dim = (s: string): string => `${ESC}2m${s}${ESC}0m`;
const green = (s: string): string => `${ESC}32m${s}${ESC}0m`;
const red = (s: string): string => `${ESC}31m${s}${ESC}0m`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadDotenv({ path: path.join(REPO_ROOT, '.env') });

  const only = new Set(argv.filter((a) => !a.startsWith('-')));
  const cases = only.size === 0 ? GOLDEN_CASES : GOLDEN_CASES.filter((c) => only.has(c.id));
  if (cases.length === 0) {
    console.error(`no such case; known: ${GOLDEN_CASES.map((c) => c.id).join(', ')}`);
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set (cp .env.example .env, then pnpm db:up)');
    process.exit(1);
  }

  const registry = createToolRegistry();
  const catalog = loadGatewayCatalog({ env: process.env, registry });
  const resolution = resolveProvider(catalog.defaultAgent().provider, process.env);
  if (!resolution.ok) {
    console.error(
      `provider not usable [${resolution.problem.code}]: ${resolution.problem.message}\n` +
        'The golden set runs against the real provider on purpose. ' +
        'Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.',
    );
    process.exit(1);
  }
  const provider = createAnthropicProvider(resolution.provider);
  bindDelegation(registry, { catalog, provider });

  // A throwaway database, seeded from scratch: the golden set never reads or
  // writes the developer's own ledger, and every case starts from the same
  // nine rows however the previous one behaved.
  const dbName = `buddi_eval_${process.pid}`;
  const admin = createPool(databaseUrl);
  const url = new URL(databaseUrl);
  url.pathname = `/${dbName}`;
  let pool: Pool | undefined;
  const results: CaseResult[] = [];

  try {
    await admin.query(`drop database if exists ${dbName}`);
    await admin.query(`create database ${dbName}`);
    pool = createPool(url.toString());
    await runMigrations(pool, installedManifests());

    const now = (): Date => EVAL_NOW;
    const ctx: ToolContext = { db: pool, ownerId: OWNER_ID, now, timezone: EVAL_TIMEZONE };
    const memoryPreamble = memoryPreambleFor(pool);

    console.log(`golden set — ${cases.length} case(s)`);
    console.log(
      dim(
        `model: ${resolution.provider.model} (${resolution.provider.credentialKind}), ` +
          `db: ${dbName}, clock pinned to ${EVAL_NOW.toISOString()}`,
      ),
    );
    console.log('');

    for (const testCase of cases) {
      await reseed(pool);
      const started = Date.now();
      const result: CaseResult = {
        id: testCase.id,
        guards: testCase.guards,
        failures: [],
        inputTokens: 0,
        outputTokens: 0,
        ms: 0,
      };
      try {
        const selected: CatalogAgent = catalog.resolve(testCase.agent);
        const conversationId = await createConversation(pool, selected.id);
        const turns: TurnRecord[] = [];
        for (const turn of testCase.turns) {
          const calls: ToolCall[] = [];
          const run = await runAgent({
            agent: selected.definition(now(), EVAL_TIMEZONE),
            provider,
            registry,
            ctx,
            pool,
            conversationId,
            userMessage: turn.question,
            memoryPreamble,
            ...(turn.plainText ? { systemSuffix: PLAIN_TEXT_SUFFIX } : {}),
            onToolCall: (name, input) => calls.push({ name, input }),
          });
          turns.push({
            question: turn.question,
            text: run.text,
            calls,
            inputTokens: run.usage.input,
            outputTokens: run.usage.output,
          });
          result.inputTokens += run.usage.input;
          result.outputTokens += run.usage.output;
        }
        result.failures = testCase.check(turns);
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
        result.failures = [`threw: ${result.error}`];
      }
      result.ms = Date.now() - started;
      results.push(result);

      const ok = result.failures.length === 0;
      console.log(
        `${ok ? green('PASS') : red('FAIL')} ${testCase.id} ` +
          dim(`(${result.ms}ms, ${result.inputTokens} in / ${result.outputTokens} out)`),
      );
      if (!ok) {
        console.log(dim(`     guards: ${testCase.guards}`));
        for (const failure of result.failures) console.log(red(`     - ${failure}`));
      }
    }
  } finally {
    await pool?.end();
    try {
      await admin.query(`drop database if exists ${dbName}`);
    } catch {
      // A failed drop must never mask a real result.
    }
    await admin.end();
  }

  const passed = results.filter((r) => r.failures.length === 0).length;
  const inputTokens = results.reduce((s, r) => s + r.inputTokens, 0);
  const outputTokens = results.reduce((s, r) => s + r.outputTokens, 0);
  console.log('');
  console.log(`${passed}/${results.length} passed`);
  console.log(
    dim(`tokens: ${inputTokens} in, ${outputTokens} out, ${inputTokens + outputTokens} total`),
  );
  if (passed !== results.length) process.exit(1);
}

/** Back to the same nine rows, whatever the last case wrote. */
async function reseed(pool: Pool): Promise<void> {
  await pool.query(
    `truncate finance.payment_events, finance.import_stagings, finance.receipts,
              finance.transactions, finance.recurring_items, finance.liabilities,
              finance.accounts, finance.preferences,
              memory.notes, memory.preferences,
              core.messages, core.conversations restart identity cascade`,
  );
  for (const statement of FIXTURE_SQL) await pool.query(statement);
}

if (process.argv[1] && process.argv[1].endsWith('golden.js')) {
  main().catch((err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exit(1);
  });
}
