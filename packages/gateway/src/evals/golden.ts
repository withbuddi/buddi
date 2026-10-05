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
 *
 * `--provider openai` runs the same set against the scout agent, which is the
 * installation's proof that the RuntimeProvider port swaps. Scout has no
 * finance tools — that is the point of it — so most cases cannot run there.
 * They are **skipped and said out loud**, one line each with the reason: a
 * suite that quietly reported 8/8 on a provider that never touched a ledger
 * would be worse than no suite at all.
 */
import path from 'node:path';
import {
  createPool,
  resolveProvider,
  runMigrations,
  PROVIDER_KINDS,
  type CatalogAgent,
  type ProviderKind,
  type CoreToolContext,
  type PluginManifest,
} from '@buddi/core';
import { createConversation, createProvider, runAgent, type RuntimeProvider } from '@buddi/runtime';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import type { Pool } from 'pg';
import {
  createToolRegistry,
  installedManifests,
  loadGatewayCatalog,
  memoryPreambleFor,
  REPO_ROOT,
} from '../agents/catalog.js';
import { bindDelegation } from '../agents/delegation.js';
import { bindOwnerTools } from '../agents/owner-tools.js';
import { systemContext } from '../system-context.js';

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
  /**
   * Which providers this case can run against. Defaulting to anthropic alone is
   * the honest default: every case below reads the owner's ledger, and only an
   * agent with finance tools can. A case that lists `openai` runs against the
   * scout agent instead (see `OPENAI_AGENT`).
   */
  providers?: readonly ProviderKind[];
  turns: { question: string; plainText?: boolean }[];
  /**
   * Canned answers for tools whose real answer depends on this machine (a
   * paired browser), so the case reads the same everywhere. The call is still
   * recorded; the tool itself never runs.
   */
  stubs?: Record<string, unknown>;
  /** The grant the case runs with, from the agent's own (a case about an agent shaped like Home Manager). */
  tools?: (granted: readonly string[]) => string[];
  /**
   * Stand-in plugins registered for this case only, for a plugin this build
   * does not compile in (the calendar lives in buddi-plugins). Each answers
   * the way the real one does for the situation the case pins.
   */
  manifests?: () => PluginManifest[];
  /** SQL run after the shared fixture, for a case that needs the owner in a given state. */
  seed?: readonly string[];
  /** Every failure, as a plain sentence. An empty array is a pass. */
  check(turns: TurnRecord[]): string[];
}

/** The agent `--provider openai` routes to: the one pinned to that provider. */
export const OPENAI_AGENT = 'scout';

/** Providers a case runs against when it does not say. */
export const DEFAULT_CASE_PROVIDERS: readonly ProviderKind[] = ['anthropic'];

export function casesFor(
  provider: ProviderKind,
  cases: readonly GoldenCase[] = GOLDEN_CASES,
): { run: GoldenCase[]; skipped: { id: string; why: string }[] } {
  const run: GoldenCase[] = [];
  const skipped: { id: string; why: string }[] = [];
  for (const testCase of cases) {
    const providers = testCase.providers ?? DEFAULT_CASE_PROVIDERS;
    if (providers.includes(provider)) run.push(testCase);
    else {
      skipped.push({
        id: testCase.id,
        why:
          provider === 'openai'
            ? `needs the finance tools, which @${OPENAI_AGENT} (openai) does not have`
            : `is an ${providers.join('/')} case`,
      });
    }
  }
  return { run, skipped };
}

/** The agent a case runs as, for the provider it is running under. */
export function agentFor(testCase: GoldenCase, provider: ProviderKind): string {
  return provider === 'openai' ? OPENAI_AGENT : testCase.agent;
}

const called = (turn: TurnRecord | undefined, name: string): ToolCall[] =>
  (turn?.calls ?? []).filter((c) => c.name === name);

/** Digits only, so '4 600', '4,600' and '4600' all compare equal. */
const digits = (text: string): string => text.replace(/[\s,.]/g, '');

/* ------------------------------------------------------------------ *
 * The cases
 * ------------------------------------------------------------------ */

/** "Your browser" mode, the extension connected and idle. */
const PAIRED_BROWSER = {
  mode: 'extension',
  settings: { mode: 'extension', browserApp: 'Google Chrome', allowedApps: [] },
  state: 'idle',
  enabled: true,
  busy: false,
  hasScreenshot: false,
};
/** "Your browser" mode with the extension not connected. */
const UNPAIRED_BROWSER = {
  ...PAIRED_BROWSER,
  state: 'unavailable',
  enabled: false,
  message: 'Your browser is not connected: pair the buddi extension in Settings → Browser.',
};
const NO_ACCESS = /(?:no|don't have|do not have|cannot get) access to your amazon/i;
const OPEN_IT_YOURSELF = /open the amazon (?:app|site|website) (?:yourself|and)/i;

/**
 * The calendar plugin as an owner with one calendar agents may change sees
 * it: "Home" (Google) writable, "Holidays" read through a private link. The
 * create answers as the real tool does — a refusal naming the calendars agents
 * may change, or the approval card waiting — without writing anywhere.
 */
export const ONE_WRITABLE_CALENDAR = 'Home';
export function oneCalendarManifest(): PluginManifest {
  const create = {
    name: 'calendar.create_event',
    description:
      'Add an event to one of the owner’s calendars that allows changes. The owner approves it on a card first. Times are the ' +
      'owner’s unless a timezone is given; an end or a duration in minutes (an hour when neither).',
    tier: 'auto' as const,
    input: z.object({
      calendar: z.string().describe('The calendar’s name (or id), one the owner allows changes on.'),
      title: z.string(),
      start: z.string().describe('YYYY-MM-DDTHH:MM in the owner’s time.'),
      end: z.string().optional(),
      duration: z.number().int().optional().describe('Minutes, when no end is given.'),
      location: z.string().optional(),
      notes: z.string().optional(),
    }),
    async execute(input: { calendar: string }) {
      if (input.calendar.trim().toLowerCase() !== ONE_WRITABLE_CALENDAR.toLowerCase()) {
        return { refused: `There is no calendar called ${input.calendar} that allows changes. Agents may change: ${ONE_WRITABLE_CALENDAR}.` };
      }
      return { pending: true, message: 'The owner has an approval card for this event; it is added when they approve.' };
    },
  };
  const today = {
    name: 'calendar.today',
    description: "Today's events from the owner's linked calendars, in their time.",
    tier: 'auto' as const,
    input: z.object({}),
    async execute() {
      return { date: 'Sunday (2026-09-13)', events: ['No events today.'], calendars: [
        { name: ONE_WRITABLE_CALENDAR, account: 'Google', changesAllowed: true },
        { name: 'Holidays', account: 'private link', changesAllowed: false },
      ] };
    },
  };
  return { name: 'calendar', version: '0.0.0-eval', schema: 'core', migrationsDir: '', tools: [create, today] } as unknown as PluginManifest;
}

/** The minutes an event the agent asked for lasts, from `duration` or `start`/`end`. */
export function minutesOf(input: { start?: string; end?: string; duration?: number } | undefined): number | null {
  if (!input) return null;
  if (typeof input.duration === 'number') return input.duration;
  if (input.start && input.end) {
    const ms = Date.parse(`${input.end.slice(0, 16)}:00Z`) - Date.parse(`${input.start.slice(0, 16)}:00Z`);
    return Number.isFinite(ms) ? Math.round(ms / 60_000) : null;
  }
  return null;
}

/** The owner of the profile case: a name and a zone, no full name, the first run behind them. */
export const PROFILE_CASE_NAME = 'Samuel Okafor';
export const PROFILE_CASE_SEED = [
  `insert into core.owner (id, preferred_name, timezone) values ('owner', 'Sam', 'UTC')
   on conflict (id) do update set preferred_name = 'Sam', timezone = 'UTC', full_name = null`,
  `insert into core.onboarding (owner_id, state, started_at, completed_at, surface)
   values ('owner', 'done', now(), now(), 'web')
   on conflict (owner_id) do update set state = 'done', completed_at = now()`,
  `delete from core.owner_places`,
];
const ASKS_FULL_NAME = /full name|your (?:last|sur)name|name (?:should|to) (?:i )?(?:sign|put)|sign (?:it|off) (?:with|as)/i;
const questions = (text: string): number => (text.match(/\?/g) ?? []).length;

const ASKS_WHICH_CALENDAR = /which calendar|what calendar|which of your calendars/i;
const STATES_TWO_HOURS = /\b(?:2|two)[ -]?(?:hours?|h)\b|2-hour|two-hour/i;

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
    // The only case that needs no ledger, so the only one the scout agent can
    // answer as well. It is also the rule most likely to differ between
    // providers, which makes it worth running on both.
    providers: ['anthropic', 'openai'],
    turns: [{ question: 'What can you actually do for me? Keep it to three lines.' }],
    check([turn]) {
      const text = turn?.text ?? '';
      const leaked = text.match(/\b(?:finance|memory|artifacts|agent)\.[a-z_]+/g) ?? [];
      return leaked.length === 0
        ? []
        : [`the reply names its tools: ${[...new Set(leaked)].join(', ')}`];
    },
  },
  {
    id: 'scout-names-its-provider-and-its-limits',
    guards:
      'The second-provider agent says it runs elsewhere and refuses to answer a money question.',
    agent: OPENAI_AGENT,
    providers: ['openai'],
    turns: [
      {
        question:
          'Which AI company answers me when I talk to you, and how much cash do I have right now?',
      },
    ],
    check([turn]) {
      const fails: string[] = [];
      const text = turn?.text ?? '';
      if (turn && text.trim() === '') return ['answered with empty text'];
      if (!/openai|gpt|different (ai )?provider|another provider/i.test(text)) {
        fails.push('does not say plainly that it runs on a different provider');
      }
      if (called(turn, 'finance.list_accounts').length > 0) {
        fails.push('called a finance tool it should not have been granted');
      }
      if (digits(text).includes('4600')) {
        fails.push('stated a cash total it has no tool to read');
      }
      if (!/advisor|ledger|finance/i.test(text)) {
        fails.push('does not hand the money half to the agent that owns it');
      }
      return fails;
    },
  },
  {
    id: 'website-question-tries-the-browser',
    guards:
      'With a browser paired, a question about a website account (an Amazon cart) is looked up with the browser, or handed to a colleague, never answered with "no access".',
    agent: 'finance-advisor',
    tools: (granted) => [...granted.filter((t) => !t.startsWith('finance.')), 'browser.status', 'browser.act'],
    stubs: {
      'browser.status': PAIRED_BROWSER,
      'browser.act': { pending: true, message: 'The owner has a card to approve this browser session; wait for it.' },
    },
    turns: [{ question: 'Can you check my Amazon cart?' }],
    check([turn]) {
      const fails: string[] = [];
      if (called(turn, 'browser.act').length === 0 && called(turn, 'agent.delegate').length === 0) {
        fails.push('neither looked with the browser nor delegated');
      }
      if (NO_ACCESS.test(turn?.text ?? '')) fails.push('told the owner it has no access while a browser is paired');
      if (OPEN_IT_YOURSELF.test(turn?.text ?? '')) fails.push('told the owner to open the app or site themselves');
      return fails;
    },
  },
  {
    id: 'website-question-without-a-browser-offers-pairing',
    guards: 'With no browser paired, the same question says what is missing and offers pairing, in one concrete step.',
    agent: 'finance-advisor',
    tools: (granted) => [...granted.filter((t) => !t.startsWith('finance.')), 'browser.status', 'browser.act'],
    stubs: { 'browser.status': UNPAIRED_BROWSER },
    turns: [{ question: 'Can you check my Amazon cart?' }],
    check([turn]) {
      const text = turn?.text ?? '';
      const fails: string[] = [];
      if (called(turn, 'browser.status').length === 0) fails.push('never checked whether a browser is available');
      if (!/pair|connect|extension|settings/i.test(text)) fails.push('does not offer pairing a browser as the next step');
      return fails;
    },
  },
  {
    id: 'one-writable-calendar-is-taken',
    guards:
      'With exactly one calendar agents may change, "add dinner with X at Y tonight" goes straight to the approval card on it, ' +
      'never asks which calendar, and states the 2-hour default it chose.',
    agent: 'finance-advisor',
    tools: (granted) => [...granted.filter((t) => !t.startsWith('finance.')), 'calendar.today', 'calendar.create_event'],
    manifests: () => [oneCalendarManifest()],
    turns: [{ question: 'Add dinner with Marion at Chez Léon tonight at 19:30.' }],
    check([turn]) {
      const text = turn?.text ?? '';
      const fails: string[] = [];
      const creates = called(turn, 'calendar.create_event');
      const landed = creates.find((c) => String(c.input?.calendar ?? '').toLowerCase() === ONE_WRITABLE_CALENDAR.toLowerCase());
      if (!landed) fails.push(`never asked to add the event to ${ONE_WRITABLE_CALENDAR}, the one calendar agents may change`);
      if (ASKS_WHICH_CALENDAR.test(text)) fails.push('asked which calendar when only one allows changes');
      if (landed && minutesOf(landed.input) !== 120) fails.push(`gave the dinner ${minutesOf(landed.input) ?? 'no'} minutes, not the 2-hour default`);
      if (!STATES_TWO_HOURS.test(text) && !/21[:.]30|9[:.]30\s*pm/i.test(text)) fails.push('did not state the 2-hour default (or the end time) it chose');
      return fails;
    },
  },
  {
    id: 'one-writable-field-asked-once',
    guards:
      'A letter needs the full name the profile lacks: the front desk asks once, one question, records the answer with ' +
      'owner.set_profile, signs with it, and never asks again for the next letter.',
    agent: 'concierge',
    seed: PROFILE_CASE_SEED,
    turns: [
      { question: "Write a short letter to my landlord saying I'll be away for all of November." },
      { question: PROFILE_CASE_NAME },
      { question: 'Thanks. Now a two-line note to my bank saying the same.' },
    ],
    check([ask, answer, again]) {
      const fails: string[] = [];
      const setsName = (turn: TurnRecord | undefined) =>
        called(turn, 'owner.set_profile').filter((c) => typeof c.input?.fullName === 'string');
      if (!ASKS_FULL_NAME.test(ask?.text ?? '')) fails.push('did not ask for the full name the letter needs');
      if (questions(ask?.text ?? '') > 1) fails.push('asked more than one question at once');
      if (setsName(ask).length > 0) fails.push('recorded a full name the owner had not said');
      const recorded = setsName(answer);
      if (recorded.length === 0) fails.push('never recorded the full name once the owner said it');
      else if (String(recorded[0]!.input.fullName).trim() !== PROFILE_CASE_NAME) fails.push(`recorded "${recorded[0]!.input.fullName}", not what the owner said`);
      if (!(answer?.text ?? '').includes(PROFILE_CASE_NAME)) fails.push('did not sign the letter with the full name');
      if (ASKS_FULL_NAME.test(again?.text ?? '')) fails.push('asked for the full name a second time');
      if (!(again?.text ?? '').includes(PROFILE_CASE_NAME)) fails.push('did not use the recorded full name in the next note');
      return fails;
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
const yellow = (s: string): string => `${ESC}33m${s}${ESC}0m`;
const dim = (s: string): string => `${ESC}2m${s}${ESC}0m`;
const green = (s: string): string => `${ESC}32m${s}${ESC}0m`;
const red = (s: string): string => `${ESC}31m${s}${ESC}0m`;

/** `--provider <kind>` and bare case ids. Anything else is a usage error. */
export function parseEvalArgs(argv: string[]): { provider: ProviderKind; only: Set<string> } {
  let provider: ProviderKind = 'anthropic';
  const only = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--provider') {
      const value = argv[++i];
      if (!value || !PROVIDER_KINDS.includes(value as ProviderKind)) {
        throw new Error(`--provider needs one of: ${PROVIDER_KINDS.join(', ')}`);
      }
      provider = value as ProviderKind;
    } else if (arg.startsWith('--provider=')) {
      const value = arg.slice('--provider='.length);
      if (!PROVIDER_KINDS.includes(value as ProviderKind)) {
        throw new Error(`--provider needs one of: ${PROVIDER_KINDS.join(', ')}`);
      }
      provider = value as ProviderKind;
    } else if (arg === '--') {
      continue;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      only.add(arg);
    }
  }
  return { provider, only };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadDotenv({ path: path.join(REPO_ROOT, '.env') });

  let parsed: { provider: ProviderKind; only: Set<string> };
  try {
    parsed = parseEvalArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const { provider: providerKind, only } = parsed;

  const selection = only.size === 0 ? GOLDEN_CASES : GOLDEN_CASES.filter((c) => only.has(c.id));
  if (selection.length === 0) {
    console.error(`no such case; known: ${GOLDEN_CASES.map((c) => c.id).join(', ')}`);
    process.exit(1);
  }
  const { run: cases, skipped } = casesFor(providerKind, selection);
  if (cases.length === 0 && skipped.length === 0) {
    console.error('nothing to run');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set (cp .env.example .env, then pnpm db:up)');
    process.exit(1);
  }

  const registry = createToolRegistry();
  const catalog = loadGatewayCatalog({ env: process.env, registry });

  /**
   * One adapter per agent, from that agent's own pinned ref. The suite never
   * substitutes a provider for another: a case routed to an agent whose
   * credential is absent stops, with the variable named.
   */
  const adapters = new Map<string, RuntimeProvider>();
  const providerFor = (agent: CatalogAgent): RuntimeProvider => {
    const cached = adapters.get(agent.id);
    if (cached) return cached;
    const resolution = resolveProvider(agent.provider, process.env);
    if (!resolution.ok) {
      console.error(
        `@${agent.handle} cannot run [${resolution.problem.code}]: ${resolution.problem.message}\n` +
          'The golden set runs against the real provider on purpose.',
      );
      process.exit(1);
    }
    const built = createProvider(resolution.provider);
    adapters.set(agent.id, built);
    return built;
  };

  // The agent every case in this run routes to decides which credential must be
  // present; resolve it now so a missing key fails before a database is made.
  const leadAgent = catalog.resolve(
    providerKind === 'openai' ? OPENAI_AGENT : catalog.defaultAgent().id,
  );
  const leadProvider = providerFor(leadAgent);
  const leadResolution = resolveProvider(leadAgent.provider, process.env);
  bindDelegation(registry, {
    catalog,
    provider: leadProvider,
    providerFor: ({ id }) => {
      const target = catalog.get(id);
      return target ? providerFor(target) : leadProvider;
    },
  });
  bindOwnerTools(registry, { catalog });

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
    const base: CoreToolContext = { db: pool, ownerId: OWNER_ID, now, timezone: EVAL_TIMEZONE };
    // The shared context every agent gets in production, rules included.
    const ctx: CoreToolContext = { ...base, systemContext: (run) => systemContext(base, run) };
    const memoryPreamble = memoryPreambleFor(pool);

    console.log(
      `golden set — ${cases.length} case(s) on ${providerKind}` +
        (skipped.length > 0 ? `, ${skipped.length} skipped` : ''),
    );
    console.log(
      dim(
        `provider: ${providerKind}, model: ${leadResolution.ok ? leadResolution.provider.model : '?'} ` +
          `(${leadResolution.ok ? leadResolution.provider.credentialKind : '?'}), ` +
          `db: ${dbName}, clock pinned to ${EVAL_NOW.toISOString()}`,
      ),
    );
    // Said out loud, never silently counted as a pass.
    for (const { id, why } of skipped) {
      console.log(`${yellow('SKIP')} ${id} ${dim(`— ${why}`)}`);
    }
    console.log('');

    /** Stand-in plugins the case in hand registered, taken out after it. */
    const standIns: string[] = [];
    for (const testCase of cases) {
      await reseed(pool);
      for (const statement of testCase.seed ?? []) await pool.query(statement);
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
        const selected: CatalogAgent = catalog.resolve(agentFor(testCase, providerKind));
        const conversationId = await createConversation(pool, selected.id);
        for (const manifest of testCase.manifests?.() ?? []) {
          registry.register(manifest);
          standIns.push(manifest.name);
        }
        const turns: TurnRecord[] = [];
        for (const turn of testCase.turns) {
          const calls: ToolCall[] = [];
          const definition = selected.definition(now(), EVAL_TIMEZONE);
          const run = await runAgent({
            agent: testCase.tools ? { ...definition, tools: testCase.tools(definition.tools) } : definition,
            provider: providerFor(selected),
            registry: testCase.stubs ? stubbed(registry, testCase.stubs) : registry,
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
      } finally {
        for (const name of standIns.splice(0)) registry.unregister(name);
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
  console.log(
    `${passed}/${results.length} passed on ${providerKind}` +
      (skipped.length > 0
        ? `, ${skipped.length} skipped (${skipped.map((s) => s.id).join(', ')})`
        : ''),
  );
  console.log(
    dim(`tokens: ${inputTokens} in, ${outputTokens} out, ${inputTokens + outputTokens} total`),
  );
  if (passed !== results.length) process.exit(1);
}

/** The registry with some tools answering from the case instead of this machine. */
export function stubbed<R extends { invoke: (...args: any[]) => Promise<unknown> }>(registry: R, stubs: Record<string, unknown>): R {
  return new Proxy(registry, {
    get(target, prop, receiver) {
      if (prop === 'invoke') {
        return async (name: string, ...rest: unknown[]) =>
          Object.prototype.hasOwnProperty.call(stubs, name) ? stubs[name] : target.invoke(name, ...rest);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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
