/**
 * The one line every `vitest run` in this repository prints before it starts.
 *
 * `globalSetup` runs once, in the runner's own process, before any worker is
 * spawned — so this is the only place a per-run statement can be made without
 * repeating it once per worker. Two things happen here, in this order:
 *
 *  1. the connection is resolved the way the application resolves it, and
 *     written into `process.env.DATABASE_URL` so the workers this process
 *     forks inherit it and need not ask the keychain again;
 *  2. the outcome is announced — where the URL came from, or that there is no
 *     database and the DB suites are being skipped.
 *
 * Point 2 is the whole reason this file exists. A green run that skipped the
 * DB suites is indistinguishable from a green run that passed them, and that
 * confusion has cost real time. Now it says which one it was.
 */
import { describeTestDatabase, resolveTestDatabase } from './database-url.js';

export default async function setup(): Promise<void> {
  const db = await resolveTestDatabase();
  // The workers read one named variable, as they always have; what changed is
  // that something resolved it first instead of trusting `.env`.
  if (db.url !== null) process.env.DATABASE_URL = db.url;
  else delete process.env.DATABASE_URL;
  console.log(describeTestDatabase(db));
}
