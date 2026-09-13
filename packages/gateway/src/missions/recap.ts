/**
 * The Friday recap mission — the first scheduled mission buddi ships.
 *
 * The prompt is the mission's *content*, stored in core.missions and versioned
 * with it; the presentation contract for an unattended run lives in
 * `SCHEDULED_RUN_SUFFIX`, not here. The two are kept apart on purpose: changing
 * how Telegram renders must not rewrite what the owner asked for weekly.
 */
import type { UpsertMissionInput } from '@buddi/core';

export const FRIDAY_RECAP_ID = 'friday-recap';
export const FRIDAY_RECAP_CRON = '0 8 * * FRI';
export const DEFAULT_TIMEZONE = 'America/New_York';

/** Timezone for scheduled missions: `BUDDI_TZ`, else New York. */
export function timezoneFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.BUDDI_TZ ?? '').trim() || DEFAULT_TIMEZONE;
}

export const FRIDAY_RECAP_PROMPT = `Produce the weekly recap. Use the finance tools for every number; never do the arithmetic yourself.

1. Cash: total across accounts, per account if there are several. If any liability is recorded, add total debt and net worth (cash minus debt).
2. Due in the next 14 days: each charge and income with its date and amount.
3. 60-day projection: the minimum projected balance and the exact date it happens, the first floor breach if there is one, and whether the safety floor holds. If no safety floor is set, say so in one line.
4. What changed since last week, if the tools can tell: this month's spending summary against the previous month's.
5. One concrete recommendation, in a single line.

Keep the whole message under 1500 characters, plain text, no markdown.`;

/** The mission definition as it is upserted. */
export const FRIDAY_RECAP_MISSION: UpsertMissionInput = {
  id: FRIDAY_RECAP_ID,
  name: 'Friday recap',
  agentId: 'finance-advisor',
  prompt: FRIDAY_RECAP_PROMPT,
  enabled: true,
};
