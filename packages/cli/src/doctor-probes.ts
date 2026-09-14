/**
 * The doctor's probes — everything that touches the outside world.
 *
 * Each one answers a status and a sentence; none of them throws for a condition
 * the owner could fix (that is the *answer*), and every one of them is cheap
 * enough to run on every `buddi doctor`.
 */
import { readdir } from 'node:fs/promises';
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  countJobsByState,
  createPool,
  createVault,
  isPaused,
  providerAuthHeaders,
  resolveProvider,
  timezoneFromEnv,
  type PluginManifest,
  type Vault,
} from '@buddi/core';
import {
  agentSearchPath,
  createToolRegistry,
  describeDatabaseError,
  hydrateSecrets,
  installedManifests,
  listDevices,
  loadGatewayCatalog,
  TelegramApi,
  webConfig,
  webTokenExists,
  webUrl,
  isLoopback,
  WEB_ENABLED_VAR,
} from '@buddi/gateway';
import type { Pool } from 'pg';
import {
  checkAgents,
  checkConfig,
  checkNodeVersion,
  checkVault,
  type AgentEngineFact,
  type DoctorProbes,
  type ProbeResult,
  type VaultFacts,
} from './doctor.js';
import { DB_UNREACHABLE, dockerState } from './db-cmd.js';
import { versionOf } from './proc.js';
import { createServiceManager } from './service/index.js';

/** One lazily created pool, shared by the database probes and closed at the end. */
class LazyPool {
  #pool: Pool | undefined;

  get(url: string): Pool {
    this.#pool ??= createPool(url);
    return this.#pool;
  }

  async end(): Promise<void> {
    if (this.#pool) await this.#pool.end().catch(() => {});
    this.#pool = undefined;
  }
}

/** Every migration file the installation *should* have applied. */
async function expectedMigrations(manifests: PluginManifest[]): Promise<Array<[string, string]>> {
  const dirs: Array<[string, string]> = [[CORE_SCHEMA, CORE_MIGRATIONS_DIR]];
  for (const m of manifests) {
    if (m.migrationsDir && m.migrationsDir.trim() !== '') dirs.push([m.schema, m.migrationsDir]);
  }
  const expected: Array<[string, string]> = [];
  for (const [schema, dir] of dirs) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files.filter((f) => f.endsWith('.sql')).sort()) expected.push([schema, f]);
  }
  return expected;
}

export interface Probes extends DoctorProbes {
  /** Release the pool the database probes opened. */
  close(): Promise<void>;
}

export interface ProbeOptions {
  /** This machine's vault. Injected in tests; `BUDDI_VAULT=none` turns it off. */
  vault?: Vault | undefined;
}

/**
 * The doctor checks the installation *as the service sees it*.
 *
 * After `buddi vault import-env`, `.env` holds `NAME=<vault>` markers, so a
 * probe that read `process.env` raw would test the literal string `<vault>` as
 * if it were a token — and report a broken installation that works perfectly.
 * Every secret-touching probe waits on this one hydration instead, which is the
 * same call the running service makes at startup.
 */
export function createProbes(env: NodeJS.ProcessEnv = process.env, opts: ProbeOptions = {}): Probes {
  const lazy = new LazyPool();
  const databaseUrl = env.DATABASE_URL;

  const vault = opts.vault ?? createVault({ env });
  let hydration: Promise<VaultFacts> | undefined;
  /** Hydrate once per run: the keychain is a process call, not a getter. */
  const secrets = (): Promise<VaultFacts> => (hydration ??= hydrateSecrets(env, vault));

  const connected = async (): Promise<Pool | null> => {
    if (!databaseUrl) return null;
    const pool = lazy.get(databaseUrl);
    try {
      await pool.query('select 1');
      return pool;
    } catch {
      return null;
    }
  };

  return {
    nodeVersion(): ProbeResult {
      return checkNodeVersion(process.versions.node);
    },

    async pnpmVersion(): Promise<ProbeResult> {
      const v = await versionOf('pnpm');
      return v
        ? { status: 'ok', detail: v }
        : { status: 'fail', detail: 'not on PATH — https://pnpm.io/installation' };
    },

    /**
     * The *daemon*, not the client. `docker --version` answers from the binary
     * alone and reported a cheerful row with Docker Desktop closed — while
     * every database row below it failed. A stopped daemon is the cause of all
     * of them, so it fails, loudly, with the one command that fixes it.
     */
    async dockerVersion(): Promise<ProbeResult> {
      const docker = await dockerState();
      if (docker.state === 'absent') return { status: 'warn', detail: docker.detail };
      if (docker.state === 'stopped') {
        return { status: 'fail', detail: `${docker.detail} — then \`buddi db up\`` };
      }
      return { status: 'ok', detail: docker.detail };
    },

    async postgres(): Promise<ProbeResult> {
      if (!databaseUrl) {
        return { status: 'fail', detail: 'DATABASE_URL is not set (run `buddi init`)' };
      }
      const pool = lazy.get(databaseUrl);
      try {
        const { rows } = await pool.query<{ v: string }>('select version() as v');
        const version = (rows[0]?.v ?? 'postgres').split(' ').slice(0, 2).join(' ');
        return { status: 'ok', detail: `${version} — ${redactUrl(databaseUrl)}` };
      } catch (err) {
        // One sentence, the same one every other entry point prints — never the
        // empty `AggregateError` pg throws for a refused connection.
        return { status: 'fail', detail: describeDatabaseError(err, databaseUrl) };
      }
    },

    async migrations(): Promise<ProbeResult> {
      const pool = await connected();
      if (!pool) return { status: 'fail', detail: DB_UNREACHABLE };
      const expected = await expectedMigrations(installedManifests());
      try {
        const { rows } = await pool.query<{ schema: string; filename: string }>(
          'select schema, filename from core.migrations',
        );
        const done = new Set(rows.map((r) => `${r.schema}/${r.filename}`));
        const pending = expected.filter(([s, f]) => !done.has(`${s}/${f}`));
        return pending.length === 0
          ? { status: 'ok', detail: `${expected.length} applied, none pending` }
          : {
              status: 'fail',
              detail: `${pending.length} pending (${pending
                .map(([s, f]) => `${s}/${f}`)
                .join(', ')}) — run \`buddi migrate\``,
            };
      } catch {
        return {
          status: 'fail',
          detail: 'core.migrations does not exist — run `buddi migrate`',
        };
      }
    },

    async vault(): Promise<ProbeResult> {
      return checkVault(await secrets());
    },

    async modelCredential(): Promise<ProbeResult> {
      const facts = await secrets();
      let ref;
      try {
        const registry = createToolRegistry();
        ref = loadGatewayCatalog({ env, registry }).defaultAgent().provider;
      } catch (err) {
        return {
          status: 'fail',
          detail: `agent catalog will not load: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const resolution = resolveProvider(ref, env);
      if (!resolution.ok) {
        // When the vault could not hand the credential over, say *that*: the
        // owner's next move is unlocking a keychain, not pasting a key.
        const blocked = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']
          .map((name) => facts.problems[name])
          .find((p) => p !== undefined && p.code !== 'missing-secret');
        return {
          status: 'fail',
          detail: blocked
            ? `${resolution.problem.message} — the ${facts.vault} vault could not supply it: ${blocked.message}`
            : `${resolution.problem.message} — set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY`,
        };
      }
      const provider = resolution.provider;
      try {
        const res = await fetch(`${provider.baseUrl}/v1/models`, {
          method: 'GET',
          headers: { 'anthropic-version': '2023-06-01', ...providerAuthHeaders(provider) },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          return {
            status: 'ok',
            detail: `${provider.credentialKind} accepted, model ${provider.model}`,
          };
        }
        // A subscription token is scoped to the messages API; /v1/models can
        // refuse it while the credential is perfectly good. Say so rather than
        // failing an installation that works.
        if (provider.credentialKind === 'subscription-token' && (res.status === 401 || res.status === 403)) {
          return {
            status: 'warn',
            detail: `${provider.credentialKind} present; /v1/models answered ${res.status} (that endpoint does not accept subscription tokens)`,
          };
        }
        return { status: 'fail', detail: `/v1/models answered ${res.status}` };
      } catch (err) {
        return {
          status: 'fail',
          detail: `could not reach ${provider.baseUrl}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    },

    /**
     * Where configuration comes from: the examples this repo ships, and the
     * owner's private directory, which overrides them and is never committed.
     * Reads files only — it works with everything else down.
     */
    async config(): Promise<ProbeResult> {
      const search = agentSearchPath(env);
      let examples = 0;
      let owned = 0;
      try {
        const catalog = loadGatewayCatalog({ env, registry: createToolRegistry(env) });
        for (const summary of catalog.list()) {
          const source = (summary as { source?: string }).source ?? 'private';
          if (source === 'example') examples += 1;
          else owned += 1;
        }
      } catch {
        /* the agents row below says why; this row still names the directories */
      }
      return checkConfig({
        examplesDir: search.examples.dir,
        examples,
        privateDir: search.owner.dir,
        private: owned,
        legacy: search.legacy,
      });
    },

    /**
     * Every agent's engine, not just the default one's. The row above answers
     * "can this installation talk to a model at all"; this one answers "and
     * which of my agents can actually run".
     */
    async agents(): Promise<ProbeResult> {
      await secrets();
      let facts: AgentEngineFact[];
      try {
        const catalog = loadGatewayCatalog({ env, registry: createToolRegistry(env) });
        facts = catalog.list().flatMap((summary) => {
          const agent = catalog.get(summary.id);
          if (!agent) return [];
          return [
            {
              id: agent.id,
              handle: agent.handle,
              provider: agent.provider.kind,
              model: agent.model,
              available: agent.availability.ok,
              ...(agent.availability.ok ? {} : { reason: agent.availability.problem.message }),
              isDefault: agent.isDefault,
            },
          ];
        });
      } catch (err) {
        return {
          status: 'fail',
          detail: `agent catalog will not load: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return checkAgents(facts);
    },

    async botToken(): Promise<ProbeResult> {
      const facts = await secrets();
      const token = env.TELEGRAM_BOT_TOKEN;
      if (!token || token.trim() === '') {
        const problem = facts.problems.TELEGRAM_BOT_TOKEN;
        return {
          status: 'warn',
          detail:
            problem && problem.code !== 'missing-secret'
              ? `TELEGRAM_BOT_TOKEN unavailable: ${problem.message} — no Telegram surface`
              : 'TELEGRAM_BOT_TOKEN is not set — no Telegram surface',
        };
      }
      try {
        const me = await new TelegramApi({ token }).getMe();
        return { status: 'ok', detail: `@${me.username ?? me.id} (id ${me.id})` };
      } catch (err) {
        return { status: 'fail', detail: err instanceof Error ? err.message : String(err) };
      }
    },

    async pairedDevices(): Promise<ProbeResult> {
      const pool = await connected();
      if (!pool) return { status: 'warn', detail: DB_UNREACHABLE };
      const devices = await listDevices(pool);
      return devices.length === 0
        ? { status: 'warn', detail: 'none paired — run `buddi telegram pair`' }
        : {
            status: 'ok',
            detail: devices.map((d) => `${d.surface}:${d.label ?? d.externalUserId}`).join(', '),
          };
    },

    /**
     * A paused installation is a *warning*, not a failure — it is a state the
     * owner chose. Failed and suspended jobs are named because they are the two
     * things waiting on a human.
     */
    async queue(): Promise<ProbeResult> {
      const pool = await connected();
      if (!pool) return { status: 'warn', detail: DB_UNREACHABLE };
      try {
        const counts = await countJobsByState(pool);
        const summary =
          `${counts.pending} pending, ${counts.leased} running, ${counts.suspended} suspended, ` +
          `${counts.failed} failed, ${counts.succeeded} succeeded`;
        if (await isPaused(pool)) {
          return { status: 'warn', detail: `PAUSED — ${summary} (\`buddi resume\` to start again)` };
        }
        if (counts.failed > 0) {
          return { status: 'warn', detail: `${summary} — \`buddi jobs --state failed\`` };
        }
        return { status: 'ok', detail: `running — ${summary}` };
      } catch {
        return { status: 'warn', detail: 'core.jobs does not exist — run `buddi migrate`' };
      }
    },

    /**
     * The dashboard: the address it is bound to, and whether the installation
     * has a token yet. Never creates one — the doctor reports, it does not
     * configure — and never prints it.
     */
    async dashboard(): Promise<ProbeResult> {
      const config = webConfig(env);
      if (!config.enabled) {
        return { status: 'warn', detail: `off (${WEB_ENABLED_VAR}=0)` };
      }
      const source = await webTokenExists({ env, ...(opts.vault ? { vault: opts.vault } : {}) });
      const where = `${webUrl(config)} (${config.host}:${config.port})`;
      if (!isLoopback(config.host)) {
        return {
          status: 'warn',
          detail: `${where} — NOT loopback; anyone who can reach this address can approve effects`,
        };
      }
      return source === null
        ? { status: 'warn', detail: `${where} — no token yet (created on the next \`buddi serve\`)` }
        : { status: 'ok', detail: `${where} — token in the ${source}` };
    },

    async service(): Promise<ProbeResult> {
      try {
        const manager = createServiceManager();
        const status = await manager.status();
        if (status.running) return { status: 'ok', detail: `${manager.kind}: ${status.detail}` };
        return {
          status: 'warn',
          detail: status.installed
            ? // The unit is on disk and the process is not up — the post-reboot
              // shape, where launchd gave up after the database kept refusing.
              `${manager.kind}: ${status.detail} — \`buddi service start\` (logs: \`buddi service logs\`)`
            : `not installed — \`buddi service install\` (or run \`buddi serve\` yourself)`,
        };
      } catch (err) {
        return { status: 'warn', detail: err instanceof Error ? err.message : String(err) };
      }
    },

    timezone(): ProbeResult {
      const tz = timezoneFromEnv(env);
      const set = env.BUDDI_TZ && env.BUDDI_TZ.trim() !== '';
      return {
        status: 'ok',
        detail: set ? `${tz} (BUDDI_TZ)` : `${tz} (default — set BUDDI_TZ to change it)`,
      };
    },

    async close(): Promise<void> {
      await lazy.end();
    },
  };
}

/** A connection string without its password. Doctor output is pasted into issues. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url.replace(/:\/\/[^@]*@/, '://***@');
  }
}
