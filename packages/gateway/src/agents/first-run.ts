/**
 * Starting the first conversation — the part that is code.
 *
 * Deliberately almost nothing. The surfaces decide *when* (an accepted message
 * arrives at an installation whose onboarding is still `pending`), core records
 * *that* it happened, and everything the owner actually reads is written by the
 * agent, following the `first-run` skill. There is no script in this file
 * because a script in code is exactly the form this feature exists not to be.
 *
 * What is here is the one sentence the run is started with, and the claim: both
 * surfaces ask `shouldStartFirstRun` and the loser is told no, so an owner who
 * opens `buddi chat` and Telegram in the same minute is interviewed once.
 */
import { beginOnboarding, getOnboarding, type Queryable } from '@buddi/core';

/** The surface name `buddi chat` records. */
export const CLI_SURFACE = 'cli';

/**
 * The system suffix a first-run turn carries.
 *
 * It points at the skill rather than restating it: the skill is a file the
 * owner can read and change, and a second copy of the arc in a TypeScript
 * string would be the one that silently wins.
 */
export const FIRST_RUN_SUFFIX = [
  'This is the owner\'s very first contact with this installation. Conduct the first run now,',
  'following your first-run skill: open with one short line about what you are, then ask one',
  'thing at a time and wait. Call owner.get_profile before you ask anything, record what they',
  'tell you with owner.set_profile as they say it, and call owner.finish_onboarding when they',
  'have what they need — or the moment they say to skip. Never send a list of questions, and',
  'never more than two short messages before you stop and let them answer.',
].join(' ');

/**
 * Claim the first run for this surface, or decline.
 *
 * Two questions in one call because the answer must be atomic: reading
 * `pending` and then starting would let two surfaces both start. The read comes
 * first only so that the common case — an installation that finished this weeks
 * ago — never writes anything at all.
 */
export async function shouldStartFirstRun(
  pool: Queryable,
  surface: string,
): Promise<boolean> {
  const current = await getOnboarding(pool);
  if (current.state !== 'pending') return false;
  const { started } = await beginOnboarding(pool, surface);
  return started;
}
