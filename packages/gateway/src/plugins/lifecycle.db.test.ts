/**
 * The whole lifecycle against a real database: install, use, uninstall.
 *
 * The plugin under test is `src/__fixtures__/test-plugin`: a real package
 * directory with a real built entry point, owning a schema whose name nobody
 * would choose for anything else. The weather example would have been the
 * obvious fixture — it is the plugin an author copies — and it is deliberately
 * *not* used for anything that touches the database, because this suite drops a
 * schema, and a suite that dropped `weather` would destroy the data of any
 * owner who had really installed the weather plugin. It is still read here, to
 * prove the example itself satisfies the contract.
 *
 * Three claims:
 *
 *  - **install is a record, not a patch.** The plugin is not compiled in; the
 *    record names it, the entry resolves, its schema migrates.
 *  - **uninstall leaves nothing dangling.** A grant naming its tools is a
 *    catalog *load error*, so uninstall refuses rather than leaving an
 *    installation that will not boot; missions it suggested are disabled; jobs
 *    queued for them are cancelled.
 *  - **uninstall keeps the data.** The schema and every row survive by default
 *    and the plugin finds them again. `--purge` is the other, separate verb.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createPool,
  listMissions,
  migrate,
  runMigrations,
  readPluginsFile,
  upsertMission,
  type PluginManifest,
} from '@buddi/core';
import type { Pool } from 'pg';
import { testDatabaseUrl } from '@buddi/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../agents/catalog.js';
import { applyInstall, entryPointOf, InstallRefusal, planInstall } from './install.js';
import { adoptPlugins, loadManifest, pluginLoadReport, resetAdoptedPlugins } from './load.js';
import { migrateInstalled } from './migrate.js';
import { installedManifests } from '../agents/catalog.js';
import { applyUninstall, declaredTools, namesPlugin, planUninstall, UninstallRefusal } from './uninstall.js';

const WEATHER_DIR = path.join(REPO_ROOT, 'examples', 'plugins', 'weather');
/** The package this suite installs, migrates and removes. */
const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'test-plugin');
const PLUGIN = 'testplug';
const SCHEMA = 'buddi_fixture_testplug';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

let pool: Pool;
let root: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  pool = createPool(databaseUrl as string);
});

async function wipeFixtureSchema(): Promise<void> {
  await pool.query(`drop schema if exists ${SCHEMA} cascade`);
  await pool.query('delete from core.migrations where schema = $1', [SCHEMA]);
}

afterAll(async () => {
  await wipeFixtureSchema();
  await pool.end();
});

beforeEach(async () => {
  resetAdoptedPlugins();
  root = mkdtempSync(path.join(tmpdir(), 'buddi-plugin-life-'));
  mkdirSync(path.join(root, 'agents'), { recursive: true });
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  // A private tree and a record file of this test's own: nothing here touches
  // the owner's installation.
  env = {
    ...process.env,
    BUDDI_AGENTS_DIR: path.join(root, 'agents'),
    BUDDI_SKILLS_DIR: path.join(root, 'skills'),
    BUDDI_PLUGINS_FILE: path.join(root, 'plugins.json'),
  };
  await wipeFixtureSchema();
});

/** Install the fixture the way the CLI does, and register it in this process. */
async function install(): Promise<PluginManifest> {
  const plan = await planInstall(PLUGIN_DIR, env);
  const record = applyInstall(plan, { env });
  await migrate(pool, { schema: plan.manifest.schema, dir: plan.manifest.migrationsDir });
  // What a real process does after the record exists: import it and register it.
  adoptPlugins(env, {
    file: plan.recordFile,
    loaded: [{ record, manifest: plan.manifest, contribution: plan.contribution }],
    problems: [],
  });
  return plan.manifest;
}

suite('installing a plugin from a directory', () => {
  it('resolves the entry point from the package, and refuses one that is not built', () => {
    expect(entryPointOf(WEATHER_DIR)).toBe(path.join(WEATHER_DIR, 'dist', 'index.js'));
    expect(entryPointOf(PLUGIN_DIR)).toBe(path.join(PLUGIN_DIR, 'index.js'));
    const empty = mkdtempSync(path.join(tmpdir(), 'buddi-not-a-plugin-'));
    expect(() => entryPointOf(empty)).toThrow(/no package.json/);
  });

  it('reads the shipped weather example as the contract says it should', async () => {
    const loaded = await loadManifest(entryPointOf(WEATHER_DIR));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.manifest.name).toBe('weather');
    expect((loaded.manifest.agents ?? []).map((a) => a.id)).toEqual(['meteo']);
    expect(loaded.manifest.network?.[0]?.host).toBe('api.open-meteo.com');
  });

  it('writes a record naming what was installed and where it came from', async () => {
    const manifest = await install();
    const contents = readPluginsFile(path.join(root, 'plugins.json'));
    expect(contents.plugins).toHaveLength(1);
    expect(contents.plugins[0]).toMatchObject({
      name: PLUGIN,
      version: manifest.version,
      schema: SCHEMA,
      source: { kind: 'directory', path: PLUGIN_DIR },
    });
  });

  /*
   * docs/install.md §7: a plugin that fails to load never stops the gateway.
   * A plugin whose migrations will not apply has not loaded — it has no schema
   * to work in — so a start migrates what it can, leaves that one out of the
   * manifests for the rest of the run, and says why where the owner looks.
   */
  it('does not stop the start when an installed plugin cannot migrate', async () => {
    const plan = await planInstall(PLUGIN_DIR, env);
    const record = applyInstall(plan, { env });
    const broken = path.join(PLUGIN_DIR, 'migrations-that-are-not-there');
    adoptPlugins(env, {
      file: plan.recordFile,
      loaded: [
        {
          record,
          manifest: { ...plan.manifest, migrationsDir: broken },
          contribution: plan.contribution,
        },
      ],
      problems: [],
    });
    expect(installedManifests(env).some((m) => m.name === PLUGIN)).toBe(true);

    const result = await migrateInstalled(pool, env);

    // Core and the compiled-in plugins migrated; this one is a load failure.
    expect(result.problems.map((p) => p.name)).toEqual([PLUGIN]);
    expect(result.problems[0]?.message).toContain(broken);
    expect(installedManifests(env).some((m) => m.name === PLUGIN)).toBe(false);
    const report = pluginLoadReport(env);
    expect(report.map((r) => r.name)).toEqual([PLUGIN]);
    expect(report[0]?.error).toContain('migrations could not be applied');
    // And nothing was created for it.
    const { rows } = await pool.query(
      'select table_name from information_schema.tables where table_schema = $1',
      [SCHEMA],
    );
    expect(rows).toEqual([]);
  });

  it('still refuses when the plugin that cannot migrate is a compiled-in one', async () => {
    // The same failure for something this build ships is this build being
    // wrong about itself: nothing names it optional, so it throws and the
    // installation does not start on a schema it could not create.
    const loaded = await loadManifest(entryPointOf(PLUGIN_DIR));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    await expect(
      runMigrations(pool, [{ ...loaded.manifest, migrationsDir: path.join(root, 'nowhere') }]),
    ).rejects.toThrow(/no migrations directory/);
  });

  it('applies the plugin\'s own migrations into the plugin\'s own schema', async () => {
    await install();
    const { rows } = await pool.query(
      'select table_name from information_schema.tables where table_schema = $1',
      [SCHEMA],
    );
    expect(rows.map((r: { table_name: string }) => r.table_name)).toEqual(['thing']);
  });

  it('refuses a plugin claiming a schema that is already somebody\'s', async () => {
    const stolen = mkdtempSync(path.join(tmpdir(), 'buddi-thief-'));
    writeFileSync(
      path.join(stolen, 'package.json'),
      JSON.stringify({ name: 'thief', main: 'index.js' }),
      'utf8',
    );
    writeFileSync(
      path.join(stolen, 'index.js'),
      "export const manifest = { name: 'thief', version: '1.0.0', schema: 'finance', migrationsDir: '', tools: [] };\n",
      'utf8',
    );
    await expect(planInstall(stolen, env)).rejects.toThrow(/already owns/);
  });

  it('refuses a plugin calling itself by a built-in name', async () => {
    const impostor = mkdtempSync(path.join(tmpdir(), 'buddi-impostor-'));
    writeFileSync(path.join(impostor, 'package.json'), JSON.stringify({ name: 'x', main: 'index.js' }), 'utf8');
    writeFileSync(
      path.join(impostor, 'index.js'),
      "export const manifest = { name: 'finance', version: '9.9.9', schema: 'finance2', migrationsDir: '', tools: [] };\n",
      'utf8',
    );
    await expect(planInstall(impostor, env)).rejects.toThrow(InstallRefusal);
  });

  it('reports a plugin whose entry is gone instead of throwing', async () => {
    const result = await loadManifest('/nowhere/at/all/index.js');
    expect(result).toMatchObject({ ok: false });
  });
});

suite('uninstall leaves nothing dangling', () => {
  it('finds the agents whose grant names the plugin, and refuses by default', async () => {
    await install();
    const dir = path.join(root, 'agents', 'pinger');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'agent.md'),
      `---\nid: pinger\nhandle: pinger\nname: Pinger\ndescription: Pong.\ntools: [testplug.*, memory.note]\n---\n\nYou say pong.\n`,
      'utf8',
    );
    const plan = await planUninstall(PLUGIN, { pool, env });
    expect(plan.agents).toHaveLength(1);
    expect(plan.agents[0]).toMatchObject({ agentId: 'pinger', removed: ['testplug.*'] });
    await expect(applyUninstall(plan, { env, pool })).rejects.toThrow(UninstallRefusal);
    // Refused means refused: the record is still there.
    expect(readPluginsFile(path.join(root, 'plugins.json')).plugins).toHaveLength(1);

    const detached = await applyUninstall(plan, { env, pool, detachAgents: true });
    expect(declaredTools(path.join(dir, 'agent.md'))).toEqual(['memory.note']);
    expect(detached.notes.join('\n')).toContain('removed testplug.* from its grant');
    expect(readPluginsFile(path.join(root, 'plugins.json')).plugins).toHaveLength(0);
  });

  it('disables the missions it suggested rather than deleting them', async () => {
    const manifest = await install();
    const suggestion = (manifest.missions ?? [])[0];
    expect(suggestion).toBeDefined();
    await upsertMission(pool, {
      id: (suggestion as { id: string }).id,
      name: 'Test plugin daily',
      agentId: 'concierge',
      prompt: 'ping',
    });
    const plan = await planUninstall(PLUGIN, { pool, env });
    expect(plan.missions.map((m) => m.id)).toContain((suggestion as { id: string }).id);
    await applyUninstall(plan, { env, pool });
    const mission = (await listMissions(pool)).find((m) => m.id === (suggestion as { id: string }).id);
    expect(mission).toBeDefined();
    expect(mission?.enabled).toBe(false);
    await pool.query('delete from core.missions where id = $1', [(suggestion as { id: string }).id]);
  });

  it('knows which declared grant entries name the plugin', () => {
    expect(namesPlugin('testplug.*', PLUGIN, ['testplug.ping'])).toBe(true);
    expect(namesPlugin('testplug.ping', PLUGIN, ['testplug.ping'])).toBe(true);
    expect(namesPlugin('memory.*', PLUGIN, ['testplug.ping'])).toBe(false);
    expect(namesPlugin('testplugger.go', PLUGIN, ['testplug.ping'])).toBe(false);
  });
});

suite('uninstall keeps the data, and --purge is the other verb', () => {
  it('leaves the schema and every row where they are, and says so', async () => {
    await install();
    await pool.query(
      `insert into ${SCHEMA}.thing (id, label) values (1, 'kept') on conflict (id) do nothing`,
    );
    const before = await pool.query(`select count(*)::int as n from ${SCHEMA}.thing`);
    const plan = await planUninstall(PLUGIN, { pool, env });
    expect(plan.data?.schema).toBe(SCHEMA);
    expect(plan.data?.totalRows).toBe((before.rows[0] as { n: number }).n);

    const outcome = await applyUninstall(plan, { env, pool });
    expect(outcome.purged).toBe(false);
    expect(outcome.notes.join('\n')).toContain('was left untouched');
    const after = await pool.query(`select count(*)::int as n from ${SCHEMA}.thing`);
    expect(after.rows[0]).toEqual(before.rows[0]);

    // And reinstalling finds it again — which is what "recoverable" means.
    await install();
    const again = await pool.query(`select count(*)::int as n from ${SCHEMA}.thing`);
    expect(again.rows[0]).toEqual(before.rows[0]);
  });

  it('drops the schema only when asked, and clears its migration ledger', async () => {
    await install();
    const plan = await planUninstall(PLUGIN, { pool, env });
    const outcome = await applyUninstall(plan, { env, pool, purge: true });
    expect(outcome.purged).toBe(true);
    expect(outcome.notes.join('\n')).toContain('DROPPED');
    const { rows } = await pool.query(
      'select 1 from information_schema.schemata where schema_name = $1',
      [SCHEMA],
    );
    expect(rows).toHaveLength(0);
    const ledger = await pool.query('select 1 from core.migrations where schema = $1', [SCHEMA]);
    expect(ledger.rows).toHaveLength(0);
  });

  it('refuses to uninstall something that is not installed, and says what is', async () => {
    await expect(planUninstall('finance', { pool, env })).rejects.toThrow(/not installed here/);
  });
});
