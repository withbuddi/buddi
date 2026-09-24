/**
 * `POST /api/plugins/<name>/agents/<id>/accept` — the Accept button on the
 * Plugins page.
 *
 * The page that says "1 agent proposed" used to end with an instruction: go
 * and say a sentence to another agent. This route is the button instead, and
 * the claim worth pinning down is that being a button changed nothing about
 * the decision. It is the same gated `platform.accept_plugin_agent`, invoked
 * as the owner, so what comes back is an approval to draw and never a written
 * file; and an agent nobody proposes is a 404 rather than anything at all.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  loadAgentCatalog,
  type PluginManifest,
  type CoreToolContext,
  type ToolDefinition,
} from '@buddi/core';
import { expect, it } from 'vitest';
import {
  createToolRegistry,
  EXAMPLES_AGENTS_DIR,
  EXAMPLES_SKILLS_DIR,
  reloadableCatalog,
} from '../agents/catalog.js';
import { bindPlatformTools } from '../agents/platform.js';
import { acceptAgentRoute } from './plugins.js';
import type { PagesDeps } from './pages.js';

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
    },
  ],
};

/**
 * Enough of a pool to record one action, and nothing that pretends to be more.
 * The insert is answered from the parameters it was given, so the row that
 * comes back is the row that was asked for.
 */
function fakePool(recorded: Array<Record<string, unknown>>) {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      if (!/insert into core\.actions/.test(sql)) return { rows: [] };
      const row = {
        id: 'action-1',
        tool: params[0],
        tool_version: params[1],
        agent_id: params[2],
        conversation_id: null,
        job_id: null,
        canonical_args: params[5],
        envelope: params[6],
        choices: params[12],
        tier: params[13],
        args_hash: params[7],
        preview: params[8],
        expires_at: new Date(),
        policy_version: params[10],
        created_at: new Date(),
        state: 'pending',
        updated_at: new Date(),
      };
      recorded.push(row);
      return { rows: [row] };
    },
  };
}

function deps(recorded: Array<Record<string, unknown>>): PagesDeps {
  const root = mkdtempSync(path.join(tmpdir(), 'buddi-accept-route-'));
  const agentsDir = path.join(root, 'agents');
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
  const ctx = {
    db: fakePool(recorded) as never,
    ownerId: 'owner',
    now: () => new Date('2026-09-15T12:00:00Z'),
    timezone: 'Europe/Paris',
  } as CoreToolContext;
  return { registry, ctx, now: () => new Date('2026-09-15T12:00:00Z') };
}

it('records a pending action as the owner, and hands back its preview', async () => {
  const recorded: Array<Record<string, unknown>> = [];
  const reply = await acceptAgentRoute(deps(recorded), 'garden', 'gardener');
  expect(reply.status).toBe(200);
  const body = reply.body as { approvalId?: string; preview?: string; result?: unknown };
  expect(body.approvalId).toBe('action-1');
  // The whole grant, in the registered tools' own words: the button changed
  // where the decision is made, not what is being decided.
  expect(body.preview).toContain('The garden plugin (1.2.0) proposes an agent');
  expect(body.preview).toContain('garden.water_log');
  // Nothing ran. A gated tool invoked here is an approval, never an effect.
  expect(body.result).toBeUndefined();
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ tool: 'platform.accept_plugin_agent', agent_id: 'owner', tier: 'gated' });
});

it('is case-insensitive about the proposed id, like the tool is', async () => {
  const reply = await acceptAgentRoute(deps([]), 'garden', 'GARDENER');
  expect(reply.status).toBe(200);
});

it('404s on an agent no installed plugin proposes, without recording anything', async () => {
  const recorded: Array<Record<string, unknown>> = [];
  const reply = await acceptAgentRoute(deps(recorded), 'garden', 'nobody');
  expect(reply.status).toBe(404);
  expect((reply.body as { error: string }).error).toContain('nobody');
  expect(recorded).toEqual([]);
});

it('404s on a plugin that is not installed at all', async () => {
  const reply = await acceptAgentRoute(deps([]), 'telescope', 'gardener');
  expect(reply.status).toBe(404);
});
