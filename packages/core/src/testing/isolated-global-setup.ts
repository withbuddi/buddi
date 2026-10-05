/**
 * The global setup for packages whose DB suites must be isolated: an explicit
 * `DATABASE_URL` only (the vault is never asked), never the dev database's
 * port, and the memory vault for every worker this run forks.
 *
 * `BUDDI_VAULT` is set to `memory` when the run did not say, before anything
 * else, so no worker can open the keychain; a run that named another vault is
 * refused by `isolatedTestDatabase` once it has a database.
 */
import { describeTestDatabase, isolatedTestDatabase } from './database-url.js';

export default async function setup(): Promise<void> {
  process.env.BUDDI_VAULT ??= 'memory';
  const db = isolatedTestDatabase(process.env);
  if (db.url !== null) process.env.DATABASE_URL = db.url;
  else delete process.env.DATABASE_URL;
  console.log(describeTestDatabase(db));
}
