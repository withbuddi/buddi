/**
 * The first lineup, installed package by package from a copy of the market
 * index (agent-catalogue.md §10, §12): every package parses strictly and
 * hashes to its integrity, plans, and installs through the real job — the
 * missing by-buddi plugin staged and approved on its exact integrity, then
 * the agent approved — with its picks in the file, its missions off, its
 * handle, its sidecar, and exactly the grant the plan showed.
 *
 * The plugins are test doubles built from the index's own listings: each
 * listing's `claims.manifest.tools` (names, tiers, owner-only flags) becomes a
 * manifest whose tools do nothing. Weather, Calendar and Speech are installed
 * from the start, so the packages' `?` tools hold; Finance and Image are not,
 * so CFO and Illustrator stage them on the way. No picture is served, so the
 * install also shows a package without its face still lands.
 *
 * The fixture is `__fixtures__/catalogue-lineup.json`. Refresh it whenever a
 * package changes in buddi-market:
 *   node scripts/index.mjs <buddi>/packages/gateway/src/__fixtures__/catalogue-lineup.json https://withbuddi.com
 *
 * Against a throwaway database; skipped unless DATABASE_URL is set.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  createPool,
  ensureOwner,
  getAction,
  getActiveSchedule,
  getMission,
  loadAgentCatalog,
  migrate,
  type CoreToolContext,
  type PluginManifest,
  type ToolDefinition,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { marketFetch } from '../__fixtures__/agent-package.js';
import { createToolRegistry, EXAMPLES_AGENTS_DIR, EXAMPLES_SKILLS_DIR, reloadableCatalog } from '../agents/catalog.js';
import { bindPlatformTools } from '../agents/platform.js';
import { catalogueJobSettled, catalogueRoute, installRoute, planRoute, resetCatalogueJobs, type CatalogueDeps } from './catalogue.js';
import { createCatalogueService, readPackages } from './catalogue-source.js';
import { resetMarketCache } from './market.js';
import type { TakeOnEngine } from './take-on.js';
import { decideApprovalFromWeb } from './write.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_lineup_test_${process.pid}`;
const now = (): Date => new Date();

const INDEX = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'catalogue-lineup.json'), 'utf8'),
) as { plugins: Array<Record<string, any>>; agents: Array<Record<string, any>> };

/** §10's ten, by package name. */
const LINEUP = ['chief-of-staff', 'researcher', 'cfo', 'chef', 'travel-planner', 'writer', 'coach', 'tutor', 'home-manager', 'illustrator'];
/** Installed before anything is added; the rest arrive with the agent that requires them. */
const PRESENT = ['weather', 'calendar', 'speech'];

/** A plugin that does nothing, with exactly the tools its listing claims. */
function pluginDouble(name: string): PluginManifest {
  const listing = INDEX.plugins.find((p) => p.name === name);
  if (!listing) throw new Error(`the fixture lists no plugin "${name}"`);
  const manifest = listing.claims.manifest as { version: string; description: string; tools: Array<{ name: string; tier: string; ownerOnly?: boolean; description: string }> };
  return {
    name,
    version: manifest.version,
    description: manifest.description,
    schema: name,
    migrationsDir: '',
    tools: manifest.tools.map(
      (t) =>
        ({
          name: t.name,
          description: t.description,
          tier: t.tier,
          ...(t.ownerOnly ? { ownerOnly: true } : {}),
          input: z.object({}).passthrough(),
          async execute() {
            return {};
          },
        }) as unknown as ToolDefinition<any, any>,
    ),
  };
}

/** A line for each text pick, so the "For this owner" section is written and can be read back. */
function textFills(entry: Record<string, any>): Record<string, string> {
  const fills: Record<string, string> = {};
  for (const fill of entry.fills as Array<{ id: string; kind: string }>) if (fill.kind === 'text') fills[fill.id] = `Test answer for ${fill.id}`;
  return fills;
}

suite('the first lineup, from a copy of the market index', () => {
  let admin: Pool;
  let pool: Pool;
  let root: string;
  let agentsDir: string;
  let deps: CatalogueDeps;
  let registry: ReturnType<typeof createToolRegistry>;
  let catalog: ReturnType<typeof reloadableCatalog>;
  const market = { index: INDEX as unknown as Record<string, unknown>, pictures: new Map<string, Buffer>() };
  const staged: string[] = [];

  const engine = {
    stagePlugin: vi.fn(async (spec: string) => {
      staged.push(spec);
      const name = /^@withbuddi\/plugin-([a-z0-9-]+)@/.exec(spec)?.[1] ?? spec;
      const listing = INDEX.plugins.find((p) => p.name === name)!;
      return { id: `stage-${name}`, name, version: listing.version, integrity: listing.integrity };
    }),
    approveStaged: vi.fn(async (id: string) => ({ kind: 'installed', record: { name: id.replace(/^stage-/, '') }, plan: {}, restartNeeded: false, migrations: [] })),
    rejectStaged: vi.fn(() => true),
    setPluginEnabled: vi.fn(async (name: string) => {
      if (!registry.manifests().some((m) => m.name === name)) registry.register(pluginDouble(name));
      return { name, enabled: true, changed: true, missions: [], restartNeeded: false };
    }),
  } as unknown as TakeOnEngine;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');

    root = mkdtempSync(path.join(tmpdir(), 'buddi-lineup-db-'));
    agentsDir = path.join(root, 'agents');
    const skillsDir = path.join(root, 'skills');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      BUDDI_DATA_DIR: path.join(root, 'data'),
      BUDDI_AGENTS_DIR: agentsDir,
      BUDDI_SKILLS_DIR: skillsDir,
      BUDDI_PLUGINS_FILE: path.join(root, 'plugins.json'),
    };
    registry = createToolRegistry({});
    for (const name of PRESENT) registry.register(pluginDouble(name));
    catalog = reloadableCatalog(() =>
      loadAgentCatalog({
        dirs: [
          { dir: EXAMPLES_AGENTS_DIR, skillsDir: EXAMPLES_SKILLS_DIR, source: 'example' },
          { dir: agentsDir, skillsDir, source: 'private' },
        ],
        registry,
        env: {},
      }),
    );
    const ctx = { db: pool, ownerId: 'owner', now, timezone: 'UTC' } as unknown as CoreToolContext;
    const source = createCatalogueService({ env, log: () => {}, registry, ctx, now, fetch: marketFetch(market), version: async () => '0.1.0-pre.32' });
    // An account that draws is linked here; no mailbox, so the mail tools are the optional kind.
    const service = { ...source, needs: async () => ({ mailbox: false, 'image-account': true }) };
    bindPlatformTools(registry, {
      catalog,
      reload: () => catalog.reload(),
      agentsDir,
      skillsDir,
      examplesDir: EXAMPLES_AGENTS_DIR,
      catalogue: () => service,
    });
    deps = {
      registry,
      ctx,
      now,
      env,
      log: () => {},
      pool,
      service,
      binding: { catalog, agentsDir, trashRoot: path.join(root, '.trash') },
      approve: (actionId) => decideApprovalFromWeb({ pool, registry, ctx, now }, actionId, 'approved'),
      engine,
      liveRegistry: registry as never,
      fetch: marketFetch(market),
      loadWaitMs: 2_000,
    };
    resetMarketCache();
    resetCatalogueJobs();
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('carries the ten, each parsing strictly and hashing to its integrity', async () => {
    const { packages, problems } = readPackages(INDEX as unknown as Record<string, unknown>);
    expect(problems).toEqual([]);
    expect(packages.map((p) => p.manifest.name).sort()).toEqual([...LINEUP].sort());
    const reply = await catalogueRoute(deps, new URL('http://x/api/catalogue'));
    expect(reply.status).toBe(200);
    const states = Object.fromEntries((reply.body as { agents: Array<{ name: string; state: string }> }).agents.map((a) => [a.name, a.state]));
    expect(states).toMatchObject({ cfo: 'needs', illustrator: 'needs', researcher: 'ready', 'chief-of-staff': 'ready' });
  });

  for (const name of LINEUP) {
    it(`adds ${name} through the plan, the job and its approval`, async () => {
      const entry = INDEX.agents.find((a) => a.name === name)!;
      const fills = textFills(entry);
      const plan = await planRoute(deps, name, { fills });
      expect(plan.status, JSON.stringify(plan.body)).toBe(200);
      const planned = plan.body as { handle: string; tools: Array<{ name: string }>; missions: Array<{ id: string; enabled: boolean }>; plugins: Array<{ name: string }>; preview: string | null };
      expect(planned.handle).toBe(entry.handle);
      expect(planned.missions.every((m) => m.enabled === false)).toBe(true);
      // Every plugin it requires and lacks is installed on the way, and nothing else.
      const missing = Object.keys(entry.requires as Record<string, string>).filter((p) => !registry.manifests().some((m) => m.name === p));
      expect(planned.plugins.map((p) => p.name).sort()).toEqual(missing.sort());

      // The grant the sheet listed goes back with the click: the resolved one when its plugins are here, the
      // package's own list (its integrity covers it) while one is missing.
      if (planned.preview === null) expect(planned.tools.map((t) => t.name)).toEqual(entry.tools);
      const started = await installRoute(deps, name, { version: entry.version, fills, tools: planned.tools.map((t) => t.name) });
      expect(started.status, JSON.stringify(started.body)).toBe(202);
      const job = await catalogueJobSettled((started.body as { jobId: string }).jobId);
      expect(job, JSON.stringify(job)).toMatchObject({ state: 'done', agent: { id: name, handle: entry.handle } });
      for (const plugin of missing) expect(staged).toContain(`@withbuddi/plugin-${plugin}@${INDEX.plugins.find((p) => p.name === plugin)!.version}`);

      // The grant is what the plan showed, tool for tool, and every `?` tool whose plugin is here holds.
      catalog.reload();
      const agent = catalog.get(name);
      expect(agent, `${name} did not load: ${JSON.stringify(catalog.refused?.())}`).toBeDefined();
      if (planned.preview !== null) expect([...agent!.tools].sort()).toEqual(planned.tools.map((t) => t.name).sort());
      for (const claim of entry.claims.tools as Array<{ name: string; plugin: string; optional: boolean }>) {
        const here = claim.plugin === 'core' || registry.manifests().some((m) => m.name === claim.plugin);
        if (here) expect(agent!.tools, `${name} lacks ${claim.name}`).toContain(claim.name);
      }

      // The file, its picks, its skills and its sidecar.
      const dir = path.join(agentsDir, name);
      const file = readFileSync(path.join(dir, 'agent.md'), 'utf8');
      expect(file).toMatch(new RegExp(`^handle: ${entry.handle}$`, 'm'));
      for (const [id, value] of Object.entries(fills)) expect(file, `${name}'s pick ${id}`).toContain(value);
      for (const skill of entry.skills as Array<{ file: string }>) expect(existsSync(path.join(dir, 'skills', skill.file)), skill.file).toBe(true);
      const sidecar = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
      expect(sidecar).toMatchObject({ source: 'market', package: name, version: entry.version, proposal: entry.integrity });

      // Missions: every one created, every one off, at its cron.
      for (const mission of entry.missions as Array<{ id: string; cron: string }>) {
        const id = `agent:${name}:${mission.id}`;
        expect(await getMission(pool, id), id).toMatchObject({ enabled: false, agentId: name });
        expect((await getActiveSchedule(pool, id))?.cron, id).toBe(mission.cron);
      }
      const action = await getAction(pool, job!.approvalId!);
      expect(action).toMatchObject({ tool: 'platform.install_agent', state: 'succeeded' });
    });
  }
});
