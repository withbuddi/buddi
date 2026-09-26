/**
 * `buddi status` — one screen of how this installation is.
 *
 * Each part is read on its own and a part that cannot be read says so in one
 * line; nothing here throws past `collectStatus`. `buddi doctor` stays the
 * deep check: this is the glance.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { localDateTimeString } from '@buddi/core';
import type { InstallKind } from './commands.js';

const exec = promisify(execFile);

export type ServiceState = 'running' | 'stopped' | 'not-installed' | 'unknown';

export interface StatusReport {
  version: string;
  install: InstallKind;
  service: { state: ServiceState; detail: string };
  database: { reachable: boolean; error?: string };
  agents: {
    ready: Array<{ handle: string; id: string }>;
    unavailable: Array<{ handle: string; id: string; reason: string }>;
    error?: string;
  };
  /** Null when the database could not be read. */
  needsYou: { approvals: number; questions: number } | null;
  lastRecapAt: string | null;
  update: { available: boolean; latest?: string };
}

/** Everything `collectStatus` reads, injectable so the report is testable. */
export interface StatusSources {
  install: InstallKind;
  version(): Promise<string>;
  service(): Promise<{ state: ServiceState; detail: string }>;
  probeDatabase(): Promise<void>;
  describeDatabaseError(err: unknown): string;
  agents(): Promise<Array<{ handle: string; id: string; available: boolean; reason?: string }>>;
  attention(): Promise<{ approvals: number; questions: number }>;
  lastRecapAt(): Promise<Date | null>;
  update(): Promise<{ available: boolean; latest?: string }>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function collectStatus(sources: StatusSources): Promise<StatusReport> {
  const version = await sources.version().catch(() => 'unknown');
  const service = await sources
    .service()
    .catch((err): { state: ServiceState; detail: string } => ({ state: 'unknown', detail: message(err) }));

  let database: StatusReport['database'];
  try {
    await sources.probeDatabase();
    database = { reachable: true };
  } catch (err) {
    database = { reachable: false, error: sources.describeDatabaseError(err) };
  }

  const agents: StatusReport['agents'] = { ready: [], unavailable: [] };
  try {
    for (const agent of await sources.agents()) {
      if (agent.available) agents.ready.push({ handle: agent.handle, id: agent.id });
      else agents.unavailable.push({ handle: agent.handle, id: agent.id, reason: agent.reason ?? 'not available' });
    }
  } catch (err) {
    agents.error = message(err);
  }

  const needsYou = database.reachable ? await sources.attention().catch(() => null) : null;
  const lastRecap = database.reachable ? await sources.lastRecapAt().catch(() => null) : null;
  const update = await sources.update().catch(() => ({ available: false }));

  return {
    version,
    install: sources.install,
    service,
    database,
    agents,
    needsYou,
    lastRecapAt: lastRecap ? lastRecap.toISOString() : null,
    update,
  };
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The report as a few short sentences. Pure. */
export function renderStatus(report: StatusReport, timezone = 'UTC'): string {
  const lines: string[] = [];
  lines.push(
    `buddi ${report.version}, ${report.install === 'packaged' ? 'a packaged install' : 'a source checkout'}.`,
  );

  const service = report.service;
  if (service.state === 'running') lines.push(`The service is ${service.detail}.`);
  else if (service.state === 'not-installed') {
    lines.push(
      report.install === 'packaged'
        ? 'The service is not running. Run buddi to start it.'
        : 'The service is not installed. Run buddi service install.',
    );
  } else if (service.state === 'stopped') lines.push(`The service is not running: ${service.detail}. Run buddi service start.`);
  else lines.push(`The service could not be read: ${service.detail}`);

  lines.push(
    report.database.reachable
      ? 'The database is reachable.'
      : `The database is not reachable: ${report.database.error ?? 'no reason given'}`,
  );

  const { ready, unavailable, error } = report.agents;
  if (error !== undefined) lines.push(`The agents could not be read: ${error}`);
  else {
    if (ready.length === 0) lines.push('No agent can run yet.');
    else lines.push(`${count(ready.length, 'agent can', 'agents can')} run: ${ready.map((a) => `@${a.handle}`).join(', ')}.`);
    for (const agent of unavailable) lines.push(`@${agent.handle} cannot run: ${agent.reason.replace(/\.$/, '')}.`);
  }

  if (report.needsYou === null) {
    lines.push(report.database.reachable ? 'What needs you could not be read.' : 'What needs you is unknown without the database.');
  } else {
    const { approvals, questions } = report.needsYou;
    if (approvals + questions === 0) lines.push('Nothing needs you.');
    else {
      const parts = [
        ...(approvals > 0 ? [count(approvals, 'approval', 'approvals')] : []),
        ...(questions > 0 ? [count(questions, 'question', 'questions')] : []),
      ];
      lines.push(`${parts.join(' and ')} ${approvals + questions === 1 ? 'needs' : 'need'} you. Open the dashboard with buddi.`);
    }
  }

  if (report.lastRecapAt !== null) {
    lines.push(`The last recap went out ${localDateTimeString(new Date(report.lastRecapAt), timezone)}.`);
  }

  if (report.update.available && report.update.latest) {
    lines.push(`A newer buddi is available: ${report.update.latest}. Run buddi upgrade.`);
  }
  return lines.join('\n');
}

/** When a process started, as `ps` says it; undefined when it cannot. */
export async function startedAt(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await exec('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 3_000 });
    const text = stdout.trim().replace(/\s+/g, ' ');
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

/** The supervisor's control socket, beside the data it looks after. */
export function supervisorSocketPath(dataDir: string): string {
  return path.join(dataDir, 'supervisor.sock');
}
