/**
 * `buddi db secure` — give this installation's database a real password, and
 * check that its port is not published to the neighbourhood.
 *
 * The shipped defaults were `POSTGRES_PASSWORD: buddi` on a port Docker binds
 * to `0.0.0.0`. On a laptop that has ever joined a café, an office or a hotel
 * network, that is the owner's entire financial history, mail and conversation
 * log behind a four-letter password on an open port. The compose file now
 * publishes `127.0.0.1` and reads the password from the environment; this
 * command is the other half — the migration for everyone already running.
 *
 * Two properties matter more than anything else here:
 *
 *  - **Idempotent.** A second run on a secured installation rotates nothing and
 *    says so. There is no state to get half-way through.
 *  - **Reversible.** The password is changed in the running server *first*, the
 *    new one is proved to work, and only then is it written to the vault and
 *    `.env`. If any step fails, the old password is put back and the
 *    installation is left exactly as it was — working, on the old password,
 *    with a sentence saying so.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import {
  DATABASE_URL_VAR,
  DB_PASSWORD_VAR,
  LEGACY_DB_PASSWORD,
  assembleDatabaseUrl,
  createVault,
  databaseDefaults,
  generateDatabasePassword,
  isVaultPlaceholder,
  passwordInDatabaseUrl,
  redactDatabaseUrl,
  resolveDatabaseUrl,
  VAULT_PLACEHOLDER_LINE,
  VaultLockedError,
  vaultState,
  type Vault,
} from '@buddi/core';
import { probeDatabase } from '@buddi/gateway';
import { applyEnvEdits, parseEnv } from './env-file.js';
import { ENV_FILE, REPO_ROOT } from './paths.js';
import { run } from './proc.js';

/**
 * The compose service the database is.
 *
 * Spelled here rather than imported from `db-cmd`, which imports *this* module:
 * one three-letter constant is a better price than a cycle between the command
 * and the thing the command does.
 */
export const DB_SERVICE = 'postgres';

/** How a caller reaches `docker`. Injected in tests; never a shell. */
export type Exec = typeof run;

export interface SecureDeps {
  env?: NodeJS.ProcessEnv;
  /**
   * Injected in tests. `false` means "this machine has no vault at all", which
   * is the one configuration `db secure` refuses: there would be nowhere to put
   * the new password except back into `.env`.
   */
  vault?: Vault | false | undefined;
  exec?: Exec;
  repoRoot?: string;
  envFile?: string;
  out?: (line: string) => void;
  /** Injected in tests so the assertions can name the password. */
  generate?: () => string;
  /** Proves a URL connects. Injected in tests. */
  probe?: (url: string) => Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Where the port is published
 * ------------------------------------------------------------------ */

export interface PublishedBinding {
  /** What compose printed, e.g. `127.0.0.1:55433` or `0.0.0.0:5432`. */
  published?: string;
  /** Why it could not be read: a stopped daemon, a container that is not up. */
  error?: string;
}

/**
 * Ask compose where it actually published the port.
 *
 * The compose *file* is a claim; this is the running truth, and they differ for
 * exactly as long as it takes someone to `buddi db up` after an edit — which is
 * the window the doctor exists to close.
 */
export async function publishedBinding(
  exec: Exec = run,
  repoRoot: string = REPO_ROOT,
): Promise<PublishedBinding> {
  const res = await exec('docker', ['compose', 'port', DB_SERVICE, '5432'], {
    cwd: repoRoot,
    timeoutMs: 20_000,
  });
  const text = `${res.stdout}\n${res.stderr}`.trim();
  if (res.code !== 0) {
    const first = text.split('\n').find((l) => l.trim() !== '')?.trim();
    return { error: first === undefined || first === '' ? `docker exited ${res.code}` : first };
  }
  const line = res.stdout.split('\n').find((l) => l.trim() !== '')?.trim();
  if (line === undefined || line === '') {
    return { error: 'the postgres container is not running (`buddi db up`)' };
  }
  return { published: line };
}

/** The host half of `127.0.0.1:5432` or `[::]:5432`, or null when unparseable. */
export function hostOfPublished(published: string): string | null {
  const bracketed = /^\[(.+)\]:\d+$/.exec(published.trim());
  if (bracketed) return bracketed[1] as string;
  const plain = /^(.+):\d+$/.exec(published.trim());
  return plain ? (plain[1] as string) : null;
}

/* ------------------------------------------------------------------ *
 * The password
 * ------------------------------------------------------------------ */

/** A secret shown as its shape. The value is never printed, not even by this. */
export function shape(value: string): string {
  return `${value.length} chars, ${value.slice(0, 2)}…`;
}

export interface EnsureResult {
  password: string;
  /** True when this call generated it; false when the vault already had one. */
  created: boolean;
}

/**
 * The vault would not open, so no password was generated and none was stored.
 *
 * A locked vault used to come out of here as an uncaught `VaultLockedError`,
 * which is how a fresh Linux installation — where the file vault is the default
 * and `BUDDI_VAULT_KEY` is not set until someone sets it — answered `buddi db
 * up` with a stack trace. It is a configuration state, so it is a value.
 */
export interface EnsureLocked {
  locked: true;
  /** What to say, and what to do about it. Never a secret. */
  advice: string;
}

export type EnsureOutcome = EnsureResult | EnsureLocked | null;

export function isLocked(outcome: EnsureOutcome): outcome is EnsureLocked {
  return outcome !== null && 'locked' in outcome;
}

/**
 * The password a fresh installation's container should be created with.
 *
 * Returns `null` — "not ours to decide" — when an explicit `DATABASE_URL` is in
 * the environment: that owner runs their own Postgres, and buddi neither
 * generates nor rotates credentials it did not issue.
 *
 * Deliberately does *not* invent a `BUDDI_VAULT_KEY` when the file vault has
 * none. A key generated here would be generated again by the next process that
 * did not inherit it, and the two would seal secrets neither could open. The
 * key is generated in one place only — `buddi init`, in front of the owner —
 * and everything else says so.
 */
export async function ensureDatabasePassword(deps: SecureDeps = {}): Promise<EnsureOutcome> {
  const env = deps.env ?? process.env;
  const vault = deps.vault === undefined ? createVault({ env }) : (deps.vault || undefined);
  if (!vault) return null;

  const fileUrl = await explicitUrlInEnvFile(deps.envFile ?? ENV_FILE);
  if (fileUrl !== null) return null;

  const state = vaultState({ env });
  const existing = await vault.get(DB_PASSWORD_VAR).catch(() => null);
  if (existing !== null && existing.trim() !== '') {
    return { password: existing.trim(), created: false };
  }
  const password = (deps.generate ?? generateDatabasePassword)();
  try {
    await vault.set(DB_PASSWORD_VAR, password);
  } catch (err) {
    if (err instanceof VaultLockedError) {
      return {
        locked: true,
        advice: state.advice !== '' ? state.advice : err.message,
      };
    }
    throw err;
  }
  return { password, created: true };
}

/**
 * An explicit `DATABASE_URL` written into `.env`, or null for the marker/absent.
 *
 * The *file*, not `process.env`: every subcommand has already assembled a URL
 * into its environment, so the environment can no longer tell you whether the
 * owner asked for one. This is the question "is this buddi's own container?".
 */
export async function explicitUrlInEnvFile(file: string = ENV_FILE): Promise<string | null> {
  if (!existsSync(file)) return null;
  const parsed = parseEnv(await readFile(file, 'utf8'));
  const value = (parsed[DATABASE_URL_VAR] ?? '').trim();
  if (value === '' || isVaultPlaceholder(value)) return null;
  return value;
}

/**
 * Is this the exact connection string this project used to ship?
 *
 * Every installation that predates this change has one line in `.env` reading
 * `DATABASE_URL=postgres://buddi:buddi@localhost:<port>/buddi`. That line looks
 * "explicit", but it is not a choice anyone made — it is the default, and it is
 * precisely what `db secure` exists to replace. Anything else with a
 * `DATABASE_URL` in it really is the owner's own Postgres, and is left alone.
 */
export function isShippedDefaultUrl(url: string, env: NodeJS.ProcessEnv = {}): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const defaults = databaseDefaults(env);
  const host = parsed.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  return (
    decodeURIComponent(parsed.username) === defaults.user &&
    decodeURIComponent(parsed.password) === LEGACY_DB_PASSWORD &&
    decodeURIComponent(parsed.pathname.replace(/^\//, '')) === defaults.database &&
    loopback &&
    (parsed.port || '5432') === defaults.port
  );
}

/* ------------------------------------------------------------------ *
 * ALTER ROLE, through the container
 * ------------------------------------------------------------------ */

/**
 * `alter role buddi with password '…'`, run by `psql` inside the container.
 *
 * The password is interpolated into the statement, so it is checked against the
 * generated alphabet first: a value with a quote in it never reaches `psql`.
 * The *old* password travels as `PGPASSWORD` in the exec environment, which is
 * the same mechanism `buddi backup` already uses for `pg_dump`.
 */
export async function alterRolePassword(opts: {
  exec: Exec;
  repoRoot: string;
  user: string;
  currentPassword: string;
  newPassword: string;
  database: string;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  // The value is interpolated into a SQL literal, so it is checked against the
  // alphabet buddi generates from first. A rollback to the old `buddi` password
  // passes this; anything holding a quote, a backslash or a newline does not,
  // and never reaches `psql`.
  if (!/^[A-Za-z0-9_-]+$/.test(opts.newPassword)) {
    return { ok: false, detail: 'refusing to interpolate that password into SQL' };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.user)) {
    return { ok: false, detail: `refusing to alter the role ${JSON.stringify(opts.user)}` };
  }
  const res = await opts.exec(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      '-e',
      `PGPASSWORD=${opts.currentPassword}`,
      DB_SERVICE,
      'psql',
      '-U',
      opts.user,
      '-d',
      opts.database,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `alter role "${opts.user}" with password '${opts.newPassword}'`,
    ],
    { cwd: opts.repoRoot, timeoutMs: 60_000 },
  );
  if (res.code !== 0) {
    const detail = `${res.stderr || res.stdout}`.trim().split('\n').slice(0, 3).join('; ');
    return { ok: false, detail: detail === '' ? `psql exited ${res.code}` : detail };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * The command
 * ------------------------------------------------------------------ */

export async function runDbSecure(deps: SecureDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((line: string) => console.log(line));
  const exec = deps.exec ?? run;
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const envFile = deps.envFile ?? ENV_FILE;
  const probe = deps.probe ?? ((url: string) => probeDatabase(url));
  const vault = deps.vault === undefined ? createVault({ env }) : (deps.vault || undefined);

  out('buddi db secure — the database gets a password of its own');

  if (!vault) {
    out('');
    out('There is no vault on this machine (BUDDI_VAULT=none), so there is nowhere');
    out('to put the new password except back into .env in clear — which is the');
    out('thing this command exists to stop. Turn a vault on (BUDDI_VAULT=keychain');
    out('on macOS, BUDDI_VAULT=file with BUDDI_VAULT_KEY elsewhere) and re-run.');
    return 1;
  }

  const explicit = await explicitUrlInEnvFile(envFile);
  if (explicit !== null && !isShippedDefaultUrl(explicit, env)) {
    out('');
    out(`.env sets DATABASE_URL explicitly (${redactDatabaseUrl(explicit)}).`);
    out('That wins over everything, and buddi does not rotate a credential it did');
    out('not issue. If this is buddi\'s own container, delete that line and re-run;');
    out('if it is your own Postgres, rotate the password there and you are done.');
    return 0;
  }

  const defaults = databaseDefaults(env);
  const stored = await vault.get(DB_PASSWORD_VAR).catch(() => null);
  const storedPassword = stored === null ? null : stored.trim();

  /* 1. What is true right now ------------------------------------- */
  // Deliberately *not* `env.DATABASE_URL`: every subcommand has already had it
  // assembled into the process environment, so reading it back would only tell
  // us what we ourselves put there. Ask the sources again instead.
  const sources: NodeJS.ProcessEnv = { ...env };
  delete sources[DATABASE_URL_VAR];
  const before = await resolveDatabaseUrl({ env: sources, vault });
  out('');
  out('before:');
  out(`  DATABASE_URL   ${redactDatabaseUrl(before.url)} (${before.source})`);
  out(
    `  ${DB_PASSWORD_VAR}  ${
      storedPassword === null || storedPassword === ''
        ? 'not in the vault'
        : `in the ${vault.kind} vault (${shape(storedPassword)})`
    }`,
  );

  /* 2. Already done? ----------------------------------------------- */
  if (storedPassword !== null && storedPassword !== '' && storedPassword !== LEGACY_DB_PASSWORD) {
    const working = await probe(before.url).then(
      () => true,
      () => false,
    );
    if (working) {
      await writeVaultMarker(envFile, out);
      out('');
      out('Already secured: the password is in the vault and the database accepts it.');
      out('Nothing was rotated. This command is safe to run as often as you like.');
      return 0;
    }
    out('');
    out(`The vault holds a ${DB_PASSWORD_VAR} the database does not accept — rotating to a fresh one.`);
  }

  /* 3. The password the server has today --------------------------- */
  const currentPassword = passwordInDatabaseUrl(before.url) ?? LEGACY_DB_PASSWORD;
  const reachable = await probe(before.url).then(
    () => true,
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  if (reachable !== true) {
    out('');
    out(`The database is not reachable on the password buddi has: ${reachable}`);
    out('Start it with `buddi db up` and re-run. Nothing was changed.');
    return 1;
  }

  /* 4. Rotate, in the running server ------------------------------- */
  const newPassword = (deps.generate ?? generateDatabasePassword)();
  const newUrl = assembleDatabaseUrl({ ...defaults, password: newPassword });
  out('');
  out(`rotating: ALTER ROLE ${defaults.user} — old ${shape(currentPassword)} → new ${shape(newPassword)}`);

  const altered = await alterRolePassword({
    exec,
    repoRoot,
    user: defaults.user,
    database: defaults.database,
    currentPassword,
    newPassword,
  });
  if (!altered.ok) {
    out(`  ALTER ROLE failed: ${altered.detail}`);
    out('Nothing was changed — the installation is still on its old password.');
    return 1;
  }
  out('  ALTER ROLE ok');

  /* 5. Prove the new one works before writing it anywhere ---------- */
  const rollback = async (why: string): Promise<number> => {
    out(`  ${why}`);
    const back = await alterRolePassword({
      exec,
      repoRoot,
      user: defaults.user,
      database: defaults.database,
      currentPassword: newPassword,
      newPassword: currentPassword,
    });
    if (back.ok) {
      out('  rolled back: the database is on its OLD password and the installation still works.');
      out('  Nothing was written to the vault or to .env.');
      return 1;
    }
    // The one genuinely bad outcome, said plainly rather than swallowed.
    out(`  ROLLBACK FAILED: ${back.detail}`);
    out(`  The database now expects a password nothing has recorded. Put it back with:`);
    out(`    docker compose exec -T ${DB_SERVICE} psql -U ${defaults.user} -d ${defaults.database} \\`);
    out(`      -c "alter role ${defaults.user} with password '<the old one>'"`);
    return 1;
  };

  try {
    await probe(newUrl);
  } catch (err) {
    return rollback(
      `the new password does not connect: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  out(`  verified: ${redactDatabaseUrl(newUrl)} connects`);

  /* 6. Store it, then point .env at the vault ---------------------- */
  try {
    await vault.set(DB_PASSWORD_VAR, newPassword);
  } catch (err) {
    return rollback(
      `the vault refused the new password: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  out(`  stored ${DB_PASSWORD_VAR} in the ${vault.kind} vault`);

  await writeVaultMarker(envFile, out);

  // This process keeps working without a restart; everything else needs one.
  env[DB_PASSWORD_VAR] = newPassword;
  env[DATABASE_URL_VAR] = newUrl;

  out('');
  out('after:');
  out(`  DATABASE_URL   ${redactDatabaseUrl(newUrl)} (assembled from the vault)`);
  out(`  .env           DATABASE_URL=${VAULT_PLACEHOLDER_LINE} — no password in the file`);
  out('');
  out('Restart anything that is already running, so it picks the new one up:');
  out('  buddi service restart');
  out('');
  out('If the container is still published on 0.0.0.0 (buddi doctor says so), re-create');
  out('it on loopback: `buddi db down && buddi db up`. Your data is in a named volume');
  out('and survives that.');
  return 0;
}

/**
 * Point `.env` at the vault. Idempotent, and it never *adds* a password: the
 * only thing it can write into that file is the marker.
 */
async function writeVaultMarker(file: string, out: (line: string) => void): Promise<void> {
  if (!existsSync(file)) return;
  const text = await readFile(file, 'utf8');
  const parsed = parseEnv(text);
  const value = (parsed[DATABASE_URL_VAR] ?? '').trim();
  if (value !== '' && isVaultPlaceholder(value)) return;
  const rewritten = applyEnvEdits(text, [
    { key: DATABASE_URL_VAR, value: VAULT_PLACEHOLDER_LINE },
  ]);
  await writeFile(file, rewritten, { mode: 0o600 });
  out(`  rewrote ${file}: DATABASE_URL=${VAULT_PLACEHOLDER_LINE}`);
}
