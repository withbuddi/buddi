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
import { request } from 'node:http';
import { open, mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { environment, dashboardReady, launchAgentLabel, launchAgentPlist, reloadLaunchAgent, nativeEnvironment } from './environment.js';
import type { InstallContext } from './environment.js';
import { supervise, supervisorSocket } from './supervisor.js';
import { installedVersion, readUpgradeState, upgradeDoctorLines, versionView } from './upgrade.js';
import type { UpgradeJob, VersionView } from './upgrade.js';
import type { SupervisorStatus } from './supervisor.js';

const entry = fileURLToPath(import.meta.url);
// <root>/packages/install/dist/launcher.js — the installation root is three up.
const root = path.resolve(path.dirname(entry), '../../..');
const exec = promisify(execFile);
const args = process.argv.slice(2);

/**
 * Ask this installation's supervisor. The socket in the data directory is the
 * whole credential, and `fetch` cannot address a Unix socket, so this is
 * `node:http`'s client: one request, no agent, nothing pooled.
 */
async function ask<T>(ctx: InstallContext, method: string, route: string, body?: unknown): Promise<T> {
  if (!ctx.state) throw new Error('Not initialized. Run buddi first.');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise<T>((resolve, reject) => {
    const req = request({
      socketPath: supervisorSocket(ctx.data), path: route, method,
      headers: { host: 'localhost', ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) },
      timeout: 25_000,
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        // 200 is "done, and here is the result"; 202 is "accepted, and here is
        // what it looked like when you asked" — which is what `restart` and the
        // long-running verbs answer, because the reply has to leave before the
        // thing it starts takes the process away.
        if (res.statusCode !== 200 && res.statusCode !== 202) {
          const refusal = (() => { try { return (JSON.parse(text) as { error?: string }).error; } catch { return undefined; } })();
          return reject(new Error(refusal ?? `Supervisor refused the request (${res.statusCode}).`));
        }
        try { resolve(JSON.parse(text) as T); }
        catch { reject(new Error('The supervisor answered with something that is not JSON.')); }
      });
    });
    req.once('timeout', () => req.destroy(new Error('The supervisor did not answer within 25 seconds.')));
    req.once('error', reject);
    req.end(payload);
  });
}

async function control(ctx: InstallContext, action = 'status'): Promise<SupervisorStatus> {
  return await ask<SupervisorStatus>(ctx, action === 'status' ? 'GET' : 'POST', `/${action}`);
}

/**
 * `buddi upgrade`, in a packaged installation: ask the supervisor, then watch.
 *
 * The supervisor replaces the code and hands over to a new supervisor, so the
 * job this follows stops answering halfway through — on purpose. What comes
 * after the socket goes quiet is the second half of the same upgrade, and the
 * history entry the new supervisor writes is the verdict.
 */
async function followUpgrade(ctx: InstallContext, id: string): Promise<number> {
  let last = '';
  const say = (phase: string, detail?: string): void => {
    if (phase === last) return;
    last = phase;
    console.log(`  ${phase}${detail === undefined ? '' : ` — ${detail}`}`);
  };
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    let job: { phase: string; detail?: string; error?: string; finishedAt?: string };
    // The supervisor handed over; that silence is the `restarting` step.
    try { job = await ask(ctx, 'GET', `/jobs/${id}`); }
    catch { break; }
    say(job.phase, job.detail);
    if (job.phase === 'failed') {
      console.error(`buddi: the upgrade failed: ${job.error ?? 'no reason given'}`);
      console.error('Nothing was migrated and buddi is running again on the version it was on.');
      return 1;
    }
    if (job.finishedAt !== undefined && job.phase !== 'restarting') break;
    if (Date.now() > deadline) { console.error('buddi: the upgrade is taking longer than twenty minutes; inspect logs/supervisor.log.'); return 1; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log('  restarting — waiting for the upgraded buddi');
  const back = Date.now() + 5 * 60_000;
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const view = await ask<{ current: string; history: Array<{ outcome: string; to: string; step?: string; error?: string }> }>(ctx, 'GET', '/version');
      const entry = view.history[view.history.length - 1];
      if (entry?.outcome === 'done') { console.log(`buddi is now on ${view.current}.`); return 0; }
      if (entry?.outcome === 'failed') {
        console.error(`buddi: the upgrade failed at ${entry.step ?? 'an unknown step'}: ${entry.error ?? 'no reason given'}`);
        console.error('Run buddi doctor: it prints the archive to restore from and how.');
        return 1;
      }
    } catch { /* The successor has not taken the socket yet. */ }
    if (Date.now() > back) { console.error('buddi: the upgraded buddi did not come back; inspect logs/supervisor.log.'); return 1; }
  }
}

async function launchService(ctx: InstallContext, temporary: boolean): Promise<void> {
  await mkdir(path.join(ctx.data, 'logs'), { recursive: true, mode: 0o700 });
  if (!temporary && process.platform === 'darwin') {
    const label = launchAgentLabel(ctx.data);
    const plist = launchAgentPlist(ctx.data);
    const dir = path.dirname(plist);
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
    /*
     * The upgrade row, read from disk rather than from the supervisor: the one
     * state it most matters in — `upgrade-failed`, where the gateway is
     * deliberately not running — is also the one where the owner may be
     * looking at a supervisor that is barely up. The file is the record.
     */
    const state = await readUpgradeState(ctx.data, await installedVersion(root));
    for (const line of upgradeDoctorLines(versionView(state), ctx.state?.phase)) console.log(line);
    console.log(`Logs: ${path.join(ctx.data, 'logs')}`); return;
  }
  if (args[0] === 'version' || args[0] === '--version' || args[0] === '-v') {
    let view: VersionView | undefined;
    try { view = await ask<VersionView>(ctx, 'GET', '/version'); }
    catch { view = versionView(await readUpgradeState(ctx.data, await installedVersion(root))); }
    console.log(`buddi ${view.current}`);
    if (view.updateAvailable) console.log(`A newer buddi is available: ${view.latest}`);
    else if (view.latest !== undefined) console.log('This is the latest version.');
    return;
  }
  if (args[0] === 'upgrade') {
    // The checkout's `--no-backup` has no meaning here: the archive is the way
    // back from a migration, and this path migrates under code it just installed.
    if (args.includes('--no-backup')) throw new Error('A packaged upgrade always takes a backup first; it is the way back. Run buddi upgrade.');
    const version = args[1] !== undefined && !args[1].startsWith('-') ? args[1] : undefined;
    console.log('Upgrading. A backup is taken first, and buddi restarts itself when the new version is in place.');
    const { job } = await ask<{ job: UpgradeJob }>(ctx, 'POST', '/upgrade', version === undefined ? {} : { version });
    process.exitCode = await followUpgrade(ctx, job.id);
    return;
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
    console.log('The link expires in five minutes; reuse is rejected within the current server lifetime (not across restarts). Run buddi again for a fresh link.');
    if (!args.includes('--no-open') && process.platform === 'darwin') await exec('open', [url], { env: nativeEnvironment(ctx.env) });
    return;
  }
  if (['init', 'db', 'backup', 'migrate', 'serve'].includes(args[0] as string) || args[0] === 'service') {
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
