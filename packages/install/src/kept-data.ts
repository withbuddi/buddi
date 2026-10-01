/**
 * The "kept plugin data" line of a packaged `buddi doctor`.
 *
 * A packaged install answers `doctor` in the launcher, not with the checkout's
 * table of probes, so the row that table prints while a restore's plugin data
 * waits (`checkPendingPluginData`) never reached a packaged owner — the one
 * who restores most. This prints the same sentence there, whenever
 * `core.pending_plugin_data` has rows.
 */
import type { InstallContext } from './environment.js';

export interface KeptEntry {
  schema: string;
  rows: number;
  reason: string | null;
}

/** The line, or null when nothing waits. Pure: the row's own wording. */
export async function keptPluginDataLine(read: () => Promise<readonly KeptEntry[]>): Promise<string | null> {
  const { checkPendingPluginData } = await import('@buddi/cli');
  let entries: readonly KeptEntry[];
  try {
    entries = await read();
  } catch {
    // A database that is down is the supervisor line's to report.
    return null;
  }
  const result = checkPendingPluginData(entries);
  return result === null ? null : `Kept plugin data: ${result.detail}`;
}

/** Read `core.pending_plugin_data` of this installation's database. */
export function readKeptPluginData(ctx: Pick<InstallContext, 'env' | 'state'>): () => Promise<readonly KeptEntry[]> {
  return async () => {
    const core = await import('@buddi/core');
    if (ctx.state?.database === 'managed') await core.hydrateDatabaseUrl(ctx.env);
    const url = ctx.env.DATABASE_URL;
    if (url === undefined || url.trim() === '' || url.startsWith('<')) return [];
    const pool = core.createPool(url);
    try {
      await pool.query('select 1');
      return await core.listPendingPluginData(pool);
    } finally {
      await pool.end().catch(() => {});
    }
  };
}
