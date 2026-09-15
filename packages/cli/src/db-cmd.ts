/**
 * `buddi db up|down|status` — the postgres container, from the one binary.
 *
 * The installation's database is a container in this repo's compose file, and
 * until now the only way to start it was to remember `pnpm db:up` from the repo
 * root. After a reboot with Docker Desktop closed, that is exactly the thing
 * nobody remembers — so it gets a first-class command, and every "database not
 * reachable" message in the codebase points at it.
 *
 * Nothing here parses compose output: `docker compose` already prints a table
 * worth reading, and this is a thin, honest wrapper around it plus one
 * readiness answer.
 */
import {
  DATABASE_URL_VAR,
  DB_PASSWORD_VAR,
  assembleDatabaseUrl,
  databaseDefaults,
} from '@buddi/core';
import { describeDatabaseError, probeDatabase } from '@buddi/gateway';
import type { DbAction } from './args.js';
import { DB_SERVICE, ensureDatabasePassword, runDbSecure } from './db-secure.js';
import { REPO_ROOT } from './paths.js';
import { run, runInherit } from './proc.js';

export { DB_SERVICE };

/**
 * What the rows downstream of the database say when there is no connection.
 * They are not failures of their own — repeating a stack trace per row only
 * buries the one row that matters.
 */
export const DB_UNREACHABLE = 'skipped: database unreachable';

/** What to say when the daemon is down. The one fix, in the one sentence. */
export const DOCKER_DOWN = 'Docker is not running (open -a Docker)';

export type DockerState = 'running' | 'stopped' | 'absent';

/**
 * Is there a Docker *daemon*? `docker --version` answers from the client alone
 * and says "yes" with Docker Desktop closed, which is how a stopped daemon used
 * to read as a healthy row in `buddi doctor`.
 */
export async function dockerState(
  exec: typeof run = run,
): Promise<{ state: DockerState; detail: string }> {
  const version = await exec('docker', ['--version'], { timeoutMs: 15_000 });
  if (version.code === 127) {
    return { state: 'absent', detail: 'not on PATH — needed only for the postgres container' };
  }
  const info = await exec('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeoutMs: 20_000,
  });
  if (info.code !== 0) return { state: 'stopped', detail: DOCKER_DOWN };
  const server = info.stdout.trim();
  const client = (version.stdout || version.stderr).split('\n')[0]?.trim() ?? 'docker';
  return { state: 'running', detail: server === '' ? client : `${client} (engine ${server})` };
}

/**
 * `docker compose …` in the repo, inheriting the terminal so progress shows.
 *
 * The child inherits this process's environment, which is how the generated
 * `BUDDI_DB_PASSWORD` reaches `POSTGRES_PASSWORD` in the compose file without
 * ever being written to `.env` — compose prefers the real environment over the
 * `.env` it reads for itself.
 */
async function compose(args: string[]): Promise<number> {
  return runInherit('docker', ['compose', ...args], { cwd: REPO_ROOT });
}

export async function runDb(
  action: DbAction,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const docker = await dockerState();
  if (docker.state === 'absent') {
    console.error('docker is not installed — https://docs.docker.com/desktop/');
    return 1;
  }
  if (docker.state === 'stopped') {
    console.error(DOCKER_DOWN);
    return 1;
  }

  if (action === 'secure') {
    return runDbSecure({ env });
  }

  if (action === 'up') {
    // First run on a fresh machine: the container is about to be created, and
    // `initdb` reads POSTGRES_PASSWORD exactly once. Generate the password
    // *before* that happens, so a brand-new installation is never built around
    // the one this project shipped with. A vault that already holds one is
    // left alone, which is what makes a second `db up` a no-op.
    const ensured = await ensureDatabasePassword({ env });
    if (ensured) {
      env[DB_PASSWORD_VAR] = ensured.password;
      if (ensured.created) {
        // Nothing has connected yet, so the URL assembled at startup was built
        // around the old default. Re-assemble it before the readiness probe.
        env[DATABASE_URL_VAR] = assembleDatabaseUrl({
          ...databaseDefaults(env),
          password: ensured.password,
        });
        console.log(`generated a database password and stored it as ${DB_PASSWORD_VAR} in the vault`);
      }
    }
    const code = await compose(['up', '-d', DB_SERVICE]);
    if (code !== 0) return code;
    // Started is not the same as accepting connections; wait for the latter,
    // because the next thing the owner types will need it.
    return reportReadiness(env, { waitMs: 30_000 });
  }

  if (action === 'down') {
    return compose(['down']);
  }

  const code = await compose(['ps']);
  if (code !== 0) return code;
  return reportReadiness(env, { waitMs: 0 });
}

/**
 * `pg_isready`, one way or another.
 *
 * Inside the container first — that is the authoritative answer and needs no
 * client installed — then, whatever it said, a connection over the URL the
 * installation actually uses, because a healthy container on an unmapped port
 * is still a broken installation.
 */
async function reportReadiness(
  env: NodeJS.ProcessEnv,
  opts: { waitMs: number },
): Promise<number> {
  const ready = await run(
    'docker',
    ['compose', 'exec', '-T', DB_SERVICE, 'pg_isready', '-U', 'buddi', '-d', 'buddi'],
    { cwd: REPO_ROOT, timeoutMs: 20_000 },
  );
  const line = (ready.stdout || ready.stderr).trim().split('\n')[0];
  console.log(`pg_isready: ${line === '' || line === undefined ? `exit ${ready.code}` : line}`);

  const url = env.DATABASE_URL;
  const deadline = Date.now() + opts.waitMs;
  for (;;) {
    try {
      await probeDatabase(url);
      console.log(`connected: ${url ? redact(url) : '(DATABASE_URL unset)'}`);
      return 0;
    } catch (err) {
      if (Date.now() >= deadline) {
        console.error(describeDatabaseError(err, url));
        return 1;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

/** A connection string without its password; command output gets pasted around. */
function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url.replace(/:\/\/[^@]*@/, '://***@');
  }
}
