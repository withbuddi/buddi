/**
 * The doctor's probes — everything that touches the outside world.
 *
 * Each one answers a status and a sentence; none of them throws for a condition
 * the owner could fix (that is the *answer*), and every one of them is cheap
 * enough to run on every `buddi doctor`.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  DB_PASSWORD_VAR,
  LEGACY_DB_PASSWORD,
  countJobsByState,
  createPool,
  createVault,
  describeSource,
  vaultState,
  isPaused,
  passwordInDatabaseUrl,
  providerAuthHeaders,
  resolveProvider,
  timezoneFromEnv,
  type PluginManifest,
  type Vault,
} from '@buddi/core';
import {
  agentSearchPath,
  createToolRegistry,
  dataDir,
  readExtensionRecord,
  defaultHttpTransport,
  describeDatabaseError,
  hydrateSecrets,
  installedManifests,
  listDevices,
  loadGatewayCatalog,
  adoptedPlugins,
  loadInstalledPlugins,
  verifyInstalledHash,
  TelegramApi,
  telegramFetchOn,
  TAILSCALE_SETTING_KEY,
  resolveTailscaleBinary,
  tailscaleSelf,
  toTailscaleSetting,
  webConfig,
  webTokenExists,
  webUrl,
  isLoopback,
  WEB_ENABLED_VAR,
  type HttpTransport,
} from '@buddi/gateway';
import {
  NATIVE_BACKEND_ID,
  PROVIDER_VAR,
  resolveKey as resolveSearchKey,
  searchConfiguration,
} from '@buddi/tool-web';
import type { Pool } from 'pg';
import { STALE_AFTER_MS, listArchives, readRecovery, readWebSetting } from '@buddi/core';
import { createBackupScheduler } from './backup/schedule.js';
import { BACKUP_DIR } from './paths.js';
import {
  checkAgents,
  checkBackups,
  checkConfig,
  checkDatabaseExposure,
  checkRecovery,
  checkTailscale,
  checkNodeVersion,
  checkPlugins,
  checkVault,
  type AgentEngineFact,
  type DoctorProbes,
  type ProbeResult,
  type VaultFacts,
} from './doctor.js';
import { DB_UNREACHABLE, dockerState } from './db-cmd.js';
import { explicitUrlInEnvFile, isShippedDefaultUrl, publishedBinding } from './db-secure.js';
import { run, versionOf } from './proc.js';
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
  /**
   * The outbound transport. Defaults to the one every other caller uses
   * (`node:https`, nothing pooled — packages/runtime/src/transport.ts). Injected
   * in tests, which is also what keeps a `buddi doctor` test from reaching the
   * network: there is a seam here rather than a stubbed global.
   */
  http?: HttpTransport | undefined;
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
  const http = opts.http ?? defaultHttpTransport;
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

    /**
     * The one row that is about the *network*, not about whether things work.
     *
     * Both halves are read from the running system rather than from the compose
     * file: `docker compose port` says where the port actually landed, and the
     * password is whatever this process resolved — so an edit nobody applied
     * still reads as a failure until the container is re-created.
     */
    async databaseExposure(): Promise<ProbeResult> {
      // "Compose-managed" means buddi issued this credential. An explicit
      // `DATABASE_URL` in `.env` says it did not — and it has to be read from
      // the file, because by now one has been assembled into the environment.
      const explicit = await explicitUrlInEnvFile();
      const composeManaged = explicit === null || isShippedDefaultUrl(explicit, env);

      let passwordInVault = false;
      if (vault) {
        try {
          const stored = await vault.get(DB_PASSWORD_VAR);
          passwordInVault = stored !== null && stored.trim() !== '';
        } catch {
          // A locked or absent vault: the `vault` row above already says so.
        }
      }
      const inUse = databaseUrl === undefined ? null : passwordInDatabaseUrl(databaseUrl);
      const binding = await publishedBinding();

      return checkDatabaseExposure({
        composeManaged,
        legacyPassword: inUse === LEGACY_DB_PASSWORD,
        passwordInVault,
        ...(binding.published === undefined ? {} : { published: binding.published }),
        ...(binding.error === undefined ? {} : { bindingError: binding.error }),
      });
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
      // `vaultState` is asked separately from hydration on purpose: hydration
      // can only report that a secret did not resolve, and on a machine with no
      // keychain the useful sentence is about the *vault* — which file, which
      // variable, which command — not about the secret that happened to be
      // asked for first.
      return checkVault({ ...(await secrets()), state: vaultState({ env }) });
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
        // The same transport the provider adapters use, not the global `fetch`:
        // `buddi doctor` is one-shot and would never have wedged, but a probe
        // that reports on the model path should exercise the model path. See
        // packages/runtime/src/transport.ts.
        const res = await http(`${provider.baseUrl}/v1/models`, {
          method: 'GET',
          headers: { 'anthropic-version': '2023-06-01', ...providerAuthHeaders(provider) },
          signal: AbortSignal.timeout(15_000),
          idleTimeoutMs: 15_000,
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
              ...(agent.heldBack === undefined ? {} : { heldBack: true }),
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

    /**
     * Can the agents look anything up?
     *
     * No network call: the question is whether a key is configured, and asking
     * the provider would spend one of the owner's free searches on every
     * `buddi doctor`. It reads the *hydrated* environment, so a key that lives
     * in the keychain reads as present rather than as the `<vault>` marker.
     */
    async webSearch(): Promise<ProbeResult> {
      const facts = await secrets();
      const { provider, native, problem } = searchConfiguration(env);
      const key = resolveSearchKey(provider, env);
      // There are two backends now, and which one an agent gets depends on the
      // agent: a provider that searches server-side needs no key at all, and
      // this probe cannot see agents. So it reports what it can see — the key —
      // and names the half of the installation that is unaffected, rather than
      // warning about a gap that is not one for most of them.
      const nativeNote =
        'agents on a provider with its own server-side search (Anthropic) search without one';
      if (!key.configured) {
        const secretProblem = facts.problems[provider.keyName];
        const because =
          secretProblem && secretProblem.code !== 'missing-secret'
            ? `${provider.keyName} unavailable: ${secretProblem.message}`
            : key.reason;
        if (native) {
          return {
            status: 'ok',
            detail:
              `${PROVIDER_VAR}=${NATIVE_BACKEND_ID} — every agent searches through its own provider; ` +
              `agents on a provider without server-side search can read a page but cannot search`,
          };
        }
        return {
          status: 'warn',
          detail:
            `${because} — ${nativeNote}, and agents on any other provider can read a page but cannot search; ` +
            `\`buddi vault set ${provider.keyName}\` (free key: ${provider.signupUrl})`,
        };
      }
      const where = facts.sources[provider.keyName] === 'vault' ? 'vault' : '.env';
      if (native) {
        return {
          status: 'ok',
          detail:
            `${PROVIDER_VAR}=${NATIVE_BACKEND_ID} — every agent searches through its own provider; ` +
            `the ${provider.label} key in the ${where} is unused until that changes`,
        };
      }
      const forced = (env[PROVIDER_VAR] ?? '').trim() !== '';
      return {
        status: 'ok',
        detail:
          `${provider.label} — key from the ${where}` +
          `${forced ? ` (forced by ${PROVIDER_VAR}, on every provider)` : `; ${nativeNote}`}` +
          `${problem ? ` (${problem})` : ''}`,
      };
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
        const me = await new TelegramApi({ token, fetch: telegramFetchOn(http) }).getMe();
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
          // A failed job is not a statistic: it is work that did not happen and
          // will not happen unless the owner says so. The line says that, and
          // says how to undo it.
          return {
            status: 'warn',
            detail:
              `${summary} — ${counts.failed} piece(s) of work gave up and did nothing; ` +
              '`buddi jobs --state failed` to see them, `buddi jobs retry --all` to run them again',
          };
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

    /**
     * What the owner installed on top of this build, and whether it loaded.
     *
     * The same read `buddi plugins list` does — the record file and one import
     * per entry — and, like that command, one bad plugin is an answer rather
     * than an exception. Nothing is adopted into this process: the doctor
     * reports, it does not register.
     */
    async plugins(): Promise<ProbeResult> {
      // What this process actually adopted, when it adopted anything: that is
      // the set the agents were built against, so it is the honest answer.
      // Falling back to a fresh read keeps the probe usable from a process
      // that never called `loadPluginsOnce` — a test, or a future caller.
      const plugins = adoptedPlugins(env) ?? (await loadInstalledPlugins(env));
      // Against what was approved, not just against what loads: a plugin runs
      // with everything buddi can do, and the recorded hash is the only thing
      // that can say afterwards that its files are not the ones agreed to.
      // Every plugin with a record, not only the ones that loaded: a plugin
      // whose files were replaced is exactly the one most likely to stop
      // importing, and "it did not load" and "it is not what you approved" are
      // two different sentences that belong together.
      const records = [
        ...plugins.loaded.map((p) => p.record),
        ...plugins.problems.flatMap((p) => (p.record === undefined ? [] : [p.record])),
      ];
      const changed = records
        .map((record) => verifyInstalledHash(record, { env }))
        .filter((v) => !v.matches)
        .map((v) => ({ name: v.name, message: v.message }));
      return checkPlugins({
        record: plugins.file,
        loaded: plugins.loaded.map((p) => ({
          name: p.record.name,
          version: p.manifest.version,
          source: describeSource(p.record.source),
        })),
        problems: plugins.problems.map((p) => ({ name: p.name, message: p.message })),
        changed,
      });
    },

    /**
     * How agents get a screen.
     *
     * The mode the owner last chose, and — in "Your browser" mode — whether a
     * Chrome has been paired and which extension build it was. Whether that
     * extension is connected *right now* is only visible to the running
     * gateway, which holds the socket, so this row says when it was last seen
     * instead of guessing.
     */
    async browser(): Promise<ProbeResult> {
      let mode = 'computer';
      try {
        const settings = JSON.parse(await readFile(path.join(dataDir(env), 'browser', 'settings.json'), 'utf8')) as { mode?: unknown };
        if (typeof settings.mode === 'string') mode = settings.mode;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          return { status: 'warn', detail: `browser settings will not read: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      if (mode !== 'extension') {
        return { status: 'ok', detail: `mode=${mode}${mode === 'computer' && process.platform !== 'darwin' ? ' — computer mode needs macOS; switch to a browser mode in Computer & browser' : ''}` };
      }
      const record = await readExtensionRecord(env);
      if (!record) {
        return { status: 'warn', detail: 'mode=extension, no browser paired — open the buddi extension in Chrome and pair it in Computer & browser' };
      }
      const seen = record.lastSeenAt === '' ? 'never seen' : `last seen ${record.lastSeenAt}`;
      return { status: 'ok', detail: `mode=extension, paired ${record.pairedAt || 'at an unknown time'}${record.extension ? `, extension ${record.extension}` : ''}, ${seen} (the running gateway holds the live connection)` };
    },

    /**
     * Do backups exist, are they recent, and is anything taking the next one?
     *
     * Reads the directory listing only — never an archive's contents — so it
     * costs nothing and still works with Docker down, which is one of the
     * moments an owner most wants to know whether they have a backup.
     */
    async backups(): Promise<ProbeResult> {
      const archives = await listArchives(BACKUP_DIR);
      const newest = archives[0];
      let scheduleInstalled = false;
      let scheduleError: string | undefined;
      try {
        scheduleInstalled = (await createBackupScheduler().status()).installed;
      } catch (err) {
        scheduleError = err instanceof Error ? err.message : String(err);
      }
      return checkBackups(
        {
          dir: BACKUP_DIR,
          count: archives.length,
          ...(newest
            ? {
                newestAgeMs: Date.now() - newest.at,
                newestName: newest.name,
                newestBytes: newest.bytes,
              }
            : {}),
          scheduleInstalled,
          ...(scheduleError === undefined ? {} : { scheduleError }),
        },
        STALE_AFTER_MS,
      );
    },

    /**
     * Is this installation still in recovery after a restore?
     *
     * Read through core's own `readRecovery`, so the doctor and the dashboard
     * cannot disagree about what the row means.
     */
    /**
     * Signing in through Tailscale: is the daemon here, is the setting on and
     * for whom, and is the dashboard actually published on the tailnet?
     *
     * `tailscale serve status --json` is read only when a `tailscale` binary
     * is found — by the same resolution the gateway uses, PATH first and then
     * the two places a Mac keeps one. Without it the row says it could not
     * check rather than guessing.
     */
    async tailscale(): Promise<ProbeResult> {
      const config = webConfig(env);
      const daemon = await tailscaleSelf();
      const pool = await connected();
      const stored = pool === null
        ? null
        : toTailscaleSetting(await readWebSetting(pool, TAILSCALE_SETTING_KEY).catch(() => null));
      const serve = await serveStatus(config.port);
      return checkTailscale({
        daemon: { reachable: daemon.available, self: daemon.self?.login ?? null },
        setting: stored,
        ...(config.publicOrigin !== undefined ? { publicOrigin: config.publicOrigin } : {}),
        gatewayPort: config.port,
        serve,
      });
    },

    async recovery(): Promise<ProbeResult> {
      const pool = await connected();
      if (pool === null) return checkRecovery({ active: false, unknown: true });
      try {
        const state = await readRecovery(pool);
        if (state === null || !state.active) return checkRecovery({ active: false });
        return checkRecovery({
          active: true,
          restoredAt: state.restoredAt,
          archive: state.archive,
          pending: {
            jobs: state.pending.jobs,
            missions: state.pending.missions,
            approvals: state.pending.approvals,
            grants: state.pending.grants,
          },
        });
      } catch {
        // No `core.recovery` table is an installation that has never been
        // restored, which is not in recovery.
        return checkRecovery({ active: false });
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

/**
 * What `tailscale serve status --json` says, when there is a `tailscale` to
 * ask. Anything but a clean answer is "could not check" — the doctor reports
 * what it saw and never guesses at a route it did not read.
 */
async function serveStatus(gatewayPort: number): Promise<{ checked: boolean; routesGateway?: boolean; error?: string }> {
  const binary = resolveTailscaleBinary();
  if (binary === null) return { checked: false, error: 'the tailscale binary was not found' };
  const res = await run(binary, ['serve', 'status', '--json'], { timeoutMs: 10_000 });
  if (res.code === 127) return { checked: false, error: 'the tailscale binary was not found' };
  if (res.code !== 0) return { checked: false, error: (res.stderr || res.stdout).trim().split('\n')[0] ?? `exit ${res.code}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout.trim() === '' ? 'null' : res.stdout);
  } catch {
    return { checked: false, error: 'tailscale answered with something that is not JSON' };
  }
  // The shape varies by version, and all this row needs is whether any
  // handler in it proxies to the port the dashboard is bound to.
  const text = JSON.stringify(parsed ?? {});
  const routesGateway = text.includes(`127.0.0.1:${gatewayPort}`) || text.includes(`localhost:${gatewayPort}`);
  return { checked: true, routesGateway };
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
