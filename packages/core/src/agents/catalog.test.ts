import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../registry.js';
import type { PluginManifest } from '../tools.js';
import {
  AgentCatalogError,
  DEFAULT_MAX_TURNS,
  selectSkills,
  generatedSection,
  injectToday,
  loadAgentCatalog,
  resolveToolNames,
  toDateString,
  UnknownAgentError,
} from './catalog.js';
import { AgentFileError, parseAgentFile, parseYamlSubset, splitFrontmatter } from './frontmatter.js';
import { DEFAULT_MODEL } from './provider-from-env.js';
import { parseSkillFile } from './skills.js';

/** A stand-in plugin: core may not import a real one (dependency direction). */
function fakeManifest(names: string[], plugin = 'finance'): PluginManifest {
  return {
    name: plugin,
    version: '0.0.0',
    schema: plugin,
    migrationsDir: '/dev/null',
    tools: names.map((name) => ({
      name,
      description: name,
      tier: 'auto' as const,
      input: z.object({}),
      execute: async () => ({}),
    })),
  };
}

const TOOLS = ['finance.list_accounts', 'finance.project_cashflow', 'notes.search'];

function registryOf(names: string[] = TOOLS): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(fakeManifest(names.filter((n) => n.startsWith('finance.'))));
  const others = names.filter((n) => !n.startsWith('finance.'));
  if (others.length > 0) registry.register(fakeManifest(others, 'notes'));
  return registry;
}

function agentFile(frontmatter: string, body = 'You are a test agent. Today is {{today}}.'): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

/**
 * Lay out `<root>/agents/<id>/agent.md`, optional `<root>/agents/<id>/skills/`
 * and optional `<root>/skills/`, and return the agents directory — the shared
 * skills directory is found next to it, exactly as it is in the repo.
 */
function catalogDir(
  files: Record<string, string>,
  extra: { shared?: Record<string, string>; skills?: Record<string, Record<string, string>> } = {},
): string {
  const root = mkdtempSync(path.join(tmpdir(), 'buddi-agents-'));
  const dir = path.join(root, 'agents');
  mkdirSync(dir, { recursive: true });
  for (const [id, content] of Object.entries(files)) {
    mkdirSync(path.join(dir, id), { recursive: true });
    writeFileSync(path.join(dir, id, 'agent.md'), content);
  }
  for (const [id, skills] of Object.entries(extra.skills ?? {})) {
    mkdirSync(path.join(dir, id, 'skills'), { recursive: true });
    for (const [name, content] of Object.entries(skills)) {
      writeFileSync(path.join(dir, id, 'skills', `${name}.md`), content);
    }
  }
  if (extra.shared !== undefined) {
    mkdirSync(path.join(root, 'skills'), { recursive: true });
    for (const [name, content] of Object.entries(extra.shared)) {
      writeFileSync(path.join(root, 'skills', `${name}.md`), content);
    }
  }
  return dir;
}

function skillFile(frontmatter: string, body = 'Do the thing carefully.'): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

const FINANCE = agentFile(
  ['id: finance-advisor', 'name: Finance Advisor', 'description: Money.', 'tools: [finance.*]', 'default: true'].join('\n'),
);
const CONCIERGE = agentFile(
  ['id: concierge', 'name: Concierge', 'description: Front desk.', 'tools: []'].join('\n'),
  'You are the concierge.',
);

describe('splitFrontmatter', () => {
  it('separates the yaml block from the body', () => {
    const { frontmatter, body } = splitFrontmatter('---\nid: a\n---\n\nbody text\n');
    expect(frontmatter).toBe('id: a');
    expect(body).toBe('body text\n');
  });

  it('refuses a file with no frontmatter', () => {
    expect(() => splitFrontmatter('just a body')).toThrow(AgentFileError);
  });

  it('refuses an unterminated frontmatter block', () => {
    expect(() => splitFrontmatter('---\nid: a\nbody')).toThrow(/never closed/);
  });
});

describe('parseYamlSubset', () => {
  it('reads scalars, booleans and numbers', () => {
    expect(parseYamlSubset('id: a-b\nname: "A B"\ndefault: true\nmaxTurns: 4')).toEqual({
      id: 'a-b',
      name: 'A B',
      default: true,
      maxTurns: 4,
    });
  });

  it('reads a flow list and an empty flow list', () => {
    expect(parseYamlSubset('tools: [a.x, b.*]\nother: []')).toEqual({
      tools: ['a.x', 'b.*'],
      other: [],
    });
  });

  it('reads a block list', () => {
    expect(parseYamlSubset('tools:\n  - a.x\n  - b.y\nid: z')).toEqual({
      tools: ['a.x', 'b.y'],
      id: 'z',
    });
  });

  it('ignores comments and blank lines', () => {
    expect(parseYamlSubset('# a comment\n\nid: a')).toEqual({ id: 'a' });
  });

  it('refuses a duplicate key and a malformed line', () => {
    expect(() => parseYamlSubset('id: a\nid: b')).toThrow(/duplicate key/);
    expect(() => parseYamlSubset('id a')).toThrow(/key: value/);
  });
});

describe('parseAgentFile', () => {
  it('parses frontmatter and body together', () => {
    const parsed = parseAgentFile(FINANCE, { dirName: 'finance-advisor' });
    expect(parsed.frontmatter.id).toBe('finance-advisor');
    expect(parsed.frontmatter.tools).toEqual(['finance.*']);
    expect(parsed.frontmatter.default).toBe(true);
    expect(parsed.body).toContain('{{today}}');
  });

  it('refuses an id that does not match its directory', () => {
    expect(() => parseAgentFile(FINANCE, { dirName: 'money' })).toThrow(/does not match/);
  });

  it('refuses a non-kebab-case id', () => {
    const file = agentFile('id: Finance_Advisor\nname: X\ndescription: d\ntools: []');
    expect(() => parseAgentFile(file)).toThrow(/kebab-case/);
  });

  it('refuses a missing required field', () => {
    expect(() => parseAgentFile(agentFile('id: a\nname: A\ntools: []'))).toThrow(
      /description/,
    );
  });

  it('refuses an unknown frontmatter key', () => {
    const file = agentFile('id: a\nname: A\ndescription: d\ntools: []\ntier: auto');
    expect(() => parseAgentFile(file)).toThrow(/Unrecognized key|unrecognized/i);
  });

  it('refuses an unknown language', () => {
    const file = agentFile('id: a\nname: A\ndescription: d\ntools: []\nlanguage: de');
    expect(() => parseAgentFile(file)).toThrow(AgentFileError);
  });

  it('refuses an empty persona body', () => {
    expect(() => parseAgentFile('---\nid: a\nname: A\ndescription: d\ntools: []\n---\n\n')).toThrow(
      /body/,
    );
  });
});

describe('resolveToolNames', () => {
  const registry = registryOf();

  it('expands a glob in registry order', () => {
    expect(resolveToolNames(['finance.*'], registry, 'a')).toEqual([
      'finance.list_accounts',
      'finance.project_cashflow',
    ]);
  });

  it('accepts exact names and de-duplicates overlaps', () => {
    expect(
      resolveToolNames(['finance.project_cashflow', 'finance.*'], registry, 'a'),
    ).toEqual(['finance.list_accounts', 'finance.project_cashflow']);
  });

  it('resolves no tools to no tools', () => {
    expect(resolveToolNames([], registry, 'a')).toEqual([]);
  });

  it('fails closed on an entry that matches nothing', () => {
    expect(() => resolveToolNames(['email.send'], registry, 'a')).toThrow(AgentCatalogError);
    expect(() => resolveToolNames(['email.*'], registry, 'a')).toThrow(/matches no registered tool/);
  });
});

describe('loadAgentCatalog', () => {
  const load = (files: Record<string, string>, env: NodeJS.ProcessEnv = {}) =>
    loadAgentCatalog({ dir: catalogDir(files), registry: registryOf(), env });

  it('lists every agent with its summary', () => {
    const catalog = load({ 'finance-advisor': FINANCE, concierge: CONCIERGE });
    expect(catalog.list()).toEqual([
      { id: 'concierge', name: 'Concierge', description: 'Front desk.', isDefault: false },
      {
        id: 'finance-advisor',
        name: 'Finance Advisor',
        description: 'Money.',
        isDefault: true,
      },
    ]);
  });

  it('resolves an id, and the default when none is given', () => {
    const catalog = load({ 'finance-advisor': FINANCE, concierge: CONCIERGE });
    expect(catalog.resolve('concierge').id).toBe('concierge');
    expect(catalog.resolve().id).toBe('finance-advisor');
    expect(catalog.defaultAgent().id).toBe('finance-advisor');
    expect(catalog.get('concierge')?.name).toBe('Concierge');
    expect(catalog.get('nope')).toBeUndefined();
  });

  it('fails closed on an unknown id instead of falling back to the default', () => {
    const catalog = load({ 'finance-advisor': FINANCE });
    expect(() => catalog.resolve('tax-wizard')).toThrow(UnknownAgentError);
    expect(() => catalog.resolve('tax-wizard')).toThrow(/finance-advisor/);
  });

  it('refuses two defaults', () => {
    const second = CONCIERGE.replace('tools: []', 'tools: []\ndefault: true');
    expect(() => load({ 'finance-advisor': FINANCE, concierge: second })).toThrow(
      /exactly one agent may be default/,
    );
  });

  it('refuses an agent file whose id is not its directory', () => {
    expect(() => load({ money: FINANCE })).toThrow(AgentCatalogError);
  });

  it('refuses an agent granting a tool the registry does not have', () => {
    const bad = agentFile('id: mailer\nname: M\ndescription: d\ntools: [email.send]');
    expect(() => load({ mailer: bad })).toThrow(/matches no registered tool/);
  });

  it('reports a missing default only when one is asked for', () => {
    const catalog = load({ concierge: CONCIERGE });
    expect(catalog.list()).toHaveLength(1);
    expect(() => catalog.defaultAgent()).toThrow(/default: true/);
  });

  it('refuses a missing agents directory', () => {
    expect(() =>
      loadAgentCatalog({ dir: '/nope/not/here', registry: registryOf(), env: {} }),
    ).toThrow(/cannot read agents directory/);
  });

  it('ignores a directory without an agent.md', () => {
    const dir = catalogDir({ 'finance-advisor': FINANCE });
    mkdirSync(path.join(dir, 'notes'), { recursive: true });
    const catalog = loadAgentCatalog({ dir, registry: registryOf(), env: {} });
    expect(catalog.list().map((a) => a.id)).toEqual(['finance-advisor']);
  });

  it('defaults the model, the turn budget and the language', () => {
    const agent = load({ concierge: CONCIERGE }).resolve('concierge');
    expect(agent.model).toBe(DEFAULT_MODEL);
    expect(agent.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(agent.language).toBe('mirror');
  });

  it('honours a pinned model over BUDDI_MODEL, and BUDDI_MODEL over the default', () => {
    const pinned = CONCIERGE.replace('tools: []', 'tools: []\nmodel: claude-haiku-4-5');
    expect(load({ concierge: pinned }, { BUDDI_MODEL: 'from-env' }).resolve('concierge').model).toBe(
      'claude-haiku-4-5',
    );
    expect(load({ concierge: CONCIERGE }, { BUDDI_MODEL: 'from-env' }).resolve('concierge').model).toBe(
      'from-env',
    );
  });

  it('pins the credential kind from the environment', () => {
    const agent = load({ concierge: CONCIERGE }, { CLAUDE_CODE_OAUTH_TOKEN: 't' }).resolve(
      'concierge',
    );
    expect(agent.provider.credential.kind).toBe('subscription-token');
  });

  it('appends a generated section naming the resolved tools', () => {
    const agent = load({ 'finance-advisor': FINANCE }).resolve('finance-advisor');
    expect(agent.systemPromptTemplate).toContain(
      'Tools available to you in this installation: finance.list_accounts, finance.project_cashflow.',
    );
    expect(load({ concierge: CONCIERGE }).resolve('concierge').systemPromptTemplate).toContain(
      'You have no tools in this installation.',
    );
  });

  it('builds a runnable definition with {{today}} substituted', () => {
    const agent = load({ 'finance-advisor': FINANCE }).resolve('finance-advisor');
    const definition = agent.definition(new Date('2026-09-13T23:30:00Z'));
    expect(definition.id).toBe('finance-advisor');
    expect(definition.name).toBe('Finance Advisor');
    expect(definition.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(definition.tools).toEqual(agent.tools);
    expect(definition.systemPrompt).toContain('Today is 2026-09-13.');
    expect(definition.systemPrompt).not.toContain('{{today}}');
    expect(agent.systemPromptTemplate).toContain('{{today}}');
  });
});

describe('today injection', () => {
  it('renders the UTC date', () => {
    expect(toDateString(new Date('2026-09-13T23:59:59Z'))).toBe('2026-09-13');
  });

  it('replaces every placeholder', () => {
    expect(injectToday('{{today}} and {{today}}', 'x')).toBe('x and x');
  });
});

describe('generatedSection', () => {
  it('states the language rule for each supported value', () => {
    expect(generatedSection([], 'mirror')).toContain('Never switch language on your own.');
    expect(generatedSection([], 'en')).toContain('Always reply in English');
    expect(generatedSection([], 'fr')).toContain('Réponds toujours en français');
  });
});

describe('skills in the catalog', () => {
  const load = (
    files: Record<string, string>,
    extra: Parameters<typeof catalogDir>[1] = {},
  ) => loadAgentCatalog({ dir: catalogDir(files, extra), registry: registryOf(), env: {} });

  const VERDICTS = skillFile(
    ['name: verdicts', 'description: What a verdict states.', 'provenance: owner'].join('\n'),
    'Always quote minBalance and its date.',
  );
  const HOUSE = skillFile(
    ['name: plain-text', 'description: No markdown on plain surfaces.', 'provenance: imported', 'source: https://example.test/rule'].join('\n'),
    'Never type an asterisk.',
  );

  it('loads a private skill and composes it into the prompt with its footer', () => {
    const agent = load({ 'finance-advisor': FINANCE }, {
      skills: { 'finance-advisor': { verdicts: VERDICTS } },
    }).resolve('finance-advisor');

    expect(agent.skills.map((s) => s.name)).toEqual(['verdicts']);
    expect(agent.skills[0]?.provenance).toBe('owner');
    expect(agent.skills[0]?.file.endsWith(path.join('skills', 'verdicts.md'))).toBe(true);
    expect(agent.systemPromptTemplate).toContain('# SKILLS');
    expect(agent.systemPromptTemplate).toContain('## verdicts');
    expect(agent.systemPromptTemplate).toContain('Always quote minBalance and its date.');
    expect(agent.systemPromptTemplate).toContain('(skill: verdicts, provenance: owner)');
  });

  it('keeps the generated wiring section last, after the skills', () => {
    const agent = load({ 'finance-advisor': FINANCE }, {
      skills: { 'finance-advisor': { verdicts: VERDICTS } },
    }).resolve('finance-advisor');
    const skillsAt = agent.systemPromptTemplate.indexOf('# SKILLS');
    const wiringAt = agent.systemPromptTemplate.indexOf('## Your wiring');
    expect(skillsAt).toBeGreaterThan(0);
    expect(wiringAt).toBeGreaterThan(skillsAt);
  });

  it('adds no section at all when an agent has no skills', () => {
    const agent = load({ concierge: CONCIERGE }).resolve('concierge');
    expect(agent.skills).toEqual([]);
    expect(agent.systemPromptTemplate).not.toContain('# SKILLS');
  });

  it('loads an unfiltered shared skill for every agent, and quotes its source', () => {
    const catalog = load(
      { 'finance-advisor': FINANCE, concierge: CONCIERGE },
      { shared: { 'plain-text': HOUSE } },
    );
    for (const id of ['finance-advisor', 'concierge']) {
      const agent = catalog.resolve(id);
      expect(agent.skills.map((s) => s.name)).toEqual(['plain-text']);
      expect(agent.systemPromptTemplate).toContain(
        '(skill: plain-text, provenance: imported, source: https://example.test/rule)',
      );
    }
  });

  it('honours the agents filter on a shared skill', () => {
    const filtered = HOUSE.replace('provenance: imported', 'provenance: imported\nagents: [concierge]');
    const catalog = load(
      { 'finance-advisor': FINANCE, concierge: CONCIERGE },
      { shared: { 'plain-text': filtered } },
    );
    expect(catalog.resolve('concierge').skills.map((s) => s.name)).toEqual(['plain-text']);
    expect(catalog.resolve('finance-advisor').skills).toEqual([]);
  });

  it('orders private skills before shared ones', () => {
    const agent = load({ 'finance-advisor': FINANCE }, {
      shared: { 'plain-text': HOUSE },
      skills: { 'finance-advisor': { verdicts: VERDICTS } },
    }).resolve('finance-advisor');
    expect(agent.skills.map((s) => s.name)).toEqual(['verdicts', 'plain-text']);
  });

  it('fails closed on a skills: entry naming no shared skill', () => {
    const declared = FINANCE.replace('tools: [finance.*]', 'tools: [finance.*]\nskills: [nope]');
    expect(() => load({ 'finance-advisor': declared }, { shared: { 'plain-text': HOUSE } })).toThrow(
      /declares skill "nope"/,
    );
  });

  it('fails closed when a declared shared skill excludes this agent', () => {
    const filtered = HOUSE.replace('provenance: imported', 'provenance: imported\nagents: [concierge]');
    const declared = FINANCE.replace('tools: [finance.*]', 'tools: [finance.*]\nskills: [plain-text]');
    expect(() => load({ 'finance-advisor': declared }, { shared: { 'plain-text': filtered } })).toThrow(
      /lists agents concierge and not this one/,
    );
  });

  it('reports a malformed skill file as a skill-file catalog error', () => {
    const broken = skillFile('name: verdicts\ndescription: d\ntools: [finance.*]');
    let caught: unknown;
    try {
      load({ 'finance-advisor': FINANCE }, { skills: { 'finance-advisor': { verdicts: broken } } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentCatalogError);
    expect((caught as AgentCatalogError).code).toBe('skill-file');
    expect((caught as Error).message).toMatch(/never grants a tool/);
  });

  it('refuses a shared skill that collides with a private one', () => {
    expect(() =>
      load({ 'finance-advisor': FINANCE }, {
        shared: { verdicts: VERDICTS },
        skills: { 'finance-advisor': { verdicts: VERDICTS } },
      }),
    ).toThrow(/one name, one procedure/);
  });
});

describe('selectSkills', () => {
  const shared = (name: string, agents?: string[]) =>
    parseSkillFile(
      `---\nname: ${name}\ndescription: d${agents ? `\nagents: [${agents.join(', ')}]` : ''}\n---\n\nbody\n`,
      { scope: 'shared' },
    );

  it('includes an unfiltered shared skill without it being declared', () => {
    expect(selectSkills('a', [], [], [shared('house')]).map((s) => s.name)).toEqual(['house']);
  });

  it('excludes a filtered shared skill that does not name the agent', () => {
    expect(selectSkills('a', [], [], [shared('house', ['b'])])).toEqual([]);
  });

  it('includes a filtered shared skill that names the agent', () => {
    expect(selectSkills('a', [], [], [shared('house', ['a', 'b'])]).map((s) => s.name)).toEqual([
      'house',
    ]);
  });
});
