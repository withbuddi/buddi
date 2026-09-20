#!/usr/bin/env node
/**
 * `buddi` in a packaged installation: the one binary the tarball installs.
 *
 * It prepares the environment, then either supervises, runs the gateway child,
 * controls the supervisor, or hands the arguments to the checkout CLI. Every
 * `@buddi/*` import below is dynamic and happens after `environment()` has
 * run, because those packages compute their path constants on import.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { open, mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { environment, dashboardReady, reloadLaunchAgent, nativeEnvironment } from './environment.js';
import type { InstallContext } from './environment.js';
import { supervise, controlToken } from './supervisor.js';
import type { SupervisorStatus } from './supervisor.js';

const entry = fileURLToPath(import.meta.url);
// <root>/packages/install/dist/launcher.js — the installation root is three up.
const root = path.resolve(path.dirname(entry), '../../..');
const exec = promisify(execFile);
const args = process.argv.slice(2);

async function control(ctx: InstallContext, action = 'status'): Promise<SupervisorStatus> {
  if (!ctx.state) throw new Error('Not initialized. Run buddi first.');
  const gateway = await import('@buddi/gateway');
  const { token } = await gateway.ensureWebToken({ env: ctx.env, readOnly: true });
  const response = await fetch(`http://127.0.0.1:${ctx.state.controlPort}/${action}`, {
    method: action === 'status' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${controlToken(token)}` }, signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Supervisor refused the request (${response.status}).`);
  return await response.json() as SupervisorStatus;
}

async function launchService(ctx: InstallContext, temporary: boolean): Promise<void> {
  await mkdir(path.join(ctx.data, 'logs'), { recursive: true, mode: 0o700 });
  if (!temporary && process.platform === 'darwin') {
    const label = `com.buddi.install.${createHash('sha256').update(ctx.data).digest('hex').slice(0, 12)}`;
    const dir = path.join(os.homedir(), 'Library/LaunchAgents');
    const plist = path.join(dir, `${label}.plist`);
    const { buildPlist } = await import('@buddi/cli');
    await mkdir(dir, { recursive: true });
    await writeFile(plist, buildPlist({
      label, nodePath: process.execPath, serveEntry: entry, args: ['supervise'],
      environment: { BUDDI_DATA_DIR: ctx.data }, workingDirectory: ctx.data,
      path: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      logFile: path.join(ctx.data, 'logs/supervisor.log'), errorFile: path.join(ctx.data, 'logs/supervisor.log'),
    }), { mode: 0o600 });
    const domain = `gui/${process.getuid!()}`;
    await reloadLaunchAgent((cmd, argv) => exec(cmd, argv, { env: nativeEnvironment(ctx.env) }), domain, label, plist);
    return;
  }
  if (!temporary && process.platform !== 'darwin') throw new Error('Background installation is currently macOS-only. Use buddi --no-service or buddi supervise on this platform.');
  const log = await open(path.join(ctx.data, 'logs/supervisor.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [entry, 'supervise'], { detached: true, stdio: ['ignore', log.fd, log.fd], env: ctx.env });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
}

async function run(): Promise<void> {
  let ctx = await environment(root);
  if (args[0] === 'supervise') return supervise(ctx);
  if (args[0] === '__gateway') {
    // Parent death must not leave two gateways claiming jobs on the next boot.
    if (!process.send) throw new Error('The gateway child must be started by buddi supervise.');
    const parentGone = () => process.kill(process.pid, 'SIGTERM');
    process.once('disconnect', parentGone);
    const gateway = await import('@buddi/gateway');
    try { await gateway.runServe(); }
    finally { process.removeListener('disconnect', parentGone); if (process.connected) process.disconnect(); }
    return;
  }
  if (args[0] === 'service' && ['status', 'start', 'stop', 'restart'].includes(args[1] as string)) {
    console.log(JSON.stringify(await control(ctx, args[1]), null, 2)); return;
  }
  if (args[0] === 'doctor') {
    console.log(`Data: ${ctx.data}`);
    console.log(JSON.stringify(await control(ctx), null, 2));
    console.log(`Logs: ${path.join(ctx.data, 'logs')}`); return;
  }
  if (args.length === 0 || args.every(a => ['--no-service', '--no-open'].includes(a))) {
    let running = false;
    try {
      const status = await control(ctx);
      if (status.installRoot === root && status.nodePath === process.execPath) {
        if (status.gateway === 'stopped') await control(ctx, 'start');
        running = true;
      }
    } catch { /* A missing supervisor is normal on first run. */ }
    if (!running) {
      console.log('Starting Buddi. First run provisions a private Postgres cluster.');
      await launchService(ctx, args.includes('--no-service'));
      const deadline = Date.now() + 120_000;
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 500));
        ctx = await environment(root);
        try { await control(ctx); break; } catch {
          if (Date.now() > deadline) throw new Error(`Startup did not finish. Data was preserved. Inspect ${path.join(ctx.data, 'logs/supervisor.log')}`);
        }
      }
    }
    const gateway = await import('@buddi/gateway');
    const { token } = await gateway.ensureWebToken({ env: ctx.env, readOnly: true });
    const url = gateway.webUrl({ host: '127.0.0.1', port: ctx.state!.webPort }, gateway.mintTicket(token));
    const serviceUrl = `http://127.0.0.1:${ctx.state!.controlPort}/?t=${encodeURIComponent(gateway.mintTicket(controlToken(token)))}`;
    // A process pid is not dashboard readiness. Wait for its authenticated HTTP surface.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if (await dashboardReady(ctx.state!.webPort, token)) break;
      } catch { /* startup */ }
      if (Date.now() > deadline) throw new Error(`Gateway did not become ready. Inspect ${path.join(ctx.data, 'logs/gateway.log')}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    console.log(`Dashboard: ${url}`);
    console.log(`Service controls: ${serviceUrl}`);
    console.log('Links expire in five minutes; reuse is rejected within the current server lifetime (not across restarts). Run buddi again for fresh links.');
    if (!args.includes('--no-open') && process.platform === 'darwin') await exec('open', [url], { env: nativeEnvironment(ctx.env) });
    return;
  }
  if (['init', 'upgrade', 'db', 'backup', 'migrate', 'serve'].includes(args[0] as string) || args[0] === 'service') {
    throw new Error('This checkout-oriented command is not yet supported in packaged installs. Run buddi; use service status|start|stop|restart for the gateway.');
  }
  if (ctx.state?.database === 'managed') {
    const core = await import('@buddi/core');
    await core.hydrateDatabaseUrl(ctx.env);
  }
  const cli = await import('@buddi/cli');
  process.exitCode = await cli.main(args);
}

run().catch((error: Error) => { console.error(`buddi: ${error.message}`); process.exitCode = 1; });
