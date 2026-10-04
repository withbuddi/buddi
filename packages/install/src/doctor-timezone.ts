/**
 * The "Timezone" line of a packaged `buddi doctor`.
 *
 * A packaged install answers `doctor` in the launcher, not with the checkout's
 * table of probes, so the timezone row — which zone the owner's clocks and
 * schedules use and where it comes from (Settings → Profile, `BUDDI_TZ`, or
 * the default) — never reached a packaged owner. This prints the same
 * sentence (`checkTimezone`), reading the Profile from this installation's
 * database; with the database down it says what the environment alone gives,
 * and that the Profile was not read.
 */
import type { InstallContext } from './environment.js';

/** The line, from the Profile's zone (null: none or unreadable) and the environment. Pure but for the import. */
export async function timezoneLine(readProfileZone: () => Promise<string | null>, env: NodeJS.ProcessEnv): Promise<string> {
  const { checkTimezone, systemTimezone } = await import('@buddi/cli/doctor');
  let profile: string | null = null;
  let unread = false;
  try {
    profile = await readProfileZone();
  } catch {
    unread = true;
  }
  const { detail } = checkTimezone({ profile, envZone: env.BUDDI_TZ ?? null, system: systemTimezone() });
  return `Timezone: ${detail}${unread ? ' — Settings → Profile not read: the database is not answering' : ''}`;
}

/** Read the zone Settings → Profile names in this installation's database, if it is a known one. */
export function readProfileZone(ctx: Pick<InstallContext, 'env' | 'state'>): () => Promise<string | null> {
  return async () => {
    const core = await import('@buddi/core');
    if (ctx.state?.database === 'managed') await core.hydrateDatabaseUrl(ctx.env);
    const url = ctx.env.DATABASE_URL;
    if (url === undefined || url.trim() === '' || url.startsWith('<')) return null;
    const pool = core.createPool(url);
    try {
      const zone = (await core.getOwnerProfile(pool)).timezone;
      return zone !== null && core.isKnownTimezone(zone) ? zone.trim() : null;
    } finally {
      await pool.end().catch(() => {});
    }
  };
}
