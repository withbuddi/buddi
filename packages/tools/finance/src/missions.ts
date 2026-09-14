/**
 * The scheduled missions this plugin suggests.
 *
 * A default mission is domain knowledge: "every Friday, recap the week" only
 * means something because the finance tools exist, so it ships with them rather
 * than with the gateway. Nothing here is installed by importing the plugin —
 * `buddi missions add-defaults` is the owner accepting the suggestion.
 *
 * The agent is named by role, never by id: this installation gives
 * `finance-advisor` the `overview` and `recap` roles, and another installation
 * can hand them to a different agent without touching this file.
 */
import type { SuggestedMission } from '@buddi/core';

export const FRIDAY_RECAP_ID = 'friday-recap';
export const FRIDAY_RECAP_CRON = '0 8 * * FRI';
export const FRIDAY_RECAP_PROMPT = `Produce the weekly recap. Use the finance tools for every number; never do the arithmetic yourself.

1. Cash: total across accounts, per account if there are several. If any liability is recorded, add total debt and net worth (cash minus debt).
2. Due in the next 14 days: each charge and income with its date and amount.
3. 60-day projection: the minimum projected balance and the exact date it happens, the first floor breach if there is one, and whether the safety floor holds. If no safety floor is set, say so in one line.
4. What changed since last week, if the tools can tell: this month's spending summary against the previous month's.
5. One concrete recommendation, in a single line.

Keep the whole message under 1500 characters, plain text, no markdown.`;

export const DAILY_CHECK_ID = 'daily-check';
export const DAILY_CHECK_CRON = '0 8 * * *';
export const DAILY_CHECK_PROMPT = `Run the daily check. Use the finance tools for every number; never do the arithmetic yourself.

1. Project the cashflow over the next 30 days and note the minimum balance and its date.
2. List everything due in the next 3 days — charges and income, with dates and amounts.
3. List receipts or imported transactions that are still unmatched, if the tools can tell you.

Then decide, and stay silent unless something is genuinely urgent. Urgent means one of:
- the projection breaches the safety floor within 7 days;
- a minimum payment or a charge falls due within 3 days with no payment recorded;
- an account balance is already below the floor.

If none of that is true, call mission.silent with the one-line reason. If something is urgent, call mission.report with urgency 'urgent', at most 600 characters, plain text, and exactly one recommended action.`;

export const WEEKLY_CONSOLIDATION_ID = 'weekly-consolidation';
export const WEEKLY_CONSOLIDATION_CRON = '0 20 * * SUN';
export const WEEKLY_CONSOLIDATION_PROMPT = `Placeholder. Consolidate the week's derived memories and finance observations into durable notes, then stay silent (mission.silent) unless the consolidation itself found something the owner must act on.

This mission is registered disabled on purpose: enable it once the consolidation tools exist.`;

/**
 * What each one is allowed to do to the owner's evening:
 *
 *  - `friday-recap`          always delivers (the owner asked for it weekly).
 *  - `daily-check`           delivers only if it calls mission.report.
 *  - `weekly-consolidation`  registered disabled — a placeholder for later.
 */
export const financeMissions: SuggestedMission[] = [
  {
    id: FRIDAY_RECAP_ID,
    name: 'Friday recap',
    agentRole: 'recap',
    cron: FRIDAY_RECAP_CRON,
    misfirePolicy: 'coalesce',
    prompt: FRIDAY_RECAP_PROMPT,
    // The one mission that speaks whether or not it decided to: the owner asked
    // for a recap every Friday, not for a recap when something is wrong.
    alwaysDeliver: true,
  },
  {
    id: DAILY_CHECK_ID,
    name: 'Daily check',
    agentRole: 'overview',
    cron: DAILY_CHECK_CRON,
    misfirePolicy: 'coalesce',
    prompt: DAILY_CHECK_PROMPT,
    alwaysDeliver: false,
  },
  {
    id: WEEKLY_CONSOLIDATION_ID,
    name: 'Weekly consolidation',
    agentRole: 'overview',
    cron: WEEKLY_CONSOLIDATION_CRON,
    misfirePolicy: 'coalesce',
    prompt: WEEKLY_CONSOLIDATION_PROMPT,
    alwaysDeliver: false,
    enabledByDefault: false,
  },
];
