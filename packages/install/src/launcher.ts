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
import { existsSync } from 'node:fs';
import { environment, dashboardReady, launchAgentLabel, launchAgentPlist, reloadLaunchAgent, nativeEnvironment, reloadSystemdUnit, systemdUnitPath, atomicJson, browsersDir, SERVICE_UNIT_VAR } from './environment.js';
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
/*
 * The dashboard port the owner asked for on this command line, read before
 * `environment()` pins the installed one over it. On a first run it is the
 * preferred port; on an existing installation it *moves* the port (see `run`),
 * so `BUDDI_WEB_PORT=4417 buddi` means the same thing whenever it is typed.
 */
const askedWebPort = ((): number | undefined => {
  const raw = process.env.BUDDI_WEB_PORT;
  if (raw === undefined || raw.trim() === '') return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`BUDDI_WEB_PORT is not a port: ${JSON.stringify(raw)}`);
  return port;
})();

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

/** One line from the terminal, for the one question a restore has to ask. */
async function prompt(question: string): Promise<string> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); }
  finally { rl.close(); }
}

/**
 * `buddi backup restore <archive>`, in a packaged installation.
 *
 * This is the command the recovery sentence names, so it has to be the command
 * that works: an owner whose upgrade failed while migrating is told to
 * reinstall the previous version and run this, and a binary that answers
 * "not supported in packaged installs" leaves them with a backup and no way
 * to use it.
 *
 * It is the supervisor's restore rather than the engine's, for the reason the
 * dashboard's is: the supervisor owns the database and the gateway child, so
 * it is the only process that can stop the gateway, put the archive back and
 * start it again — and it writes the recovery row that keeps the restored
 * installation's loops asleep until the owner has been through the checklist.
 * With no supervisor answering, the arguments go on to the checkout CLI, which
 * runs the engine against `DATABASE_URL` directly.
 *
 * The typed-back confirmation is the terminal's half of the guard (see
 * `checkRestoreGuard`): the supervisor decides whether one is needed, this
 * asks for it, and a run with nowhere to ask prints the refusal and stops.
 */
async function restoreThroughSupervisor(ctx: InstallContext, rest: string[]): Promise<number> {
  const named = rest.find(arg => !arg.startsWith('-'));
  if (named === undefined) throw new Error('Name the backup to restore: buddi backup restore <archive>.');
  const backups = path.join(ctx.data, 'backups');
  const resolved = path.resolve(named);
  if (named.includes(path.sep) && path.dirname(resolved) !== backups) {
    throw new Error(`A packaged restore reads its archives from ${backups}. Copy that file there and name it, or restore it from the dashboard.`);
  }
  const name = path.basename(named);
  const flag = (option: string): string | undefined => {
    const at = rest.indexOf(`--${option}`);
    return at === -1 ? undefined : rest[at + 1];
  };
  // The vault holds the passphrase of an archive this installation encrypted;
  // `--passphrase` is for one that came from another machine.
  let passphrase = flag('passphrase');
  if (passphrase === undefined && name.endsWith('.age')) {
    passphrase = (await ask<{ passphrase: string }>(ctx, 'GET', '/passphrase').catch(() => undefined))?.passphrase;
  }
  const body = (confirm?: string): Record<string, unknown> => ({
    name,
    ...(passphrase === undefined ? {} : { passphrase }),
    ...(confirm === undefined ? {} : { confirm }),
  });
  let started: { job: { id: string } };
  try {
    started = await ask<{ job: { id: string } }>(ctx, 'POST', '/restore', body());
  } catch (error) {
    const guard = /Type (\S+) to confirm\.$/.exec((error as Error).message);
    if (!guard || process.stdin.isTTY !== true) { console.error(`buddi: ${(error as Error).message}`); return 1; }
    const typed = await prompt(`${(error as Error).message}\n> `);
    if (typed === '') { console.error('buddi: nothing was typed, so nothing was restored.'); return 1; }
    started = await ask<{ job: { id: string } }>(ctx, 'POST', '/restore', body(typed));
  }
  console.log(`Restoring ${name}. The gateway is stopped for it and started again afterwards.`);
  let last = '';
  for (;;) {
    const job = await ask<{ phase: string; detail?: string; error?: string; finishedAt?: string }>(ctx, 'GET', `/jobs/${started.job.id}`);
    if (job.phase !== last) {
      last = job.phase;
      console.log(`  ${job.phase}${job.detail === undefined ? '' : ` — ${job.detail}`}`);
    }
    if (job.finishedAt !== undefined) {
      if (job.phase === 'done') { console.log('The backup is back. Run buddi doctor, then open the dashboard: it opens in recovery.'); return 0; }
      console.error(`buddi: the restore did not finish: ${job.error ?? 'no reason given'}`);
      // `rolled-back` is the engine saying it put the installation back as it
      // was; anything else did not get that far, and the archive is still there.
      console.error(job.phase === 'rolled-back'
        ? 'Nothing was changed: the installation was put back as it was.'
        : 'Inspect logs/supervisor.log before trying again.');
      return 1;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/**
 * What the service's own environment carries besides the data directory: the
 * dashboard port the owner asked for on the command line. The supervisor is
 * what provisions a first run and writes `installation.json`, and it runs
 * under launchd or systemd with none of the caller's environment — so
 * `BUDDI_WEB_PORT=4417 buddi` on a first run used to end on 4317. Once the
 * state file exists it wins over this (environment.ts), so the value here
 * only ever decides a first run.
 */
function serviceEnvironment(): Record<string, string> {
  return askedWebPort === undefined ? {} : { BUDDI_WEB_PORT: String(askedWebPort) };
}

/**
 * A URL a terminal can open on a click (OSC 8), so a link that wraps is never
 * copied by hand. The visible text is the URL itself; a terminal that does not
 * know the sequence still shows it, and a log file gets the plain URL.
 */
function terminalLink(url: string): string {
  return process.stdout.isTTY ? `\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007` : url;
}

/** What `systemctl --user` needs to find the user's manager, when the caller had it. */
function systemdSession(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].filter(key => typeof env[key] === 'string').map(key => [key, env[key] as string]));
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
      environment: { BUDDI_DATA_DIR: ctx.data, ...serviceEnvironment() }, workingDirectory: ctx.data,
      path: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      logFile: path.join(ctx.data, 'logs/supervisor.log'), errorFile: path.join(ctx.data, 'logs/supervisor.log'),
    }), { mode: 0o600 });
    const domain = `gui/${process.getuid!()}`;
    await reloadLaunchAgent((cmd, argv) => exec(cmd, argv, { env: nativeEnvironment(ctx.env) }), domain, label, plist);
    return;
  }
  if (!temporary && process.platform === 'linux') {
    /*
     * The same job as the LaunchAgent, as a systemd *user* unit: no root, the
     * owner's own session, started at login and kept alive. `systemctl --user`
     * needs the user's manager, which a desktop login or an SSH session on a
     * systemd distribution has; where it is missing the error names it.
     */
    const label = launchAgentLabel(ctx.data);
    const unit = systemdUnitPath(ctx.data, ctx.env);
    const { buildSystemdUnit } = await import('@buddi/cli');
    await mkdir(path.dirname(unit), { recursive: true });
    await writeFile(unit, buildSystemdUnit({
      label, nodePath: process.execPath, serveEntry: entry, args: ['supervise'],
      environment: { BUDDI_DATA_DIR: ctx.data, [SERVICE_UNIT_VAR]: label, ...serviceEnvironment() },
      workingDirectory: ctx.data,
      path: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
      logFile: path.join(ctx.data, 'logs/supervisor.log'), errorFile: path.join(ctx.data, 'logs/supervisor.log'),
    }), { mode: 0o600 });
    try {
      await reloadSystemdUnit((cmd, argv) => exec(cmd, argv, { env: { ...nativeEnvironment(ctx.env), ...systemdSession(ctx.env) } }), `${label}.service`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`systemd could not start the service (${detail.trim()}). The unit is at ${unit}. Run buddi --no-service to start it in the foreground instead.`);
    }
    console.log(`Background service: systemd user unit ${label} (survives logout only after: loginctl enable-linger ${ctx.env.USER ?? '$USER'})`);
    return;
  }
  if (!temporary && process.platform !== 'darwin') throw new Error('Background installation runs under launchd (macOS) or systemd (Linux). Use buddi --no-service or buddi supervise on this platform.');
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
    // What the vault is and what it protects, said the same way everywhere
    // (install.md §4): the keychain on a Mac, the file beside its key elsewhere.
    const { vaultState } = await import('@buddi/core');
    const vault = vaultState({ env: ctx.env });
    console.log(`Vault: ${vault.selection === 'keychain' ? 'the macOS keychain'
      : vault.selection === 'file' ? `encrypted file at ${vault.file}, opened by the key in ${path.join(ctx.data, 'vault-key')}${vault.locked ? ` — LOCKED: ${vault.advice}` : ' — protects it at rest; anyone with this account\'s files can open it'}`
      : vault.selection === 'memory' ? 'in memory only (nothing persists)' : 'off — secrets come from the environment'}`);
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
    /*
     * `buddi upgrade latest` is the one place the word is allowed, and it
     * never leaves this process as a word: asking for nothing in particular
     * is what makes the supervisor resolve the newest version through the
     * check before npm is told anything (see VERSION_PATTERN in upgrade.ts).
     */
    const named = args[1] !== undefined && !args[1].startsWith('-') ? args[1] : undefined;
    const version = named === 'latest' ? undefined : named;
    console.log('Upgrading. A backup is taken first, and buddi restarts itself when the new version is in place.');
    const { job } = await ask<{ job: UpgradeJob }>(ctx, 'POST', '/upgrade', version === undefined ? {} : { version });
    process.exitCode = await followUpgrade(ctx, job.id);
    return;
  }
  if (args[0] === 'browser') {
    // Needs no database and no supervisor: it looks on disk, or runs Playwright's installer.
    // An install always goes into the data directory, even where Playwright's
    // own cache already holds a build (see `browsersPath`); set before Playwright loads.
    if (args[1] === 'install') {
      ctx.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir(ctx.data);
      await mkdir(ctx.env.PLAYWRIGHT_BROWSERS_PATH, { recursive: true, mode: 0o700 });
    }
    const cli = await import('@buddi/cli');
    process.exitCode = await cli.main(args);
    return;
  }
  if (args.length === 0 || args.every(a => ['--no-service', '--no-open'].includes(a))) {
    const firstRun = ctx.state === undefined;
    let running = false;
    let relaunched = false;
    /*
     * A different port for an installation that has one: the state file is
     * rewritten and the service restarted, because the supervisor hands the
     * gateway the environment it computed at its own start. Without a service
     * (a foreground `buddi supervise`) the owner is told to restart it.
     */
    if (ctx.state !== undefined && askedWebPort !== undefined && askedWebPort !== ctx.state.webPort) {
      const serviced = process.platform === 'darwin' ? existsSync(launchAgentPlist(ctx.data)) : process.platform === 'linux' ? existsSync(systemdUnitPath(ctx.data, ctx.env)) : false;
      if (!serviced) throw new Error(`The dashboard port is ${ctx.state.webPort}. To move it to ${askedWebPort}, stop the running supervisor, change "webPort" in ${path.join(ctx.data, 'installation.json')}, and start it again.`);
      const from = ctx.state.webPort;
      await atomicJson(path.join(ctx.data, 'installation.json'), { ...ctx.state, webPort: askedWebPort });
      console.log(`Moving the dashboard from port ${from} to ${askedWebPort}; the service restarts.`);
      ctx = await environment(root);
      await launchService(ctx, false);
      relaunched = true;
    } else {
      try {
        const status = await control(ctx);
        if (status.installRoot === root && status.nodePath === process.execPath) {
          if (status.gateway === 'stopped') await control(ctx, 'start');
          running = true;
        }
      } catch { /* A missing supervisor is normal on first run. */ }
    }
    if (!running) {
      if (!relaunched) {
        console.log('Starting Buddi. First run provisions a private Postgres cluster.');
        await launchService(ctx, args.includes('--no-service'));
      }
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
    console.log(`Dashboard: ${terminalLink(url)}`);
    console.log('The link is good for five minutes. Run buddi again for a fresh one.');
    /*
     * The agents' own browser, said once on a first run and again on every run
     * while there is none: a packaged install ships no browser binary, and
     * downloading 150 MB unasked is not this command's to do.
     */
    const found = gateway.detectBrowser();
    if (firstRun && found.engine === 'none' && process.env.BUDDI_BROWSER_INSTALL === '1') {
      // Asked for on this command line, so the download is the owner's choice.
      console.log('Installing Chromium for the agents\' own browser (about 150 MB).');
      const outcome = await gateway.installBrowser({ inherit: true });
      console.log(outcome.ok ? gateway.browserLine(gateway.detectBrowser()) : `The browser install failed: ${outcome.detail}. Run buddi browser install to try again.`);
    } else if (firstRun || found.engine === 'none') console.log(gateway.browserLine(found));
    if (!args.includes('--no-open') && process.platform === 'darwin') await exec('open', [url], { env: nativeEnvironment(ctx.env) });
    return;
  }
  if (args[0] === 'backup' && args[1] === 'restore') {
    // The supervisor if there is one, the engine below if there is not. See
    // `restoreThroughSupervisor`; this is the command the recovery sentence
    // in upgrade.ts tells an owner to run.
    const supervised = await control(ctx).then(() => true, () => false);
    if (supervised) { process.exitCode = await restoreThroughSupervisor(ctx, args.slice(2)); return; }
  } else if (['init', 'db', 'backup', 'migrate', 'serve'].includes(args[0] as string) || args[0] === 'service') {
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
