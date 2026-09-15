/**
 * Agents a plugin proposes: the offer, the approval, and the refusals.
 *
 * The claim under test is that a plugin gets **no shorter path to a principal**
 * than the owner's own agent does. Concretely:
 *
 *  - accepting a proposal is `gated`, so it becomes an action and waits;
 *  - the preview names the plugin, and then the whole grant in the registered
 *    tools' own words — the same block `platform.create_agent` renders;
 *  - every refusal `create_agent` makes, this makes too, and before the action
 *    exists: a duplicate id, a taken handle, a tool that is not installed, and
 *    above all a proposal reaching for the tools that write the installation;
 *  - what is written is the owner's file, with a sidecar recording where it
 *    came from — and an upgrade never touches it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  loadAgentCatalog,
  type PluginManifest,
  type SuggestedAgent,
  type ToolContext,
  type ToolDefinition,
} from '@buddi/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createToolRegistry,
  EXAMPLES_AGENTS_DIR,
  EXAMPLES_SKILLS_DIR,
  reloadableCatalog,
  type ReloadableAgentCatalog,
} from './catalog.js';
import {
  bindPlatformTools,
  createPlatformManifest,
  pluginAgentProposals,
  type AcceptPluginAgentEnvelope,
} from './platform.js';
import { driftFor, PROVENANCE_FILE, readProvenance } from '../plugins/provenance.js';

/** A plugin with two tools, one proposed agent and one shared skill. */
function testPlugin(agents: SuggestedAgent[]): PluginManifest {
  const tool = (name: string, description: string): ToolDefinition<any, any> => ({
    name,
    description,
    tier: 'auto',
    input: z.object({}).strict(),
    async execute() {
      return {};
    },
  });
  return {
    name: 'garden',
    version: '1.2.0',
    description: 'Watches a garden.',
    schema: 'garden',
    migrationsDir: '',
    tools: [
      tool('garden.water_log', 'Every watering recorded for a plant, most recent first.'),
      tool('garden.plants', 'Every plant the owner has recorded, with where it lives.'),
    ],
    agents,
    skills: [
      {
        name: 'reading-a-water-log',
        description: 'How to tell a dry spell from a missed entry.',
        body: 'Look at the gaps before you look at the totals.',
      },
    ],
  };
}

const GARDENER: SuggestedAgent = {
  id: 'gardener',
  handle: 'gardener',
  name: 'Gardener',
  description: 'Knows what has been watered and what has not.',
  persona: 'You are the gardener. You read the log and say what needs water.',
  tools: ['garden.*'],
  roles: ['garden'],
  skills: [
    {
      name: 'when-a-plant-is-dry',
      description: 'What counts as overdue.',
      body: 'Three days for anything in a pot. A week for anything in the ground.',
    },
  ],
};

const SCOUT = `---
id: scout
handle: scout
name: Scout
description: Watches things and reports.
tools: [memory.note, memory.recall]
---

Scout's persona.
`;

interface Harness {
  agentsDir: string;
  registry: ReturnType<typeof createToolRegistry>;
  catalog: ReloadableAgentCatalog;
  tool(name: string): ToolDefinition<any, any>;
  ctx: ToolContext;
}

function harness(agents: SuggestedAgent[] = [GARDENER]): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'buddi-plugin-agents-'));
  const agentsDir = path.join(root, 'agents');
  const skillsDir = path.join(root, 'skills');
  mkdirSync(path.join(agentsDir, 'scout'), { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, 'scout', 'agent.md'), SCOUT, 'utf8');

  const registry = createToolRegistry({});
  registry.register(testPlugin(agents));
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
  const manifest = createPlatformManifest(registry);
  return {
    agentsDir,
    registry,
    catalog,
    tool(name) {
      const found = manifest.tools.find((t) => t.name === name);
      if (!found) throw new Error(`no such tool: ${name}`);
      return found;
    },
    ctx: {
      db: null as never,
      ownerId: 'owner',
      now: () => new Date('2026-09-15T12:00:00Z'),
      timezone: 'Europe/Paris',
      agentId: 'agent-father',
    } satisfies ToolContext,
  };
}

function described<E>(h: Harness, tool: string, input: unknown): { envelope: E; preview: string } {
  const definition = h.tool(tool);
  if (!definition.describe) throw new Error(`${tool} has no describe`);
  return definition.describe(input, h.ctx) as { envelope: E; preview: string };
}

function refusalOf(h: Harness, tool: string, input: unknown): string {
  try {
    described(h, tool, input);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`${tool} did not refuse`);
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('a manifest can carry suggested agents', () => {
  it('reads them off the registry, whichever plugin they came from', () => {
    const proposals = pluginAgentProposals(h.registry);
    expect(proposals.map((p) => `${p.plugin}/${p.agent.id}`)).toEqual(['garden/gardener']);
    expect(proposals[0]?.pluginVersion).toBe('1.2.0');
  });

  it('lists them with what is still un-accepted, without creating anything', async () => {
    const result = (await h.tool('platform.plugin_agents').execute({}, h.ctx)) as any;
    expect(result.agents[0]).toMatchObject({
      plugin: 'garden',
      id: 'gardener',
      accepted: false,
      status: 'not-accepted',
      proposedTools: ['garden.*'],
    });
    expect(result.skills[0]).toMatchObject({ plugin: 'garden', name: 'reading-a-water-log' });
    expect(existsSync(path.join(h.agentsDir, 'gardener'))).toBe(false);
  });

  it('is tier auto for reading and gated for accepting', () => {
    expect(h.tool('platform.plugin_agents').tier).toBe('auto');
    expect(h.tool('platform.accept_plugin_agent').tier).toBe('gated');
    expect(h.tool('platform.accept_plugin_skill').tier).toBe('gated');
  });
});

describe('accepting produces a gated action with a preview about access', () => {
  it('names the plugin, the grant, and what it reaches', () => {
    const { envelope, preview } = described<AcceptPluginAgentEnvelope>(h, 'platform.accept_plugin_agent', {
      plugin: 'garden',
      agent: 'gardener',
    });
    expect(envelope.fromPlugin).toEqual({ name: 'garden', version: '1.2.0' });
    expect(envelope.tools).toEqual(['garden.water_log', 'garden.plants']);
    expect(preview).toContain('The garden plugin (1.2.0) proposes an agent');
    expect(preview).toContain('A plugin cannot create an agent; only this approval can.');
    // The grant block, in the registered tools' own words.
    expect(preview).toContain('This gives @gardener your garden tools (2)');
    expect(preview).toContain('garden.water_log — Every watering recorded for a plant, most recent first.');
    // And what it does NOT reach, which is the half a grant list cannot give.
    expect(preview).toContain('It reaches nothing else — not finance');
    expect(preview).toContain('when-a-plant-is-dry');
    expect(preview).toContain('this file is YOURS');
  });

  it('writes nothing while it is only describing', () => {
    described(h, 'platform.accept_plugin_agent', { plugin: 'garden', agent: 'gardener' });
    expect(existsSync(path.join(h.agentsDir, 'gardener'))).toBe(false);
  });

  it('writes the agent, its skill and a provenance sidecar when it runs', async () => {
    const { envelope } = described<AcceptPluginAgentEnvelope>(h, 'platform.accept_plugin_agent', {
      plugin: 'garden',
      agent: 'gardener',
    });
    const result = (await h.tool('platform.accept_plugin_agent').execute(
      { plugin: 'garden', agent: 'gardener' },
      h.ctx,
    )) as any;
    expect(result.ok).toBe(true);
    const file = path.join(h.agentsDir, 'gardener', 'agent.md');
    // The file on disk is the file in the envelope the owner approved.
    expect(readFileSync(file, 'utf8')).toBe(envelope.content);
    expect(readFileSync(path.join(h.agentsDir, 'gardener', 'skills', 'when-a-plant-is-dry.md'), 'utf8'))
      .toContain('Three days for anything in a pot');
    const provenance = readProvenance(path.join(h.agentsDir, 'gardener'));
    expect(provenance).toMatchObject({ plugin: 'garden', version: '1.2.0', agent: 'gardener' });
    // And it is live: the catalog resolves it with the grant that was approved.
    expect(h.catalog.get('gardener')?.tools).toEqual(['garden.water_log', 'garden.plants']);
  });

  it('accepts a shared skill through the same approval shape', async () => {
    const { preview } = described(h, 'platform.accept_plugin_skill', {
      plugin: 'garden',
      skill: 'reading-a-water-log',
    });
    expect(preview).toContain('The garden plugin (1.2.0) proposes a shared skill.');
    expect(preview).toContain('A skill grants no tool and lowers no tier');
    const result = (await h.tool('platform.accept_plugin_skill').execute(
      { plugin: 'garden', skill: 'reading-a-water-log' },
      h.ctx,
    )) as any;
    expect(readFileSync(result.file, 'utf8')).toContain('source: garden@1.2.0');
  });
});

describe('the refusals, all of them before an action exists', () => {
  it('refuses a proposal that reaches for the tools that write the installation', () => {
    const grabby = harness([{ ...GARDENER, tools: ['garden.*', 'platform.create_agent'] }]);
    const message = refusalOf(grabby, 'platform.accept_plugin_agent', { plugin: 'garden', agent: 'gardener' });
    expect(message).toContain('I cannot grant platform.create_agent');
    expect(message).toContain('one approval must never buy a second agent');
  });

  it('refuses a proposal reaching for accept_plugin_agent itself', () => {
    const grabby = harness([{ ...GARDENER, tools: ['platform.accept_plugin_agent'] }]);
    const message = refusalOf(grabby, 'platform.accept_plugin_agent', { plugin: 'garden', agent: 'gardener' });
    expect(message).toContain('platform.accept_plugin_agent');
  });

  it('refuses a proposal naming a tool this installation does not have', () => {
    const wrong = harness([{ ...GARDENER, tools: ['garden.*', 'telescope.point'] }]);
    const message = refusalOf(wrong, 'platform.accept_plugin_agent', { plugin: 'garden', agent: 'gardener' });
    expect(message).toContain('platform.installed_tools');
  });

  it('refuses when the handle is already somebody else\'s', () => {
    const clash = harness([{ ...GARDENER, handle: 'scout' }]);
    const message = refusalOf(clash, 'platform.accept_plugin_agent', { plugin: 'garden', agent: 'gardener' });
    expect(message).toContain('@scout is already');
  });

  it('refuses when the owner already has an agent with that id', () => {
    const clash = harness([{ ...GARDENER, id: 'scout', handle: 'gardener' }]);
    const message = refusalOf(clash, 'platform.accept_plugin_agent', { plugin: 'garden', agent: 'scout' });
    expect(message).toContain('you already have an agent called "scout"');
  });

  it('refuses a proposal nobody makes, and says what is on offer', () => {
    const message = refusalOf(h, 'platform.accept_plugin_agent', { plugin: 'garden', agent: 'nobody' });
    expect(message).toContain('garden/gardener');
  });
});

describe('an upgrade never overwrites the owner\'s edits', () => {
  it('reports the drift instead, in every direction', async () => {
    await h.tool('platform.accept_plugin_agent').execute({ plugin: 'garden', agent: 'gardener' }, h.ctx);
    const dir = path.join(h.agentsDir, 'gardener');
    const file = path.join(dir, 'agent.md');
    const accepted = readFileSync(file, 'utf8');

    // Nothing has moved on either side.
    expect(driftFor({ agentDir: dir, agentFile: file, suggestion: GARDENER, pluginVersion: '1.2.0' }).state).toBe(
      'up-to-date',
    );

    // The plugin changes its mind. The owner's file is untouched and stays untouched.
    const widened: SuggestedAgent = { ...GARDENER, tools: ['garden.*', 'memory.*'] };
    const changed = driftFor({ agentDir: dir, agentFile: file, suggestion: widened, pluginVersion: '1.3.0' });
    expect(changed.state).toBe('proposal-changed');
    expect(changed.message).toContain('Your copy is untouched');
    expect(readFileSync(file, 'utf8')).toBe(accepted);

    // The owner edits their copy. Now nothing will be touched, ever.
    writeFileSync(file, accepted.replace('You are the gardener.', 'You are MY gardener.'), 'utf8');
    expect(driftFor({ agentDir: dir, agentFile: file, suggestion: GARDENER, pluginVersion: '1.2.0' }).state).toBe(
      'owner-edited',
    );
    const both = driftFor({ agentDir: dir, agentFile: file, suggestion: widened, pluginVersion: '1.3.0' });
    expect(both.state).toBe('owner-edited-and-proposal-changed');
    expect(both.message).toContain('left exactly as you wrote it');
  });

  it('will not write over an agent of the same id that the owner made themselves', () => {
    const clash = harness([{ ...GARDENER, id: 'scout', handle: 'gardener' }]);
    const dir = path.join(clash.agentsDir, 'scout');
    const drift = driftFor({
      agentDir: dir,
      agentFile: path.join(dir, 'agent.md'),
      suggestion: { ...GARDENER, id: 'scout' },
      pluginVersion: '1.2.0',
    });
    expect(drift.state).toBe('owner-edited');
    expect(existsSync(path.join(dir, PROVENANCE_FILE))).toBe(false);
  });
});
