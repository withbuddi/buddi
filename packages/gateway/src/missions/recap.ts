/**
 * The recap mission's *gateway* half: the weekly digest, and nothing domain.
 *
 * What the recap says is the plugin's business — the finance plugin ships the
 * prompt and the cron as a suggested mission — and how an unattended run
 * presents itself is `SCHEDULED_RUN_SUFFIX`'s. What is left here is the digest:
 * the observations the watchers parked during the week, appended to whichever
 * mission the installation's `recap` role holder runs.
 */
import {
  consumeDigestItems,
  DEFAULT_TIMEZONE,
  pendingDigestItems,
  renderDigest,
  timezoneFromEnv,
  type Mission,
  type PluginManifest,
} from '@buddi/core';
import type { Pool } from 'pg';
import { ROLE_RECAP } from '../agents/roles.js';
import { suggestedMissionForRole } from './defaults.js';
import type { PrepareRun } from './execute.js';

// The owner's timezone lives in core (`packages/core/src/time.ts`) now that the
// tools need it too; re-exported here so every existing caller keeps its import.
export { DEFAULT_TIMEZONE, timezoneFromEnv };

/**
 * The mission `/recap` runs: the one an installed plugin suggests for the
 * `recap` role. No plugin suggesting one means the command has nothing to run,
 * and says so — it never falls back to a mission id written into a surface.
 */
export function recapMissionId(
  manifests?: readonly PluginManifest[],
): string | undefined {
  return suggestedMissionForRole(ROLE_RECAP, manifests)?.id;
}

/**
 * The weekly digest, appended to the recap prompt.
 *
 * `info` findings never interrupt: the watchers put them here during the week
 * and the recap picks them up. They are consumed only once the recap has
 * actually been delivered — the commit hook runs after delivery, so a failed
 * send does not silently eat a week of observations.
 */
export function createDigestPrepare(
  pool: Pool,
  opts: { missionId?: string; now: () => Date },
): PrepareRun {
  const missionId = opts.missionId ?? recapMissionId();
  return async function prepare(mission: Mission) {
    if (missionId === undefined || mission.id !== missionId) return null;
    const items = await pendingDigestItems(pool);
    if (items.length === 0) return null;
    const ids = items.map((item) => item.id);
    return {
      appendix: renderDigest(items),
      commit: async () => {
        await consumeDigestItems(pool, ids, opts.now());
      },
    };
  };
}
