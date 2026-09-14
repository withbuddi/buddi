/**
 * `buddi doctor` — one table that says what works and what does not.
 *
 * The aggregation is pure: `collectChecks` takes *facts* (an object of probe
 * functions) and turns them into rows, and `renderTable` and `exitCodeFor` are
 * plain functions of those rows. The probes that touch the network, the
 * database and `launchctl` live in `doctor-probes.ts`, so the interesting part
 * is testable with fakes.
 *
 * A check is `critical` when the installation cannot work without it: no
 * database, no credential, unapplied migrations. Everything else is a warning —
 * a missing bot token is only a broken *surface*, and `buddi chat` still works.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** A failing critical check makes `buddi doctor` exit 1. */
  critical: boolean;
}

export interface ProbeResult {
  status: CheckStatus;
  detail: string;
}

/** Everything the doctor needs to learn from the outside world. */
export interface DoctorProbes {
  nodeVersion(): ProbeResult;
  pnpmVersion(): Promise<ProbeResult>;
  dockerVersion(): Promise<ProbeResult>;
  postgres(): Promise<ProbeResult>;
  migrations(): Promise<ProbeResult>;
  modelCredential(): Promise<ProbeResult>;
  botToken(): Promise<ProbeResult>;
  pairedDevices(): Promise<ProbeResult>;
  service(): Promise<ProbeResult>;
  timezone(): ProbeResult;
}

/** Name, whether it is critical, and how to find out — in the printed order. */
const ROWS: Array<{ name: string; critical: boolean; probe: keyof DoctorProbes }> = [
  { name: 'node', critical: true, probe: 'nodeVersion' },
  { name: 'pnpm', critical: true, probe: 'pnpmVersion' },
  { name: 'docker', critical: false, probe: 'dockerVersion' },
  { name: 'postgres', critical: true, probe: 'postgres' },
  { name: 'migrations', critical: true, probe: 'migrations' },
  { name: 'model credential', critical: true, probe: 'modelCredential' },
  { name: 'telegram bot', critical: false, probe: 'botToken' },
  { name: 'paired devices', critical: false, probe: 'pairedDevices' },
  { name: 'service', critical: false, probe: 'service' },
  { name: 'timezone', critical: false, probe: 'timezone' },
];

/** Run every probe, in order. A probe that throws is a failed check, not a crash. */
export async function collectChecks(probes: DoctorProbes): Promise<Check[]> {
  const checks: Check[] = [];
  for (const row of ROWS) {
    let result: ProbeResult;
    try {
      result = await probes[row.probe]();
    } catch (err) {
      result = { status: 'fail', detail: err instanceof Error ? err.message : String(err) };
    }
    checks.push({ name: row.name, critical: row.critical, ...result });
  }
  return checks;
}

const MARK: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

export function renderTable(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length), 4);
  const lines = checks.map(
    (c) => `  ${MARK[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`,
  );
  return lines.join('\n');
}

/** 1 when any critical check failed; a warning never fails the command. */
export function exitCodeFor(checks: Check[]): number {
  return checks.some((c) => c.critical && c.status === 'fail') ? 1 : 0;
}

export function summarize(checks: Check[]): string {
  const failed = checks.filter((c) => c.status === 'fail');
  const criticalFailures = failed.filter((c) => c.critical);
  const warnings = checks.filter((c) => c.status === 'warn');
  if (criticalFailures.length > 0) {
    return `${criticalFailures.length} critical check(s) failed: ${criticalFailures
      .map((c) => c.name)
      .join(', ')}`;
  }
  if (failed.length > 0 || warnings.length > 0) {
    return `everything critical is in place; ${failed.length + warnings.length} thing(s) to look at`;
  }
  return 'everything checks out';
}

/** Node's own floor. Kept here so the version rule is testable without a process. */
export const MIN_NODE_MAJOR = 22;

export function checkNodeVersion(version: string): ProbeResult {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? '0');
  return major >= MIN_NODE_MAJOR
    ? { status: 'ok', detail: version }
    : { status: 'fail', detail: `${version} — buddi needs Node ${MIN_NODE_MAJOR} or newer` };
}
