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
import {
  AgentFileError,
  INTRO_MAX,
  STARTER_MAX,
  parseAgentFile,
  parseYamlSubset,
  splitFrontmatter,
} from './frontmatter.js';
import { DEFAULT_MODEL, DEFAULT_OPENAI_MODEL, providerFromEnv } from './provider-from-env.js';
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
  ['id: finance-advisor', 'handle: ledger', 'name: Finance Advisor', 'description: Money.', 'tools: [finance.*]', 'default: true'].join('\n'),
);
const CONCIERGE = agentFile(
  ['id: concierge', 'handle: buddi', 'name: Concierge', 'description: Front desk.', 'tools: []'].join('\n'),
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
    const file = agentFile('id: Finance_Advisor\nhandle: xx\nname: X\ndescription: d\ntools: []');
    expect(() => parseAgentFile(file)).toThrow(/kebab-case/);
  });

  it('refuses a missing required field', () => {
    expect(() => parseAgentFile(agentFile('id: a\nhandle: aa\nname: A\ntools: []'))).toThrow(
      /description/,
    );
  });

  it('refuses an unknown frontmatter key', () => {
    const file = agentFile('id: a\nhandle: aa\nname: A\ndescription: d\ntools: []\ntier: auto');
    expect(() => parseAgentFile(file)).toThrow(/Unrecognized key|unrecognized/i);
  });

  it('refuses an unknown language', () => {
    const file = agentFile('id: a\nhandle: aa\nname: A\ndescription: d\ntools: []\nlanguage: de');
    expect(() => parseAgentFile(file)).toThrow(AgentFileError);
  });

  it('refuses a missing handle', () => {
    const file = agentFile('id: a\nname: A\ndescription: d\ntools: []');
    expect(() => parseAgentFile(file)).toThrow(/handle/);
  });

  it.each([
    ['1ledger', 'does not start with a letter'],
    ['L', 'too short'],
    ['l', 'too short'],
    ['Ledger', 'capitalised'],
    ['led_ger', 'underscored'],
    ['led ger', 'spaced'],
    ['-ledger', 'leading hyphen'],
    ['a-very-long-handle-indeed', 'over twenty characters'],
  ])('refuses the handle %s (%s)', (handle) => {
    const file = agentFile(`id: a\nhandle: ${handle}\nname: A\ndescription: d\ntools: []`);
    expect(() => parseAgentFile(file)).toThrow(AgentFileError);
  });

  it.each(['ab', 'ledger', 'credit-coach', 'a1', 'x'.repeat(20)])(
    'accepts the handle %s',
    (handle) => {
      const file = agentFile(`id: a\nhandle: ${handle}\nname: A\ndescription: d\ntools: []`);
      expect(parseAgentFile(file).frontmatter.handle).toBe(handle);
    },
  );

  /*
   * An agent's own opening: one sentence to the owner and up to three example
   * requests. Both are capped, because a "starter" that does not fit on a chip
   * is not an example request and an intro that runs to a paragraph is a
   * persona in the wrong field.
   */
  it('parses an intro and a block list of starters', () => {
    const file = agentFile(
      [
        'id: a',
        'handle: aa',
        'name: A',
        'description: d',
        'tools: []',
        'intro: I keep your calendar, and I say so when I cannot reach something.',
        'starters:',
        '  - "What is on today, and what moved?"',
        '  - Move my 3pm to tomorrow',
      ].join('\n'),
    );
    const { frontmatter } = parseAgentFile(file);
    expect(frontmatter.intro).toBe('I keep your calendar, and I say so when I cannot reach something.');
    // The comma survives: a starter is prose, so it is written as a block list
    // rather than a flow list that would split on it.
    expect(frontmatter.starters).toEqual(['What is on today, and what moved?', 'Move my 3pm to tomorrow']);
  });

  it('leaves both absent when the file says nothing', () => {
    const { frontmatter } = parseAgentFile(agentFile('id: a\nhandle: aa\nname: A\ndescription: d\ntools: []'));
    expect(frontmatter.intro).toBeUndefined();
    expect(frontmatter.starters).toBeUndefined();
  });

  it('refuses an intro longer than one sentence\'s worth', () => {
    const file = agentFile(`id: a\nhandle: aa\nname: A\ndescription: d\ntools: []\nintro: ${'x'.repeat(INTRO_MAX + 1)}`);
    expect(() => parseAgentFile(file)).toThrow(/intro must be at most/);
  });

  it('refuses a starter longer than a chip', () => {
    const file = agentFile(
      `id: a\nhandle: aa\nname: A\ndescription: d\ntools: []\nstarters:\n  - ${'x'.repeat(STARTER_MAX + 1)}`,
    );
    expect(() => parseAgentFile(file)).toThrow(/starter must be at most/);
  });

  it('refuses a fourth starter', () => {
    const file = agentFile(
      ['id: a', 'handle: aa', 'name: A', 'description: d', 'tools: []', 'starters:', '  - one', '  - two', '  - three', '  - four'].join('\n'),
    );
    expect(() => parseAgentFile(file)).toThrow(/at most 3 starters/);
  });

  it('refuses an empty persona body', () => {
    expect(() => parseAgentFile('---\nid: a\nhandle: aa\nname: A\ndescription: d\ntools: []\n---\n\n')).toThrow(
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
    const catalog = load(
      { 'finance-advisor': FINANCE, concierge: CONCIERGE },
      { ANTHROPIC_API_KEY: 'k' },
    );
    expect(catalog.list()).toEqual([
      {
        id: 'concierge',
        handle: 'buddi',
        name: 'Concierge',
        description: 'Front desk.',
        isDefault: false,
        roles: [],
        source: 'private',
        providerKind: 'anthropic',
        available: true,
      },
      {
        id: 'finance-advisor',
        handle: 'ledger',
        name: 'Finance Advisor',
        description: 'Money.',
        isDefault: true,
        roles: [],
        source: 'private',
        providerKind: 'anthropic',
        available: true,
      },
    ]);
  });

  it('resolves an agent by the role it declares, in declaration order', () => {
    const first = agentFile(
      [
        'id: alpha',
        'handle: alpha',
        'name: Alpha',
        'description: First.',
        'tools: []',
        'roles: [overview, recap]',
        'default: true',
      ].join('\n'),
      'You are alpha.',
    );
    const second = agentFile(
      [
        'id: beta',
        'handle: beta',
        'name: Beta',
        'description: Second.',
        'tools: []',
        'roles: [overview]',
      ].join('\n'),
      'You are beta.',
    );
    const catalog = load({ alpha: first, beta: second });
    expect(catalog.agentsWithRole('overview').map((a) => a.id)).toEqual(['alpha', 'beta']);
    const resolved = catalog.agentForRole('overview');
    expect(resolved.ok && resolved.agent.id).toBe('alpha');
    expect(catalog.get('alpha')?.roles).toEqual(['overview', 'recap']);
  });

  it('answers a role nobody claims with a typed problem naming the key', () => {
    const catalog = load({ concierge: CONCIERGE });
    const resolved = catalog.agentForRole('overview');
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.problem.code).toBe('no-agent-for-role');
    expect(resolved.problem.role).toBe('overview');
    expect(resolved.problem.message).toContain('roles: [overview]');
    expect(catalog.agentsWithRole('overview')).toEqual([]);
  });

  it('rejects a role that is not kebab-case', () => {
    const bad = agentFile(
      ['id: alpha', 'handle: alpha', 'name: A', 'description: d.', 'tools: []', 'roles: [Not Kebab]'].join('\n'),
      'You are alpha.',
    );
    expect(() => load({ alpha: bad })).toThrow(/kebab-case/);
  });

  it('resolves an id, and the default when none is given', () => {
    const catalog = load({ 'finance-advisor': FINANCE, concierge: CONCIERGE });
    expect(catalog.resolve('concierge').id).toBe('concierge');
    expect(catalog.resolve().id).toBe('finance-advisor');
    expect(catalog.defaultAgent().id).toBe('finance-advisor');
    expect(catalog.get('concierge')?.name).toBe('Concierge');
    expect(catalog.get('nope')).toBeUndefined();
  });

  it('resolves a handle, case-insensitively and with or without the @', () => {
    const catalog = load({ 'finance-advisor': FINANCE, concierge: CONCIERGE });
    for (const spelling of ['ledger', 'Ledger', 'LEDGER', '@ledger', ' @Ledger ']) {
      expect(catalog.resolve(spelling).id).toBe('finance-advisor');
    }
    expect(catalog.byHandle('BUDDI')?.id).toBe('concierge');
    expect(catalog.byHandle('@buddi')?.id).toBe('concierge');
    expect(catalog.byHandle('nobody')).toBeUndefined();
  });

  it('exposes the handle on the summary and on the agent', () => {
    const catalog = load({ 'finance-advisor': FINANCE, concierge: CONCIERGE });
    expect(catalog.list().map((a) => a.handle)).toEqual(['buddi', 'ledger']);
    expect(catalog.resolve('finance-advisor').handle).toBe('ledger');
  });

  it('refuses two agents answering to one handle', () => {
    const clash = CONCIERGE.replace('handle: buddi', 'handle: ledger');
    let caught: unknown;
    try {
      load({ 'finance-advisor': FINANCE, concierge: clash });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentCatalogError);
    expect((caught as AgentCatalogError).code).toBe('duplicate-handle');
    expect((caught as Error).message).toMatch(/concierge/);
  });

  it('tells each agent its own handle and lists its colleagues by handle', () => {
    const catalog = load({ 'finance-advisor': FINANCE, concierge: CONCIERGE });
    const prompt = catalog.resolve('finance-advisor').systemPromptTemplate;
    expect(prompt).toContain('Your handle is @ledger');
    expect(prompt).toContain('@buddi — Concierge: Front desk.');
    // Never itself: an agent is not its own colleague.
    expect(prompt).not.toContain('@ledger — Finance Advisor');
  });

  it('says so plainly when an agent is the only one installed', () => {
    const prompt = load({ concierge: CONCIERGE }).resolve('concierge').systemPromptTemplate;
    expect(prompt).toContain('Your handle is @buddi');
    expect(prompt).toContain('only agent installed');
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
    const bad = agentFile('id: mailer\nhandle: mail\nname: M\ndescription: d\ntools: [email.send]');
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
    const definition = agent.definition(new Date('2026-09-13T23:30:00Z'), 'UTC');
    expect(definition.id).toBe('finance-advisor');
    expect(definition.name).toBe('Finance Advisor');
    expect(definition.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(definition.tools).toEqual(agent.tools);
    expect(definition.systemPrompt).toContain('Today is 2026-09-13.');
    expect(definition.systemPrompt).not.toContain('{{today}}');
    expect(agent.systemPromptTemplate).toContain('{{today}}');
  });

  it('substitutes the owner day, not the UTC day', () => {
    const agent = load({ 'finance-advisor': FINANCE }).resolve('finance-advisor');
    // 00:30 UTC on the 14th: still the evening of the 13th in New York, and
    // already the 14th in Paris. The agent must be told the owner's day.
    const instant = new Date('2026-09-14T00:30:00Z');
    expect(agent.definition(instant, 'America/New_York').systemPrompt).toContain(
      'Today is 2026-09-13.',
    );
    expect(agent.definition(instant, 'Europe/Paris').systemPrompt).toContain(
      'Today is 2026-09-14.',
    );
  });

  it('defaults the zone to BUDDI_TZ from the env the catalog was loaded with', () => {
    const instant = new Date('2026-09-14T00:30:00Z');
    const paris = load({ 'finance-advisor': FINANCE }, { BUDDI_TZ: 'Europe/Paris' })
      .resolve('finance-advisor')
      .definition(instant);
    expect(paris.systemPrompt).toContain('Today is 2026-09-14.');
    // No BUDDI_TZ: New York, the same default the scheduler uses.
    const home = load({ 'finance-advisor': FINANCE })
      .resolve('finance-advisor')
      .definition(instant);
    expect(home.systemPrompt).toContain('Today is 2026-09-13.');
  });
});

describe('today injection', () => {
  it('renders the date in the zone it is given', () => {
    const instant = new Date('2026-09-14T00:30:00Z');
    expect(toDateString(instant, 'UTC')).toBe('2026-09-14');
    expect(toDateString(instant, 'America/New_York')).toBe('2026-09-13');
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


/* ------------------------------------------------------------------ *
 * A second provider: pinning, and one agent's missing key
 * ------------------------------------------------------------------ */

const SCOUT = agentFile(
  [
    'id: scout',
    'handle: scout',
    'name: Scout',
    'description: Second opinion.',
    'provider: openai',
    'model: gpt-5',
    'tools: []',
  ].join('\n'),
  'You are the scout.',
);

describe('a catalog with agents on two providers', () => {
  const load = (files: Record<string, string>, env: NodeJS.ProcessEnv = {}) =>
    loadAgentCatalog({ dir: catalogDir(files), registry: registryOf(), env });

  const files = { 'finance-advisor': FINANCE, concierge: CONCIERGE, scout: SCOUT };

  it('pins each agent to its own provider and credential', () => {
    const catalog = load(files, { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' });
    const scout = catalog.resolve('scout');
    expect(scout.provider.kind).toBe('openai');
    expect(scout.provider.credential).toEqual({ kind: 'api-key', env: 'OPENAI_API_KEY' });
    expect(scout.model).toBe('gpt-5');
    expect(catalog.resolve('concierge').provider.kind).toBe('anthropic');
  });

  it('never lets an Anthropic subscription token or BUDDI_MODEL leak to the openai agent', () => {
    const catalog = load(files, {
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01',
      BUDDI_MODEL: 'claude-opus-4-1',
      OPENAI_API_KEY: 'o',
    });
    const scout = catalog.resolve('scout');
    expect(scout.provider.credential.kind).toBe('api-key');
    expect(scout.provider.credential.env).toBe('OPENAI_API_KEY');
    expect(scout.model).toBe('gpt-5');
    // The Anthropic agents still take the token and the env model.
    expect(catalog.resolve('concierge').provider.credential.kind).toBe('subscription-token');
    expect(catalog.resolve('concierge').model).toBe('claude-opus-4-1');
  });

  it('loads every other agent when one agent\'s credential is missing', () => {
    // No OPENAI_API_KEY: exactly the machine this ships on.
    const catalog = load(files, { ANTHROPIC_API_KEY: 'k' });
    expect(catalog.list().map((a) => a.id)).toEqual(['concierge', 'finance-advisor', 'scout']);
    expect(catalog.defaultAgent().id).toBe('finance-advisor');

    const scout = catalog.resolve('scout');
    expect(scout.availability.ok).toBe(false);
    if (scout.availability.ok) return;
    expect(scout.availability.problem.code).toBe('missing-credential');
    expect(scout.availability.problem.message).toContain('OPENAI_API_KEY');

    const summary = catalog.list().find((a) => a.id === 'scout');
    expect(summary?.available).toBe(false);
    expect(summary?.unavailableReason).toContain('OPENAI_API_KEY');
    // Every other agent is untouched: one missing key never takes the
    // installation down.
    for (const other of catalog.list().filter((a) => a.id !== 'scout')) {
      expect(other.available).toBe(true);
    }
  });

  it('never holds the secret itself, only whether one was reachable', () => {
    const catalog = load(files, { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o-secret' });
    expect(JSON.stringify(catalog.resolve('scout').availability)).not.toContain('o-secret');
  });
});

describe('the model catalogue in an agent file', () => {
  const load = (files: Record<string, string>, env: NodeJS.ProcessEnv = {}) =>
    loadAgentCatalog({ dir: catalogDir(files), registry: registryOf(), env });

  it('refuses a model that belongs to another provider', () => {
    const crossed = SCOUT.replace('model: gpt-5', 'model: claude-sonnet-5');
    expect(() => load({ scout: crossed })).toThrow(AgentCatalogError);
    expect(() => load({ scout: crossed })).toThrow(/anthropic/);
  });

  it('refuses a model no catalogue claims, rather than trying it', () => {
    const unknown = SCOUT.replace('model: gpt-5', 'model: llama-3-70b');
    expect(() => load({ scout: unknown })).toThrow(/not in the openai catalogue/);
  });

  it('refuses an unknown provider name', () => {
    const bogus = SCOUT.replace('provider: openai', 'provider: mistral');
    expect(() => load({ scout: bogus })).toThrow(AgentCatalogError);
  });
});


describe('providerFromEnv', () => {
  it('reads the anthropic credential from what the owner has', () => {
    expect(providerFromEnv({ ANTHROPIC_API_KEY: 'k' }).credential).toEqual({
      kind: 'api-key',
      env: 'ANTHROPIC_API_KEY',
    });
    expect(providerFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 't' }).credential).toEqual({
      kind: 'subscription-token',
      env: 'CLAUDE_CODE_OAUTH_TOKEN',
    });
  });

  it('gives openai one credential kind and discovers nothing', () => {
    const ref = providerFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 't' }, undefined, 'openai');
    expect(ref.kind).toBe('openai');
    expect(ref.credential).toEqual({ kind: 'api-key', env: 'OPENAI_API_KEY' });
    expect(ref.model).toBe(DEFAULT_OPENAI_MODEL);
  });

  it('keeps each providers default model separate', () => {
    expect(providerFromEnv({}).model).toBe(DEFAULT_MODEL);
    expect(providerFromEnv({ BUDDI_MODEL: 'claude-opus-4-1' }, undefined, 'openai').model).toBe(
      DEFAULT_OPENAI_MODEL,
    );
    expect(providerFromEnv({ BUDDI_OPENAI_MODEL: 'gpt-5-mini' }, undefined, 'openai').model).toBe(
      'gpt-5-mini',
    );
  });
});
