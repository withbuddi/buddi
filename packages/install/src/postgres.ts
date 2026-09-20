/**
 * The managed cluster, as a packaged installation asks for it.
 *
 * The cluster manager itself lives in `@buddi/core` (`src/postgres/`), so the
 * checkout CLI and the packaged launcher run the same implementation. What is
 * left here is the installation's own decision: managed cluster, or an
 * external server this installation does not supervise.
 *
 * `@buddi/core` arrives as an argument rather than a value import, because
 * this module is loaded by the launcher before `environment()` has finished
 * rewriting the environment those packages read at import time. Types are
 * imported statically; they are erased.
 */
import path from 'node:path';
import type { ManagedDatabase } from '@buddi/core';
import type { ReadyContext } from './environment.js';

export type { ManagedDatabase } from '@buddi/core';

export async function startDatabase(ctx: ReadyContext, core: typeof import('@buddi/core')): Promise<ManagedDatabase> {
  if (ctx.state.database === 'external') {
    if (!ctx.env.DATABASE_URL) throw new Error('External database selected; set DATABASE_URL in the data directory .env. No local cluster was created.');
    return { stop: async () => {}, pid: null, alive: true, exited: new Promise<void>(() => {}) };
  }
  if (ctx.env.DATABASE_URL) throw new Error('This installation owns a managed cluster; remove DATABASE_URL or use a separate data directory for an external database.');
  const vault = core.createVault({ env: ctx.env });
  if (!vault) throw new Error('Managed Postgres requires an available vault.');
  const cluster = await core.startManagedCluster({
    root: ctx.root, dataDir: ctx.data, port: ctx.state.dbPort, vault,
    logFile: path.join(ctx.data, 'logs/postgres.log'), env: ctx.env,
  });
  ctx.env.DATABASE_URL = cluster.url;
  return cluster;
}
