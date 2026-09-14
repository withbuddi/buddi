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
  /** Where this boot's secrets came from — the vault, or `.env`. */
  vault(): Promise<ProbeResult>;
  modelCredential(): Promise<ProbeResult>;
  botToken(): Promise<ProbeResult>;
  pairedDevices(): Promise<ProbeResult>;
  /** The durable queue: paused or running, and how the jobs stand. */
  queue(): Promise<ProbeResult>;
  /** The local dashboard: where it is bound, and whether a token exists yet. */
  dashboard(): Promise<ProbeResult>;
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
  { name: 'vault', critical: true, probe: 'vault' },
  { name: 'model credential', critical: true, probe: 'modelCredential' },
  { name: 'telegram bot', critical: false, probe: 'botToken' },
  { name: 'paired devices', critical: false, probe: 'pairedDevices' },
  { name: 'queue', critical: false, probe: 'queue' },
  { name: 'dashboard', critical: false, probe: 'dashboard' },
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

/* ------------------------------------------------------------------ *
 * The vault row
 * ------------------------------------------------------------------ */

/**
 * What hydration learned this boot: which vault, where each secret came from,
 * and which ones resolved nowhere. Names and reasons only — never a value, so
 * the whole row is safe to paste into an issue.
 *
 * Structurally the gateway's `SecretHydration`; restated here so the pure part
 * of the doctor keeps depending on nothing.
 */
export interface VaultFacts {
  /** `keychain`, `file`, `memory` or `none`. */
  vault: string;
  sources: Record<string, 'vault' | 'env'>;
  problems: Record<string, { code: string; message: string }>;
}

/**
 * The model credential, under either of its two names. This is the only secret
 * the installation genuinely *requires*: a missing bot token costs a surface, a
 * missing app password costs a plugin, but with no model credential nothing
 * runs at all.
 */
export const REQUIRED_SECRETS: readonly string[] = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];

/**
 * Turn hydration into a row.
 *
 * A locked vault fails *before* anything else is said about the secrets: every
 * probe downstream is about to report a credential it could not reach, and the
 * lock is the one fact that explains all of them.
 */
export function checkVault(facts: VaultFacts, required: readonly string[] = REQUIRED_SECRETS): ProbeResult {
  const locked = Object.values(facts.problems).find((p) => p.code === 'vault-locked');
  if (locked) {
    return {
      status: 'fail',
      detail: `${facts.vault} vault is locked: ${locked.message} — unlock it and re-run (no secret was read)`,
    };
  }

  const named = (source: 'vault' | 'env'): string[] =>
    Object.keys(facts.sources)
      .filter((name) => facts.sources[name] === source)
      .sort();
  const fromVault = named('vault');
  const fromEnv = named('env');
  const where =
    [
      fromVault.length > 0 ? `from the vault: ${fromVault.join(', ')}` : '',
      fromEnv.length > 0 ? `from .env: ${fromEnv.join(', ')}` : '',
    ]
      .filter((s) => s !== '')
      .join('; ') || 'no secrets resolved';

  if (!required.some((name) => facts.sources[name] !== undefined)) {
    return {
      status: 'fail',
      detail:
        `${facts.vault} — ${where}; no model credential ` +
        `(\`buddi vault set CLAUDE_CODE_OAUTH_TOKEN\`, or set it in .env)`,
    };
  }

  return { status: 'ok', detail: `${facts.vault} — ${where}` };
}

/** Node's own floor. Kept here so the version rule is testable without a process. */
export const MIN_NODE_MAJOR = 22;

export function checkNodeVersion(version: string): ProbeResult {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? '0');
  return major >= MIN_NODE_MAJOR
    ? { status: 'ok', detail: version }
    : { status: 'fail', detail: `${version} — buddi needs Node ${MIN_NODE_MAJOR} or newer` };
}
