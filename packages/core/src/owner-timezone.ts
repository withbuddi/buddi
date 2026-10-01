/**
 * Saving the owner's profile when the zone may change.
 *
 * Settings → Profile is the owner's zone (`ownerTimezone`); `BUDDI_TZ` is only
 * the default while the profile names none. A new zone applies to clocks and
 * `{{today}}` at once (`setOwnerProfile` refreshes the process's copy). The
 * schedules kept in the old zone — the recap at 8 AM, the digest's day and
 * hour, a recurring reminder — move with it here, so "8 AM" stays the owner's
 * 8 AM. A schedule in any other zone was named on purpose and stays.
 */
import type { Pool } from 'pg';
import { getOwnerProfile, setOwnerProfile } from './onboarding/store.js';
import type { OwnerProfile, OwnerProfilePatch } from './onboarding/types.js';
import { rezoneSchedules } from './scheduler/missions.js';
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
  const missions = await rezoneSchedules(pool, from, to);
  return { profile, zoneChange: { from, to, missions } };
}

/**
 * At start: the schedules still kept in the configured fallback zone
 * (`BUDDI_TZ`, else New York) move to the profile's zone when the profile
 * names another. An installation set up before the profile drove the clock
 * made its recap and digest in the fallback zone, and its owner's zone was
 * the profile's all along. Nothing to do when the profile names no zone or
 * the same one. Returns what moved, if anything did.
 */
export async function alignSchedulesToOwnerZone(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ from: string; to: string; missions: string[] } | undefined> {
  const zone = (await getOwnerProfile(pool)).timezone;
  if (zone === null || !isKnownTimezone(zone)) return undefined;
  const from = timezoneFromEnv(env);
  const to = zone.trim();
  if (from === to) return undefined;
  const missions = await rezoneSchedules(pool, from, to);
  return missions.length > 0 ? { from, to, missions } : undefined;
}
