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
  createPool,
  providerAuthHeaders,
  resolveProvider,
  timezoneFromEnv,
  type PluginManifest,
} from '@buddi/core';
import {
  createToolRegistry,
  installedManifests,
  listDevices,
  loadGatewayCatalog,
  TelegramApi,
} from '@buddi/gateway';
import type { Pool } from 'pg';
import { checkNodeVersion, type DoctorProbes, type ProbeResult } from './doctor.js';
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

export function createProbes(env: NodeJS.ProcessEnv = process.env): Probes {
  const lazy = new LazyPool();
  const databaseUrl = env.DATABASE_URL;

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

    async dockerVersion(): Promise<ProbeResult> {
      const v = await versionOf('docker');
      if (!v) {
        return { status: 'warn', detail: 'not on PATH — needed only for the postgres container' };
      }
      return { status: 'ok', detail: v };
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
        return {
          status: 'fail',
          detail: `unreachable at ${redactUrl(databaseUrl)}: ${
            err instanceof Error ? err.message : String(err)
          } (pnpm db:up)`,
        };
      }
    },

    async migrations(): Promise<ProbeResult> {
      const pool = await connected();
      if (!pool) return { status: 'fail', detail: 'skipped — no database connection' };
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

    async modelCredential(): Promise<ProbeResult> {
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
        return {
          status: 'fail',
          detail: `${resolution.problem.message} — set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY`,
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

    async botToken(): Promise<ProbeResult> {
      const token = env.TELEGRAM_BOT_TOKEN;
      if (!token || token.trim() === '') {
        return { status: 'warn', detail: 'TELEGRAM_BOT_TOKEN is not set — no Telegram surface' };
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
      if (!pool) return { status: 'warn', detail: 'skipped — no database connection' };
      const devices = await listDevices(pool);
      return devices.length === 0
        ? { status: 'warn', detail: 'none paired — run `buddi telegram pair`' }
        : {
            status: 'ok',
            detail: devices.map((d) => `${d.surface}:${d.label ?? d.externalUserId}`).join(', '),
          };
    },

    async service(): Promise<ProbeResult> {
      try {
        const manager = createServiceManager();
        const status = await manager.status();
        if (status.running) return { status: 'ok', detail: `${manager.kind}: ${status.detail}` };
        return {
          status: 'warn',
          detail: status.installed
            ? `${manager.kind}: installed but not running — \`buddi service restart\``
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
