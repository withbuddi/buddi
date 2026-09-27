/**
 * Adding a starter teammate, end to end: the Add button runs the same accept
 * route the email plugin's Mail offer does, under the built-in source `buddi`,
 * and Planner arrives with its morning brief at 08:00 in the owner's timezone.
 * Against a throwaway database; skipped unless DATABASE_URL is set.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  createPool,
  ensureOwner,
  getAction,
  getActiveSchedule,
  getMission,
  listPendingActions,
  loadAgentCatalog,
  migrate,
  type CoreToolContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createToolRegistry, EXAMPLES_AGENTS_DIR, EXAMPLES_SKILLS_DIR, reloadableCatalog } from '../agents/catalog.js';
import { bindPlatformTools } from '../agents/platform.js';
import { acceptAgentRoute, type AcceptAgentDeps } from './plugins.js';
import { isPendingAccept, readTeammates } from './agent-offers.js';
import { decideApprovalFromWeb } from './write.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_starter_team_test_${process.pid}`;
const now = (): Date => new Date();

suite('adding a starter teammate', () => {
  let admin: Pool;
  let pool: Pool;
  let deps: AcceptAgentDeps;
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

    const root = mkdtempSync(path.join(tmpdir(), 'buddi-starter-db-'));
    agentsDir = path.join(root, 'agents');
    const skillsDir = path.join(root, 'skills');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    const registry = createToolRegistry({});
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
    bindPlatformTools(registry, { catalog, reload: () => catalog.reload(), agentsDir, skillsDir, examplesDir: EXAMPLES_AGENTS_DIR });
    const ctx = { db: pool, ownerId: 'owner', now, timezone: 'Europe/Paris' } as unknown as CoreToolContext;
    deps = {
      registry,
      ctx,
      now,
      agents: () => catalog.list(),
      approve: (actionId) => decideApprovalFromWeb({ pool, registry, ctx, now }, actionId, 'approved'),
      pendingAccept: async (plugin, agentId) =>
        (await listPendingActions(pool, { now: now() })).find((a) => isPendingAccept(a, plugin, agentId))?.id ?? null,
    };
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('creates Planner through the owner-approved accept, with its skills and its morning brief', async () => {
    const reply = await acceptAgentRoute(deps, 'buddi', 'planner');
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const body = reply.body as { approvalId: string; agent: { id: string; handle: string } };
    expect(body.agent).toMatchObject({ id: 'planner', handle: 'planner' });

    const action = await getAction(pool, body.approvalId);
    expect(action).toMatchObject({ tool: 'platform.accept_plugin_agent', agentId: 'owner', state: 'succeeded' });
    // The preview named the mission the owner was approving.
    expect(action?.preview).toContain('Morning brief, every day at 08:00 Europe/Paris');

    expect(existsSync(path.join(agentsDir, 'planner', 'agent.md'))).toBe(true);
    expect(readdirSync(path.join(agentsDir, 'planner', 'skills')).sort()).toEqual([
      'holding-a-follow-up.md',
      'writing-the-morning-brief.md',
    ]);
    expect(deps.agents().some((a) => a.id === 'planner')).toBe(true);

    const mission = await getMission(pool, 'agent:planner:morning-brief');
    expect(mission).toMatchObject({ name: 'Morning brief', agentId: 'planner', enabled: true });
    const schedule = await getActiveSchedule(pool, 'agent:planner:morning-brief');
    expect(schedule).toMatchObject({ cron: '0 8 * * *', timezone: 'Europe/Paris' });
  });

  it('creates Scout and Keeper with no mission, and the catalogue then says added', async () => {
    for (const id of ['scout', 'keeper']) {
      const reply = await acceptAgentRoute(deps, 'buddi', id);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(await getMission(pool, `agent:${id}:morning-brief`)).toBeNull();
    }
    const { teammates } = await readTeammates({
      registry: deps.registry,
      ctx: deps.ctx,
      now,
      pool,
      agentIds: () => deps.agents().map((a) => a.id),
    });
    expect(teammates.filter((t) => t.plugin === 'buddi').map((t) => `${t.agent}:${t.state}`)).toEqual([
      'scout:added',
      'planner:added',
      'keeper:added',
    ]);
  });
});
