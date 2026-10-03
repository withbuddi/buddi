#!/usr/bin/env node
/**
 * `pnpm test:db [-- --filter <pkg>...] [-- --keep]`: the suites against a
 * throwaway Postgres, never the dev database.
 *
 * Starts a `postgres:16` container under a unique name on a free port, waits
 * until it takes connections, migrates it with scripts/migrate.mjs, then runs
 * `pnpm test` (or `pnpm --filter <pkg> test` for each `--filter`). The
 * container is removed afterwards, on failure and on Ctrl-C too; `--keep`
 * leaves it running and prints how to reach and remove it. Exits with the
 * suite's code.
 *
 * The environment every step gets:
 *   DATABASE_URL        postgres://postgres:test@127.0.0.1:<port>/buddi
 *   BUDDI_VAULT         memory (no step touches the keychain)
 *   BUDDI_PLUGINS_FILE  node_modules/.cache/buddi-test-db/<name>/plugins.json
 *                       (a scratch file, deliberately not under $TMPDIR: the
 *                       developer plugin deny-lists that folder)
 *
 * Refuses when Docker is missing or not running, and when DATABASE_URL in the
 * calling environment already points at port 55433 (the dev database).
 * Migration reads the built packages: run `pnpm -r build` first when they are stale.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_PORT = '55433';

/** `--filter <pkg>` (repeatable, also `--filter=<pkg>`) and `--keep`; a bare `--` is ignored. */
export function parseArgs(argv) {
  const filters = [];
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--keep') keep = true;
    else if (a === '--filter' || a === '-F') {
      const pkg = argv[++i];
      if (!pkg || pkg.startsWith('-')) throw new Error('--filter needs a package name.');
      filters.push(pkg);
    } else if (a.startsWith('--filter=')) filters.push(a.slice('--filter='.length));
    else throw new Error(`Unknown argument "${a}". Usage: pnpm test:db [-- --filter <pkg>...] [-- --keep]`);
  }
  return { filters, keep };
}

/** True when a DATABASE_URL names port 55433. */
export function pointsAtDev(url) {
  if (!url) return false;
  try { return new URL(url).port === DEV_PORT; }
  catch { return url.includes(`:${DEV_PORT}`); }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The step running now, in its own process group so a signal reaches every process under it. */
let current;

function runChild(cmd, args, env) {
  return new Promise((resolve) => {
    console.log(`$ ${[cmd, ...args].join(' ')}`);
    const child = spawn(cmd, args, { cwd: root, env, stdio: 'inherit', detached: process.platform !== 'win32', shell: process.platform === 'win32' });
    current = child;
    child.on('exit', (code, signal) => { current = undefined; resolve(code ?? (signal ? 1 : 0)); });
    child.on('error', () => { current = undefined; resolve(1); });
  });
}

function stopCurrent(sig) {
  if (!current?.pid) return;
  try { process.kill(-current.pid, sig); } catch { /* already gone */ }
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); return 2; }

  if (pointsAtDev(process.env.DATABASE_URL)) {
    console.error(`DATABASE_URL points at port ${DEV_PORT}, the dev database. Unset it: test:db brings its own.`);
    return 1;
  }
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
  if (docker.error) {
    console.error('Docker is not installed (no `docker` on PATH). test:db needs it to start a throwaway Postgres.');
    return 1;
  }
  if (docker.status !== 0) {
    console.error('Docker is installed but not running. Start Docker Desktop (or the daemon), then try again.');
    return 1;
  }
  if (!existsSync(path.join(root, 'packages', 'core', 'dist'))) {
    console.error('packages/core is not built, and migration needs it: run `pnpm -r build` first.');
    return 1;
  }

  const name = `buddi-test-pg-${process.pid}-${randomBytes(3).toString('hex')}`;
  const scratch = path.join(root, 'node_modules', '.cache', 'buddi-test-db', name);
  let removed = false;
  const cleanup = () => {
    if (opts.keep) return;
    if (!removed) {
      removed = true;
      spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' });
    }
    rmSync(scratch, { recursive: true, force: true });
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      console.error(`\n${sig}: stopping the suite and removing ${name}.`);
      stopCurrent(sig);
      cleanup();
      process.exit(130);
    });
  }

  try {
    let port;
    let started = false;
    for (let attempt = 0; attempt < 3 && !started; attempt++) {
      port = await freePort();
      const r = spawnSync('docker', [
        'run', '-d', '--rm', '--name', name,
        '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=buddi',
        '-p', `127.0.0.1:${port}:5432`, 'postgres:16',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      started = r.status === 0;
      // A port taken between the check and the run: drop the half-made container and pick again.
      if (!started) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    }
    if (!started) { console.error('Could not start the postgres:16 container.'); return 1; }
    console.log(`Postgres ${name} on 127.0.0.1:${port}`);

    // Over TCP inside the container: the init-time server listens on the socket only,
    // so this answers once the real server is up.
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      ready = spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'buddi'], { stdio: 'ignore' }).status === 0;
      if (!ready) await sleep(500);
    }
    if (!ready) { console.error(`${name} did not take connections within 60 seconds.`); return 1; }

    mkdirSync(scratch, { recursive: true });
    const env = {
      ...process.env,
      DATABASE_URL: `postgres://postgres:test@127.0.0.1:${port}/buddi`,
      BUDDI_VAULT: 'memory',
      BUDDI_PLUGINS_FILE: path.join(scratch, 'plugins.json'),
    };

    const migrated = await runChild(process.execPath, [path.join(root, 'scripts', 'migrate.mjs')], env);
    if (migrated !== 0) { console.error('Migration failed.'); return migrated; }

    let code = 0;
    if (opts.filters.length === 0) {
      code = await runChild('pnpm', ['test'], env);
    } else {
      for (const pkg of opts.filters) {
        const c = await runChild('pnpm', ['--fail-if-no-match', '--filter', pkg, 'test'], env);
        if (c !== 0 && code === 0) code = c;
      }
    }
    if (opts.keep) {
      console.log(`\nKept ${name}: DATABASE_URL=${env.DATABASE_URL}`);
      console.log(`Remove it with: docker rm -f ${name}`);
    }
    return code;
  } finally {
    cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
