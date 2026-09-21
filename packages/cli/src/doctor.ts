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
  /**
   * Where the database's port is published, and what protects it. Optional so
   * that a caller built before this row existed still satisfies the interface.
   */
  databaseExposure?(): Promise<ProbeResult>;
  migrations(): Promise<ProbeResult>;
  /** Where this boot's secrets came from — the vault, or `.env`. */
  vault(): Promise<ProbeResult>;
  modelCredential(): Promise<ProbeResult>;
  /** Which engine each installed agent runs on, and whether it can run here. */
  agents(): Promise<ProbeResult>;
  /**
   * Where agents and skills are loaded from. Optional so that a caller built
   * before the search path existed still satisfies the interface; a row whose
   * probe is absent is simply not printed.
   */
  config?(): Promise<ProbeResult>;
  /**
   * Whether this installation can search the web, and through whom. Optional
   * so a caller built before the web plugin existed still satisfies the
   * interface; a row whose probe is absent is simply not printed.
   */
  webSearch?(): Promise<ProbeResult>;
  /**
   * How agents get a screen, and whether "Your browser" has a paired Chrome.
   * Optional for the same reason `config` is.
   */
  browser?(): Promise<ProbeResult>;
  botToken(): Promise<ProbeResult>;
  pairedDevices(): Promise<ProbeResult>;
  /** The durable queue: paused or running, and how the jobs stand. */
  queue(): Promise<ProbeResult>;
  /** The local dashboard: where it is bound, and whether a token exists yet. */
  dashboard(): Promise<ProbeResult>;
  service(): Promise<ProbeResult>;
  /**
   * The plugins the owner installed on top of this build: how many, and
   * whether each one loaded. Optional for the same reason `config` is.
   */
  plugins?(): Promise<ProbeResult>;
  /**
   * The backups. Optional for the same reason `config` is: a caller built
   * before this row existed still satisfies the interface.
   */
  backups?(): Promise<ProbeResult>;
  /**
   * Whether this installation is still in recovery after a restore. Optional
   * for the same reason `config` is.
   */
  recovery?(): Promise<ProbeResult>;
  /**
   * Signing in through Tailscale: the daemon, the setting, and whether the
   * proxy is actually published. Optional for the same reason `config` is.
   */
  tailscale?(): Promise<ProbeResult>;
  timezone(): ProbeResult;
}

/** Name, whether it is critical, and how to find out — in the printed order. */
const ROWS: Array<{ name: string; critical: boolean; probe: keyof DoctorProbes }> = [
  { name: 'node', critical: true, probe: 'nodeVersion' },
  { name: 'pnpm', critical: true, probe: 'pnpmVersion' },
  { name: 'docker', critical: false, probe: 'dockerVersion' },
  { name: 'postgres', critical: true, probe: 'postgres' },
  { name: 'database exposure', critical: true, probe: 'databaseExposure' },
  { name: 'migrations', critical: true, probe: 'migrations' },
  { name: 'vault', critical: true, probe: 'vault' },
  { name: 'model credential', critical: true, probe: 'modelCredential' },
  { name: 'config', critical: false, probe: 'config' },
  { name: 'agents', critical: true, probe: 'agents' },
  // Never critical: an installation whose weather plugin will not import is
  // still a working installation, minus a weather plugin. But it is never
  // silent either — "installed but did not load" is a state an owner can be in
  // for weeks without a surface ever mentioning it.
  { name: 'plugins', critical: false, probe: 'plugins' },
  // A warning, never critical: with no key the agents lose a capability and
  // are told so, which is a degraded assistant rather than a broken one.
  { name: 'web search', critical: false, probe: 'webSearch' },
  // Never critical: an installation with no browser backend is an installation
  // whose agents cannot open a website, which is a lost capability, not a
  // broken buddi.
  { name: 'browser', critical: false, probe: 'browser' },
  { name: 'telegram bot', critical: false, probe: 'botToken' },
  { name: 'paired devices', critical: false, probe: 'pairedDevices' },
  { name: 'queue', critical: false, probe: 'queue' },
  { name: 'dashboard', critical: false, probe: 'dashboard' },
  { name: 'service', critical: false, probe: 'service' },
  { name: 'backups', critical: false, probe: 'backups' },
  { name: 'recovery', critical: false, probe: 'recovery' },
  // Never critical: with this off, or its proxy down, buddi is a dashboard on
  // loopback, which is what it is by default.
  { name: 'tailscale', critical: false, probe: 'tailscale' },
  { name: 'timezone', critical: false, probe: 'timezone' },
];

/** Run every probe, in order. A probe that throws is a failed check, not a crash. */
export async function collectChecks(probes: DoctorProbes): Promise<Check[]> {
  const checks: Check[] = [];
  for (const row of ROWS) {
    const probe = probes[row.probe] as undefined | (() => ProbeResult | Promise<ProbeResult>);
    if (probe === undefined) continue;
    let result: ProbeResult;
    try {
      result = await probe.call(probes);
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
  /**
   * What this machine's vault *is*, independent of what it managed to answer.
   *
   * Hydration can only report that a secret did not resolve. That is the wrong
   * altitude for the one failure a stranger actually hits: on a machine with no
   * keychain the vault is a file and `BUDDI_VAULT_KEY` is the key, and "locked"
   * without that sentence is a variable name and no way to produce a value for
   * it. Optional so a test may omit it.
   */
  state?: { selection: string; locked: boolean; file?: string; advice: string };
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
  if (locked || facts.state?.locked === true) {
    // The advice, when there is one, *is* the fix. It names the file, the
    // variable and the command, which is the difference between a row an owner
    // can act on and a row they file an issue about.
    const why = locked?.message ?? 'no key';
    return {
      status: 'fail',
      detail:
        facts.state?.advice !== undefined && facts.state.advice !== ''
          ? `${facts.vault} vault is locked — ${facts.state.advice} (no secret was read)`
          : `${facts.vault} vault is locked: ${why} — unlock it and re-run (no secret was read)`,
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

  // A file vault that opens is fine *today*. What it is not is backed up: the
  // key is the one thing an archive deliberately never contains, so the row
  // says so every time rather than once, at `init`, months ago.
  if (facts.state?.selection === 'file') {
    return {
      status: 'ok',
      detail:
        `file vault at ${facts.state.file ?? 'the configured path'} — ${where}; ` +
        `BUDDI_VAULT_KEY opens it and is never in a backup — keep a copy off this machine`,
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

/* ------------------------------------------------------------------ *
 * The config row
 * ------------------------------------------------------------------ */

/** The resolved search path, as the doctor needs to see it. */
export interface ConfigFacts {
  /** Where the shipped examples live, and how many agents loaded from there. */
  examplesDir: string;
  examples: number;
  /** The owner's own directory, and how many agents came from it. */
  privateDir: string;
  private: number;
  /** True when the owner's agents are still inside the repository. */
  legacy: boolean;
}

/**
 * Where this installation's configuration lives.
 *
 * Never critical: an installation running only the examples is a *fresh* one,
 * not a broken one. It warns in exactly two cases — nothing private yet (say
 * where to put it) and the pre-split layout (say how to move it) — because both
 * are one command away from being right.
 */
export function checkConfig(facts: ConfigFacts): ProbeResult {
  const where =
    `examples ${facts.examplesDir} (${facts.examples}), ` +
    `private ${facts.privateDir} (${facts.private})`;
  if (facts.legacy) {
    return {
      status: 'warn',
      detail: `${where}; your agents are still inside the repository — run \`buddi agents migrate\``,
    };
  }
  if (facts.private === 0) {
    return {
      status: 'warn',
      detail: `${where}; no agents of your own yet — add one under ${facts.privateDir}`,
    };
  }
  return { status: 'ok', detail: where };
}

/* ------------------------------------------------------------------ *
 * The backups row
 * ------------------------------------------------------------------ */

/** What the doctor needs to know about the backups. */
export interface BackupFacts {
  /** Where the archives live. Printed whether or not any exist. */
  dir: string;
  /** Milliseconds since the newest archive was written; absent when there is none. */
  newestAgeMs?: number;
  newestName?: string;
  newestBytes?: number;
  count: number;
  /** Is the nightly job installed with the OS? */
  scheduleInstalled: boolean;
  /** Why the schedule could not be read at all (an unsupported platform). */
  scheduleError?: string;
}

/**
 * Never critical, always loud.
 *
 * An installation with no backup still works perfectly today — which is exactly
 * why this must not be a `fail` that an owner learns to ignore, and exactly why
 * it must not be silent either. It warns when there is no backup at all, when
 * the newest is older than the nightly job would allow, and when backups exist
 * but nothing is scheduled to take the next one.
 */
export function checkBackups(facts: BackupFacts, staleAfterMs: number): ProbeResult {
  const where = `${facts.dir}`;
  const schedule = facts.scheduleError
    ? `schedule unavailable (${facts.scheduleError})`
    : facts.scheduleInstalled
      ? 'nightly schedule installed'
      : 'NO nightly schedule (`buddi backup schedule install`)';

  if (facts.count === 0 || facts.newestAgeMs === undefined) {
    return {
      status: 'warn',
      detail: `no backup has ever been taken — \`buddi backup create\` (${where}); ${schedule}`,
    };
  }

  const age = formatAgeShort(facts.newestAgeMs);
  const size = facts.newestBytes === undefined ? '' : `, ${formatBytesShort(facts.newestBytes)}`;
  const summary = `${facts.count} archive(s) in ${where}; newest ${facts.newestName ?? ''} ${age}${size}; ${schedule}`;

  if (facts.newestAgeMs > staleAfterMs) {
    return {
      status: 'warn',
      detail: `STALE — the newest backup is ${age} (over ${Math.round(staleAfterMs / 3_600_000)}h). ${summary}`,
    };
  }
  if (!facts.scheduleInstalled && facts.scheduleError === undefined) {
    return { status: 'warn', detail: summary };
  }
  return { status: 'ok', detail: summary };
}

/* ------------------------------------------------------------------ *
 * The tailscale row
 * ------------------------------------------------------------------ */

/** What the doctor can learn about signing in through Tailscale. */
export interface TailscaleFacts {
  /** Is a local `tailscaled` answering, and who is this machine? */
  daemon: { reachable: boolean; self?: string | null | undefined };
  /** The stored setting, or null when it has never been set. */
  setting: { enabled: boolean; login: string } | null;
  /** `BUDDI_WEB_PUBLIC_ORIGIN`, when one is configured. */
  publicOrigin?: string | undefined;
  /** The port the dashboard is bound to, which Serve has to forward to. */
  gatewayPort: number;
  /**
   * What `tailscale serve status --json` said. `checked: false` means the
   * binary was not found, and the row says it could not check rather than
   * inventing a verdict.
   */
  serve: { checked: boolean; routesGateway?: boolean | undefined; error?: string | undefined };
}

/**
 * One line about signing in through Tailscale.
 *
 * Off is `ok` and one short sentence: the default is not a problem. On is
 * where the row earns its place — it names who may sign in, and it warns when
 * the pieces that make that work are missing, because "enabled" with no daemon
 * or no published route is a setting that quietly does nothing.
 */
export function checkTailscale(facts: TailscaleFacts): ProbeResult {
  const setting = facts.setting;
  const daemon = facts.daemon.reachable
    ? `tailscaled is running${facts.daemon.self ? ` as ${facts.daemon.self}` : ''}`
    : 'tailscaled is not running here';
  if (!setting?.enabled) {
    return { status: 'ok', detail: `off — nothing signs in through Tailscale; ${daemon}` };
  }

  const parts = [`on for ${setting.login}`, daemon];
  const problems: string[] = [];
  if (!facts.daemon.reachable) {
    problems.push('without a local tailscaled no whois can be made, so nobody can sign in this way');
  }
  if (facts.publicOrigin === undefined) {
    problems.push('BUDDI_WEB_PUBLIC_ORIGIN is not set, so the proxy origin is not an origin this gateway accepts');
  } else if (!/\.ts\.net$/.test(hostnameOf(facts.publicOrigin))) {
    problems.push(`the public origin ${facts.publicOrigin} is not a .ts.net origin`);
  } else {
    parts.push(`published at ${facts.publicOrigin}`);
  }
  if (!facts.serve.checked) {
    parts.push(`could not check \`tailscale serve status\` (${facts.serve.error ?? 'the tailscale binary was not found'})`);
  } else if (facts.serve.routesGateway) {
    parts.push(`serve forwards to 127.0.0.1:${facts.gatewayPort}`);
  } else {
    problems.push(`serve forwards nothing to 127.0.0.1:${facts.gatewayPort} — \`tailscale serve --bg --https=<port> http://127.0.0.1:${facts.gatewayPort}\``);
  }
  const detail = [...parts, ...problems].join('; ');
  return problems.length > 0 ? { status: 'warn', detail } : { status: 'ok', detail };
}

/** The host of an origin, or the origin itself when it does not parse. */
function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

/* ------------------------------------------------------------------ *
 * The recovery row
 * ------------------------------------------------------------------ */

/** What the doctor needs to know about a restore that has not been finished. */
export interface RecoveryFacts {
  /** True when `core.recovery` holds a row with no `left_at`. */
  active: boolean;
  /** When the restore ran. */
  restoredAt?: Date | undefined;
  /** The archive it was restored from. */
  archive?: string | undefined;
  /** What the archive carried and the owner has still to decide about. */
  pending?: { jobs: number; missions: number; approvals: number; grants: number } | undefined;
  /** The database could not be asked at all; the postgres row says why. */
  unknown?: boolean | undefined;
}

/**
 * A warning, never a failure, and never silent.
 *
 * An installation in recovery is working — chat and the dashboard are up — but
 * nothing else is running: no queue, no missions, no Telegram. That is a state
 * an owner can sit in for a week without any surface mentioning it, and then
 * wonder why their reminders stopped. So the doctor says it out loud, with the
 * date, whenever the row is open.
 */
export function checkRecovery(facts: RecoveryFacts): ProbeResult {
  if (facts.unknown) {
    return { status: 'warn', detail: 'not known — the database could not be asked' };
  }
  if (!facts.active) return { status: 'ok', detail: 'not in recovery' };

  const since = facts.restoredAt ? facts.restoredAt.toISOString().slice(0, 16).replace('T', ' ') : 'an unknown date';
  const waiting = facts.pending
    ? `${facts.pending.jobs} queued job(s), ${facts.pending.missions} mission(s), ` +
      `${facts.pending.approvals} approval(s), ${facts.pending.grants} tool grant(s) came back with the archive`
    : 'the archive’s pending work was not counted';
  return {
    status: 'warn',
    detail:
      `in recovery since ${since} (restored from ${facts.archive ?? 'an archive'}) — ` +
      `the queue, the missions and Telegram are asleep until you finish the checklist. ${waiting}`,
  };
}

/** Kept here so the row is a pure function of its facts, with no imports. */
function formatAgeShort(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m ago`;
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

/* ------------------------------------------------------------------ *
 * The agents row
 * ------------------------------------------------------------------ */

/** One agent's engine, as the doctor needs to see it. */
export interface AgentEngineFact {
  id: string;
  handle: string;
  provider: string;
  model: string;
  available: boolean;
  /** Why it cannot run here. Present only when `available` is false. */
  reason?: string;
  isDefault: boolean;
  /**
   * True when it is held back for a tool family no installed plugin provides.
   * A state of the installation, not a broken agent: the file is right and the
   * plugin is missing, so it is a warning even when it is the default one.
   */
  heldBack?: boolean;
  /** Which half of the search path it came from. */
  source?: string;
}

/**
 * Engines in one line: how many agents, on which provider and model, and which
 * of them this machine cannot actually reach.
 *
 * It FAILS only when the **default** agent cannot run — that is the one every
 * surface falls back to, so its credential is the installation's floor. An
 * unavailable specialist is a warning: the owner who has not signed up for a
 * second provider still has four agents that work, and taking the whole report
 * down over the fifth would be a lie about the state of the installation.
 */
export function checkAgents(agents: readonly AgentEngineFact[]): ProbeResult {
  if (agents.length === 0) {
    return { status: 'fail', detail: 'no agents are installed under agents/' };
  }

  const groups = new Map<string, { provider: string; model: string; count: number; reason?: string }>();
  for (const agent of agents) {
    const key = `${agent.provider}|${agent.model}`;
    const group = groups.get(key) ?? { provider: agent.provider, model: agent.model, count: 0 };
    group.count += 1;
    // Held back has its own sentence below; it is not a credential problem.
    if (!agent.available && agent.heldBack !== true && group.reason === undefined) group.reason = agent.reason;
    groups.set(key, group);
  }

  const parts = [...groups.values()].map(
    (g) =>
      `${g.count} ${g.provider} (${g.model}${g.reason === undefined ? '' : `, unavailable: ${g.reason}`})`,
  );
  const detail = `${agents.length} agent${agents.length === 1 ? '' : 's'} — ${parts.join(', ')}`;

  /*
   * Held back is its own sentence, and never a failure.
   *
   * An agent granting `finance.*` on an installation without the finance
   * plugin is *correctly written*: what is missing is an install, which the
   * owner does from one page. A failed doctor would say the installation is
   * broken when the only honest thing to report is that one plugin is absent —
   * and the gateway starts perfectly well either way (docs/install.md §7).
   */
  const held = agents.filter((a) => a.heldBack === true);
  const heldNote =
    held.length === 0
      ? ''
      : `; ${held.map((a) => `@${a.handle}`).join(', ')} held back until the plugin they grant is installed` +
        `${held.map((a) => a.reason).find((r) => r !== undefined) === undefined ? '' : ` (${held.map((a) => a.reason).find((r) => r !== undefined)})`}`;

  const fallback = agents.find((a) => a.isDefault);
  if (fallback && !fallback.available && fallback.heldBack !== true) {
    return {
      status: 'fail',
      detail: `${detail}${heldNote}; the default agent @${fallback.handle} cannot run`,
    };
  }
  const blocked = agents.filter((a) => !a.available && a.heldBack !== true);
  if (blocked.length > 0) {
    return {
      status: 'warn',
      detail: `${detail}${heldNote}; ${blocked.map((a) => `@${a.handle}`).join(', ')} cannot run here`,
    };
  }
  if (held.length > 0) return { status: 'warn', detail: `${detail}${heldNote}` };
  return { status: 'ok', detail };
}

/* ------------------------------------------------------------------ *
 * The plugins row
 * ------------------------------------------------------------------ */

/** What the doctor needs to know about the installed plugins. */
export interface PluginFacts {
  /** The record file the names came from — printed whether or not it has any. */
  record: string;
  /** Every installed plugin whose entry point imported and validated. */
  loaded: ReadonlyArray<{ name: string; version: string; source?: string }>;
  /** Every one that is in the record and did not, and the sentence saying why. */
  problems: ReadonlyArray<{ name: string; message: string }>;
  /**
   * Plugins whose files no longer hash to what was approved.
   *
   * A warning, not a failure: the plugin still loads and still works, and the
   * owner may have rebuilt it themselves. What it is not is what they agreed
   * to, and a plugin runs with everything buddi can do — so it is named.
   */
  changed?: ReadonlyArray<{ name: string; message: string }>;
}

/** `finance@1.2.3 (npm …)`, or just the version when nothing recorded a source. */
function named(plugin: { name: string; version: string; source?: string }): string {
  return `${plugin.name}@${plugin.version}${plugin.source === undefined ? '' : ` (${plugin.source})`}`;
}

/**
 * What the owner installed, and whether it is actually running.
 *
 * The built-in plugins are deliberately not counted here: they cannot be in one
 * state or the other, and a row that said "14 plugins" every time would hide
 * the one number that varies. What varies is the record — and a plugin can sit
 * in it, installed, migrated, named in an agent's grants, and not load at all.
 * `buddi plugins list` has said so since the lifecycle shipped; the doctor,
 * which is the command an owner runs when something feels wrong, did not ask.
 */
export function checkPlugins(facts: PluginFacts): ProbeResult {
  const total = facts.loaded.length + facts.problems.length;
  const changed = facts.changed ?? [];
  if (total === 0) {
    return {
      status: 'ok',
      detail: `none installed beyond what this build ships (${facts.record})`,
    };
  }
  const installed = `${total} installed`;
  const working = facts.loaded.map(named).join(', ');
  if (facts.problems.length === 0 && changed.length === 0) {
    return { status: 'ok', detail: `${installed}, all loaded: ${working}` };
  }
  if (facts.problems.length === 0) {
    return {
      status: 'warn',
      detail:
        `${installed}, all loaded: ${working}. ` +
        `${changed.map((c) => c.message).join(' ')}`,
    };
  }
  const broken = facts.problems.map((p) => `${p.name} (${p.message})`).join('; ');
  return {
    status: 'fail',
    detail:
      `${installed}, ${facts.problems.length} did not load — ${broken}` +
      `${facts.loaded.length === 0 ? '' : `; loaded: ${working}`}` +
      `${changed.length === 0 ? '' : `. ${changed.map((c) => c.message).join(' ')}`}. ` +
      'Its tools are absent from every agent: `buddi plugins list`, then rebuild it or ' +
      '`buddi plugins uninstall <name>`',
  };
}

/* ------------------------------------------------------------------ *
 * The database exposure row
 * ------------------------------------------------------------------ */

/**
 * What protects the database from the rest of the network.
 *
 * This is the row that would have caught the real thing: the compose file
 * published `"${BUDDI_DB_PORT:-5432}:5432"`, Docker read the missing host as
 * `0.0.0.0`, and the owner's financial history, mail bodies and conversations
 * sat on a LAN-reachable port behind the password `buddi`. Two facts, one row,
 * and `critical` — an installation in that state is not "working with a
 * warning", it is open.
 */
export interface DatabaseExposureFacts {
  /**
   * Does buddi own this database? False when an explicit `DATABASE_URL` points
   * at someone's own Postgres — their binding and their password, not ours.
   */
  composeManaged: boolean;
  /** What `docker compose port postgres 5432` printed, e.g. `127.0.0.1:55433`. */
  published?: string;
  /** Why the binding could not be read: a stopped daemon, a stopped container. */
  bindingError?: string;
  /** True when the password in use is the literal `buddi` this project shipped. */
  legacyPassword: boolean;
  /** True when `BUDDI_DB_PASSWORD` is in the vault, where compose expects it. */
  passwordInVault: boolean;
}

/** The command that fixes every failure this row can report. */
export const SECURE_COMMAND = 'buddi db secure';

/** Loopback, by address. `localhost` counts; a name that is not one does not. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** The host half of `127.0.0.1:5432` or `[::]:5432`, or null when unparseable. */
export function publishedHost(published: string): string | null {
  const bracketed = /^\[(.+)\]:\d+$/.exec(published.trim());
  if (bracketed) return bracketed[1] as string;
  const plain = /^(.+):\d+$/.exec(published.trim());
  return plain ? (plain[1] as string) : null;
}

export function checkDatabaseExposure(facts: DatabaseExposureFacts): ProbeResult {
  if (!facts.composeManaged) {
    return {
      status: 'ok',
      detail:
        'your own postgres (DATABASE_URL is set explicitly) — its binding and its password are yours',
    };
  }

  const problems: string[] = [];

  if (facts.published !== undefined) {
    const host = publishedHost(facts.published);
    if (host === null) {
      problems.push(`cannot read the published binding (${facts.published})`);
    } else if (!isLoopbackHost(host)) {
      problems.push(
        `the port is published on ${facts.published} — NOT loopback, so every host on ` +
          `this network can reach the database`,
      );
    }
  }

  if (facts.legacyPassword) {
    problems.push('the password is the literal `buddi` this project shipped with');
  } else if (!facts.passwordInVault) {
    problems.push(
      'no BUDDI_DB_PASSWORD in the vault, and compose expects one — the container is ' +
        'running on whatever password it was created with',
    );
  }

  if (problems.length > 0) {
    const exposed =
      facts.published !== undefined && !isLoopbackHost(publishedHost(facts.published) ?? '');
    const fix = exposed
      ? `run \`${SECURE_COMMAND}\`, then \`buddi db down && buddi db up\` to re-create it on 127.0.0.1`
      : `run \`${SECURE_COMMAND}\``;
    return { status: 'fail', detail: `${problems.join('; ')} — ${fix}` };
  }

  if (facts.bindingError !== undefined) {
    // The password is fine and the binding is unknown: a stopped container is
    // not an exposure, and claiming either way would be a guess.
    return {
      status: 'warn',
      detail: `password in the vault; could not read the published port (${facts.bindingError})`,
    };
  }

  return {
    status: 'ok',
    detail: `${facts.published ?? 'not published'} (loopback only); password in the vault`,
  };
}
