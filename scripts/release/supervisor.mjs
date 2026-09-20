import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { acquireLock, initialize, atomicJson } from './environment.mjs';
import { startDatabase, stopChild } from './postgres.mjs';

export function controlToken(token) { return createHmac('sha256', token).update('buddi-supervisor-v1').digest('hex'); }
export function restartDelay(failures) { return Math.min(30_000, 2000 * 2 ** Math.min(failures, 4)); }
function equal(a, b) { return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }

/** Narrow maintenance API. No arbitrary command, path, SQL or environment input. */
export function controlServer({ gateway, token, port, status, action, dashboardUrl }) {
  const sessions = new gateway.SessionStore({ local: 60 * 60_000 });
  const spent = new gateway.SpentTickets();
  const origin = `http://127.0.0.1:${port}`;
  return createServer((req, res) => {
    void handle(req, res).catch(() => gateway.sendEmpty(res, 500));
  });
  async function handle(req, res) {
    if (req.headers.host !== `127.0.0.1:${port}`) return gateway.sendEmpty(res, 403);
    const url = new URL(req.url, origin);
    const ticket = url.searchParams.get('t');
    if (req.method === 'GET' && ticket) {
      const verified = gateway.verifyTicket(controlToken(token), ticket, new Date());
      if (!verified.ok || !spent.spend(verified.nonce, verified.expiresAt, new Date())) return gateway.sendEmpty(res, 401);
      const session = sessions.create('local');
      return gateway.sendEmpty(res, 302, { Location: '/', 'Set-Cookie': gateway.cookieHeader('buddi_supervisor', session.id) });
    }
    const bearer = equal(req.headers.authorization, `Bearer ${controlToken(token)}`);
    const cookies = gateway.parseCookies(req.headers.cookie);
    const session = sessions.get(cookies.buddi_supervisor, 'local');
    if (!bearer && !session) return gateway.sendEmpty(res, 401);
    if (req.method === 'GET' && url.pathname === '/status') return gateway.sendJson(res, 200, status());
    if (req.method === 'POST' && ['/start', '/stop', '/restart'].includes(url.pathname)) {
      if (!bearer && (req.headers.origin !== origin || !gateway.SessionStore.csrfMatches(session, req.headers['x-buddi-csrf']))) return gateway.sendEmpty(res, 403);
      if (bearer && req.headers.origin && req.headers.origin !== origin) return gateway.sendEmpty(res, 403);
      await action(url.pathname.slice(1));
      return gateway.sendJson(res, 200, status());
    }
    if (req.method === 'GET' && url.pathname === '/' && session) {
      const nonce = randomBytes(24).toString('base64');
      res.writeHead(200, { ...gateway.baseHeaders(), 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
      res.end(`<!doctype html><title>Buddi service</title><h1>Buddi service</h1><p id="state"></p><button data-action="start">Start gateway</button> <button data-action="stop">Stop gateway</button> <button data-action="restart">Restart gateway</button><p><a href="/dashboard">Open dashboard</a></p><script nonce="${nonce}">const state=document.querySelector('#state');async function refresh(){const r=await fetch('/status');const s=await r.json();state.textContent='Database: '+s.database+' · Gateway: '+s.gateway;}document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const r=await fetch('/'+b.dataset.action,{method:'POST',headers:{'x-buddi-csrf':'${session.csrf}'}});if(!r.ok)throw Error('Action failed');await refresh();}catch(e){state.textContent=e.message;}finally{b.disabled=false;}});refresh();setInterval(refresh,3000);</script>`);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/dashboard') return gateway.sendEmpty(res, 302, { Location: dashboardUrl() });
    gateway.sendEmpty(res, 404);
  }
}

export async function supervise(ctx) {
  const release = await acquireLock(ctx.data);
  let database, server, child, retry, log;
  let desired = true, closing = false, chain = Promise.resolve();
  let failures = 0;
  const stopGateway = async () => {
    desired = false; clearTimeout(retry);
    await stopChild(child); child = undefined;
  };
  let resolveShutdown;
  const shutdown = new Promise(resolve => { resolveShutdown = resolve; });
  const onSignal = () => { closing = true; desired = false; resolveShutdown(); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    await initialize(ctx);
    const core = await import(ctx.require.resolve('@buddi/core'));
    const gateway = await import(ctx.require.resolve('@buddi/gateway'));
    database = await startDatabase(ctx, core);
    database.exited.then(() => {
      if (!closing) { console.error('Managed Postgres exited; stopping the gateway. Restart buddi after checking logs/postgres.log.'); onSignal(); }
    });
    ctx.state.phase = 'migrating'; await atomicJson(path.join(ctx.data, 'installation.json'), ctx.state);
    const pool = core.createPool(ctx.env.DATABASE_URL);
    try {
      const exists = await pool.query("SELECT to_regclass('core.migrations') AS table_name");
      if (exists.rows[0].table_name) {
        const shipped = new Map([['core', new Set(await readdir(core.CORE_MIGRATIONS_DIR))]]);
        for (const manifest of gateway.installedManifests()) {
          if (manifest.migrationsDir) shipped.set(manifest.schema, new Set(await readdir(manifest.migrationsDir)));
        }
        const applied = await pool.query('SELECT schema, filename FROM core.migrations');
        if (applied.rows.some(row => shipped.has(row.schema) && !shipped.get(row.schema).has(row.filename))) {
          throw new Error('Database schema is newer than this release. Install the matching release; no migration or gateway start was attempted.');
        }
      }
      await core.runMigrations(pool, gateway.installedManifests());
    }
    finally { await pool.end(); }
    ctx.state.phase = 'ready'; await atomicJson(path.join(ctx.data, 'installation.json'), ctx.state);
    const { token } = await gateway.ensureWebToken({ env: ctx.env });
    log = createWriteStream(path.join(ctx.data, 'logs/gateway.log'), { flags: 'a', mode: 0o600 });
    const start = () => {
      desired = true;
      clearTimeout(retry);
      if (closing || !database.alive || (child && child.exitCode === null && child.signalCode === null)) return;
      const started = Date.now();
      child = spawn(process.execPath, [path.join(ctx.root, 'bin/buddi.mjs'), '__gateway'], { env: ctx.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      child.once('error', () => console.error('Gateway could not start; check the installed Node executable.'));
      child.once('close', () => {
        if (Date.now() - started >= 60_000) failures = 0;
        if (desired && !closing && database.alive) retry = setTimeout(start, restartDelay(failures++));
      });
    };
    server = controlServer({ gateway, token, port: ctx.state.controlPort,
      status: () => ({ phase: ctx.state.phase, supervisorPid: process.pid, installRoot: ctx.root, nodePath: process.execPath, database: database.pid ? (database.alive ? 'running' : 'failed') : 'external', databasePid: database.pid,
        gateway: child && child.exitCode === null && child.signalCode === null ? 'running' : 'stopped', gatewayPid: child?.pid ?? null }),
      action: name => { chain = chain.catch(() => {}).then(async () => { if (name !== 'start') await stopGateway(); if (name !== 'stop') start(); }); return chain; },
      dashboardUrl: () => gateway.webUrl({ host: '127.0.0.1', port: ctx.state.webPort }, gateway.mintTicket(token)),
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ctx.state.controlPort, '127.0.0.1', resolve); });
    start();
    console.log('Buddi supervisor ready.');
    await shutdown;
  } finally {
    closing = true;
    await chain.catch(() => {});
    await stopGateway();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    try { await database?.stop(); }
    finally {
      log?.end(); await release();
      process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    }
  }
}
