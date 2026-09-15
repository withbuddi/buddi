/**
 * Where `DATABASE_URL` comes from.
 *
 * The database holds the owner's financial history, their mail bodies and every
 * conversation they have ever had with an agent. For most of this project's
 * life it was protected by the literal password `buddi`, written into `.env` in
 * clear, on a port Docker published to `0.0.0.0` — which is to say, to every
 * machine on the café wifi. Both halves of that are fixed: the compose file
 * publishes on loopback only, and the password is a generated secret that lives
 * in the vault, exactly where the model credential and the bot token live.
 *
 * So the connection string is *assembled at runtime* rather than stored:
 *
 *  1. an explicit `DATABASE_URL` in the environment wins, always — that is the
 *     escape hatch for someone running their own Postgres, on their own host,
 *     with their own credentials, and buddi has no business rewriting it;
 *  2. otherwise a `DATABASE_URL` the owner put in the vault wholesale;
 *  3. otherwise `BUDDI_DB_PASSWORD` from the vault, wrapped around this
 *     installation's own defaults (user `buddi`, database `buddi`, loopback,
 *     `BUDDI_DB_PORT`);
 *  4. otherwise the day-1 default, password and all, so that an installation
 *     that predates this change keeps running until `buddi db secure` is run.
 *
 * Step 4 is the compatibility promise and step 1 is the escape hatch; the two
 * in the middle are what a secure installation actually uses.
 */
import { randomBytes } from 'node:crypto';
import { createVault } from './vault/index.js';
import { envValue, resolveSecret, type SecretProblem } from './vault/resolve.js';
import type { Vault } from './vault/types.js';

/** The variable every component still reads. Assembled, not stored. */
export const DATABASE_URL_VAR = 'DATABASE_URL';

/** The vault name the generated Postgres password is filed under. */
export const DB_PASSWORD_VAR = 'BUDDI_DB_PASSWORD';

/** Host port for the container; the same variable the compose file reads. */
export const DB_PORT_VAR = 'BUDDI_DB_PORT';

export const DEFAULT_DB_USER = 'buddi';
export const DEFAULT_DB_NAME = 'buddi';
export const DEFAULT_DB_PORT = '5432';

/**
 * Loopback, spelled as an address rather than as `localhost`.
 *
 * `localhost` resolves to `::1` first on a Mac, and the container publishes
 * `127.0.0.1` — a difference that shows up as a connection refused nobody can
 * explain. The literal address is unambiguous.
 */
export const DEFAULT_DB_HOST = '127.0.0.1';

/**
 * The password this project shipped with, and the one `buddi db secure` exists
 * to replace. Named so the doctor can recognise it rather than guess.
 */
export const LEGACY_DB_PASSWORD = 'buddi';

/**
 * Characters a generated password is allowed to contain.
 *
 * base64url, so the value survives a URL's userinfo with no percent-encoding
 * and can be interpolated into a `psql` literal without an escaping question.
 */
const GENERATED = /^[A-Za-z0-9_-]+$/;

/** Is this a password buddi generated (and may therefore interpolate safely)? */
export function isGeneratedPassword(value: string): boolean {
  return GENERATED.test(value) && value.length >= 24;
}

/**
 * A password with 192 bits of entropy, in 32 URL-safe characters.
 *
 * Not a passphrase and not memorable: nobody types this. It is generated once,
 * handed to Postgres, and kept in the OS keychain.
 */
export function generateDatabasePassword(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export interface DatabaseParts {
  user: string;
  password: string;
  host: string;
  port: string;
  database: string;
}

/** This installation's defaults, with the one piece the owner may set. */
export function databaseDefaults(env: NodeJS.ProcessEnv = {}): Omit<DatabaseParts, 'password'> {
  const port = (env[DB_PORT_VAR] ?? '').trim();
  return {
    user: DEFAULT_DB_USER,
    host: DEFAULT_DB_HOST,
    port: port === '' ? DEFAULT_DB_PORT : port,
    database: DEFAULT_DB_NAME,
  };
}

export function assembleDatabaseUrl(parts: DatabaseParts): string {
  const user = encodeURIComponent(parts.user);
  const password = encodeURIComponent(parts.password);
  return `postgres://${user}:${password}@${parts.host}:${parts.port}/${parts.database}`;
}

/** A connection string without its password. Every log and every table uses it. */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url.replace(/:\/\/[^@]*@/, '://***@');
  }
}

/** The password inside a connection string, or null when there is none. */
export function passwordInDatabaseUrl(url: string): string | null {
  try {
    const password = decodeURIComponent(new URL(url).password);
    return password === '' ? null : password;
  } catch {
    return null;
  }
}

export type DatabaseUrlSource =
  /** An explicit `DATABASE_URL` in the environment — the escape hatch. */
  | 'env'
  /** Assembled from a secret the vault holds. */
  | 'vault'
  /** The day-1 default, password `buddi` and all. */
  | 'default';

export interface DatabaseUrlResolution {
  url: string;
  source: DatabaseUrlSource;
  /** True when the password is the one this project shipped with. */
  legacyPassword: boolean;
  /**
   * Why the vault could not answer, when it was asked and refused. A locked
   * keychain is worth reporting; "this machine has no such secret" is not.
   */
  problem?: SecretProblem;
}

export interface ResolveDatabaseUrlOptions {
  env?: NodeJS.ProcessEnv;
  /** Absent means "no vault on this machine": only steps 1 and 4 are open. */
  vault?: Vault | undefined;
}

/**
 * Settle on one connection string. Never throws, never prompts, never logs.
 */
export async function resolveDatabaseUrl(
  opts: ResolveDatabaseUrlOptions = {},
): Promise<DatabaseUrlResolution> {
  const env = opts.env ?? {};
  const vault = opts.vault;

  const explicit = envValue(env, DATABASE_URL_VAR);
  if (explicit !== undefined) {
    return {
      url: explicit,
      source: 'env',
      legacyPassword: passwordInDatabaseUrl(explicit) === LEGACY_DB_PASSWORD,
    };
  }

  let problem: SecretProblem | undefined;
  const note = (p: SecretProblem): void => {
    // "Not on this machine" is a configuration fact the next step handles.
    if (p.code !== 'missing-secret' && problem === undefined) problem = p;
  };

  const whole = await resolveSecret(DATABASE_URL_VAR, { vault, env: {} });
  if (whole.ok) {
    return {
      url: whole.value,
      source: 'vault',
      legacyPassword: passwordInDatabaseUrl(whole.value) === LEGACY_DB_PASSWORD,
    };
  }
  note(whole.problem);

  const password = await resolveSecret(DB_PASSWORD_VAR, { vault, env });
  if (password.ok) {
    return {
      url: assembleDatabaseUrl({ ...databaseDefaults(env), password: password.value }),
      source: password.source === 'vault' ? 'vault' : 'env',
      legacyPassword: password.value === LEGACY_DB_PASSWORD,
      ...(problem ? { problem } : {}),
    };
  }
  note(password.problem);

  return {
    url: assembleDatabaseUrl({ ...databaseDefaults(env), password: LEGACY_DB_PASSWORD }),
    source: 'default',
    legacyPassword: true,
    ...(problem ? { problem } : {}),
  };
}

/**
 * Resolve and write `DATABASE_URL` into `env`, once, at a process's front door.
 *
 * Mutating the environment is deliberate and confined to composition roots: the
 * pool, the backup's `pg_dump`, `scripts/migrate.mjs` and every `buddi`
 * subcommand all still read one named variable, and this is what fills it in.
 */
export async function hydrateDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  vault: Vault | undefined = createVault({ env }),
): Promise<DatabaseUrlResolution> {
  const resolution = await resolveDatabaseUrl({ env, vault });
  env[DATABASE_URL_VAR] = resolution.url;
  return resolution;
}
