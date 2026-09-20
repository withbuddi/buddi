#!/usr/bin/env node
/** Real isolated npm install + managed cluster. Never opens a browser or installs a service. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { dashboardReady, reloadLaunchAgent } from '../../packages/install/dist/environment.js';

const exec = promisify(execFile);
const archive = process.argv[2];
if (!archive) throw new Error('Usage: node scripts/release/smoke.mjs /absolute/path/buddi-version.tgz');
const testRoot = await mkdtemp(path.join(os.tmpdir(), 'buddi-smoke-'));
const data = path.join(testRoot, 'owner data');
const serviceTest = process.argv.includes('--service');
if (serviceTest && process.platform !== 'darwin') throw new Error('--service smoke is macOS-only');
const label = `com.buddi.install.${createHash('sha256').update(data).digest('hex').slice(0, 12)}`;
const launchTarget = `gui/${process.getuid?.()}/${label}`;
const startArgs = serviceTest ? ['--no-open'] : ['--no-service', '--no-open'];
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(BUDDI_|DATABASE_URL$|TELEGRAM_|ANTHROPIC_|OPENAI_|CLAUDE_|GMAIL_)/.test(name)));
Object.assign(env, { BUDDI_DATA_DIR: data, BUDDI_VAULT: 'file' });
let pid;
console.log(`Isolated smoke directory: ${testRoot}`);
try {
  await mkdir(data, { recursive: true, mode: 0o700 });
  // The launchd fixture must also select the isolated file vault after login.
  await writeFile(path.join(data, '.env'), 'BUDDI_VAULT=file\n', { mode: 0o600 });
  await exec('npm', ['install', '--prefix', testRoot, '--ignore-scripts', '--no-audit', '--no-fund', archive], { env, timeout: 120_000 });
  const entry = path.join(testRoot, 'node_modules/buddi/packages/install/dist/launcher.js');
  const cli = async args => (await exec(process.execPath, [entry, ...args], { env, cwd: testRoot, timeout: 150_000 })).stdout;
  const start = await cli(startArgs);
  const status = JSON.parse(await cli(['service', 'status'])); pid = status.supervisorPid;
  assert.equal(status.database, 'running'); assert.equal(status.gateway, 'running');
  const require = createRequire(path.join(testRoot, 'node_modules/buddi/package.json'));
  const core = await import(require.resolve('@buddi/core'));
  const vault = core.createVault({ env: { BUDDI_VAULT: 'file', BUDDI_VAULT_FILE: path.join(data, 'vault.json'), BUDDI_VAULT_KEY: (await readFile(path.join(data, 'vault-key'), 'utf8')).trim() } });
  const password = await vault.get('BUDDI_DB_PASSWORD');
  assert.equal(await readFile(path.join(data, '.initdb-password'), 'utf8').catch(error => error.code), 'ENOENT');
  const initialState = JSON.parse(await readFile(path.join(data, 'installation.json'), 'utf8'));
  const { Client } = require('pg');
  const connection = { host: '127.0.0.1', port: initialState.dbPort, user: 'buddi', password, database: 'buddi' };
  const database = new Client(connection);
  await database.connect();
  try {
    const privileges = await database.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
    assert.equal(privileges.rows[0].rolsuper, false);
    await database.query('CREATE TABLE public.smoke_preservation (value text NOT NULL)');
    await database.query("INSERT INTO public.smoke_preservation VALUES ('keep across restarts')");
  } finally { await database.end(); }
  const dashboard = new URL(start.match(/Dashboard: (.+)/)[1]);
  assert.equal(await dashboardReady(initialState.webPort, await vault.get('BUDDI_WEB_TOKEN')), true);
  assert.equal(await dashboardReady(initialState.webPort, 'different-install'), false);
  const unauth = await fetch(new URL('/api/session', dashboard)); assert.equal(unauth.status, 401);
  const login = await fetch(dashboard, { redirect: 'manual' }); assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const assets = await fetch(new URL('/', dashboard), { headers: { cookie } });
  assert.equal(assets.status, 200); assert.match(await assets.text(), /<html/);
  assert.equal((await fetch(dashboard, { redirect: 'manual' })).status, 401, 'ticket cannot be replayed');
  const again = await cli(startArgs); assert.match(again, /Dashboard:/);
  const repeated = JSON.parse(await cli(['service', 'status']));
  assert.equal(repeated.supervisorPid, pid); assert.equal(repeated.databasePid, status.databasePid);
  const stopped = JSON.parse(await cli(['service', 'stop']));
  assert.equal(stopped.gateway, 'stopped'); assert.equal(stopped.databasePid, status.databasePid);
  // A different application at the persisted dashboard port must not look ready.
  const impostor = createServer((_req, res) => { res.writeHead(401); res.end(); });
  await new Promise((resolve, reject) => { impostor.once('error', reject); impostor.listen(initialState.webPort, '127.0.0.1', resolve); });
  try {
    assert.equal(await dashboardReady(initialState.webPort, await vault.get('BUDDI_WEB_TOKEN')), false);
    const conflicting = JSON.parse(await cli(['service', 'start']));
    for (let i = 0; i < 100; i++) {
      try { process.kill(conflicting.gatewayPid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.throws(() => process.kill(conflicting.gatewayPid, 0), /ESRCH/, 'required dashboard bind failure terminates the gateway');
    await cli(['service', 'stop']);
  } finally { await new Promise(resolve => impostor.close(resolve)); }
  const service = new URL(start.match(/Service controls: (.+)/)[1]);
  const controlUnauth = await fetch(new URL('/status', service)); assert.equal(controlUnauth.status, 401);
  const controlLogin = await fetch(service, { redirect: 'manual' });
  const controlCookie = controlLogin.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const denied = await fetch(new URL('/start', service), { method: 'POST', headers: { cookie: controlCookie, origin: service.origin } });
  assert.equal(denied.status, 403, 'browser writes require CSRF');
  const page = await fetch(new URL('/', service), { headers: { cookie: controlCookie } });
  const html = await page.text();
  const csrf = html.match(/'x-buddi-csrf':'([^']+)'/)[1];
  assert.notEqual(html.match(/<script nonce="([^"]+)"/)[1], csrf, 'CSP nonce is independent of CSRF');
  const started = await fetch(new URL('/start', service), { method: 'POST', headers: { cookie: controlCookie, origin: service.origin, 'x-buddi-csrf': csrf } });
  assert.equal(started.status, 200);
  const restarted = await started.json();
  assert.equal(restarted.databasePid, status.databasePid); assert.notEqual(restarted.gatewayPid, status.gatewayPid);
  // Crash recovery is distinct from an intentional stop.
  process.kill(restarted.gatewayPid, 'SIGKILL');
  let recovered;
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    recovered = JSON.parse(await cli(['service', 'status']));
    if (recovered.gateway === 'running' && recovered.gatewayPid !== restarted.gatewayPid) break;
  }
  assert.equal(recovered.gateway, 'running'); assert.notEqual(recovered.gatewayPid, restarted.gatewayPid);
  // The supervisor itself dies: the IPC gateway stops, but the same authenticated
  // cluster can be adopted without initdb, duplicated gateways, or data loss.
  process.kill(pid, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 2500));
  await cli(startArgs);
  const adopted = JSON.parse(await cli(['service', 'status'])); pid = adopted.supervisorPid;
  assert.notEqual(adopted.supervisorPid, recovered.supervisorPid);
  // launchd can reap the complete job's process group after supervisor death.
  // Detached mode must adopt; under launchd a clean cluster restart is valid too.
  if (!serviceTest) assert.equal(adopted.databasePid, recovered.databasePid);
  assert.equal(adopted.database, 'running');
  if (!serviceTest) {
    // This server has no child exit listener in its new supervisor: exercise the probe.
    process.kill(adopted.databasePid, 'SIGINT');
    for (let i = 0; i < 150; i++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'adopted database failure stops supervisor');
    assert.throws(() => process.kill(adopted.gatewayPid, 0), /ESRCH/, 'adopted database failure stops gateway');
    await cli(startArgs);
    pid = JSON.parse(await cli(['service', 'status'])).supervisorPid;
  } else {
    // Reload a currently loaded job, not just the missing-job bootstrap path.
    const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
    const unit = await readFile(plist, 'utf8');
    await writeFile(plist, unit.replace('<string>supervise</string>', '<string>supervise</string><string>--reload-fixture</string>'));
    await reloadLaunchAgent(exec, `gui/${process.getuid()}`, label, plist);
    let replacement;
    for (let i = 0; i < 200; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try {
        replacement = JSON.parse(await cli(['service', 'status']));
        if (replacement.supervisorPid !== pid) break;
      } catch { /* launchd is replacing the old process */ }
    }
    assert.ok(replacement && replacement.supervisorPid !== pid, 'active job was replaced');
    pid = replacement.supervisorPid;
    assert.match((await exec('launchctl', ['print', launchTarget])).stdout, /--reload-fixture/, 'launchd loaded the new arguments');
    await cli(startArgs);
  }
  if (serviceTest) await exec('launchctl', ['bootout', launchTarget]);
  else process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  pid = undefined;
  const stateFile = path.join(data, 'installation.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.phase = 'migrating';
  await writeFile(stateFile, JSON.stringify(state));
  // Exercise server-side SQL literal quoting, not only generated base64url passwords.
  const rotated = "fixture'quote\\slash-and-new-password";
  await vault.set('BUDDI_DB_PASSWORD', rotated);
  connection.password = rotated;
  await cli(startArgs);
  const rebooted = JSON.parse(await cli(['service', 'status'])); pid = rebooted.supervisorPid;
  assert.equal(rebooted.phase, 'ready');
  assert.equal((await readFile(path.join(data, 'postgres/PG_VERSION'), 'utf8')).trim(), '18');
  const preserved = new Client(connection);
  await preserved.connect();
  try { assert.deepEqual((await preserved.query('SELECT value FROM public.smoke_preservation')).rows, [{ value: 'keep across restarts' }]); }
  finally { await preserved.end(); }
  console.log('PASS: clean npm install, no scripts, private Postgres, install-specific readiness, authenticated dashboard, replay/CSRF rejection, idempotent start, gateway/supervisor crash recovery, password rotation, migration-phase restart' + (serviceTest ? ', LaunchAgent lifecycle.' : ', adopted database death.'));
} catch (error) {
  // Print only logs owned by this isolated fixture, never the live installation.
  for (const name of ['supervisor', 'gateway', 'postgres']) {
    const text = await readFile(path.join(data, 'logs', `${name}.log`), 'utf8').catch(() => '');
    if (text) console.error(`${name}: ${text.slice(-5000)}`);
  }
  throw error;
} finally {
  if (serviceTest) {
    await exec('launchctl', ['bootout', launchTarget]).catch(() => {});
    // Only the LaunchAgent created for this exact random test directory.
    await unlink(path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)).catch(() => {});
  }
  if (!pid) {
    const lock = await readFile(path.join(data, 'supervisor.lock'), 'utf8').catch(() => '');
    if (/^\d+$/.test(lock)) pid = Number(lock);
  }
  if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  if (pid) for (let i = 0; i < 200; i++) {
    try { process.kill(pid, 0); } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log(`Test data retained for inspection: ${testRoot}`);
}
