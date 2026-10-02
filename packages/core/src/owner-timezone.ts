/**
 * Saving the owner's profile when the zone may change.
 *
 * Settings → Profile is the owner's zone (`ownerTimezone`); `BUDDI_TZ` is only
 * the default while the profile names none. A new zone applies to clocks and
 * `{{today}}` at once (`setOwnerProfile` refreshes the process's copy). The
 * schedules that follow the owner's zone — made without one: the recap at
 * 8 AM, the digest's day and hour, a recurring reminder — move with it here,
 * so "8 AM" stays the owner's 8 AM. A schedule whose zone was named on
 * purpose (`timezone_explicit`) stays.
 */
import type { Pool } from 'pg';
import { getOwnerProfile, setOwnerProfile } from './onboarding/store.js';
import type { OwnerProfile, OwnerProfilePatch } from './onboarding/types.js';
import { type OwnerFollowingDeclaration, rezoneSchedules, settleUnflaggedSchedules } from './scheduler/missions.js';
import { isKnownTimezone, timezoneFromEnv } from './time.js';

export interface SavedOwnerProfile {
  profile: OwnerProfile;
  /** Set when the effective zone changed: from, to, and the missions moved. */
  zoneChange?: { from: string; to: string; missions: string[] };
}

export async function saveOwnerProfile(
  pool: Pool,
  patch: OwnerProfilePatch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SavedOwnerProfile> {
  if (patch.timezone === undefined) return { profile: await setOwnerProfile(pool, patch) };
  const effective = (zone: string | null): string =>
    zone !== null && isKnownTimezone(zone) ? zone.trim() : timezoneFromEnv(env);
  const from = effective((await getOwnerProfile(pool)).timezone);
  const profile = await setOwnerProfile(pool, patch);
  const to = effective(profile.timezone);
  if (from === to) return { profile };
  const missions = await rezoneSchedules(pool, to);
  return { profile, zoneChange: { from, to, missions } };
}

/**
 * At every start: the schedules made before buddi recorded whether a zone was
 * named on purpose are settled once by provenance — one buddi itself made
 * without a zone (`declared`: a default mission, the digest, a plugin agent's
 * mission) that still sits in the default zone of the time (`BUDDI_TZ`, else
 * New York) or the Profile's follows the owner; any other, ambiguous ones
 * included, keeps its zone — and then every schedule that
 * follows the owner and is not in the owner's zone moves to it (a Profile
 * change made while buddi was stopped, or by an older buddi). Returns what
 * moved, if anything.
 */
export async function settleScheduleZones(
  pool: Pool,
  env: NodeJS.ProcessEnv,
  declared: readonly OwnerFollowingDeclaration[] = [],
): Promise<{ to: string; missions: string[]; settled: { following: number; explicit: number } }> {
  const zone = (await getOwnerProfile(pool)).timezone;
  const fallback = timezoneFromEnv(env);
  const to = zone !== null && isKnownTimezone(zone) ? zone.trim() : fallback;
  const settled = await settleUnflaggedSchedules(pool, [...new Set([fallback, to])], declared);
  const missions = await rezoneSchedules(pool, to);
  return { to, missions, settled };
}
