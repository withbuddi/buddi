#!/usr/bin/env node
/** Real isolated npm install + managed cluster. Never opens a browser or installs a service. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
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
/*
 * A port nobody wanted.
 *
 * The launcher prefers 4317, which is the port the owner's own installation
 * and the Docker trial listen on — so a smoke that takes it makes the machine
 * unusable for the thing the smoke is testing, and a fixture left behind holds
 * it until somebody hunts down the pid. The kernel picks a free one instead,
 * and `freePort` starts from it.
 */
const webPort = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
Object.assign(env, { BUDDI_DATA_DIR: data, BUDDI_VAULT: 'file', BUDDI_WEB_PORT: String(webPort) });
let pid;

/**
 * Stop the fixture even when this script is killed.
 *
 * The `finally` below covers a failure; it does not cover ^C, and a supervisor
 * that outlives the run keeps a port and a Postgres of its own. The pid is
 * read from the lock file because the variable may not be set yet.
 */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    let victim = pid;
    if (!victim) {
      try { victim = Number(readFileSync(path.join(data, 'supervisor.lock'), 'utf8').trim()); } catch {}
    }
    if (victim) { try { process.kill(victim, 'SIGTERM'); } catch {} }
    console.error(`\n${signal}: stopped the smoke fixture${victim ? ` (pid ${victim})` : ''}; data is at ${testRoot}`);
    process.exit(130);
  });
}
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
  /*
   * First run, as the wizard drives it. No model call is made here — the chat
   * step is the one thing this cannot exercise — so it goes as far as the API
   * does: what is still needed, a step recorded, the first agent written and
   * loaded, and the record closed.
   */
  const wizardCsrf = decodeURIComponent(cookie.match(/buddi_csrf=([^;]+)/)[1]);
  const wizardHeaders = { cookie, origin: dashboard.origin, 'x-buddi-csrf': wizardCsrf, 'content-type': 'application/json' };
  const onboarding = async () => (await fetch(new URL('/api/onboarding', dashboard), { headers: { cookie } })).json();
  const firstRun = await onboarding();
  assert.equal(firstRun.state, 'pending');
  assert.equal(firstRun.needs.model, true, 'a fresh install has no model account');
  // And no ghost of one: the legacy accounts are named after environment
  // variables, and a packaged install has none of them set.
  const accountsView = await (await fetch(new URL('/api/provider-accounts', dashboard), { headers: { cookie } })).json();
  assert.deepEqual(accountsView.accounts, [], 'a fresh install starts with zero model accounts');
  assert.equal((await fetch(new URL('/api/onboarding/step', dashboard), { method: 'POST', headers: { cookie, origin: dashboard.origin }, body: '{}' })).status, 403, 'first-run writes require CSRF');
  const stepped = await fetch(new URL('/api/onboarding/step', dashboard), { method: 'POST', headers: wizardHeaders, body: JSON.stringify({ step: 'welcome' }) });
  assert.equal(stepped.status, 200);
  assert.deepEqual((await stepped.json()).stepsDone, ['welcome']);
  // A step may carry what its name cannot: which conversation the owner met
  // their assistant in. That is what a reload mid-handover reads back, so the
  // assistant introduces itself exactly once.
  const learned = await fetch(new URL('/api/onboarding/step', dashboard), { method: 'POST', headers: wizardHeaders, body: JSON.stringify({ step: 'hello', conversationId: 'c-smoke' }) });
  assert.equal(learned.status, 200);
  assert.equal((await learned.json()).details.conversationId, 'c-smoke');
  assert.equal((await onboarding()).details.conversationId, 'c-smoke');
  const madeAgent = await fetch(new URL('/api/onboarding/agent', dashboard), {
    method: 'POST', headers: wizardHeaders,
    body: JSON.stringify({ name: 'Smoke', handle: 'smoke', description: 'The agent this release smoke test creates.' }),
  });
  const madeText = await madeAgent.text();
  assert.equal(madeAgent.status, 200, madeText);
  const madeBody = JSON.parse(madeText);
  // The first agent *is* the shipped Concierge, renamed: same id, the owner's
  // handle, and one assistant on the roster rather than two.
  assert.equal(madeBody.id, 'concierge');
  assert.equal(madeBody.handle, 'smoke');
  assert.equal(madeBody.live, true, 'the running catalog reloaded the new agent');
  assert.equal(madeBody.agent.isDefault, true, 'the first private agent is the default one');
  assert.equal(madeBody.agent.name, 'Smoke', 'the shipped Concierge is not listed beside it');
  const roster = await (await fetch(new URL('/api/agents', dashboard), { headers: { cookie } })).json();
  assert.ok(roster.agents.some(agent => agent.handle === 'smoke'), 'the new agent is in /api/agents');
  assert.ok(!roster.agents.some(agent => agent.name === 'Concierge'), 'the example it replaced is gone');
  assert.ok(!roster.agents.some(agent => agent.id === 'agent-father'), 'Agent Father waits for an account and an assistant');
  const file = await readFile(path.join(data, 'agents/concierge/agent.md'), 'utf8');
  assert.match(file, /language: mirror/);
  assert.match(file, /handle: smoke/);
  /*
   * Is Ollama there? The *gateway* answers, because the dashboard bundle
   * reaches no host but its own. Nothing here asserts which answer: a
   * machine running Ollama and one that never heard of it are both fine, and
   * what matters is that the route answers rather than hanging or throwing.
   */
  const ollama = await fetch(new URL('/api/onboarding/ollama', dashboard), { headers: { cookie } });
  assert.equal(ollama.status, 200);
  const ollamaBody = await ollama.json();
  assert.equal(typeof ollamaBody.running, 'boolean', 'the Ollama probe says whether it is running');
  assert.ok(Array.isArray(ollamaBody.models), 'the Ollama probe lists models');
  // Telegram, from the dashboard: behind the same CSRF gate as every write,
  // and refusing a pasted string that is not a bot token.
  assert.equal((await fetch(new URL('/api/telegram/token', dashboard), { method: 'POST', headers: { cookie, origin: dashboard.origin }, body: '{}' })).status, 403, 'the Telegram token requires CSRF');
  const notAToken = await fetch(new URL('/api/telegram/token', dashboard), { method: 'POST', headers: wizardHeaders, body: JSON.stringify({ token: 'nope' }) });
  assert.equal(notAToken.status, 400);
  // "Done" has to mean done: with no model account this is refused, and the
  // skip below is the explicit way past it.
  const tooSoon = await fetch(new URL('/api/onboarding/complete', dashboard), { method: 'POST', headers: wizardHeaders, body: '{}' });
  assert.equal(tooSoon.status, 409);
  assert.match((await tooSoon.json()).error, /model account/);
  const skippedRun = await fetch(new URL('/api/onboarding/skip', dashboard), { method: 'POST', headers: wizardHeaders, body: '{}' });
  assert.equal(skippedRun.status, 200);
  assert.equal((await skippedRun.json()).state, 'skipped');
  // A skipped install with nothing set up does not become "finished" by asking.
  const lateComplete = await fetch(new URL('/api/onboarding/complete', dashboard), { method: 'POST', headers: wizardHeaders, body: '{}' });
  assert.equal(lateComplete.status, 409, 'a skipped install with no model account is still not finished');
  const afterSkip = await onboarding();
  assert.equal(afterSkip.state, 'skipped');
  assert.equal(afterSkip.needs.agent, false, 'the agent it wrote counts as the owner\'s own');
  const again = await cli(startArgs); assert.match(again, /Dashboard:/);
  const repeated = JSON.parse(await cli(['service', 'status']));
  assert.equal(repeated.supervisorPid, pid); assert.equal(repeated.databasePid, status.databasePid);
  const stopped = JSON.parse(await cli(['service', 'stop']));
  assert.equal(stopped.gateway, 'stopped'); assert.equal(stopped.databasePid, status.databasePid);
  // A different application at the persisted dashboard port must not look ready.
  const impostor = createHttpServer((_req, res) => { res.writeHead(401); res.end(); });
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
  // The supervisor is controlled over an owner-only socket, and the dashboard
  // is its second client: the same switches, behind the session and CSRF gate.
  const socket = path.join(data, 'supervisor.sock');
  assert.equal(((await stat(socket)).mode & 0o777).toString(8), '600', 'the control socket is owner-only');
  // The gateway was left stopped above; this also mints a fresh dashboard link,
  // because a restarted gateway keeps no session from the one before it.
  const resumed = await cli(startArgs);
  const live = new URL(resumed.match(/Dashboard: (.+)/)[1]);
  assert.equal((await fetch(new URL('/api/service', live))).status, 401, 'the service view needs a session');
  const liveLogin = await fetch(live, { redirect: 'manual' }); assert.equal(liveLogin.status, 302);
  const liveCookie = liveLogin.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const cliStatus = JSON.parse(await cli(['service', 'status']));
  const viewed = await fetch(new URL('/api/service', live), { headers: { cookie: liveCookie } });
  assert.equal(viewed.status, 200);
  const view = await viewed.json();
  assert.equal(view.supervised, true);
  assert.equal(view.status.gatewayPid, cliStatus.gatewayPid);
  assert.equal(view.status.databasePid, cliStatus.databasePid);
  const csrf = decodeURIComponent(liveCookie.match(/buddi_csrf=([^;]+)/)[1]);
  const origin = live.origin;
  const refused = await fetch(new URL('/api/service/restart', live), { method: 'POST', headers: { cookie: liveCookie, origin } });
  assert.equal(refused.status, 403, 'dashboard writes require CSRF');
  // A restart ends the gateway that accepted it, so it is accepted and then
  // performed; the CLI is what can still see the outcome.
  const started = await fetch(new URL('/api/service/restart', live), { method: 'POST', headers: { cookie: liveCookie, origin, 'x-buddi-csrf': csrf } });
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), { supervised: true, pending: 'restart' });
  let restarted;
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    restarted = JSON.parse(await cli(['service', 'status']));
    if (restarted.gateway === 'running' && restarted.gatewayPid !== cliStatus.gatewayPid) break;
  }
  assert.equal(restarted.gateway, 'running');
  assert.notEqual(restarted.gatewayPid, cliStatus.gatewayPid, 'the dashboard restart replaced the gateway');
  assert.equal(restarted.databasePid, status.databasePid, 'the database is untouched by a gateway restart');
  // Crash recovery is distinct from an intentional stop.
  process.kill(restarted.gatewayPid, 'SIGKILL');
  let recovered;
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    recovered = JSON.parse(await cli(['service', 'status']));
    if (recovered.gateway === 'running' && recovered.gatewayPid !== restarted.gatewayPid) break;
  }
  assert.equal(recovered.gateway, 'running'); assert.notEqual(recovered.gatewayPid, restarted.gatewayPid);
  // The supervisor itself dies: the IPC gateway stops. The next supervisor stops
  // the postmaster left behind on its cluster and starts its own in its place —
  // never adopting it — without initdb, duplicated gateways, or data loss.
  process.kill(pid, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 2500));
  await cli(startArgs);
  const successor = JSON.parse(await cli(['service', 'status'])); pid = successor.supervisorPid;
  assert.notEqual(successor.supervisorPid, recovered.supervisorPid);
  assert.equal(recovered.database, 'running'); assert.equal(successor.database, 'running');
  assert.notEqual(successor.databasePid, recovered.databasePid, 'a leftover postmaster is restarted, not adopted');
  const survived = new Client(connection);
  await survived.connect();
  try { assert.deepEqual((await survived.query('SELECT value FROM public.smoke_preservation')).rows, [{ value: 'keep across restarts' }]); }
  finally { await survived.end(); }
  if (!serviceTest) {
    // The database child dies under its own supervisor: gateway and supervisor
    // follow it down, and the launcher starts the installation again cleanly.
    process.kill(successor.databasePid, 'SIGINT');
    for (let i = 0; i < 150; i++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'database failure stops supervisor');
    assert.throws(() => process.kill(successor.gatewayPid, 0), /ESRCH/, 'database failure stops gateway');
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
  console.log('PASS: clean npm install, no scripts, private Postgres, install-specific readiness, authenticated dashboard, replay/CSRF rejection, owner-only 0600 control socket, dashboard service view agreeing with the CLI, idempotent start, gateway/supervisor crash recovery, password rotation, migration-phase restart, leftover postmaster restarted rather than adopted, first-run API through to a loaded first agent, the local-AI probe, the handover conversation on the record and the Telegram token gate, unfinished setup refusing to call itself done' + (serviceTest ? ', LaunchAgent lifecycle.' : ', database death ends the supervisor.'));
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
