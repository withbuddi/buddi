/**
 * `buddi init` asks for a name and a timezone and writes them to the env file,
 * because at that point there may be no database to write to. The row the
 * agents actually read is `core.owner`. This closes the gap at boot: each
 * env value fills its field once, and only while that field is empty — an
 * answer the owner later changed in Settings or told an agent is never
 * overwritten by a stale line in a file.
 */
import type { Pool } from 'pg';
import { getOwnerProfile, isKnownTimezone, setOwnerProfile } from '@buddi/core';

export async function seedOwnerFromEnv(pool: Pool, env: NodeJS.ProcessEnv): Promise<string[]> {
  const name = (env.BUDDI_OWNER_NAME ?? '').trim();
  const zone = (env.BUDDI_TZ ?? '').trim();
  if (name === '' && zone === '') return [];
  const profile = await getOwnerProfile(pool);
  const patch: { preferredName?: string; timezone?: string } = {};
  if (name !== '' && !profile.preferredName) patch.preferredName = name;
  if (zone !== '' && !profile.timezone && isKnownTimezone(zone)) patch.timezone = zone;
  if (Object.keys(patch).length === 0) return [];
  await setOwnerProfile(pool, patch);
  return Object.keys(patch);
}
