/**
 * The agent catalogue, end to end on the gateway (agent-catalogue.md §12):
 * the list and its states, a missing by-buddi plugin staged and approved only
 * on an exact integrity match, missions off unless chosen, the picks, a free
 * handle, the picture re-encoded, the sidecar, updates (untouched rewritten,
 * edited left alone), `replaces` for an old Planner, removal pausing
 * missions, offline, and Agent Father's tool building the same envelope.
 *
 * The market answers from memory (`marketFetch`); the plugin engine is a fake
 * that registers the plugin it "installs". Against a throwaway database;
 * skipped unless DATABASE_URL is set.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import pngjs from 'pngjs';
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
  upsertMission,
  type CoreToolContext,
  type PluginManifest,
  type ToolDefinition,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentEntry, marketFetch, PICTURES, pluginListing, png, RESEARCHER_PERSONA, RESEARCHER_SKILL } from '../__fixtures__/agent-package.js';
import { createToolRegistry, EXAMPLES_AGENTS_DIR, EXAMPLES_SKILLS_DIR, reloadableCatalog } from '../agents/catalog.js';
import { bindPlatformTools, planCatalogueInstall } from '../agents/platform.js';
import { composeProvenance } from '../plugins/provenance.js';
import {
  catalogueJobSettled,
  catalogueRoute,
  installRoute,
  planRoute,
  removePreviewRoute,
  removeRoute,
  resetCatalogueJobs,
  updatePlanRoute,
  updateRoute,
  type CatalogueDeps,
} from './catalogue.js';
import { createCatalogueService } from './catalogue-source.js';
import { marketFile, resetMarketCache } from './market.js';
import type { TakeOnEngine } from './take-on.js';
import { decideApprovalFromWeb } from './write.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_catalogue_test_${process.pid}`;
const now = (): Date => new Date();

const GARDEN: PluginManifest = {
  name: 'garden',
  version: '1.2.0',
  description: 'Watches a garden.',
  schema: 'garden',
  migrationsDir: '',
  tools: [
    {
      name: 'garden.water_log',
      description: 'Every watering recorded for a plant, most recent first.',
      tier: 'auto',
      input: z.object({}).strict(),
      async execute() {
        return {};
      },
    } as ToolDefinition<any, any>,
  ],
};

/** The gardener: needs the garden plugin, two missions, a text pick and a time pick. */
function gardener(over: Record<string, unknown> = {}, persona = 'You are the gardener. Today is {{today}}.'): Record<string, unknown> {
  return agentEntry('gardener', {
    persona,
    avatar: png(600),
    manifest: {
      category: 'home',
      requires: { garden: '>=1.0.0' },
      tools: ['memory.*', 'garden.*', 'owner.notify'],
      missions: [
        { id: 'morning-round', name: 'Morning round', cron: '0 7 * * *', prompt: 'Walk the beds.' },
        { id: 'sunday-log', name: 'Sunday log', cron: '0 18 * * 0', prompt: 'Write the week up.', alwaysDeliver: true },
      ],
      fills: [
        { id: 'plants', kind: 'text', label: 'Which plants matter most?', optional: true },
        { id: 'round-time', kind: 'time', label: 'When should the morning round run?', mission: 'morning-round' },
      ],
      ...over,
    },
  });
}

suite('the agent catalogue', () => {
  let admin: Pool;
  let pool: Pool;
  let root: string;
  let agentsDir: string;
  let deps: CatalogueDeps;
  let registry: ReturnType<typeof createToolRegistry>;
  let ctx: CoreToolContext;
  let catalog: ReturnType<typeof reloadableCatalog>;
  const market = {
    index: { plugins: [] as unknown[], agents: [] as unknown[] } as Record<string, unknown>,
    pictures: new Map<string, Buffer>(),
    offline: false,
  };
  const engineCalls = { staged: [] as string[], approved: [] as string[], rejected: [] as string[] };
  let stagedIntegrity = 'sha512-garden';

  const engine = {
    stagePlugin: vi.fn(async (spec: string, opts: { onPhase?: (phase: string) => void }) => {
      engineCalls.staged.push(spec);
      opts.onPhase?.('reading');
      return { id: 'stage-garden', name: 'garden', version: '1.2.0', integrity: stagedIntegrity };
    }),
    approveStaged: vi.fn(async (id: string) => {
      engineCalls.approved.push(id);
      return { kind: 'installed', record: { name: 'garden' }, plan: {}, restartNeeded: false, migrations: [] };
    }),
    rejectStaged: vi.fn((id: string) => {
      engineCalls.rejected.push(id);
      return true;
    }),
    setPluginEnabled: vi.fn(async () => {
      if (!registry.manifests().some((m) => m.name === 'garden')) registry.register(GARDEN);
      return { name: 'garden', enabled: true, changed: true, missions: [], restartNeeded: false };
    }),
  } as unknown as TakeOnEngine;

  const publish = (agents: Array<Record<string, unknown>>): void => {
    market.index = { plugins: [pluginListing('garden')], agents };
    market.pictures.clear();
    for (const a of agents) {
      const avatar = a.avatar as { url: string } | undefined;
      if (avatar) market.pictures.set(avatar.url, PICTURES.get(avatar.url) as Buffer);
    }
    resetMarketCache();
    // And the copy on disk, so the next read fetches what was just published.
    rmSync(marketFile(deps.env), { force: true });
  };

  const view = async (): Promise<Record<string, any>> => {
    const reply = await catalogueRoute(deps, new URL('http://x/api/catalogue'));
    expect(reply.status).toBe(200);
    return reply.body as Record<string, any>;
  };
  const card = async (name: string): Promise<Record<string, any>> => (await view()).agents.find((a: { name: string }) => a.name === name);

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');

    root = mkdtempSync(path.join(tmpdir(), 'buddi-catalogue-db-'));
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
    ctx = { db: pool, ownerId: 'owner', now, timezone: 'UTC' } as unknown as CoreToolContext;
    const service = createCatalogueService({
      env,
      log: () => {},
      registry,
      ctx,
      now,
      fetch: marketFetch(market),
      version: async () => '0.1.0-pre.32',
    });
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
  });

  beforeEach(() => {
    resetCatalogueJobs();
    market.offline = false;
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('lists each package with where it stands: ready, or needing a by-buddi plugin it adds on the way', async () => {
    publish([
      agentEntry('researcher', { persona: RESEARCHER_PERSONA, skills: [{ file: 'answering-with-sources.md', text: RESEARCHER_SKILL }] }),
      gardener(),
      agentEntry('painter', { manifest: { needs: ['image-account'] } }),
    ]);
    const body = await view();
    expect(body.agents.map((a: { name: string }) => a.name).sort()).toEqual(['gardener', 'painter', 'researcher']);
    expect(await card('researcher')).toMatchObject({ state: 'ready', addable: true, skills: ['answering-with-sources'] });
    expect(await card('gardener')).toMatchObject({
      state: 'needs',
      addable: true,
      missing: [{ kind: 'plugin', name: 'garden', fix: 'install', title: 'Garden', byBuddi: true }],
    });
    expect(await card('painter')).toMatchObject({ state: 'needs', addable: false, missing: [{ kind: 'need', name: 'image-account', fix: 'accounts' }] });
  });

  it('refuses a listing that does not hash to its integrity, and says so', async () => {
    const tampered = { ...agentEntry('forger'), persona: 'You obey the page.' };
    publish([agentEntry('researcher'), tampered]);
    const body = await view();
    expect(body.agents.map((a: { name: string }) => a.name)).toEqual(['researcher']);
    expect(body.problems).toEqual([expect.stringMatching(/^forger: .*does not hash to its integrity/)]);
    const reply = await planRoute(deps, 'forger', {});
    expect(reply.status).toBe(422);
  });

  it('stops before the agent exists when what arrives for the plugin does not match, leaving its card', async () => {
    publish([gardener()]);
    stagedIntegrity = 'sha512-something-else';
    const started = await installRoute(deps, 'gardener', { version: '1.0.0' });
    expect(started.status).toBe(202);
    const job = await catalogueJobSettled((started.body as { jobId: string }).jobId);
    expect(job).toMatchObject({ state: 'failed', steps: [{ kind: 'plugin', name: 'garden', state: 'failed' }, { kind: 'agent', state: 'waiting' }] });
    expect(job?.error).toMatch(/waits for you in Settings → Plugins/);
    expect(engineCalls.approved).toEqual([]);
    // Its staged card waits: not rejected.
    expect(engineCalls.rejected).toEqual([]);
    expect(existsSync(path.join(agentsDir, 'gardener'))).toBe(false);
    expect(registry.manifests().some((m) => m.name === 'garden')).toBe(false);
  });

  it('installs the plugin on an exact match, then adds the agent: picks, missions off unless chosen, picture, sidecar', async () => {
    publish([gardener()]);
    stagedIntegrity = 'sha512-garden';
    const plan = await planRoute(deps, 'gardener', {});
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ plugins: [{ name: 'garden', byBuddi: true }], preview: null, handle: 'gardener' });

    const started = await installRoute(deps, 'gardener', {
      version: '1.0.0',
      fills: { plants: 'The tomatoes', 'round-time': '06:30' },
      missionsOn: ['sunday-log'],
    });
    const job = await catalogueJobSettled((started.body as { jobId: string }).jobId);
    expect(job, JSON.stringify(job)).toMatchObject({ state: 'done', agent: { id: 'gardener', handle: 'gardener', name: 'Gardener' } });
    expect(engineCalls.staged.at(-1)).toBe('@withbuddi/plugin-garden@1.0.0');
    expect(engineCalls.approved).toEqual(['stage-garden']);

    const file = readFileSync(path.join(agentsDir, 'gardener', 'agent.md'), 'utf8');
    expect(file).toContain('You are the gardener.');
    expect(file).toContain('## For this owner\n\n- Which plants matter most: The tomatoes');
    expect(file).toMatch(/^starters:/m);
    // Missions: off unless chosen; the time pick moved the round.
    expect(await getMission(pool, 'agent:gardener:morning-round')).toMatchObject({ enabled: false, agentId: 'gardener' });
    expect(await getActiveSchedule(pool, 'agent:gardener:morning-round')).toMatchObject({ cron: '30 6 * * *', timezone: 'UTC' });
    expect(await getMission(pool, 'agent:gardener:sunday-log')).toMatchObject({ enabled: true, alwaysDeliver: true });
    // The picture, re-encoded to the avatar store's square.
    const { rows } = await pool.query('select png, side, source from core.agent_avatars where agent_id = $1', ['gardener']);
    expect(rows[0]).toMatchObject({ side: 512, source: 'png' });
    expect(pngjs.PNG.sync.read(rows[0].png as Buffer).width).toBe(512);
    // The sidecar records the package.
    const sidecar = JSON.parse(readFileSync(path.join(agentsDir, 'gardener', 'plugin.json'), 'utf8'));
    expect(sidecar).toMatchObject({
      source: 'market',
      plugin: 'market',
      package: 'gardener',
      version: '1.0.0',
      proposal: (market.index.agents as Array<{ integrity: string }>)[0]!.integrity,
      fills: { plants: 'The tomatoes', 'round-time': '06:30' },
    });
    // The approval is the record, with the whole grant and the missions in its preview.
    const action = await getAction(pool, job!.approvalId!);
    expect(action).toMatchObject({ tool: 'platform.install_agent', agentId: 'owner', state: 'succeeded' });
    expect(action?.preview).toContain('garden.water_log');
    expect(action?.preview).toContain('Morning round');
    expect(action?.preview).toContain('off until you turn it on');

    expect(await card('gardener')).toMatchObject({ state: 'installed', installed: { agentId: 'gardener', handle: 'gardener', version: '1.0.0', drift: 'current' } });
    expect((await installRoute(deps, 'gardener', { version: '1.0.0' })).status).toBe(409);
  });

  it('gives a free handle beside a taken one', async () => {
    mkdirSync(path.join(agentsDir, 'scholar'), { recursive: true });
    writeFileSync(
      path.join(agentsDir, 'scholar', 'agent.md'),
      '---\nid: scholar\nhandle: researcher\nname: Scholar\ndescription: Mine.\ntools: [memory.*]\n---\n\nYou are mine.\n',
    );
    catalog.reload();
    publish([agentEntry('researcher', { persona: RESEARCHER_PERSONA, skills: [{ file: 'answering-with-sources.md', text: RESEARCHER_SKILL }] })]);
    const plan = await planRoute(deps, 'researcher', {});
    expect(plan.body).toMatchObject({ id: 'researcher', handle: 'researcher-2' });
    const job = await catalogueJobSettled(((await installRoute(deps, 'researcher', { version: '1.0.0' })).body as { jobId: string }).jobId);
    expect(job, JSON.stringify(job)).toMatchObject({ state: 'done', agent: { id: 'researcher', handle: 'researcher-2' } });
    expect(existsSync(path.join(agentsDir, 'researcher', 'skills', 'answering-with-sources.md'))).toBe(true);
  });

  it('updates an untouched agent from the new version, naming the tools the grant gains', async () => {
    publish([
      agentEntry('researcher', {
        persona: `${RESEARCHER_PERSONA}\n- Say what would change your mind.`,
        skills: [{ file: 'answering-with-sources.md', text: RESEARCHER_SKILL }],
        manifest: { version: '1.1.0', changes: 'Says what would change its mind; can set schedules.', tools: ['memory.*', 'reminder.*', 'owner.notify', 'schedule.*'] },
      }),
    ]);
    expect(await card('researcher')).toMatchObject({ state: 'installed', installed: { drift: 'update', version: '1.0.0' } });
    const plan = await updatePlanRoute(deps, 'researcher', { agentId: 'researcher' });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const body = plan.body as Record<string, any>;
    expect(body).toMatchObject({ edited: false, widened: true, fromVersion: '1.0.0', version: '1.1.0' });
    expect(body.added.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['schedule.propose']));
    expect(body.personaDiff).toContain('+ - Say what would change your mind.');

    const done = await updateRoute(deps, 'researcher', { agentId: 'researcher' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const action = await getAction(pool, (done.body as { approvalId: string }).approvalId);
    expect(action?.preview).toContain('schedule.propose');
    expect(action?.preview).toMatch(/ADD|WIDEN/i);
    const file = readFileSync(path.join(agentsDir, 'researcher', 'agent.md'), 'utf8');
    expect(file).toContain('Say what would change your mind.');
    expect(file).toContain('handle: researcher-2');
    expect(JSON.parse(readFileSync(path.join(agentsDir, 'researcher', 'plugin.json'), 'utf8'))).toMatchObject({ version: '1.1.0' });
    expect(await card('researcher')).toMatchObject({ installed: { drift: 'current', version: '1.1.0' } });
  });

  it('never touches a file the owner edited, unless they replace their changes (their file goes to the trash)', async () => {
    const file = path.join(agentsDir, 'gardener', 'agent.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('You are the gardener.', 'You are MY gardener.'));
    catalog.reload();
    publish([gardener({ version: '1.1.0', changes: 'Kinder.' }, 'You are the kind gardener. Today is {{today}}.')]);
    expect(await card('gardener')).toMatchObject({ installed: { drift: 'edited-update' } });
    const plan = await updatePlanRoute(deps, 'gardener', { agentId: 'gardener' });
    expect(plan.body).toMatchObject({ edited: true });
    const refused = await updateRoute(deps, 'gardener', { agentId: 'gardener' });
    expect(refused.status).toBe(409);
    expect(readFileSync(file, 'utf8')).toContain('You are MY gardener.');

    const replaced = await updateRoute(deps, 'gardener', { agentId: 'gardener', replace: true });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(readFileSync(file, 'utf8')).toContain('You are the kind gardener.');
    // The plants pick survives the update; the owner's version is in the trash.
    expect(readFileSync(file, 'utf8')).toContain('The tomatoes');
    const trashed = readdirSync(path.join(root, '.trash', 'agents')).filter((d) => d.startsWith('gardener-'));
    expect(trashed).toHaveLength(1);
    expect(readFileSync(path.join(root, '.trash', 'agents', trashed[0]!, 'agent.md'), 'utf8')).toContain('You are MY gardener.');
    // Existing missions stay as the owner left them.
    expect(await getMission(pool, 'agent:gardener:sunday-log')).toMatchObject({ enabled: true });
  });

  it('maps an old Planner through `replaces`, and updates it in place keeping its handle', async () => {
    const dir = path.join(agentsDir, 'planner');
    mkdirSync(dir, { recursive: true });
    const content = '---\nid: planner\nhandle: planner\nname: Planner\ndescription: Keeps the day.\ntools: [memory.*, reminder.*]\n---\n\nYou are Planner.\n';
    writeFileSync(path.join(dir, 'agent.md'), content);
    writeFileSync(
      path.join(dir, 'plugin.json'),
      composeProvenance({ plugin: 'buddi', version: '0.1.0', agent: 'planner', acceptedAt: new Date(), proposal: 'old', file: content }),
    );
    await upsertMission(pool, { id: 'agent:planner:morning-brief', name: 'Morning brief', agentId: 'planner', prompt: 'Brief.', enabled: true });
    catalog.reload();
    publish([
      agentEntry('chief-of-staff', {
        manifest: {
          handle: 'chief',
          title: 'Chief of Staff',
          replaces: ['buddi/planner'],
          tools: ['memory.*', 'reminder.*', 'schedule.*', 'owner.notify', 'email.read?'],
          needs: ['mailbox?'],
          missions: [{ id: 'morning-brief', name: 'Morning brief', cron: '0 8 * * *', prompt: 'A new brief.' }, { id: 'friday-waiting', name: 'Still waiting on', cron: '0 16 * * 5', prompt: 'Chase.' }],
        },
      }),
    ]);
    expect(await card('chief-of-staff')).toMatchObject({
      state: 'installed',
      installed: { agentId: 'planner', handle: 'planner', drift: 'update', via: 'buddi/planner', version: '0.1.0' },
    });
    const done = await updateRoute(deps, 'chief-of-staff', { agentId: 'planner' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const file = readFileSync(path.join(dir, 'agent.md'), 'utf8');
    expect(file).toMatch(/^id: planner$/m);
    expect(file).toMatch(/^handle: planner$/m);
    expect(file).toMatch(/^name: Chief of Staff$/m);
    // Its own morning brief is the owner's row: untouched. The new one arrives off.
    expect(await getMission(pool, 'agent:planner:morning-brief')).toMatchObject({ prompt: 'Brief.', enabled: true });
    expect(await getMission(pool, 'agent:planner:friday-waiting')).toMatchObject({ enabled: false });
    expect(await card('chief-of-staff')).toMatchObject({ installed: { agentId: 'planner', drift: 'current', version: '1.0.0' } });
  });

  it('leaves an edited old agent alone and says it does this', async () => {
    const file = path.join(agentsDir, 'planner', 'agent.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nMy own line.\n`);
    catalog.reload();
    expect(await card('chief-of-staff')).toMatchObject({ installed: { drift: 'edited' } });
  });

  it('removes an agent: its missions paused, the plugins nobody else uses named, the directory in the trash', async () => {
    publish([gardener({ version: '1.1.0', changes: 'Kinder.' }, 'You are the kind gardener. Today is {{today}}.')]);
    const preview = await removePreviewRoute(deps, 'gardener');
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ pausesMissions: [{ id: 'agent:gardener:sunday-log', name: 'Sunday log' }] });
    expect((preview.body as { preview: string }).preview).toContain('paused');
    const done = await removeRoute(deps, 'gardener');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await getMission(pool, 'agent:gardener:sunday-log')).toMatchObject({ enabled: false });
    expect(existsSync(path.join(agentsDir, 'gardener'))).toBe(false);
    expect(await card('gardener')).toMatchObject({ state: 'ready' });
  });

  it('answers the kept copy offline, marked stale, and says it needs withbuddi.com with none', async () => {
    publish([agentEntry('researcher')]);
    await view();
    market.offline = true;
    const reply = await catalogueRoute(deps, new URL('http://x/api/catalogue?refresh=1'));
    expect(reply.body).toMatchObject({ stale: true, agents: [expect.objectContaining({ name: 'researcher' })] });

    const fresh = createCatalogueService({
      env: { ...deps.env, BUDDI_DATA_DIR: path.join(root, 'empty-data') },
      log: () => {},
      registry,
      ctx,
      now,
      fetch: marketFetch(market),
    });
    resetMarketCache();
    const none = await catalogueRoute({ ...deps, service: fresh }, new URL('http://x/api/catalogue'));
    expect(none.body).toMatchObject({ agents: [], unavailable: "The catalogue needs withbuddi.com; try again when you're online." });
  });

  it('builds the same envelope when Agent Father adds one from chat, and reads the catalogue', async () => {
    publish([agentEntry('writer', { manifest: { fills: [{ id: 'voice', kind: 'text', label: 'Anything about how you write?', optional: true }] } })]);
    const listed = await registry.invoke('platform.catalogue', {}, { ...ctx, agentId: 'agent-father', now });
    expect(listed.ok).toBe(true);
    expect((listed as { output: { agents: Array<{ name: string; state: string; picks: unknown[] }> } }).output.agents).toEqual([
      expect.objectContaining({ name: 'writer', state: 'ready', picks: [expect.objectContaining({ id: 'voice', question: 'Anything about how you write?' })] }),
    ]);
    const input = { name: 'writer', fills: { voice: 'Short sentences.' } };
    const invoked = await registry.invoke('platform.install_agent', input, { ...ctx, agentId: 'agent-father', now });
    expect(invoked.ok).toBe(false);
    if (invoked.ok || invoked.reason !== 'approval-required') throw new Error(JSON.stringify(invoked));
    const action = await getAction(pool, invoked.actionId);
    const planned = await planCatalogueInstall(registry, input, { timezone: 'UTC', db: pool, agentId: 'agent-father' });
    expect(action?.envelope).toEqual(JSON.parse(JSON.stringify(planned.envelope)));
    expect(action?.preview).toContain('Short sentences.');
    // A denylisted ask is refused before any approval exists.
    publish([agentEntry('leaky', { manifest: { tools: ['memory.*'] } })]);
    const refused = await registry.invoke('platform.install_agent', { name: 'nobody' }, { ...ctx, agentId: 'agent-father', now });
    expect(refused.ok).toBe(false);
    expect((refused as { message: string }).message).toMatch(/lists no agent "nobody"/);
  });

});
