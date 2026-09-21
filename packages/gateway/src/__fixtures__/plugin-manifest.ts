/**
 * A plugin manifest for the in-process suites — a fixture, never a built-in.
 *
 * The mission machinery, the registry and the approval path all need *a*
 * domain plugin to be exercised: something with a family of its own, a tool
 * that changes the world and therefore needs an approval, and the richest set
 * of suggested missions anybody ships — a recap that always delivers, a daily
 * check that stays silent unless it decides otherwise, and a placeholder
 * registered disabled.
 *
 * That used to be `@buddi/tool-finance`, imported from the tree. Finance is now
 * a plugin like any other and lives in its own repository, so the suites that
 * asserted what the platform does with a manifest — never that this build has
 * finance — get one here instead. Nothing in it touches the database: it owns
 * no schema and ships no migrations, which is what `migrationsDir: ''` says.
 */
import { z } from 'zod';
import type { PluginManifest, Sentinel, SuggestedMission } from '@buddi/core';

export const LEDGER_RECAP_ID = 'friday-recap';
export const LEDGER_RECAP_CRON = '0 8 * * FRI';
export const LEDGER_RECAP_PROMPT = `Produce the weekly recap. Use the ledger tools for every number; never do the arithmetic yourself.

1. Cash: total across accounts, per account if there are several. If any liability is recorded, add total debt and net worth (cash minus debt).
2. Due in the next 14 days: each charge and income with its date and amount.
3. 60-day projection: the minimum projected balance and the exact date it happens, the first floor breach if there is one, and whether the safety floor holds.
4. What changed since last week, if the tools can tell.
5. One concrete recommendation, in a single line.

Keep the whole message under 1500 characters, plain text, no markdown.`;

export const LEDGER_CHECK_ID = 'daily-check';
export const LEDGER_CHECK_CRON = '0 8 * * *';
export const LEDGER_CHECK_PROMPT = `Run the daily check. Use the ledger tools for every number; never do the arithmetic yourself.

1. Project the balance over the next 30 days and note the minimum and its date.
2. List everything due in the next 3 days, with dates and amounts.
3. List anything still unmatched, if the tools can tell you.

Then decide, and stay silent unless something is genuinely urgent — the projection breaching the floor within 7 days, or a payment due within 3 days with nothing recorded against it.

If none of that is true, call mission.silent with the one-line reason. If something is urgent, call mission.report with urgency 'urgent', at most 600 characters, plain text, and exactly one recommended action.`;

export const LEDGER_CONSOLIDATION_ID = 'weekly-consolidation';
export const LEDGER_CONSOLIDATION_CRON = '0 20 * * SUN';

/** A recap, a watcher, and a placeholder that ships disabled. */
export const fixtureMissions: SuggestedMission[] = [
  {
    id: LEDGER_RECAP_ID,
    name: 'Friday recap',
    agentRole: 'recap',
    cron: LEDGER_RECAP_CRON,
    misfirePolicy: 'coalesce',
    prompt: LEDGER_RECAP_PROMPT,
    alwaysDeliver: true,
  },
  {
    id: LEDGER_CHECK_ID,
    name: 'Daily check',
    agentRole: 'overview',
    cron: LEDGER_CHECK_CRON,
    misfirePolicy: 'coalesce',
    prompt: LEDGER_CHECK_PROMPT,
    alwaysDeliver: false,
  },
  {
    id: LEDGER_CONSOLIDATION_ID,
    name: 'Weekly consolidation',
    agentRole: 'overview',
    cron: LEDGER_CONSOLIDATION_CRON,
    misfirePolicy: 'coalesce',
    prompt: 'Placeholder. Consolidate the week, then stay silent (mission.silent) unless it found something the owner must act on.',
    alwaysDeliver: false,
    enabledByDefault: false,
  },
];

/** One watch, so a manifest with sentinels is in play where one is needed. */
export const fixtureSentinels: Sentinel[] = [
  {
    id: 'ledger.floor-breach',
    description: 'Would say when the projected balance breaks the floor.',
    every: 3600,
    async run() {
      return [];
    },
  },
];

/**
 * The manifest. One `auto` read and one `gated` write, because a plugin with
 * nothing gated never reaches the approval machinery these suites exercise.
 */
export const fixturePluginManifest: PluginManifest & {
  sentinels: NonNullable<PluginManifest['sentinels']>;
} = {
  name: 'ledger',
  version: '0.1.0',
  description: 'A fixture plugin: a small ledger, for the suites.',
  schema: '',
  migrationsDir: '',
  tools: [
    {
      name: 'ledger.balance',
      description: 'The current balance. Reads its own data and writes nothing.',
      tier: 'auto',
      input: z.object({}).strict(),
      async execute() {
        return { balance: 1200, currency: 'EUR' };
      },
    },
    {
      name: 'ledger.pay',
      description: 'Pays a bill. Moves money outside this machine, so it is gated.',
      tier: 'gated',
      input: z.object({ payee: z.string().min(1), amount: z.number().positive() }).strict(),
      describe(input) {
        return {
          envelope: { payee: input.payee, amount: input.amount, currency: 'EUR' },
          preview: `Pay ${input.amount} EUR to ${input.payee}.`,
        };
      },
      async execute(input) {
        return { paid: input.amount, payee: input.payee };
      },
    },
  ],
  sentinels: fixtureSentinels,
  missions: fixtureMissions,
};

export default fixturePluginManifest;
