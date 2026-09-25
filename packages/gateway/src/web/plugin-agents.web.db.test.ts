/**
 * The Accept button, end to end: one click creates the agent.
 *
 * The owner's click is the approval. The route records the gated
 * `platform.accept_plugin_agent` action as the owner and decides it through
 * `decideApprovalFromWeb` — the card's own Approve — in the same request, so
 * the agent exists when the answer arrives. A second click is "already there",
 * never a second agent. The agent arrives with the mascot its proposal
 * names. And an offer the plugin says is now wanted — the first mailbox
 * saved — raises its card without a click, once. Against a throwaway
 * database; skipped unless DATABASE_URL is set.
 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  createPool,
  ensureOwner,
  getAction,
  listPendingActions,
  loadAgentCatalog,
  readWebSetting,
  migrate,
  type CoreToolContext,
  type PluginManifest,
  type ToolDefinition,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createToolRegistry,
  EXAMPLES_AGENTS_DIR,
  EXAMPLES_SKILLS_DIR,
  reloadableCatalog,
} from '../agents/catalog.js';
import { bindPlatformTools } from '../agents/platform.js';
import { acceptAgentRoute, type AcceptAgentDeps } from './plugins.js';
import { AGENT_OFFERS_KEY, isPendingAccept, raiseAgentOffers, type RaiseAgentOffersDeps } from './agent-offers.js';
import { decideApprovalFromWeb } from './write.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_accept_agent_test_${process.pid}`;
const now = (): Date => new Date();
/** How many mailboxes the garden has: what its offer query reads. */
const beds = { count: 0 };

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
  agents: [
    {
      id: 'gardener',
      handle: 'gardener',
      name: 'Gardener',
      description: 'Knows what has been watered and what has not.',
      persona: 'You are the gardener.',
      tools: ['garden.*'],
      avatar: 'garage',
    },
    {
      id: 'weeder',
      handle: 'weeder',
      name: 'Weeder',
      description: 'Pulls weeds once there is a bed.',
      persona: 'You pull weeds.',
      tools: ['garden.*'],
      offer: { text: 'The beds need a weeder.', query: 'weeder_wanted' },
      avatar: 'mail',
    },
  ],
  queries: [{ name: 'weeder_wanted', params: z.object({}), produce: async () => ({ wanted: beds.count > 0 }) }],
};

suite('accepting a proposed agent from the dashboard', () => {
  let admin: Pool;
  let pool: Pool;
  let deps: AcceptAgentDeps;
  let offerDeps: RaiseAgentOffersDeps;
  const asked: string[] = [];
  let agentsDir: string;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
    await ensureOwner(pool, 'owner');

    const root = mkdtempSync(path.join(tmpdir(), 'buddi-accept-db-'));
    agentsDir = path.join(root, 'agents');
    const skillsDir = path.join(root, 'skills');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    const registry = createToolRegistry({});
    registry.register(GARDEN);
    const catalog = reloadableCatalog(() =>
      loadAgentCatalog({
        dirs: [
          { dir: EXAMPLES_AGENTS_DIR, skillsDir: EXAMPLES_SKILLS_DIR, source: 'example' },
          { dir: agentsDir, skillsDir, source: 'private' },
        ],
        registry,
        env: {},
      }),
    );
    bindPlatformTools(registry, {
      catalog,
      reload: () => catalog.reload(),
      agentsDir,
      skillsDir,
      examplesDir: EXAMPLES_AGENTS_DIR,
    });
    const ctx = { db: pool, ownerId: 'owner', now, timezone: 'UTC' } as unknown as CoreToolContext;
    deps = {
      registry,
      ctx,
      now,
      agents: () => catalog.list(),
      approve: (actionId) => decideApprovalFromWeb({ pool, registry, ctx, now }, actionId, 'approved'),
      pendingAccept: async (plugin, agentId) =>
        (await listPendingActions(pool, { now: now() })).find((a) => isPendingAccept(a, plugin, agentId))?.id ?? null,
    };
    offerDeps = {
      registry,
      ctx,
      now,
      pool,
      agentIds: () => catalog.list().map((a) => a.id),
      askApproval: async (action) => {
        asked.push(action.id);
      },
    };
  });

  const pendingAccepts = async (agent: string): Promise<string[]> =>
    (await listPendingActions(pool, { now: now() })).filter((a) => isPendingAccept(a, 'garden', agent)).map((a) => a.id);
  const pictureOf = async (agent: string): Promise<number> =>
    (await pool.query('select count(*)::int as n from core.agent_avatars where agent_id = $1', [agent])).rows[0].n;

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('creates and approves in one call, as the owner', async () => {
    const reply = await acceptAgentRoute(deps, 'garden', 'gardener');
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const body = reply.body as { approvalId: string; agent: { id: string; handle: string; name: string } };
    expect(body.agent).toEqual({ id: 'gardener', handle: 'gardener', name: 'Gardener' });

    // The card is still the record: the owner's action, decided and executed.
    const action = await getAction(pool, body.approvalId);
    expect(action).toMatchObject({ tool: 'platform.accept_plugin_agent', agentId: 'owner', state: 'succeeded' });

    // And the agent exists afterwards.
    expect(existsSync(path.join(agentsDir, 'gardener', 'agent.md'))).toBe(true);
    expect(deps.agents().some((a) => a.id === 'gardener')).toBe(true);
    // With the mascot its proposal names, in the store an upload uses.
    expect(await pictureOf('gardener')).toBe(1);
  });

  it('answers "already there" on a second call, not a second agent', async () => {
    const before = await pool.query('select count(*)::int as n from core.actions');
    const reply = await acceptAgentRoute(deps, 'garden', 'gardener');
    expect(reply).toEqual({
      status: 200,
      body: { already: true, agent: { id: 'gardener', handle: 'gardener', name: 'Gardener' } },
    });
    const after = await pool.query('select count(*)::int as n from core.actions');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(deps.agents().filter((a) => a.id === 'gardener')).toHaveLength(1);
  });

  it('raises the card itself when the first bed is saved, once, and approving it creates the agent', async () => {
    // Nothing wanted yet: nothing raised.
    expect(await raiseAgentOffers(offerDeps, 'garden')).toEqual([]);

    beds.count = 1;
    const raised = await raiseAgentOffers(offerDeps, 'garden');
    expect(raised).toHaveLength(1);
    expect(await pendingAccepts('weeder')).toEqual(raised);
    // On Telegram too, when one is paired.
    expect(asked).toEqual(raised);
    expect(await readWebSetting(pool, AGENT_OFFERS_KEY)).toMatchObject({ raised: ['garden/weeder'] });

    // A second bed raises nothing more.
    beds.count = 2;
    expect(await raiseAgentOffers(offerDeps, 'garden')).toEqual([]);
    expect(await pendingAccepts('weeder')).toEqual(raised);

    // Approving it — the click decides the waiting card, not a second one.
    const reply = await acceptAgentRoute(deps, 'garden', 'weeder');
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toMatchObject({ approvalId: raised[0], agent: { id: 'weeder', handle: 'weeder' } });
    expect(await getAction(pool, raised[0]!)).toMatchObject({ state: 'succeeded' });
    expect(existsSync(path.join(agentsDir, 'weeder', 'agent.md'))).toBe(true);
    expect(await pictureOf('weeder')).toBe(1);
    expect(await pendingAccepts('weeder')).toEqual([]);
  });
});
