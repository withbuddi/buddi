/**
 * The `platform.*` family — what it refuses, what it shows, and what it writes.
 *
 * The three things worth testing here are the three things that make an agent
 * creating an agent safe:
 *
 *  - **the refusals happen before the action exists.** Every validation case
 *    below calls `describe`, which is the hook that runs *before* an approval
 *    is recorded. If one of these reached `execute` instead, an owner would be
 *    asked to approve something that could not happen.
 *  - **the preview is about access.** A grant that widens has to say so, name
 *    what was added, and say what those tools reach in the registry's own
 *    words — not ours, and not the model's.
 *  - **the write is exact and reversible.** The file on disk is the file in the
 *    envelope; an edit that names only a frontmatter key leaves the persona
 *    byte-for-byte; a delete moves a directory rather than destroying it.
 *
 * Everything runs against a temporary private agents directory and the real
 * registry, so "is this tool installed?" is answered by the installation.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { loadAgentCatalog, type ToolContext, type ToolDefinition } from '@buddi/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createToolRegistry,
  loadGatewayCatalog,
  EXAMPLES_AGENTS_DIR,
  EXAMPLES_SKILLS_DIR,
  reloadableCatalog,
  type ReloadableAgentCatalog,
} from './catalog.js';
import {
  bindPlatformTools,
  type PlatformAccounts,
  createPlatformManifest,
  type CreateAgentEnvelope,
  type DeleteAgentEnvelope,
  type UpdateAgentEnvelope,
  type WriteSkillEnvelope,
} from './platform.js';
import { diffGrant, firstSentence, groupGrant } from './platform-grant.js';

/* ------------------------------------------------------------------ *
 * A private agents directory of our own
 * ------------------------------------------------------------------ */

const SCOUT = `---
id: scout
handle: scout
name: Scout
description: Watches things and reports.
tools: [memory.note, memory.recall]
maxTurns: 7
---

Scout's persona, written by hand.

It has a --- line inside it, on purpose.
`;

interface Harness {
  root: string;
  agentsDir: string;
  skillsDir: string;
  catalog: ReloadableAgentCatalog;
  registry: ReturnType<typeof createToolRegistry>;
  tool(name: string): ToolDefinition<any, any>;
  ctx: ToolContext;
  reloads: number;
}

function harness(caller = 'agent-father', accounts?: PlatformAccounts): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'buddi-platform-'));
  const agentsDir = path.join(root, 'agents');
  const skillsDir = path.join(root, 'skills');
  mkdirSync(path.join(agentsDir, 'scout'), { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, 'scout', 'agent.md'), SCOUT, 'utf8');

  const registry = createToolRegistry({});
  const load = () =>
    loadAgentCatalog({
      dirs: [
        { dir: EXAMPLES_AGENTS_DIR, skillsDir: EXAMPLES_SKILLS_DIR, source: 'example' },
        { dir: agentsDir, skillsDir, source: 'private' },
      ],
      registry,
      env: {},
    });
  const catalog = reloadableCatalog(load);
  const state = { reloads: 0 };
  bindPlatformTools(registry, {
    catalog,
    reload: () => {
      state.reloads += 1;
      catalog.reload();
    },
    agentsDir,
    skillsDir,
    examplesDir: EXAMPLES_AGENTS_DIR,
    ...(accounts ? { accounts: () => accounts } : {}),
  });
  const manifest = createPlatformManifest(registry);
  const ctx = {
    db: null as never,
    ownerId: 'owner',
    now: () => new Date('2026-09-15T12:00:00Z'),
    timezone: 'Europe/Paris',
    agentId: caller,
  } satisfies ToolContext;

  return {
    root,
    agentsDir,
    skillsDir,
    catalog,
    registry,
    tool(name) {
      const found = manifest.tools.find((t) => t.name === name);
      if (!found) throw new Error(`no such tool: ${name}`);
      if (found.tier !== 'gated') return found;
      // This unit harness stands in for the executor's approved snapshot.
      return { ...found, execute: async (input, ctx) => found.execute(input, {
        ...ctx, approvedEffect: ctx.approvedEffect ?? await found.describe!(input, ctx),
      }) };
    },
    ctx,
    get reloads() {
      return state.reloads;
    },
  } as Harness;
}

/** `describe`, as the registry calls it: the throw is the refusal. */
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

const baseCreate = {
  id: 'bookkeeper',
  handle: 'bookkeeper',
  name: 'Bookkeeper',
  description: 'Keeps the books tidy.',
  persona: 'You are the bookkeeper. You keep notes and set reminders.',
  tools: ['memory.*', 'reminder.*'],
};

let h: Harness;
beforeEach(() => {
  h = harness();
});

/* ------------------------------------------------------------------ *
 * Refusals, all of them before an action exists
 * ------------------------------------------------------------------ */

describe('validation happens before the action exists', () => {
  it('refuses a handle nobody could type', () => {
    const message = refusalOf(h, 'platform.create_agent', { ...baseCreate, handle: 'Book Keeper!' });
    expect(message).toContain('not a usable handle');
  });

  it('refuses an id that is already one of the owner\'s agents', () => {
    const message = refusalOf(h, 'platform.create_agent', { ...baseCreate, id: 'scout', handle: 'scouty' });
    expect(message).toContain('you already have an agent called "scout"');
  });

  it('refuses a handle another agent already answers to, case-insensitively', () => {
    const message = refusalOf(h, 'platform.create_agent', { ...baseCreate, handle: 'SCOUT' });
    expect(message).toContain('@scout is already Scout');
  });

  it('refuses a tool this installation does not have, and says where to look', () => {
    const message = refusalOf(h, 'platform.create_agent', {
      ...baseCreate,
      tools: ['memory.*', 'crypto.wire_transfer'],
    });
    expect(message).toContain('crypto.wire_transfer');
    expect(message).toContain('platform.installed_tools');
  });

  it('refuses a delegate that is not an installed agent', () => {
    const message = refusalOf(h, 'platform.create_agent', { ...baseCreate, delegates: ['accountant'] });
    expect(message).toContain('not an agent installed here');
  });

  it('refuses a model the pinned provider does not serve', () => {
    const message = refusalOf(h, 'platform.create_agent', {
      ...baseCreate,
      provider: 'anthropic',
      model: 'gpt-5',
    });
    expect(message).toContain('never migrated for you');
  });

  it('refuses to touch an agent the repository ships, and offers the copy instead', () => {
    const message = refusalOf(h, 'platform.update_agent', { id: 'concierge', description: 'mine now' });
    expect(message).toContain('belong to');
    expect(message).toContain('private directory');
    expect(message).toContain('replacesExample');
  });

  it('will not let Agent Father edit its own file, because it ships as an example', () => {
    // The one agent that may write cannot write itself: its persona is the
    // platform's. Copying it into the private directory is the way to change
    // it, and from then on the self-edit preview rule applies to the copy.
    const message = refusalOf(h, 'platform.update_agent', {
      id: 'agent-father',
      tools: ['platform.*', 'finance.*'],
    });
    expect(message).toContain('one of the examples this repository ships');
  });

  it('refuses to delete a shipped example', () => {
    const message = refusalOf(h, 'platform.delete_agent', { id: 'concierge' });
    expect(message).toContain('shipped example');
  });

  it('refuses to write a skill into the examples tree', () => {
    const message = refusalOf(h, 'platform.write_skill', {
      name: 'house-rule',
      scope: 'agent',
      agentId: 'concierge',
      description: 'x',
      provenance: 'agent',
      body: 'do the thing',
    });
    expect(message).toContain('belong to');
  });

  it('refuses a change that changes nothing', () => {
    const message = refusalOf(h, 'platform.update_agent', { id: 'scout', maxTurns: 7 });
    expect(message).toContain('already says exactly this');
  });

  it('refuses to grant the write tools to anybody, however they are spelled', () => {
    // One approval must never buy a second agent that can write the
    // installation forever after.
    for (const grant of [['platform.*'], ['memory.*', 'platform.create_agent'], ['platform.delete_agent']]) {
      const message = refusalOf(h, 'platform.create_agent', { ...baseCreate, tools: grant });
      expect(message).toContain('not grantable through this tool');
      expect(message).toContain('platform.list_agents');
    }
  });

  it('refuses to widen an existing agent into a writer', () => {
    const message = refusalOf(h, 'platform.update_agent', {
      id: 'scout',
      tools: ['memory.note', 'platform.update_agent'],
    });
    expect(message).toContain('not grantable through this tool');
  });

  it('still grants the read tools freely', () => {
    const { envelope } = described<CreateAgentEnvelope>(h, 'platform.create_agent', {
      ...baseCreate,
      tools: ['memory.*', 'platform.list_agents', 'platform.read_agent'],
    });
    expect(envelope.tools).toContain('platform.list_agents');
    expect(envelope.tools).toContain('platform.read_agent');
  });

  it('refuses a delegate allowlist that names an agent holding the write tools', () => {
    // @father holds them, so nobody may be given a corridor to it.
    const message = refusalOf(h, 'platform.create_agent', { ...baseCreate, delegates: ['agent-father'] });
    expect(message).toContain('may not delegate to agent-father');
    expect(message).toContain('platform.create_agent');

    const onUpdate = refusalOf(h, 'platform.update_agent', { id: 'scout', delegates: ['@father'] });
    expect(onUpdate).toContain('may not delegate to agent-father');
  });

  it('refuses an unknown agent', () => {
    expect(refusalOf(h, 'platform.update_agent', { id: 'nobody', maxTurns: 3 })).toContain(
      'there is no agent "nobody"',
    );
  });
});

/* ------------------------------------------------------------------ *
 * The envelope and the preview
 * ------------------------------------------------------------------ */

describe('the envelope carries the whole file and the resolved grant', () => {
  it('names every tool the grant resolves to, not the glob the model wrote', () => {
    const { envelope } = described<CreateAgentEnvelope>(h, 'platform.create_agent', baseCreate);
    expect(envelope.declaredTools).toEqual(['memory.*', 'reminder.*']);
    expect(envelope.tools).toContain('memory.note');
    expect(envelope.tools).toContain('reminder.set');
    expect(envelope.tools.every((t) => t.startsWith('memory.') || t.startsWith('reminder.'))).toBe(true);
  });

  it('carries the complete resulting file and the path it lands on', () => {
    const { envelope } = described<CreateAgentEnvelope>(h, 'platform.create_agent', baseCreate);
    expect(envelope.file).toBe(path.join(h.agentsDir, 'bookkeeper', 'agent.md'));
    expect(envelope.content).toContain('id: bookkeeper');
    expect(envelope.content).toContain('tools: [memory.*, reminder.*]');
    expect(envelope.content.trimEnd().endsWith('You are the bookkeeper. You keep notes and set reminders.')).toBe(
      true,
    );
  });

  it('puts what the grant reaches at the top of the preview, in the tools\' own words', () => {
    const { preview } = described<CreateAgentEnvelope>(h, 'platform.create_agent', baseCreate);
    expect(preview).toContain('This gives @bookkeeper your memory tools');
    expect(preview).toContain('What that reaches:');
    // The description is the registry's, quoted, not a sentence written here.
    const memoryNote = createToolRegistry({})
      .list()
      .find((t) => t.name === 'memory.note');
    expect(preview).toContain(firstSentence(memoryNote?.description ?? ''));
    // And what it does not reach is named too.
    expect(preview).toContain('It reaches nothing else');
    expect(preview).toContain('finance');
  });
});

describe('an update that widens a grant says so', () => {
  const widen = { id: 'scout', tools: ['memory.note', 'memory.recall', 'finance.*'] };

  it('names the widening, the added tools and what they reach', () => {
    const { envelope, preview } = described<UpdateAgentEnvelope>(h, 'platform.update_agent', widen);
    expect(envelope.widened).toBe(true);
    expect(envelope.added).toContain('finance.list_accounts');
    expect(envelope.toolsBefore).toEqual(['memory.note', 'memory.recall']);

    expect(preview).toContain('THIS WIDENS WHAT @scout CAN REACH.');
    expect(preview).toContain('This adds @scout your finance tools');
    expect(preview).toContain('What it newly reaches:');
    expect(preview).toContain('finance.list_accounts —');
    // The tools it already had are shown separately, so the two never blur.
    expect(preview).toContain('Unchanged, and it already had these: memory.note, memory.recall');
  });

  it('says plainly when an agent is proposing a change to its own file', () => {
    const self = harness('scout');
    const { envelope, preview } = described<UpdateAgentEnvelope>(self, 'platform.update_agent', widen);
    expect(envelope.isSelfEdit).toBe(true);
    expect(preview).toContain("THIS IS THE CALLER'S OWN FILE");
  });

  it('does not shout when the grant is untouched', () => {
    const { envelope, preview } = described<UpdateAgentEnvelope>(h, 'platform.update_agent', {
      id: 'scout',
      maxTurns: 9,
    });
    expect(envelope.widened).toBe(false);
    expect(preview).toContain('Its tool grant does not change');
    expect(preview).toContain('maxTurns: 7 → 9');
  });
});

describe('the examples tree belongs to the platform', () => {
  const override = {
    ...baseCreate,
    id: 'concierge',
    handle: 'buddi',
    name: 'My Concierge',
    description: 'Mine, not the repository\'s.',
  };

  it('refuses to take a shipped example\'s id by accident, and offers the copy', () => {
    const message = refusalOf(h, 'platform.create_agent', override);
    expect(message).toContain('one of the examples this repository ships');
    expect(message).toContain('replacesExample');
  });

  it('writes the copy into the private directory when the owner asked for it', async () => {
    const { envelope, preview } = described<CreateAgentEnvelope>(h, 'platform.create_agent', {
      ...override,
      replacesExample: true,
    });
    expect(envelope.replacesExample).toBe(true);
    // Never under examples/, always under the owner's own directory.
    expect(envelope.file).toBe(path.join(h.agentsDir, 'concierge', 'agent.md'));
    expect(envelope.file.includes(`${path.sep}examples${path.sep}`)).toBe(false);
    expect(preview).toContain('OVERRIDES the shipped example agent');

    await h.tool('platform.create_agent').execute({ ...override, replacesExample: true }, h.ctx);
    const now = h.catalog.resolve('concierge');
    expect(now.source).toBe('private');
    expect(now.name).toBe('My Concierge');
    // Replacing the example that claims `default: true` must not leave the
    // installation without a default agent.
    expect(h.catalog.defaultAgent().id).toBe('concierge');
    expect(readFileSync(path.join(EXAMPLES_AGENTS_DIR, 'concierge', 'agent.md'), 'utf8')).toContain(
      'The agent buddi ships with',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

describe('create, approve, talk to it', () => {
  it('writes exactly the file the envelope described', async () => {
    const { envelope } = described<CreateAgentEnvelope>(h, 'platform.create_agent', baseCreate);
    const result = (await h.tool('platform.create_agent').execute(baseCreate, h.ctx)) as {
      ok: boolean;
      live: boolean;
      file: string;
    };
    expect(result.ok).toBe(true);
    expect(readFileSync(envelope.file, 'utf8')).toBe(envelope.content);
    expect(readFileSync(envelope.file, 'utf8')).toBe(
      [
        '---',
        'id: bookkeeper',
        'handle: bookkeeper',
        'name: Bookkeeper',
        'description: Keeps the books tidy.',
        'tools: [memory.*, reminder.*]',
        '---',
        '',
        'You are the bookkeeper. You keep notes and set reminders.',
        '',
      ].join('\n'),
    );
  });

  it('makes the new agent resolvable in this same process, with no restart', async () => {
    expect(h.catalog.get('bookkeeper')).toBeUndefined();
    const result = (await h.tool('platform.create_agent').execute(baseCreate, h.ctx)) as { live: boolean; message: string };
    expect(result.live).toBe(true);
    expect(h.reloads).toBe(1);
    // The same catalog object every surface is holding now answers for it.
    const created = h.catalog.resolve('@bookkeeper');
    expect(created.id).toBe('bookkeeper');
    expect(created.tools).toContain('reminder.set');
    expect(h.catalog.list().map((a) => a.id)).toContain('bookkeeper');
    expect(result.message).toContain('no restart');
  });

  it('writes a delegates.json when one was asked for, in the same move', async () => {
    await h.tool('platform.create_agent').execute({ ...baseCreate, delegates: ['scout'] }, h.ctx);
    const file = path.join(h.agentsDir, 'bookkeeper', 'delegates.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(['scout']);
  });
});

describe('update', () => {
  it('refuses state changed after approval rather than overwriting it', async () => {
    const input = { id: 'scout', description: 'Approved description.' };
    const approvedEffect = described(h, 'platform.update_agent', input);
    const file = path.join(h.agentsDir, 'scout', 'agent.md');
    const changed = readFileSync(file, 'utf8') + '\nThe owner added this after approval.\n';
    writeFileSync(file, changed);
    await expect(h.tool('platform.update_agent').execute(input, { ...h.ctx, approvedEffect }))
      .rejects.toThrow(/no longer matches/);
    expect(readFileSync(file, 'utf8')).toBe(changed);
  });
  it('leaves the persona byte-for-byte when only frontmatter changes', async () => {
    const file = path.join(h.agentsDir, 'scout', 'agent.md');
    const before = readFileSync(file, 'utf8');
    await h.tool('platform.update_agent').execute({ id: 'scout', maxTurns: 9 }, h.ctx);
    const after = readFileSync(file, 'utf8');
    expect(after).not.toBe(before);
    expect(after.split('\n---\n')[1]).toBe(before.split('\n---\n')[1]);
    expect(after).toContain('It has a --- line inside it, on purpose.');
  });

  it('preserves every field it was not told about', async () => {
    await h.tool('platform.update_agent').execute({ id: 'scout', description: 'Now watches harder.' }, h.ctx);
    const scout = h.catalog.resolve('scout');
    expect(scout.description).toBe('Now watches harder.');
    expect(scout.handle).toBe('scout');
    expect(scout.name).toBe('Scout');
    expect(scout.maxTurns).toBe(7);
    expect(scout.tools).toEqual(['memory.note', 'memory.recall']);
  });

  it('replaces the persona when one is given, and the frontmatter survives', async () => {
    await h.tool('platform.update_agent').execute({ id: 'scout', persona: 'A whole new Scout.' }, h.ctx);
    const text = readFileSync(path.join(h.agentsDir, 'scout', 'agent.md'), 'utf8');
    expect(text).toContain('handle: scout');
    expect(text).toContain('A whole new Scout.');
    expect(text).not.toContain('written by hand');
  });
});

describe('delete moves, it does not destroy', () => {
  it('moves the directory aside and says where it went', async () => {
    const dir = path.join(h.agentsDir, 'scout');
    const result = (await h.tool('platform.delete_agent').execute({ id: 'scout' }, h.ctx)) as {
      movedTo: string;
      message: string;
    };
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(result.movedTo)).toBe(true);
    expect(readFileSync(path.join(result.movedTo, 'agent.md'), 'utf8')).toBe(SCOUT);
    expect(result.movedTo).toContain(path.join('.trash', 'agents'));
    expect(result.message).toContain(result.movedTo);
    // And it is gone from the running catalog immediately.
    expect(h.catalog.get('scout')).toBeUndefined();
  });

  it('describes the move before it happens', () => {
    const { envelope, preview } = described<DeleteAgentEnvelope>(h, 'platform.delete_agent', { id: 'scout' });
    expect(envelope.directory).toBe(path.join(h.agentsDir, 'scout'));
    expect(envelope.trashDirectory).toContain('.trash');
    expect(preview).toContain('Nothing is destroyed');
  });
});

describe('skills', () => {
  it('writes an agent-private skill and composes it into that agent\'s prompt', async () => {
    const input = {
      name: 'how-to-watch',
      scope: 'agent',
      agentId: 'scout',
      description: 'The order to check things in.',
      provenance: 'agent',
      body: 'First look, then report.',
    };
    const { envelope } = described<WriteSkillEnvelope>(h, 'platform.write_skill', input);
    expect(envelope.file).toBe(path.join(h.agentsDir, 'scout', 'skills', 'how-to-watch.md'));
    await h.tool('platform.write_skill').execute(input, h.ctx);
    expect(readFileSync(envelope.file, 'utf8')).toBe(envelope.content);
    expect(h.catalog.resolve('scout').skills.map((s) => s.name)).toContain('how-to-watch');
    expect(h.catalog.resolve('scout').systemPromptTemplate).toContain('First look, then report.');
  });

  it('writes a shared skill into the owner\'s shared directory', async () => {
    const input = {
      name: 'house-style',
      scope: 'shared',
      description: 'How everybody writes here.',
      provenance: 'owner',
      body: 'Short sentences.',
    };
    await h.tool('platform.write_skill').execute(input, h.ctx);
    expect(existsSync(path.join(h.skillsDir, 'house-style.md'))).toBe(true);
    expect(h.catalog.resolve('scout').skills.map((s) => s.name)).toContain('house-style');
  });
});

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

describe('the read tools', () => {
  it('lists every agent with its source and its grant', async () => {
    const result = (await h.tool('platform.list_agents').execute({}, h.ctx)) as {
      agents: Array<{ id: string; source: string; tools: string[] }>;
    };
    const scout = result.agents.find((a) => a.id === 'scout');
    expect(scout?.source).toBe('private');
    expect(scout?.tools).toEqual(['memory.note', 'memory.recall']);
    expect(result.agents.find((a) => a.id === 'concierge')?.source).toBe('example');
  });

  it('reports the tools this installation actually has, by family', async () => {
    const result = (await h.tool('platform.installed_tools').execute({}, h.ctx)) as {
      families: Array<{ family: string; glob: string; tools: unknown[] }>;
      total: number;
    };
    expect(result.families.map((f) => f.family)).toContain('finance');
    expect(result.families.find((f) => f.family === 'memory')?.glob).toBe('memory.*');
    expect(result.total).toBeGreaterThan(20);
  });

  it('reads one agent whole: frontmatter, persona and skills', async () => {
    const result = (await h.tool('platform.read_agent').execute({ id: '@scout' }, h.ctx)) as {
      ok: boolean;
      persona: string;
      editable: boolean;
      frontmatter: { maxTurns: number };
    };
    expect(result.ok).toBe(true);
    expect(result.editable).toBe(true);
    expect(result.frontmatter.maxTurns).toBe(7);
    expect(result.persona).toContain('written by hand');
  });

  it('says a shipped example is not editable', async () => {
    const result = (await h.tool('platform.read_agent').execute({ id: 'concierge' }, h.ctx)) as {
      editable: boolean;
    };
    expect(result.editable).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The pure helpers
 * ------------------------------------------------------------------ */

describe('grant arithmetic', () => {
  it('groups a grant into families in registry order', () => {
    const specs = createToolRegistry({}).list();
    const grouped = groupGrant(['memory.note', 'reminder.set', 'memory.recall'], specs);
    expect(grouped.map((g) => g.family)).toEqual(['memory', 'reminder']);
    expect(grouped[0]?.tools.map((t) => t.name)).toEqual(['memory.note', 'memory.recall']);
  });

  it('knows an addition from a removal', () => {
    expect(diffGrant(['a', 'b'], ['b', 'c'])).toEqual({
      added: ['c'],
      removed: ['a'],
      kept: ['b'],
      widened: true,
    });
    expect(diffGrant(['a', 'b'], ['a']).widened).toBe(false);
  });

  it('clips a tool description to its first sentence', () => {
    expect(firstSentence('Does one thing. Then another thing entirely.')).toBe('Does one thing.');
    expect(firstSentence('x'.repeat(200)).endsWith('…')).toBe(true);
  });
});

describe('a delegates.json naming a writer is refused at load', () => {
  it('will not load a catalog where anybody can reach the write tools by delegation', () => {
    // The file is plain text: an owner can write one by hand and a backup can
    // restore one, so the rule cannot live only where a grant is proposed.
    const root = mkdtempSync(path.join(tmpdir(), 'buddi-platform-delegates-'));
    const agentsDir = path.join(root, 'agents');
    mkdirSync(path.join(agentsDir, 'scout'), { recursive: true });
    writeFileSync(path.join(agentsDir, 'scout', 'agent.md'), SCOUT, 'utf8');
    writeFileSync(path.join(agentsDir, 'scout', 'delegates.json'), '["agent-father"]', 'utf8');

    expect(() =>
      loadGatewayCatalog({
        env: { BUDDI_AGENTS_DIR: agentsDir, BUDDI_SKILLS_DIR: path.join(root, 'skills') },
        registry: createToolRegistry({}),
      }),
    ).toThrow(/may not delegate to agent-father/);
  });
});


/* ------------------------------------------------------------------ *
 * Named accounts
 * ------------------------------------------------------------------ */

describe('with named model accounts', () => {
  const assigned: Array<[string, string, string]> = [];
  const bindings = new Map<string, { accountId: string; model: string }>();
  const accounts: PlatformAccounts = {
    list: () => [
      { id: 'acc-local', label: 'Local endpoint', kind: 'openai-compatible', enabled: true, configured: true, defaultModel: 'qwen3:8b', assignedAgents: [] },
      { id: 'acc-claude', label: 'Anthropic API', kind: 'anthropic', enabled: true, configured: true, defaultModel: 'claude-sonnet-5', assignedAgents: ['scout'] },
      { id: 'acc-off', label: 'Old key', kind: 'openai', enabled: false, configured: true, defaultModel: 'gpt-5', assignedAgents: [] },
    ],
    bindingOf: (id) => bindings.get(id),
    assign: async (agentId, accountId, model) => { assigned.push([agentId, accountId, model]); bindings.set(agentId, { accountId, model }); },
  };
  let a: Harness;
  beforeEach(() => { assigned.length = 0; bindings.clear(); bindings.set('scout', { accountId: 'acc-claude', model: 'claude-sonnet-5' }); a = harness('agent-father', accounts); });

  it('lists the accounts by name, with who uses them', async () => {
    const result = await a.tool('platform.list_accounts').execute({}, a.ctx) as { accounts: Array<{ name: string; provider: string; usable: boolean; usedBy: string[] }> };
    expect(result.accounts.map((x) => x.name)).toEqual(['Local endpoint', 'Anthropic API', 'Old key']);
    expect(result.accounts[0]).toMatchObject({ provider: 'openai-compatible', usable: true });
    expect(result.accounts[2]!.usable).toBe(false);
    expect(result.accounts[1]!.usedBy).toEqual(['scout']);
  });

  it('asks for an account rather than guessing, and refuses the old provider road', () => {
    expect(refusalOf(a, 'platform.create_agent', baseCreate)).toContain('which account');
    expect(refusalOf(a, 'platform.create_agent', { ...baseCreate, provider: 'anthropic' })).toContain('named accounts');
    expect(refusalOf(a, 'platform.create_agent', { ...baseCreate, account: 'Old key' })).toContain('disabled');
    expect(refusalOf(a, 'platform.create_agent', { ...baseCreate, account: 'Nope' })).toContain('no account is called');
    expect(refusalOf(a, 'platform.create_agent', { ...baseCreate, account: 'Anthropic API', model: 'gpt-5' })).toContain('Anthropic API');
  });

  it('creates on the named account, keeps the model out of the file, and assigns after writing', async () => {
    const { envelope, preview } = described<CreateAgentEnvelope>(a, 'platform.create_agent', { ...baseCreate, account: 'local endpoint' });
    expect(envelope.account).toEqual({ id: 'acc-local', label: 'Local endpoint', kind: 'openai-compatible', model: 'qwen3:8b' });
    expect(preview).toContain('"Local endpoint" account (openai-compatible), model qwen3:8b');
    expect(envelope.content).not.toContain('model:');
    expect(envelope.content).not.toContain('provider:');
    const result = await a.tool('platform.create_agent').execute({ ...baseCreate, account: 'local endpoint' }, a.ctx) as { message: string };
    expect(assigned).toEqual([['bookkeeper', 'acc-local', 'qwen3:8b']]);
    expect(result.message).toContain('Runs on "Local endpoint"');
  });

  it('moves an existing agent to another account, and treats a model-only change as an assignment', async () => {
    const moved = described<UpdateAgentEnvelope>(a, 'platform.update_agent', { id: 'scout', account: 'Local endpoint' });
    expect(moved.envelope.changes).toContainEqual({ key: 'runs on', from: 'Anthropic API, claude-sonnet-5', to: 'Local endpoint, qwen3:8b' });
    expect(moved.envelope.content).not.toContain('qwen3');
    await a.tool('platform.update_agent').execute({ id: 'scout', account: 'Local endpoint' }, a.ctx);
    expect(assigned).toEqual([['scout', 'acc-local', 'qwen3:8b']]);
    const retuned = described<UpdateAgentEnvelope>(a, 'platform.update_agent', { id: 'scout', model: 'qwen3:32b' });
    expect(retuned.envelope.changes).toContainEqual({ key: 'runs on', from: 'Local endpoint, qwen3:8b', to: 'Local endpoint, qwen3:32b' });
    const listed = await a.tool('platform.list_agents').execute({}, a.ctx) as { agents: Array<{ id: string; account?: string | null; model: string | null }> };
    expect(listed.agents.find((x) => x.id === 'scout')).toMatchObject({ account: 'Local endpoint', model: 'qwen3:8b' });
  });
});
