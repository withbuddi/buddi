/**
 * How the test suites find a database — the same way the application does.
 *
 * Every DB-backed suite in this repository used to open with
 * `const databaseUrl = process.env.DATABASE_URL`. That was right for exactly as
 * long as the password lived in `.env` in clear. Once `buddi db secure` moved
 * it into the keychain, `.env` holds `DATABASE_URL="<vault>"` — a marker, not a
 * value — and `set -a; . ./.env; pnpm test` handed every suite the literal
 * string `<vault>`, which `pg` dutifully parsed as the host `base`. The result
 * was `getaddrinfo ENOTFOUND base` in two hundred tests and an afternoon spent
 * looking for a code regression that was never there.
 *
 * So the tests resolve their connection through `resolveDatabaseUrl`, exactly
 * like the pool, the backup and every `buddi` subcommand:
 *
 *  - an explicit `DATABASE_URL` in the environment wins (the escape hatch);
 *  - the vault answers otherwise (`DATABASE_URL`, or `BUDDI_DB_PASSWORD`
 *    wrapped around this installation's defaults);
 *  - the `<vault>` marker counts as *absent*, never as a hostname.
 *
 * One deliberate difference from the application: the day-1 fallback — the
 * built-in `buddi:buddi` string `resolveDatabaseUrl` returns when nothing else
 * answers — is **not** a database as far as the tests are concerned. Guessing
 * at a connection string is how a suite turns "no database configured" into a
 * connection error; `source: 'default'` means no database, and the suites skip,
 * which is what they have always done when `DATABASE_URL` was unset.
 */
import { resolveDatabaseUrl, redactDatabaseUrl } from '../database-url.js';
import { createVault } from '../vault/index.js';
import { envValue } from '../vault/resolve.js';

export interface TestDatabase {
  /** The connection string the suites should use, or `null` to skip. */
  url: string | null;
  /** Where it came from. `none` means: nothing answered, skip. */
  source: 'env' | 'vault' | 'none';
  /** Why the vault could not answer, when it was asked and refused. */
  problem?: string;
}

/** Resolved once per process; the keychain is not worth asking twice. */
let pending: Promise<TestDatabase> | undefined;

/**
 * Settle on the database the suites in this process should use. Never throws.
 */
export function resolveTestDatabase(env: NodeJS.ProcessEnv = process.env): Promise<TestDatabase> {
  pending ??= (async (): Promise<TestDatabase> => {
    const resolution = await resolveDatabaseUrl({ env, vault: createVault({ env }) });
    const problem = resolution.problem?.message;
    if (resolution.source === 'default') {
      return { source: 'none', url: null, ...(problem ? { problem } : {}) };
    }
    return {
      url: resolution.url,
      source: resolution.source,
      ...(problem ? { problem } : {}),
    };
  })();
  return pending;
}

/**
 * The one line a DB-backed suite needs:
 *
 * ```ts
 * const databaseUrl = await testDatabaseUrl();
 * const suite = databaseUrl ? describe : describe.skip;
 * ```
 */
export async function testDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const resolved = await resolveTestDatabase(env);
  return resolved.url ?? undefined;
}

/**
 * What the run says out loud, once, before anything is collected.
 *
 * A green run that quietly skipped two hundred tests looks exactly like a green
 * run that executed them — until someone ships on the strength of it. This is
 * the sentence that tells the two apart.
 */
export function describeTestDatabase(db: TestDatabase): string {
  const note = db.problem ? ` (vault: ${db.problem})` : '';
  if (db.url === null) {
    return `database: none resolved — DB suites skipped${note}`;
  }
  const where = db.source === 'env' ? 'environment' : 'vault';
  return `database: ${redactDatabaseUrl(db.url)} (from the ${where}) — DB suites run${note}`;
}

/** The dev instance's Docker Postgres. No suite may ever point at it. */
export const DEV_DATABASE_PORT = '55433';

/**
 * The isolated way to find a test database: an explicit `DATABASE_URL` in the
 * environment and nothing else. The vault is never asked (a keychain on the
 * developer's Mac answers with the dev database), the dev instance's port is
 * refused outright, and a run that has a URL must use the memory vault, so no
 * suite reads or writes the real keychain. Throws on a refusal: a run pointed
 * at the wrong database stops, it does not skip.
 */
export function isolatedTestDatabase(env: NodeJS.ProcessEnv = process.env): TestDatabase {
  const url = envValue(env, 'DATABASE_URL');
  if (url === undefined) return { url: null, source: 'none', problem: 'DATABASE_URL is not set explicitly' };
  let port: string;
  try {
    port = new URL(url).port;
  } catch {
    throw new Error('Refusing to run DB suites: DATABASE_URL is not a URL.');
  }
  if (port === DEV_DATABASE_PORT) {
    throw new Error(`Refusing to run DB suites against port ${DEV_DATABASE_PORT}: that is the dev instance's database. Use a throwaway Postgres (pnpm test:db).`);
  }
  if (env.BUDDI_VAULT !== 'memory') {
    throw new Error('Refusing to run DB suites without BUDDI_VAULT=memory: a test must never reach the real keychain.');
  }
  return { url, source: 'env' };
}

/** `isolatedTestDatabase`'s URL, or `undefined` to skip. */
export function isolatedTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return isolatedTestDatabase(env).url ?? undefined;
}
