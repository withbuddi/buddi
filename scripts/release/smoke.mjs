#!/usr/bin/env node
/** Real isolated npm install + managed cluster. Never opens a browser or installs a service. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, unlink, stat, copyFile, cp, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
const freeLocalPort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const webPort = await freeLocalPort();
/*
 * The one thing a plugin fixture needs from outside: a file to write when its
 * code first runs. It is set here, before the first supervisor starts, because
 * the gateway inherits the supervisor's environment and the plugin section
 * below asserts on a gateway that was started long before it.
 */
const markerFile = path.join(testRoot, 'plugin-marker.log');
Object.assign(env, { BUDDI_DATA_DIR: data, BUDDI_VAULT: 'file', BUDDI_WEB_PORT: String(webPort), BUDDI_FIXTURE_MARKER: markerFile });
let pid;
/* The second installation the backup is restored into. Stopped like the first. */
const restored = path.join(testRoot, 'restored data');
let pidB;

/**
 * Stop the fixture even when this script is killed.
 *
 * The `finally` below covers a failure; it does not cover ^C, and a supervisor
 * that outlives the run keeps a port and a Postgres of its own. The pid is
 * read from the lock file because the variable may not be set yet.
 */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    const victims = [];
    for (const [held, dir] of [[pid, data], [pidB, restored]]) {
      let victim = held;
      if (!victim) {
        try { victim = Number(readFileSync(path.join(dir, 'supervisor.lock'), 'utf8').trim()); } catch {}
      }
      if (victim) { try { process.kill(victim, 'SIGTERM'); victims.push(victim); } catch {} }
    }
    console.error(`\n${signal}: stopped the smoke fixture${victims.length ? ` (pid ${victims.join(', ')})` : ''}; data is at ${testRoot}`);
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
  /* ================================================================ *
   * A → B: back one installation up, restore it into another.
   *
   * Everything below goes through the dashboard's HTTP API and the
   * supervisor's control socket, which is what an owner's browser and the
   * supervisor itself use. Nothing shells out to `age`, `tar`, `pg_dump` or
   * `psql`, and no model is ever called: the content planted on A is written
   * the way the owner writes it (the API) or, where a route would need a
   * model, straight into the database this fixture owns.
   * ================================================================ */

  /** One JSON call on a supervisor's control socket, the owner-only way in. */
  const socketCall = (socketPath, route, method = 'GET', payload) => new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
    const call = httpRequest({
      socketPath, path: route, method,
      headers: { host: 'localhost', ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, body: text === '' ? null : JSON.parse(text) });
      });
    });
    call.on('error', reject);
    if (body) call.write(body);
    call.end();
  });

  /** A fresh dashboard session: the ticket the launcher mints, spent once. */
  const signIn = async runCli => {
    const url = new URL((await runCli(startArgs)).match(/Dashboard: (.+)/)[1]);
    const opened = await fetch(url, { redirect: 'manual' });
    assert.equal(opened.status, 302, 'the launcher minted a dashboard ticket');
    const jar = opened.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const token = decodeURIComponent(jar.match(/buddi_csrf=([^;]+)/)[1]);
    const at = route => new URL(route, url);
    return {
      origin: url.origin,
      get: async route => fetch(at(route), { headers: { cookie: jar } }),
      send: async (route, payload, method = 'POST') => fetch(at(route), {
        method,
        headers: { cookie: jar, origin: url.origin, 'x-buddi-csrf': token, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      upload: async (route, bytes, headers) => fetch(at(route), {
        method: 'POST',
        headers: { cookie: jar, origin: url.origin, 'x-buddi-csrf': token, 'content-type': 'application/octet-stream', ...headers },
        body: bytes,
      }),
    };
  };

  /** Terminal phases, as Task C landed them. */
  const ENDED = new Set(['done', 'failed', 'rolled-back']);
  /**
   * Poll a job to its end on the control socket.
   *
   * The socket rather than the dashboard, because a restore stops the gateway:
   * the job id stays valid across that, but the HTTP route serving it does not.
   */
  const awaitJob = async (socketPath, id, seconds = 420) => {
    for (let i = 0; i < seconds * 4; i++) {
      const reply = await socketCall(socketPath, `/jobs/${id}`);
      if (reply.status === 200 && ENDED.has(reply.body.phase)) return reply.body;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`job ${id} never finished`);
  };
  /** `wanted` appears in `phases`, in this order, with anything in between. */
  const isSubsequence = (wanted, phases) => {
    let at = 0;
    for (const phase of phases) if (phase === wanted[at]) at++;
    return at === wanted.length;
  };
  /** One query against an installation's own database, connection closed after. */
  const ask = async (settings, sql, values = []) => {
    const client = new Client(settings);
    await client.connect();
    try { return (await client.query(sql, values)).rows; } finally { await client.end(); }
  };
  const countRows = async settings => {
    const [row] = await ask(settings, `select
      (select count(*) from core.conversations)::int as conversations,
      (select count(*) from core.messages)::int as messages,
      (select count(*) from core.artifacts)::int as artifacts,
      (select count(*) from core.jobs)::int as jobs,
      (select count(*) from memory.preferences)::int as preferences`);
    return row;
  };

  const socketA = path.join(data, 'supervisor.sock');
  const a = await signIn(cli);

  /* 1. Something worth losing: an account, a profile, a memory, a second
   * agent, an artifact, a conversation, and one job left on the queue. */
  const savedAccount = await a.send('/api/provider-accounts/save', {
    label: 'Smoke model', kind: 'anthropic', auth: 'api-key',
    defaultModel: 'claude-sonnet-5', enabled: true, secret: 'sk-ant-smoke-never-used',
  });
  assert.equal(savedAccount.status, 200, await savedAccount.clone().text());
  const named = await a.send('/api/owner', { preferredName: 'Smoke Owner' });
  assert.equal(named.status, 200);
  const remembered = await a.send('/api/memory/preferences', { key: 'smoke_note', value: 'restores are tested, not hoped for' });
  assert.equal(remembered.status, 200);
  await mkdir(path.join(data, 'agents/smoke-two'), { recursive: true });
  await writeFile(
    path.join(data, 'agents/smoke-two/agent.md'),
    '---\nid: smoke-two\nhandle: two\nname: Smoke Two\ndescription: The second agent, written before the backup.\ntools: []\n---\n\nYou are Smoke Two. Today is {{today}}.\n',
  );
  const artifactBytes = Buffer.from('the bytes an artifact is made of\n');
  const artifactSha = createHash('sha256').update(artifactBytes).digest('hex');
  const artifactRel = `artifacts/2026/09/${artifactSha}.txt`;
  await mkdir(path.dirname(path.join(data, artifactRel)), { recursive: true });
  await writeFile(path.join(data, artifactRel), artifactBytes);
  await ask(connection, `insert into core.artifacts (kind, mime, filename, size_bytes, sha256, storage_path, created_by)
    values ('document', 'text/plain', 'smoke.txt', $1, $2, $3, 'owner')`, [artifactBytes.length, artifactSha, artifactRel]);
  const [conversation] = await ask(connection, `insert into core.conversations (agent_id) values ('concierge') returning id`);
  for (const [role, text] of [['user', 'what did we decide?'], ['assistant', 'to keep a backup that restores']]) {
    await ask(connection, `insert into core.messages (conversation_id, role, content) values ($1, $2, $3::jsonb)`,
      [conversation.id, role, JSON.stringify([{ type: 'text', text }])]);
  }
  /*
   * A job left queued, to prove recovery holds it.
   *
   * Paused first, because A's own worker would claim it within a second and
   * the archive would then carry a finished job rather than a waiting one.
   * The pause travels in the dump and is lifted on B before the wait, so what
   * is measured there is recovery mode and nothing else. The agent it names
   * does not exist, so claiming it fails in the catalog and no model is called.
   */
  await ask(connection, `insert into core.system_flags (key, value, updated_at) values ('paused', 'true'::jsonb, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`);
  const [planted] = await ask(connection, `insert into core.jobs (kind, payload, state, max_attempts, dedup_key)
    values ('agent-run', $1::jsonb, 'pending', 1, 'smoke-recovery') returning id`,
    [JSON.stringify({ agentId: 'no-such-agent-smoke', prompt: 'planted before the backup' })]);

  /* 2. The backup, encrypted with the passphrase this installation keeps. */
  const passphrase = (await (await a.get('/api/backups/passphrase')).json()).passphrase;
  assert.match(passphrase, /\S/, 'the installation keeps a backup passphrase');
  const backupStarted = await a.send('/api/backups', { encrypt: true });
  assert.equal(backupStarted.status, 202);
  const backupJob = await awaitJob(socketA, (await backupStarted.json()).job.id);
  assert.equal(backupJob.phase, 'done', backupJob.error ?? '');
  const archiveName = backupJob.report.archive;
  assert.match(archiveName, /^buddi-backup-\d{8}-\d{6}\.tar\.gz\.age$/);
  const archivePath = path.join(data, 'backups', archiveName);
  const archiveBytes = await readFile(archivePath);
  assert.ok((await stat(`${archivePath.slice(0, -4)}.json`)).size > 0, 'the envelope is written beside the ciphertext');
  const listedOnA = await (await a.get('/api/backups')).json();
  assert.equal(listedOnA.supervised, true);
  assert.equal(listedOnA.archives.find(entry => entry.name === archiveName).envelopeOk, true);

  /* 3. Verify, and the two ways it has to fail. No `age` binary anywhere. */
  const verified = await awaitJob(socketA, (await (await a.send('/api/backups/verify', { name: archiveName })).json()).job.id);
  assert.equal(verified.phase, 'done', verified.error ?? '');
  assert.equal(verified.report.ok, true);
  // One byte flipped in a copy: the envelope says so, and verify refuses it.
  const damagedName = 'buddi-backup-19990101-000000.tar.gz.age';
  const damagedPath = path.join(data, 'backups', damagedName);
  await copyFile(`${archivePath.slice(0, -4)}.json`, `${damagedPath.slice(0, -4)}.json`);
  const flipped = Buffer.from(archiveBytes);
  flipped[flipped.length - 1] ^= 0xff;
  await writeFile(damagedPath, flipped);
  const damagedEntry = (await (await a.get('/api/backups')).json()).archives.find(entry => entry.name === damagedName);
  assert.equal(damagedEntry.envelopeOk, false, 'the envelope catches a flipped byte');
  const damagedJob = await awaitJob(socketA, (await (await a.send('/api/backups/verify', { name: damagedName })).json()).job.id);
  assert.equal(damagedJob.phase, 'failed', 'a tampered archive does not verify');
  // A wrong passphrase, through the one route that takes one: `/verify` uses
  // the stored passphrase, so the passphrase itself is what is replaced.
  assert.equal((await a.send('/api/backups/passphrase', { passphrase: 'not the words that open this' }, 'PUT')).status, 200);
  const wrongPhrase = await awaitJob(socketA, (await (await a.send('/api/backups/verify', { name: archiveName })).json()).job.id);
  assert.equal(wrongPhrase.phase, 'failed');
  assert.match(wrongPhrase.error, /does not open this backup/, 'the wrong passphrase says so in plain words');
  assert.equal((await a.send('/api/backups/passphrase', { passphrase }, 'PUT')).status, 200);
  const rightAgain = await awaitJob(socketA, (await (await a.send('/api/backups/verify', { name: archiveName })).json()).job.id);
  assert.equal(rightAgain.phase, 'done', 'the right passphrase opens it again');
  // And through `POST /restore`, where a wrong passphrase must stop before
  // anything is touched. The confirmation is the database's own name.
  const databaseName = listedOnA.database;
  assert.equal((await a.send('/api/backups/restore', { name: archiveName, passphrase })).status, 400, 'a restore over live rows needs the typed confirmation');
  const refusedRestore = await a.send('/api/backups/restore', { name: archiveName, passphrase: 'six words that are not it', confirm: databaseName });
  assert.equal(refusedRestore.status, 202);
  const refusedJob = await awaitJob(socketA, (await refusedRestore.json()).job.id);
  // Nothing was touched, so there is nothing to put back: this ends `failed`,
  // and `rolled-back` is reserved for a restore that did undo something.
  assert.equal(refusedJob.phase, 'failed', refusedJob.error ?? '');
  assert.match(refusedJob.error, /does not open this backup/);
  assert.equal(refusedJob.phases.includes('database'), false, 'a wrong passphrase never reaches the database');

  /* 4. Installation B: the same tarball, a clean data directory, its own
   * ports, and the archive restored before a single question is answered. */
  await mkdir(restored, { recursive: true, mode: 0o700 });
  await writeFile(path.join(restored, '.env'), 'BUDDI_VAULT=file\n', { mode: 0o600 });
  const envB = { ...env, BUDDI_DATA_DIR: restored, BUDDI_WEB_PORT: String(await freeLocalPort()) };
  const cliB = async args => (await exec(process.execPath, [entry, ...args], { env: envB, cwd: testRoot, timeout: 300_000 })).stdout;
  await cliB(['--no-service', '--no-open']);
  pidB = JSON.parse(await cliB(['service', 'status'])).supervisorPid;
  const socketB = path.join(restored, 'supervisor.sock');
  let b = await signIn(cliB);
  const freshB = await (await b.get('/api/onboarding')).json();
  assert.equal(freshB.state, 'pending', 'B has never been set up');
  assert.equal(freshB.needs.model, true);
  const uploaded = await b.upload('/api/onboarding/restore', archiveBytes, {
    'x-filename': archiveName,
    'x-backup-passphrase': passphrase,
  });
  assert.equal(uploaded.status, 202, await uploaded.clone().text());
  const restoreJob = await awaitJob(socketB, (await uploaded.json()).job.id);
  assert.equal(restoreJob.phase, 'done', restoreJob.error ?? '');
  assert.ok(
    // `recovery` sits between `database` and `files`: Task C writes the row
    // through the engine's `afterDatabase` hook, so a restore that cannot be
    // gated rolls back instead of coming up ungated.
    isSubsequence(['stopping', 'snapshot', 'database', 'recovery', 'files', 'starting', 'done'], restoreJob.phases),
    `the restore ran its phases in order: ${restoreJob.phases.join(' → ')}`,
  );

  /* 5. What came back. */
  const stateB = JSON.parse(await readFile(path.join(restored, 'installation.json'), 'utf8'));
  const vaultB = core.createVault({ env: { BUDDI_VAULT: 'file', BUDDI_VAULT_FILE: path.join(restored, 'vault.json'), BUDDI_VAULT_KEY: (await readFile(path.join(restored, 'vault-key'), 'utf8')).trim() } });
  const connectionB = { host: '127.0.0.1', port: stateB.dbPort, user: 'buddi', password: await vaultB.get('BUDDI_DB_PASSWORD'), database: 'buddi' };
  b = await signIn(cliB);
  const rosterB = await (await b.get('/api/agents')).json();
  assert.ok(rosterB.agents.some(agent => agent.handle === 'smoke'), 'the first agent came back');
  assert.ok(rosterB.agents.some(agent => agent.handle === 'two'), 'the second agent came back');
  const messagesB = await ask(connectionB, `select role from core.messages where conversation_id = $1 order by created_at`, [conversation.id]);
  assert.deepEqual(messagesB.map(row => row.role), ['user', 'assistant'], 'the conversation and both messages came back');
  assert.deepEqual(await readFile(path.join(restored, artifactRel)), artifactBytes, 'the artifact bytes came back');
  const memoryB = await (await b.get('/api/memory')).json();
  assert.ok(memoryB.preferences.some(entry => entry.key === 'smoke_note'), 'the memory row came back');
  assert.equal((await (await b.get('/api/owner')).json()).preferredName, 'Smoke Owner', 'the setting came back');
  const recovery = await (await b.get('/api/recovery')).json();
  assert.equal(recovery.active, true, 'B woke up in recovery');
  assert.match(recovery.archive, /\.tar\.gz\.age$/);
  assert.ok(recovery.checklist.secrets.some(secret => secret.kind === 'account'), 'the model account is listed as a secret to paste again');
  assert.ok(recovery.checklist.pending.jobs >= 1, 'the queued job is counted as pending work');
  assert.equal((await (await b.get('/api/onboarding')).json()).needs.model, true, 'a restored account with no credential still needs a model');
  assert.equal((await (await b.get('/api/telegram')).json()).running, false, 'Telegram is not started in recovery');
  assert.equal((await (await b.get('/api/service')).json()).status.recovery, true, 'the supervisor reports recovery');
  /*
   * Nothing runs on its own. The pause the archive carried is lifted first, so
   * the only thing holding the planted job is recovery mode, and the wait is
   * several times the worker's one-second poll.
   */
  await ask(connectionB, `update core.system_flags set value = 'false'::jsonb where key = 'paused'`);
  await new Promise(resolve => setTimeout(resolve, 5000));
  const held = await ask(connectionB, `select state, attempts from core.jobs where id = $1`, [planted.id]);
  assert.equal(held[0].state, 'pending', 'the queue claims nothing while recovery is active');
  assert.equal(held[0].attempts, 0);

  /* 6. A restore that fails where the engine can see it.
   *
   * The artifacts *directory* on B is replaced by a plain file. The engine
   * swaps that directory whole — "replaced, not merged" — so a collision
   * inside it is no failure at all; a non-directory where the directory has to
   * go is the one the files step refuses outright, and it refuses it after the
   * private directories have already been swapped, so the rollback has real
   * work to undo. The pre-restore snapshot carries no file at that path, so
   * putting everything back is clean and the job can end in a true
   * `rolled-back`.
   */
  const before = await countRows(connectionB);
  const databaseB = (await socketCall(socketB, '/backups')).body.database;
  const collision = path.join(restored, 'artifacts');
  const parked = path.join(restored, 'artifacts-parked');
  await rm(parked, { recursive: true, force: true });
  await rename(collision, parked);
  await writeFile(collision, 'not a directory\n');
  const attempted = await b.upload('/api/backups/restore', archiveBytes, {
    'x-filename': archiveName,
    'x-backup-passphrase': passphrase,
    'x-backup-confirm': databaseB,
  });
  assert.equal(attempted.status, 202, await attempted.clone().text());
  const failedRestore = await awaitJob(socketB, (await attempted.json()).job.id);
  assert.equal(failedRestore.phase, 'rolled-back', `a failed file step rolls back: ${failedRestore.error ?? ''}`);
  assert.ok(isSubsequence(['snapshot', 'database', 'files'], failedRestore.phases), failedRestore.phases.join(' → '));
  // Put the directory back before anything else looks for it.
  await rm(collision, { recursive: true, force: true });
  await rename(parked, collision);
  const snapshots = (await socketCall(socketB, '/backups')).body.archives.filter(entry => entry.name.startsWith('pre-restore-'));
  assert.ok(snapshots.length >= 1, 'the pre-restore snapshot is kept and listed');
  assert.deepEqual(await countRows(connectionB), before, 'the database is exactly what it was before the failed restore');

  /* 7. Leaving recovery starts the loops again, and the job waiting since
   * before the backup is finally claimed. */
  b = await signIn(cliB);
  const left = await b.send('/api/recovery/leave', { dropPending: false, keepGrants: [] });
  assert.equal(left.status, 202);
  const leftBody = await left.json();
  assert.equal(leftBody.restarting, true, 'under a supervisor, leaving recovery restarts the gateway');
  assert.equal(leftBody.droppedJobs, 0, 'dropPending: false keeps the pending work');
  let claimed;
  for (let i = 0; i < 120; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    claimed = (await ask(connectionB, `select state, attempts from core.jobs where id = $1`, [planted.id]))[0];
    if (claimed.state !== 'pending' || claimed.attempts > 0) break;
  }
  assert.ok(claimed.state !== 'pending' || claimed.attempts > 0, 'the queue claims the job once recovery is over');
  assert.equal((await (await (await signIn(cliB)).get('/api/recovery')).json()).active, false, 'recovery is over');
  process.kill(pidB, 'SIGTERM');
  for (let i = 0; i < 100; i++) {
    try { process.kill(pidB, 0); } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  pidB = undefined;


  /* ================================================================ *
   * Plugins: a package nobody published, from a tarball to a tool an
   * agent holds.
   *
   * The whole two-approval design exists for one property, and the
   * fixture is built to make that property visible: its top-level code
   * appends a line to BUDDI_FIXTURE_MARKER. Staging must leave that file
   * absent — nothing was imported — and approving must create it. There
   * is no way to fake either side of that, because importing a module is
   * what runs it.
   *
   * Everything here goes through the dashboard API and the supervisor's
   * control socket, the two doors an owner actually has, and one CLI run
   * for the path a terminal takes. No registry is asked anything: the
   * fixtures are packed with `npm pack` from this checkout into the
   * smoke's own temp directory, and the packages they stage declare no
   * dependency that is not a `file:` path inside the tarball.
   * ================================================================ */
  const fixtureSource = fileURLToPath(new URL('../../packages/gateway/src/plugins/fixtures/', import.meta.url));
  const workshop = path.join(testRoot, 'plugin-fixtures');
  await mkdir(workshop, { recursive: true });

  /** Pack a directory the way npm publishes one. Local: nothing is fetched. */
  const packFixture = async dir => {
    const packed = await exec('npm', ['pack', '--ignore-scripts', '--json'], { cwd: dir, env, timeout: 120_000 });
    return path.join(dir, JSON.parse(packed.stdout)[0].filename);
  };

  /**
   * The marker fixture, renamed, as a tarball.
   *
   * Two edits to the checked-in fixture, both so that staging it reaches
   * no registry. Its `zod` dependency is dropped and zod is resolved
   * through the `@buddi/core` peer symlink the stage writes instead, so
   * `stagePlugin` skips `npm install` entirely; and the plugin, schema
   * and tool names are rewritten, so the copy the CLI installs is a
   * different plugin from the one the API installs.
   */
  const buildMarkerFixture = async (name, schema, markerEnv) => {
    const dir = path.join(workshop, name);
    await rm(dir, { recursive: true, force: true });
    await cp(path.join(fixtureSource, 'marker-plugin'), dir, { recursive: true });
    const renamed = text => text.split('fixture-marker').join(name).split('fixture_marker').join(schema);
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    delete pkg.dependencies;
    pkg.name = `buddi-plugin-${name}`;
    // The name a package declares for its plugin is what approval checks the
    // exported manifest against, so the copy renames both halves.
    if (pkg.buddi?.name !== undefined) pkg.buddi.name = name;
    await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    await writeFile(path.join(dir, 'index.js'), renamed(await readFile(path.join(dir, 'index.js'), 'utf8')).replace(
      "import { z } from 'zod';",
      "import { createRequire } from 'node:module';\n"
        + "const fromCore = createRequire(import.meta.resolve('@buddi/core'));\n"
        + "const { z } = fromCore('zod');",
    ).replace(
      // The checked-in fixture reads its own migrations directory out of a URL
      // with `.pathname`, which percent-encodes the space in this smoke's data
      // directory and resolves to a path that is not there. The shipped weather
      // example does it the right way; the fixture is corrected here so that the
      // scenario tests migrations rather than that mistake.
      "new URL('./migrations', import.meta.url).pathname",
      "fileURLToPath(new URL('./migrations', import.meta.url))",
    ).replace(
      // One fixture per marker file: `plugins info` and `doctor` import every
      // installed plugin, so a shared variable would have one fixture writing
      // the file another one's assertions are about.
      /BUDDI_FIXTURE_MARKER/g,
      markerEnv,
    ).replace(
      "import { appendFileSync } from 'node:fs';",
      "import { appendFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';",
    ));
    for (const file of ['buddi.md', 'migrations/001_init.sql']) {
      await writeFile(path.join(dir, file), renamed(await readFile(path.join(dir, file), 'utf8')));
    }
    return packFixture(dir);
  };

  const markerTarball = await buildMarkerFixture('fixture-marker', 'fixture_marker', 'BUDDI_FIXTURE_MARKER');
  const cliTarball = await buildMarkerFixture('fixture-cli', 'fixture_cli', 'BUDDI_FIXTURE_MARKER_CLI');
  const throwingDir = path.join(workshop, 'fixture-throws');
  await cp(path.join(fixtureSource, 'throwing-plugin'), throwingDir, { recursive: true });
  const throwingTarball = await packFixture(throwingDir);

  /*
   * A plugin whose dependency wants to run code when it is installed.
   * The dependency is a `file:` path inside the package, so npm resolves
   * it without a registry, and its `postinstall` writes a file that must
   * never appear: staging installs with --ignore-scripts, before any
   * approval exists.
   */
  const scriptsDir = path.join(workshop, 'fixture-scripts');
  const postinstallProof = path.join(workshop, 'postinstall-ran');
  await mkdir(path.join(scriptsDir, 'vendor/noisy-dep'), { recursive: true });
  await writeFile(path.join(scriptsDir, 'package.json'), `${JSON.stringify({
    name: 'buddi-plugin-fixture-scripts', version: '1.0.0', type: 'module', main: 'index.js',
    buddi: { manifest: 'manifest' }, dependencies: { 'noisy-dep': 'file:./vendor/noisy-dep' },
  }, null, 2)}\n`);
  await writeFile(path.join(scriptsDir, 'index.js'), 'export const manifest = { name: "fixture-scripts" };\n');
  await writeFile(path.join(scriptsDir, 'vendor/noisy-dep/package.json'), `${JSON.stringify({
    name: 'noisy-dep', version: '1.0.0',
    scripts: { postinstall: `node -e "require('fs').writeFileSync('${postinstallProof}', 'ran')"` },
  }, null, 2)}\n`);
  await writeFile(path.join(scriptsDir, 'vendor/noisy-dep/index.js'), 'module.exports = {};\n');
  const scriptsTarball = await packFixture(scriptsDir);

  /** Poll a staging job on the dashboard. Its phases are the engine's. */
  const stageJob = async (session, id, seconds = 300) => {
    for (let i = 0; i < seconds * 4; i++) {
      const reply = await (await session.get(`/api/plugins/jobs/${id}`)).json();
      if (['done', 'failed'].includes(reply.phase)) return reply;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`staging job ${id} never finished`);
  };
  /** Stage a tarball the way the page does, and return the card it draws. */
  const stage = async (session, tarball) => {
    const accepted = await session.send('/api/plugins/stage', { spec: tarball });
    assert.equal(accepted.status, 202, await accepted.clone().text());
    const finished = await stageJob(session, (await accepted.json()).job.id);
    assert.equal(finished.phase, 'done', finished.error ?? '');
    const view = await (await session.get('/api/plugins')).json();
    const card = view.staged.find(entry => entry.id === finished.stagedId);
    assert.ok(card, 'the staged package is on the list the page reads');
    return { card, view };
  };
  /** Approve, carrying back exactly what the card showed. */
  const approve = (session, card, extra = {}) => session.send(`/api/plugins/staged/${card.id}/approve`, {
    integrity: card.integrity,
    // The fix pass may add a second hash the approval re-verifies; whatever
    // the card carries is what goes back, which is the whole point of it.
    ...(card.stagedHash === undefined ? {} : { stagedHash: card.stagedHash }),
    ...extra,
  });
  /** Restart the gateway through the supervisor, and wait for the new one. */
  const restartGateway = async () => {
    const before = JSON.parse(await cli(['service', 'status'])).gatewayPid;
    const asked = await socketCall(socketA, '/restart', 'POST');
    assert.equal(asked.status, 202, 'the supervisor accepts a restart on its control socket');
    let after;
    for (let i = 0; i < 300; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      after = JSON.parse(await cli(['service', 'status']));
      if (after.gateway === 'running' && after.gatewayPid !== before) break;
    }
    assert.equal(after.gateway, 'running', 'the gateway came back after the restart');
    assert.notEqual(after.gatewayPid, before, 'the restart replaced the gateway process');
    return after;
  };
  /* The CLI, run against this installation and never the owner's: every
   * path it reads is under the smoke's own data directory. */
  const cliMarker = path.join(testRoot, 'plugin-marker-cli.log');
  const buddiCli = path.join(testRoot, 'node_modules/buddi/packages/cli/dist/main.js');
  const cliEnv = {
    ...env,
    BUDDI_AGENTS_DIR: path.join(data, 'agents'),
    BUDDI_SKILLS_DIR: path.join(data, 'skills'),
    BUDDI_HOME: data,
    BUDDI_ENV_FILE: path.join(data, '.env'),
    BUDDI_VAULT_FILE: path.join(data, 'vault.json'),
    BUDDI_VAULT_KEY: (await readFile(path.join(data, 'vault-key'), 'utf8')).trim(),
    BUDDI_FIXTURE_MARKER_CLI: cliMarker,
    DATABASE_URL: `postgres://buddi:${encodeURIComponent(connection.password)}@127.0.0.1:${connection.port}/buddi`,
  };
  /** Run the packaged CLI. A non-zero exit is an answer here, not a throw. */
  const buddi = async args => {
    try {
      const done = await exec(process.execPath, [buddiCli, ...args], { env: cliEnv, cwd: testRoot, timeout: 300_000 });
      return { code: 0, out: `${done.stdout}${done.stderr}` };
    } catch (error) {
      return { code: error.code ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
  };
  const doctorRow = async name => {
    const report = await buddi(['doctor']);
    const row = report.out.split('\n').find(line => new RegExp(`^\\s+(ok|warn|FAIL)\\s+${name}\\s`).test(line));
    assert.ok(row, `buddi doctor has a ${name} row:\n${report.out}`);
    return row.trim();
  };

  /* 1. Staged, and nothing of it has run. */
  let p = await signIn(cli);
  const beforeStaging = await (await p.get('/api/plugins')).json();
  assert.equal(beforeStaging.installed.length, 0, 'a fresh installation has no plugin of its own');
  assert.match(beforeStaging.trust, /not sandboxed/, 'the page is given the trust sentence to show');
  assert.equal(beforeStaging.checkout, false, 'a packaged installation is not a checkout');
  const { card } = await stage(p, markerTarball);
  assert.equal(await readFile(markerFile, 'utf8').catch(error => error.code), 'ENOENT',
    'staging imported nothing: the fixture\'s top-level code has not run');
  assert.equal(card.name, 'buddi-plugin-fixture-marker');
  assert.match(card.integrity, /^sha512-[A-Za-z0-9+/=]+$/, 'the card shows the hash of the tarball it holds');
  assert.equal(card.claims.schema, 'fixture_marker', 'the card shows the schema the package claims in its buddi.md');
  assert.deepEqual(card.claims.hosts, ['example.invalid'], 'and the hosts it claims');
  assert.equal(card.claims.missing, false);
  assert.deepEqual(card.dependencies.withScripts, [], 'nothing in its tree wants to run code at install');
  assert.equal(card.state, 'staged');
  assert.equal(card.dir, undefined, 'no staging path goes on the wire');
  assert.equal(card.packageDir, undefined);

  /* 2. An approval is for the thing that was read about, or it is nothing. */
  const wrongHash = await approve(p, { ...card, integrity: 'sha512-AAAAnotthehashyouwereshown' });
  assert.equal(wrongHash.status, 409, await wrongHash.clone().text());
  assert.match((await wrongHash.json()).error, /integrity/i);
  assert.equal(await readFile(markerFile, 'utf8').catch(error => error.code), 'ENOENT',
    'a refused approval imports nothing either');

  /* 3. The right one: the first moment this plugin's code has ever run. */
  const approved = await approve(p, card);
  const approvedBody = await approved.json();
  assert.equal(approved.status, 200, JSON.stringify(approvedBody));
  assert.ok(approvedBody.installed, `approval 1 installed it: ${JSON.stringify(approvedBody.plan?.drift ?? approvedBody)}`);
  assert.equal(approvedBody.installed.name, 'fixture-marker');
  assert.equal(approvedBody.restartNeeded, true, 'its tools belong to the next process, and the API says so');
  assert.deepEqual(approvedBody.migrations, ['001_init.sql'], 'approval applied its migrations into its own schema');
  /*
   * The marker exists now and did not before, which is the whole property.
   * There are two lines in it rather than one: `place` re-reads the manifest
   * from where the package now lives, so an install imports the entry twice —
   * once to plan it and once after the move. Both are after the approval.
   */
  const markerLines = (await readFile(markerFile, 'utf8')).trim().split('\n');
  assert.ok(markerLines.length >= 1, 'approving is what imported it');
  for (const line of markerLines) assert.match(line, /^imported /);
  const afterApproval = await (await p.get('/api/plugins')).json();
  assert.equal(afterApproval.restartNeeded, true);
  const installedCard = afterApproval.installed.find(entry => entry.name === 'fixture-marker');
  assert.equal(installedCard.source.kind, 'tarball');
  assert.equal(installedCard.integrity, card.integrity, 'the record kept the hash that was approved');
  assert.equal(installedCard.loaded, false, 'this process never imported it into its registry');

  /* 4. A dependency that wants to run code says so before anything is approved. */
  const scripts = await stage(p, scriptsTarball);
  assert.deepEqual(scripts.card.dependencies.withScripts, ['noisy-dep (postinstall)'],
    'the card names the dependency that wants to run code at install');
  assert.ok(scripts.card.dependencies.count >= 1);
  assert.equal(await readFile(postinstallProof, 'utf8').catch(error => error.code), 'ENOENT',
    'it was installed with --ignore-scripts, so it has not run');
  const rejected = await p.send(`/api/plugins/staged/${scripts.card.id}/reject`, {});
  assert.equal(rejected.status, 200);
  assert.equal((await (await p.get('/api/plugins')).json()).staged.some(entry => entry.id === scripts.card.id), false,
    'a rejected stage and everything it fetched are gone');

  /* 5. Restart, and the tool exists. */
  await restartGateway();
  p = await signIn(cli);
  const loadedView = await (await p.get('/api/plugins')).json();
  const loadedCard = loadedView.installed.find(entry => entry.name === 'fixture-marker');
  assert.equal(loadedCard.loaded, true, 'the restarted gateway adopted it');
  assert.equal(loadedCard.error, undefined);
  assert.equal(loadedCard.contribution.tools, 1, 'it brought one tool');
  assert.equal(loadedView.restartNeeded, false, 'nothing is waiting for a restart any more');
  const migrated = await ask(connection, `select filename from core.migrations where schema = 'fixture_marker' order by filename`);
  assert.deepEqual(migrated.map(row => row.filename), ['001_init.sql'], 'its migration is recorded in the ledger');
  const itsTables = await ask(connection, `select table_name from information_schema.tables where table_schema = 'fixture_marker'`);
  assert.deepEqual(itsTables.map(row => row.table_name), ['notes'], 'and its table exists');
  const info = await buddi(['plugins', 'info', 'fixture-marker']);
  assert.equal(info.code, 0, info.out);
  assert.match(info.out, /fixture-marker\.echo/, '`plugins info` names the tool it brought');
  assert.match(info.out, /tarball/, 'and where it came from');
  assert.match(info.out, /notes: 0 rows/, 'and what it has stored in its own schema');
  assert.match(await doctorRow('plugins'), /^ok\b.*fixture-marker/, 'doctor is clean with it installed');

  /*
   * The tool an agent holds. A grant naming a tool this installation does
   * not have is a catalog load error, so an agent that still loads with
   * `fixture-marker.echo` in its file is the proof that the plugin's tool
   * is registered in the running process.
   */
  const agentFile = path.join(data, 'agents/concierge/agent.md');
  const agentBefore = await readFile(agentFile, 'utf8');
  await writeFile(agentFile, agentBefore.replace('tools: [', 'tools: [fixture-marker.echo, '));
  await restartGateway();
  p = await signIn(cli);
  const granted = (await (await p.get('/api/agents')).json()).agents.find(agent => agent.handle === 'smoke');
  assert.ok(granted, 'the agent still loads with a plugin tool in its grant');
  assert.ok(granted.tools.includes('fixture-marker.echo'), 'and the plugin\'s tool is one of its tools');

  /* 6. Changed on disk since it was approved. */
  const installedDir = path.join(data, 'plugins/fixture-marker');
  const pluginEntry = path.join(installedDir, 'index.js');
  const approvedEntry = await readFile(pluginEntry, 'utf8');
  await writeFile(path.join(installedDir, 'buddi.md'),
    `${await readFile(path.join(installedDir, 'buddi.md'), 'utf8')}\nEdited after it was approved.\n`);
  assert.match(await doctorRow('plugins'), /^warn\b.*fixture-marker changed on disk since it was approved/,
    'doctor names the plugin whose files are not the ones that were approved');

  /* 7. A plugin whose entry throws.
   *
   * Approving one is refused, because approval 1 *is* the first import:
   * there is no way to install a package that cannot be read. What the
   * load report is for is the other case — an installed plugin that stops
   * importing — so the marker plugin is broken on disk and the gateway
   * restarted on top of it.
   */
  const throwing = await stage(p, throwingTarball);
  const refusedThrow = await approve(p, throwing.card);
  const refusedBody = await refusedThrow.json();
  assert.equal(refusedThrow.status, 409, JSON.stringify(refusedBody));
  assert.match(refusedBody.error, /this fixture throws on import, on purpose/,
    'the refusal quotes what the package did when it was imported');
  assert.equal((await (await p.get('/api/plugins')).json()).installed.some(entry => entry.name === 'fixture-throws'),
    false, 'nothing was installed');
  await p.send(`/api/plugins/staged/${throwing.card.id}/reject`, {});
  // The agent's grant goes back first: a grant naming a tool that is about
  // to disappear is a separate failure, and this step is about the plugin.
  await writeFile(agentFile, agentBefore);
  await writeFile(pluginEntry, 'throw new Error("this installed plugin stopped importing");\n');
  await restartGateway();
  p = await signIn(cli);
  const brokenView = await (await p.get('/api/plugins')).json();
  const brokenCard = brokenView.installed.find(entry => entry.name === 'fixture-marker');
  assert.equal(brokenCard.loaded, false, 'a plugin that throws at import is reported, not hidden');
  assert.match(brokenCard.error, /stopped importing/, 'with the error it threw');
  assert.equal((await (await p.get('/api/agents')).json()).agents.some(agent => agent.handle === 'smoke'), true,
    'the gateway is up and answering with one plugin broken');
  assert.match(await doctorRow('plugins'), /^FAIL\b.*fixture-marker/, 'doctor fails the row for a plugin that did not load');
  await writeFile(pluginEntry, approvedEntry);

  /* 8. Uninstall keeps the data; purge is the other, separate verb. */
  const removed = await p.send('/api/plugins/fixture-marker/uninstall', {});
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal((await (await p.get('/api/plugins')).json()).installed.some(entry => entry.name === 'fixture-marker'),
    false, 'the record no longer names it');
  const gone = await buddi(['plugins', 'info', 'fixture-marker']);
  assert.equal(gone.code, 1);
  assert.match(gone.out, /no plugin called "fixture-marker"/, '`plugins info` says it is not installed here');
  assert.deepEqual(
    (await ask(connection, `select schema_name from information_schema.schemata where schema_name = 'fixture_marker'`))
      .map(row => row.schema_name),
    ['fixture_marker'],
    'its schema and everything in it survived the uninstall',
  );
  // Installed again, so the purge has something to destroy.
  const restaged = await stage(p, markerTarball);
  const reinstalled = await approve(p, restaged.card);
  assert.equal(reinstalled.status, 200, await reinstalled.clone().text());
  const unconfirmed = await p.send('/api/plugins/fixture-marker/uninstall', { purge: true, confirm: 'fixture_marker' });
  assert.equal(unconfirmed.status, 409, 'a purge that does not type the name back is refused');
  const purged = await p.send('/api/plugins/fixture-marker/uninstall', { purge: true, confirm: 'fixture-marker' });
  assert.equal(purged.status, 200, await purged.clone().text());
  assert.equal((await purged.json()).purged, true);
  assert.deepEqual(
    await ask(connection, `select schema_name from information_schema.schemata where schema_name = 'fixture_marker'`),
    [], 'purge dropped its schema',
  );

  /* 9. The same two steps from a terminal.
   *
   * `install` without `--yes` is a summary: it stages, prints the trust
   * sentence the page shows, and imports nothing. `--yes` is the terminal's
   * approval, and an approval carries the hash that was read: without
   * `--integrity` there is nothing binding the yes to the package that was
   * staged, so it is refused for a source that was fetched.
   */
  const staged = await buddi(['plugins', 'install', cliTarball]);
  assert.equal(staged.code, 0, staged.out);
  // Both read it from the engine's one constant; only the terminal hard-wraps
  // it, so the comparison is on the words rather than on where the lines break.
  const collapsed = text => text.replace(/\s+/g, ' ');
  assert.ok(collapsed(staged.out).includes(collapsed(beforeStaging.trust)),
    'the CLI prints the same trust sentence as the page');
  assert.match(staged.out, /NOTHING OF THIS PLUGIN HAS RUN/);
  assert.equal(await readFile(cliMarker, 'utf8').catch(error => error.code), 'ENOENT',
    '`plugins install` without --yes imported nothing');
  const cliIntegrity = /integrity (sha512-\S+)/.exec(staged.out)[1];
  const stagedId = /buddi plugins approve (\S+)/.exec(staged.out)[1];
  const blindYes = await buddi(['plugins', 'install', cliTarball, '--yes']);
  assert.match(blindYes.out, /--yes did not install it/, `--yes alone approved a fetched package:\n${blindYes.out}`);
  assert.match(blindYes.out, /--integrity/, 'and it says what the yes is missing');
  assert.equal(await readFile(cliMarker, 'utf8').catch(error => error.code), 'ENOENT',
    'a refused --yes imported nothing');
  const wrongYes = await buddi(['plugins', 'approve', stagedId, '--integrity', 'sha512-notthehashyouwereshown']);
  assert.equal(wrongYes.code, 1, wrongYes.out);
  assert.match(wrongYes.out, /integrity/i, 'a hash that is not the staged one is refused in the terminal too');
  assert.equal(await readFile(cliMarker, 'utf8').catch(error => error.code), 'ENOENT');
  const cliApproved = await buddi(['plugins', 'approve', stagedId, '--integrity', cliIntegrity]);
  assert.equal(cliApproved.code, 0, cliApproved.out);
  assert.match(cliApproved.out, /installed fixture-cli/);
  assert.match((await readFile(cliMarker, 'utf8')).trim(), /^imported /, 'approving from the terminal imported it');
  const unconfirmedPurge = await buddi(['plugins', 'uninstall', 'fixture-cli', '--yes', '--purge']);
  assert.equal(unconfirmedPurge.code, 1, `a terminal purge without the name typed back:\n${unconfirmedPurge.out}`);
  const cliRemoved = await buddi(['plugins', 'uninstall', 'fixture-cli', '--yes', '--purge', '--confirm', 'fixture-cli']);
  assert.equal(cliRemoved.code, 0, cliRemoved.out);
  assert.deepEqual(
    await ask(connection, `select schema_name from information_schema.schemata where schema_name = 'fixture_cli'`),
    [], 'the terminal path drops the schema too when asked to purge',
  );

  console.log('PASS: clean npm install, no scripts, private Postgres, install-specific readiness, authenticated dashboard, replay/CSRF rejection, owner-only 0600 control socket, dashboard service view agreeing with the CLI, idempotent start, gateway/supervisor crash recovery, password rotation, migration-phase restart, leftover postmaster restarted rather than adopted, first-run API through to a loaded first agent, the local-AI probe, the handover conversation on the record and the Telegram token gate, unfinished setup refusing to call itself done'
    + ', encrypted backup and verify with no external binary, a flipped byte caught by the envelope, a wrong passphrase refused in plain words by verify and by restore, the passphrase replaced and verify passing again'
    + ', a second installation restored from the upload before its first question — agents, conversation, artifact bytes, memory, setting and account checklist all back, phases in order'
    + ', recovery holding the queue and Telegram down, a failed file step rolled back with the pre-restore snapshot kept and the rows unchanged, and leaving recovery letting the queue claim again'
    + ', a plugin staged from a tarball with nothing of it imported, an approval refused for a hash that was not the one shown, approved and only then imported, a dependency\'s install script named and never run'
    + ', its tool registered after a restart and held by an agent, its migration applied to its own schema, doctor clean and then naming it changed on disk, a package that throws at import refused and an installed one that stops importing reported with the gateway still answering'
    + ', uninstall keeping the schema and purge dropping it, and the same two steps from the terminal'
    + (serviceTest ? ', LaunchAgent lifecycle.' : ', database death ends the supervisor.'));
} catch (error) {
  // Print only logs owned by this isolated fixture, never the live installation.
  for (const [label, dir] of [['A', data], ['B', restored]]) {
    for (const name of ['supervisor', 'gateway', 'postgres']) {
      const text = await readFile(path.join(dir, 'logs', `${name}.log`), 'utf8').catch(() => '');
      if (text) console.error(`${label} ${name}: ${text.slice(-5000)}`);
    }
  }
  throw error;
} finally {
  if (serviceTest) {
    await exec('launchctl', ['bootout', launchTarget]).catch(() => {});
    // Only the LaunchAgent created for this exact random test directory.
    await unlink(path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)).catch(() => {});
  }
  for (const dir of [data, restored]) {
    let victim = dir === data ? pid : pidB;
    if (!victim) {
      const lock = await readFile(path.join(dir, 'supervisor.lock'), 'utf8').catch(() => '');
      if (/^\d+$/.test(lock)) victim = Number(lock);
    }
    if (!victim) continue;
    try { process.kill(victim, 'SIGTERM'); } catch {}
    for (let i = 0; i < 200; i++) {
      try { process.kill(victim, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  console.log(`Test data retained for inspection: ${testRoot}`);
}
