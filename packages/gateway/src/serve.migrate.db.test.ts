/**
 * A checkout's `buddi serve` migrates at start, exactly as the supervisor does.
 *
 * This is the whole claim, against a real throwaway database: a start on an
 * empty schema applies core's migrations and an installed plugin's; an
 * installed third-party plugin whose migrations will not apply is demoted to
 * the load report and the start carries on; a database migrated by newer code
 * refuses before anything runs.
 *
 * `main` itself is what is called — not a helper standing in for it — with one
 * seam: `createWiringAsync` throws a sentinel, so the start stops at the line
 * after the migration. Getting to that sentinel *is* "the gateway still
 * starts"; not getting there is a start that was refused.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyInstall, planInstall } from './plugins/install.js';
import { adoptPlugins, pluginLoadReport, resetAdoptedPlugins } from './plugins/load.js';

/** The one seam: the start stops here, having already migrated. */
const WIRING_SENTINEL = 'wiring is not built in this test';

vi.mock('./bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bootstrap.js')>();
  return {
    ...actual,
    // `.env` and the plugin record are this test's own, set on `process.env`
    // below; loading them again would read the developer's installation.
    loadEnvironment: async () => ({
      url: process.env.DATABASE_URL ?? '',
      source: 'env' as const,
      legacyPassword: false,
    }),
    createWiringAsync: async () => {
      throw new Error(WIRING_SENTINEL);
    },
  };
});

const { main } = await import('./serve.js');

const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'test-plugin');
const PLUGIN = 'testplug';
const SCHEMA = 'buddi_fixture_testplug';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_serve_migrate_test_${process.pid}`;

suite('a checkout serve start migrates what is installed', () => {
  let admin: Pool;
  let pool: Pool;
  let testUrl: string;
  const saved: Record<string, string | undefined> = {};
  const logs: string[] = [];

  const setEnv = (name: string, value: string): void => {
    if (!(name in saved)) saved[name] = process.env[name];
    process.env[name] = value;
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    testUrl = url.toString();
    pool = createPool(testUrl);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(() => {
    logs.length = 0;
    resetAdoptedPlugins();
    const root = mkdtempSync(path.join(tmpdir(), 'buddi-serve-migrate-'));
    mkdirSync(path.join(root, 'agents'), { recursive: true });
    mkdirSync(path.join(root, 'skills'), { recursive: true });
    setEnv('DATABASE_URL', testUrl);
    setEnv('BUDDI_AGENTS_DIR', path.join(root, 'agents'));
    setEnv('BUDDI_SKILLS_DIR', path.join(root, 'skills'));
    setEnv('BUDDI_PLUGINS_FILE', path.join(root, 'plugins.json'));
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.query(`drop schema if exists ${SCHEMA} cascade`);
  });

  /** Install the fixture and register it as this process's external plugin. */
  const installFixture = async (migrationsDir?: string): Promise<void> => {
    const plan = await planInstall(PLUGIN_DIR, process.env);
    const record = applyInstall(plan, { env: process.env });
    adoptPlugins(process.env, {
      file: plan.recordFile,
      loaded: [
        {
          record,
          manifest: migrationsDir ? { ...plan.manifest, migrationsDir } : plan.manifest,
          contribution: plan.contribution,
        },
      ],
      problems: [],
    });
  };

  /** Run the start and report where it got to. */
  const start = async (): Promise<{ reached: 'wiring' | 'refused'; error: string }> => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    try {
      await main();
      throw new Error('serve start returned, which it never does in this test');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Both endings are `process.exit(1)` — `main` reports the wiring failure
      // itself. Which one happened is on the log: the sentinel means the start
      // got past the migration and was cut off at the line after it.
      const reached = logs.some((line) => line.includes(WIRING_SENTINEL)) ? 'wiring' : 'refused';
      return { reached, error: message };
    } finally {
      exit.mockRestore();
    }
  };

  const appliedFilenames = async (schema: string): Promise<string[]> => {
    const { rows } = await pool.query<{ filename: string }>(
      'select filename from core.migrations where schema = $1 order by filename',
      [schema],
    );
    return rows.map((r) => r.filename);
  };

  it('applies core and an installed plugin, and says so once per migration', async () => {
    await pool.query('drop schema if exists core cascade');
    await installFixture();

    const outcome = await start();

    // The start carried on past the migration.
    expect(outcome.reached).toBe('wiring');
    expect((await appliedFilenames('core')).length).toBeGreaterThan(0);
    expect(await appliedFilenames(SCHEMA)).toEqual(['001_test.sql']);
    const { rows } = await pool.query(
      'select table_name from information_schema.tables where table_schema = $1',
      [SCHEMA],
    );
    expect(rows).toHaveLength(1);
    // One line per applied migration, and one summary. The database was empty
    // when this start began, so every recorded migration is one of this run's.
    const applied = logs.filter((line) => line.startsWith('migrate: applied '));
    const recorded = await pool.query<{ n: number }>('select count(*)::int as n from core.migrations');
    expect(applied).toHaveLength(recorded.rows[0]!.n);
    expect(applied).toContain(`migrate: applied ${SCHEMA}/001_test.sql`);
    expect(logs.filter((line) => /^migrate: \d+ migration\(s\) applied$/.test(line))).toHaveLength(1);
  }, 60_000);

  it('says the schema is up to date on the next start, and applies nothing twice', async () => {
    await installFixture();
    const before = await appliedFilenames('core');

    const outcome = await start();

    expect(outcome.reached).toBe('wiring');
    expect(await appliedFilenames('core')).toEqual(before);
    expect(logs).toContain('migrate: schema up to date');
    expect(logs.filter((line) => line.startsWith('migrate: applied '))).toHaveLength(0);
  }, 60_000);

  it('demotes a third-party plugin whose migrations will not apply, and still starts', async () => {
    await pool.query(`drop schema if exists ${SCHEMA} cascade`);
    await pool.query('delete from core.migrations where schema = $1', [SCHEMA]);
    const missing = path.join(PLUGIN_DIR, 'migrations-that-are-not-there');
    await installFixture(missing);

    const outcome = await start();

    expect(outcome.reached).toBe('wiring');
    const report = pluginLoadReport(process.env);
    expect(report.map((r) => r.name)).toEqual([PLUGIN]);
    expect(report[0]?.error).toContain('migrations could not be applied');
    expect(logs.some((line) => line.includes(`plugin ${PLUGIN} was not loaded`))).toBe(true);
    // Nothing of its own was created, and core is still migrated.
    const { rows } = await pool.query(
      'select table_name from information_schema.tables where table_schema = $1',
      [SCHEMA],
    );
    expect(rows).toEqual([]);
    expect((await appliedFilenames('core')).length).toBeGreaterThan(0);
  }, 60_000);

  it('refuses to start on a schema newer than this code, before anything runs', async () => {
    await installFixture();
    await pool.query(
      "insert into core.migrations (schema, filename) values ('core', '999_from_the_future.sql')",
    );
    try {
      const outcome = await start();

      expect(outcome.reached).toBe('refused');
      expect(outcome.error).toBe('process.exit(1)');
      expect(logs.some((line) => /newer than this release/.test(line))).toBe(true);
      // The refusal came before the migrations: nothing was applied for the
      // plugin this start would otherwise have migrated.
      expect(await appliedFilenames(SCHEMA)).toEqual([]);
    } finally {
      await pool.query("delete from core.migrations where filename = '999_from_the_future.sql'");
    }
  }, 60_000);
});
