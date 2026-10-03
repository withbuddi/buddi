import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rememberOwnerTimezone } from '../time.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../registry.js';
import type { PluginManifest } from '../tools.js';
import {
  AgentCatalogError,
  DEFAULT_MAX_TURNS,
  selectSkills,
  generatedSection,
  heldBackMessage,
  MAX_LISTED_COLLEAGUES,
  type AgentRosterEntry,
  type CatalogAgent,
  injectToday,
  loadAgentCatalog,
  setCatalogNoticeLog,
  resolveToolGrants,
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
import type { AgentFrontmatter } from './frontmatter.js';

/**
 * The gateway's account service, reduced to what the catalog asks: every
 * Anthropic agent has a working model account (Anthropic reads nothing from
 * the environment any more); an OpenAI agent falls through to its env key.
 */
const anthropicAccount = (env: NodeJS.ProcessEnv) =>
  ((agent: AgentFrontmatter) =>
    agent.provider === 'openai'
      ? undefined
      : { provider: providerFromEnv(env, agent.model), availability: { ok: true as const } }) as NonNullable<
    Parameters<typeof loadAgentCatalog>[0]['providerSelection']
  >;

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

  it('refuses an id the installation already means something by', () => {
    // `owner` is the agent id a write from a plugin page is recorded under,
    // and the one `ownerOnly` checks; `room` is a group's own voice. An agent
    // called either would make the ledger ambiguous about who did something.
    for (const reserved of ['owner', 'room']) {
      const file = agentFile(`id: ${reserved}\nhandle: ${reserved}x\nname: X\ndescription: d\ntools: []`);
      expect(() => parseAgentFile(file, { dirName: reserved, file: `/agents/${reserved}/agent.md` })).toThrow(
        /is reserved/,
      );
    }
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
    // The strict form: a proposed grant is refused whatever the reason,
    // including a plugin that is simply not installed yet.
    expect(() => resolveToolNames(['email.send'], registry, 'a')).toThrow(AgentCatalogError);
    expect(() => resolveToolNames(['email.*'], registry, 'a')).toThrow(/matches no registered tool/);
  });
});

describe('resolveToolGrants', () => {
  const registry = registryOf();

  it('separates a missing plugin from a grant that can never resolve', () => {
    expect(resolveToolGrants(['email.*', 'notes.search'], registry, 'a')).toEqual({
      tools: ['notes.search'],
      missingFamilies: ['email'],
      disabledFamilies: [],
    });
    // The family is here; the name is not. No install would fix that.
    expect(() => resolveToolGrants(['finance.wire_money'], registry, 'a')).toThrow(
      /matches no registered tool/,
    );
    // Not family-shaped at all.
    expect(() => resolveToolGrants(['send_mail'], registry, 'a')).toThrow(AgentCatalogError);
  });

  it('reports each missing family once, in declaration order', () => {
    expect(
      resolveToolGrants(['mail.*', 'email.read', 'email.*', 'mail.send'], registry, 'a').missingFamilies,
    ).toEqual(['mail', 'email']);
  });
});

describe('optional grants', () => {
  const registry = registryOf();

  it('skips a family nothing provides when the grant ends in ?', () => {
    expect(resolveToolGrants(['notes.*', 'weather.*?', 'calendar.today?'], registry, 'a')).toEqual({
      tools: ['notes.search'],
      missingFamilies: [],
      disabledFamilies: [],
    });
    // The strict form, a proposed grant, accepts it too: nothing is claimed that is not here.
    expect(resolveToolNames(['notes.search', 'weather.*?'], registry, 'a')).toEqual(['notes.search']);
    // A connection namespace that is not connected right now, likewise.
    expect(resolveToolGrants(['mcp.github.*?'], registry, 'a').missingFamilies).toEqual([]);
  });

  it('resolves like any grant once the family is here', () => {
    expect(resolveToolGrants(['finance.*?'], registry, 'a').tools).toEqual([
      'finance.list_accounts',
      'finance.project_cashflow',
    ]);
    expect(resolveToolGrants(['finance.list_accounts?'], registry, 'a').tools).toEqual(['finance.list_accounts']);
  });

  it('still refuses a tool that does not exist in a family that is loaded', () => {
    expect(() => resolveToolGrants(['finance.wire_money?'], registry, 'a')).toThrow(/matches no registered tool/);
  });

  it('reads only the last ? as the marker; any other ? is the one-character wildcard', () => {
    expect(resolveToolGrants(['notes.sea?ch'], registry, 'a').tools).toEqual(['notes.search']);
    expect(resolveToolGrants(['notes.searc??'], registry, 'a').tools).toEqual(['notes.search']);
    // `notes.searc?` is the optional grant of `notes.searc`, which does not exist in a loaded family.
    expect(() => resolveToolGrants(['notes.searc?'], registry, 'a')).toThrow(/matches no registered tool/);
  });

  it('loads an agent file whose optional family is missing, with the rest of its grant', () => {
    const dir = catalogDir({
      planner: agentFile('id: planner\nhandle: planner\nname: Planner\ndescription: Keeps the day.\ntools: [notes.*, weather.*?, calendar.*?]'),
    });
    const planner = loadAgentCatalog({ dir, registry, env: {}, providerSelection: anthropicAccount({}) }).resolve('planner');
    expect(planner.heldBack).toBeUndefined();
    expect(planner.tools).toEqual(['notes.search']);
    expect(planner.available).toBe(true);
  });
});

describe('grants to a disabled plugin', () => {
  const registry = registryOf();

  it('skips the family instead of holding the agent back, and names it', () => {
    expect(resolveToolGrants(['notes.*', 'weather.*', 'weather.today'], registry, 'a', new Set(['weather']))).toEqual({
      tools: ['notes.search'],
      missingFamilies: [],
      disabledFamilies: ['weather'],
    });
    // A family that is simply not installed still holds the agent back.
    expect(resolveToolGrants(['mail.*'], registry, 'a', new Set(['weather'])).missingFamilies).toEqual(['mail']);
  });

  it('loads the agent with the rest of its grant, and says so on its summary and in its prompt', () => {
    const dir = catalogDir({
      planner: agentFile('id: planner\nhandle: planner\nname: Planner\ndescription: Keeps the day.\ntools: [notes.*, weather.*]'),
    });
    const catalog = loadAgentCatalog({ dir, registry, env: {}, providerSelection: anthropicAccount({}), disabledPlugins: ['weather'] });
    const planner = catalog.resolve('planner');
    expect(planner.heldBack).toBeUndefined();
    expect(planner.available).toBe(true);
    expect(planner.tools).toEqual(['notes.search']);
    expect(planner.disabledPlugins).toEqual(['weather']);
    expect(catalog.list().find((a) => a.id === 'planner')?.disabledPlugins).toEqual(['weather']);
    expect(planner.systemPromptTemplate).toContain('- weather is disabled, so its tools are out.');
  });
});

describe('loadAgentCatalog', () => {
  const load = (files: Record<string, string>, env: NodeJS.ProcessEnv = {}, accounts = false) =>
    loadAgentCatalog({ dir: catalogDir(files), registry: registryOf(), env, ...(accounts ? { providerSelection: anthropicAccount(env) } : {}) });

  it('lists every agent with its summary', () => {
    const catalog = load(
      { 'finance-advisor': FINANCE, concierge: CONCIERGE },
      {},
      true,
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

  /*
   * Two files claiming the default used to take the whole installation down.
   * It is a *disagreement*, and the record settles it — so the catalog loads,
   * somebody answers, and the dashboard is told what to offer a fix for.
   */
  it('loads when two files claim the default, and says so', () => {
    const second = CONCIERGE.replace('tools: []', 'tools: []\ndefault: true');
    const catalog = load({ 'finance-advisor': FINANCE, concierge: second }, {}, true);
    expect(catalog.list()).toHaveLength(2);
    expect(catalog.defaultProblem).toMatchObject({
      code: 'multiple-defaults',
      agents: ['concierge', 'finance-advisor'],
    });
    // Nobody wins on the file flag, so the first runnable agent answers.
    expect(catalog.defaultAgent().id).toBe('concierge');
    expect(catalog.list().filter((a) => a.isDefault).map((a) => a.id)).toEqual(['concierge']);
  });

  it('refuses an agent file whose id is not its directory', () => {
    expect(() => load({ money: FINANCE })).toThrow(AgentCatalogError);
  });

  it('refuses an agent granting a tool inside a family that IS installed', () => {
    // `finance` is registered here, so `finance.wire_money` is not a missing
    // plugin: it is a name that will never exist, whatever the owner installs.
    const bad = agentFile('id: mailer\nhandle: mail\nname: M\ndescription: d\ntools: [finance.wire_money]');
    expect(() => load({ mailer: bad })).toThrow(/matches no registered tool/);
  });

  it('refuses a grant no install could ever satisfy', () => {
    for (const grant of ['send_mail', 'finance', 'fin*.send']) {
      const bad = agentFile(`id: mailer\nhandle: mail\nname: M\ndescription: d\ntools: [${grant}]`);
      expect(() => load({ mailer: bad }), grant).toThrow(AgentCatalogError);
    }
  });

  /*
   * A family no plugin here provides is a *missing plugin*, not a broken file.
   * `email.*` is exactly right the moment the email plugin is installed, so the
   * agent is held back — listed, toolless, unrunnable, with the sentence — and
   * every other agent loads. One uninstalled plugin never takes the
   * installation down (docs/install.md §7).
   */
  describe('an agent granting a family nothing provides', () => {
    const MAILER = agentFile(
      'id: mailer\nhandle: mail\nname: Mailer\ndescription: Reads the post.\ntools: [email.*, notes.search]',
    );

    it('is held back rather than failing the whole catalog', () => {
      const catalog = load({ mailer: MAILER, 'finance-advisor': FINANCE }, {}, true);
      expect(catalog.list().map((a) => a.id).sort()).toEqual(['finance-advisor', 'mailer']);
      // Every other agent is untouched: tools, availability, the lot.
      const advisor = catalog.resolve('finance-advisor');
      expect(advisor.heldBack).toBeUndefined();
      expect(advisor.tools.length).toBeGreaterThan(0);
      expect(advisor.availability.ok).toBe(true);
    });

    it('holds no tools at all — not even the half that resolved', () => {
      const mailer = load({ mailer: MAILER }).resolve('mailer');
      expect(mailer.tools).toEqual([]);
      expect(mailer.definition(new Date()).tools).toEqual([]);
      expect(mailer.heldBack).toEqual({
        reason: 'missing-plugin',
        families: ['email'],
        message: 'Needs a plugin providing the email tools.',
      });
    });

    it('cannot run, and says why in the same field every other refusal uses', () => {
      const mailer = load({ mailer: MAILER }, {}, true).resolve('mailer');
      expect(mailer.available).toBe(false);
      expect(mailer.availability.ok).toBe(false);
      expect(mailer.availability.ok ? '' : mailer.availability.problem.code).toBe('missing-plugin');
      expect(mailer.unavailableReason).toBe('Needs a plugin providing the email tools.');
    });

    it('does not fail to start over an agent that predates the reserved ids', () => {
      /*
       * `owner` and `room` were reserved after some installations already had
       * agents. Such a file must not stop the boot: it is said out loud, and
       * it appears held back — with nothing granted and no way to be run.
       */
      const warned: string[] = [];
      const file = agentFile('id: owner\nhandle: ownerly\nname: Owner\ndescription: An old agent.\ntools: []');
      const catalog = loadAgentCatalog({
        dir: catalogDir({ owner: file, concierge: CONCIERGE }),
        registry: registryOf(),
        env: {}, providerSelection: anthropicAccount({}),
        log: (line) => warned.push(line),
      });
      expect(warned.some((line) => line.includes('/owner/agent.md') && line.includes('is reserved'))).toBe(true);
      const held = (catalog.refused?.() ?? [])[0] as CatalogAgent;
      expect(held.heldBack?.reason).toBe('reserved-id');
      expect(held.available).toBe(false);
      expect(held.tools).toEqual([]);
      expect(held.availability.ok ? '' : held.availability.problem.code).toBe('reserved-id');
      // And the installation still has the agents it can run.
      expect(catalog.list().map((a) => a.id)).toContain('concierge');
    });

    it('keeps a refused file out of the roster, the handles and the default', () => {
      const file = agentFile('id: owner\nhandle: ownerly\nname: Owner\ndescription: An old agent.\ntools: []');
      const catalog = loadAgentCatalog({
        dir: catalogDir({ owner: file, concierge: CONCIERGE }),
        registry: registryOf(),
        env: {}, providerSelection: anthropicAccount({}),
        // Even recorded as the default, it cannot be it: it is not an agent.
        defaultAgentId: 'owner',
        log: () => {},
      });
      expect(catalog.list().map((a) => a.id)).toEqual(['concierge']);
      expect(catalog.get('owner')).toBeUndefined();
      expect(catalog.byHandle('ownerly')).toBeUndefined();
      expect(() => catalog.resolve('@ownerly')).toThrow();
      expect(catalog.defaultAgent().id).toBe('concierge');
      expect(catalog.agentsWithRole('overview').map((a) => a.id)).not.toContain('owner');
      // It exists in exactly one place: the list the Agents page reads.
      const refused = catalog.refused?.() ?? [];
      expect(refused.map((a) => a.id)).toEqual(['owner']);
      expect(refused[0]?.heldBack?.reason).toBe('reserved-id');
      expect(refused[0]?.tools).toEqual([]);
    });

    it('lets a real agent answer to a handle a refused file also invented', () => {
      /*
       * The stub's handle is made up from its directory, so it must take part
       * in nothing — including the duplicate-handle check, which would
       * otherwise refuse a perfectly good agent because of a file that was
       * never loaded.
       */
      const refused = agentFile('id: owner\nhandle: owner\nname: Owner\ndescription: Old.\ntools: []');
      const real = agentFile('id: front-desk\nhandle: owner\nname: Desk\ndescription: The desk.\ntools: []');
      const catalog = loadAgentCatalog({
        dir: catalogDir({ owner: refused, 'front-desk': real }),
        registry: registryOf(),
        env: {}, providerSelection: anthropicAccount({}),
        log: () => {},
      });
      expect(catalog.byHandle('owner')?.id).toBe('front-desk');
    });

    it('names the plugin when the installation knows which one provides the family', () => {
      const catalog = loadAgentCatalog({
        dir: catalogDir({ mailer: MAILER }),
        registry: registryOf(),
        env: {},
        pluginForFamily: (family) => (family === 'email' ? 'email' : undefined),
      });
      expect(catalog.resolve('mailer').heldBack?.message).toBe('Needs the email plugin.');
    });

    it('carries the sentence into the summary list the rosters read', () => {
      const summary = load({ mailer: MAILER }).list().find((a) => a.id === 'mailer');
      expect(summary?.available).toBe(false);
      expect(summary?.heldBack?.families).toEqual(['email']);
      expect(summary?.unavailableReason).toBe(summary?.heldBack?.message);
    });
  });

  it('lands on the first runnable agent when no file claims the default', () => {
    const catalog = load({ concierge: CONCIERGE }, {}, true);
    expect(catalog.list()).toHaveLength(1);
    expect(catalog.defaultAgent().id).toBe('concierge');
    expect(catalog.defaultProblem).toMatchObject({ code: 'no-default-agent', agents: [] });
  });

  /*
   * The resolution order, which is the whole of this change: the record the
   * installation holds, then the single file flag, then whoever can answer.
   */
  describe('the recorded default', () => {
    const recorded = (defaultAgentId: string, files: Record<string, string>) =>
      loadAgentCatalog({
        dir: catalogDir(files),
        registry: registryOf(),
        env: {}, providerSelection: anthropicAccount({}),
        defaultAgentId,
      });

    it('wins over a file that declares default: true', () => {
      const catalog = recorded('concierge', { 'finance-advisor': FINANCE, concierge: CONCIERGE });
      expect(catalog.defaultAgent().id).toBe('concierge');
      // The file that lost the claim must stop saying it has it.
      expect(catalog.list().find((a) => a.id === 'finance-advisor')?.isDefault).toBe(false);
      expect(catalog.defaultProblem).toBeUndefined();
    });

    it('takes a handle as well as an id', () => {
      expect(recorded('@buddi', { 'finance-advisor': FINANCE, concierge: CONCIERGE }).defaultAgent().id)
        .toBe('concierge');
    });

    it('is ignored when it names nobody, and the file flag decides', () => {
      const catalog = recorded('ghost', { 'finance-advisor': FINANCE, concierge: CONCIERGE });
      expect(catalog.defaultAgent().id).toBe('finance-advisor');
    });

    it('is ignored when the agent it names cannot run and another one can', () => {
      // Held back: it grants a family no plugin here provides, so it can never
      // take a turn — and the record must not send every chat at it.
      const ghost = agentFile(
        ['id: ghost', 'handle: ghost', 'name: Ghost', 'description: d', 'tools: [ghost.*]'].join('\n'),
      );
      const catalog = recorded('ghost', { 'finance-advisor': FINANCE, ghost });
      expect(catalog.get('ghost')?.available).toBe(false);
      expect(catalog.defaultAgent().id).toBe('finance-advisor');
    });

    it('keeps the choice when nobody can run: there is nothing better to fall back to', () => {
      const catalog = loadAgentCatalog({
        dir: catalogDir({ 'finance-advisor': FINANCE, concierge: CONCIERGE }),
        registry: registryOf(),
        env: {}, // no credential: every agent is unavailable
        defaultAgentId: 'concierge',
      });
      expect(catalog.defaultAgent().id).toBe('concierge');
    });

    it('settles a tree whose files claim it twice', () => {
      const second = CONCIERGE.replace('tools: []', 'tools: []\ndefault: true');
      const catalog = recorded('finance-advisor', { 'finance-advisor': FINANCE, concierge: second });
      expect(catalog.defaultAgent().id).toBe('finance-advisor');
      // Still reported: the owner's files disagree, and the picker says so.
      expect(catalog.defaultProblem?.code).toBe('multiple-defaults');
    });

    it('silences "nobody claims it" once the installation has answered', () => {
      const catalog = recorded('concierge', { concierge: CONCIERGE });
      expect(catalog.defaultAgent().id).toBe('concierge');
      expect(catalog.defaultProblem).toBeUndefined();
    });
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

  /*
   * The budget is a number an owner lives with, not an implementation detail:
   * twelve steps ran out in the middle of a browser task, and the run went
   * quiet. Pinned here so raising or lowering it is a deliberate edit.
   */
  it('gives an agent that pins nothing a budget of 40 steps', () => {
    expect(DEFAULT_MAX_TURNS).toBe(40);
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

  it('reads no Anthropic credential from the environment: an agent needs a model account', () => {
    const agent = load({ concierge: CONCIERGE }, { SOME_TOKEN: 't' }).resolve('concierge');
    expect(agent.provider.credential).toEqual({ kind: 'api-key', env: '' });
    expect(agent.availability).toMatchObject({ ok: false, problem: { code: 'missing-credential' } });
    expect(agent.unavailableReason).toMatch(/model account/);
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

  it('takes the profile zone over BUDDI_TZ, read when the definition is asked for', () => {
    const instant = new Date('2026-09-14T00:30:00Z');
    const agent = load({ 'finance-advisor': FINANCE }, { BUDDI_TZ: 'America/New_York' }).resolve('finance-advisor');
    try {
      expect(agent.definition(instant).systemPrompt).toContain('Today is 2026-09-13.');
      // Settings → Profile moved the owner to Lisbon after the catalog was loaded.
      rememberOwnerTimezone('Europe/Lisbon');
      expect(agent.definition(instant).systemPrompt).toContain('Today is 2026-09-14.');
    } finally {
      rememberOwnerTimezone(null);
    }
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
  const colleague = (n: number, over: Partial<AgentRosterEntry> = {}): AgentRosterEntry => ({
    id: `agent-${n}`, handle: `a${n}`, name: `Agent ${n}`, description: `Does ${n} things`, ...over,
  });

  it('states the language rule for each supported value', () => {
    expect(generatedSection([], 'mirror')).toContain('Never switch language on your own.');
    expect(generatedSection([], 'en')).toContain('Always reply in English');
    expect(generatedSection([], 'fr')).toContain('Réponds toujours en français');
  });

  /*
   * A handle is what the owner reads; an id is what the tool takes. The old
   * sentence said "never by its id", which contradicted the delegate list
   * printed four lines below it.
   */
  it('separates what the owner is told from what the tool is passed', () => {
    const section = generatedSection(['agent.delegate'], 'en', {
      handle: 'asker', colleagues: [colleague(1)], delegates: [colleague(1)],
    });
    expect(section).toContain('When naming an agent to the owner, use its handle; pass ids only to agent.delegate.');
    expect(section).not.toContain('never by its id');
  });

  it('names two dozen colleagues and counts the rest', () => {
    const many = Array.from({ length: MAX_LISTED_COLLEAGUES + 7 }, (_, i) => colleague(i));
    const section = generatedSection(['agent.delegate'], 'en', {
      handle: 'asker', colleagues: many, delegates: many,
    });
    expect(section).toContain('@a0 — Agent 0');
    expect(section).not.toContain('@a24 — Agent 24');
    expect(section.match(/…and 7 more\./g)).toHaveLength(2);
  });

  it('says which colleagues this installation cannot run', () => {
    const section = generatedSection(['agent.delegate'], 'en', {
      handle: 'asker',
      colleagues: [colleague(1, { available: false }), colleague(2)],
      delegates: [colleague(1, { available: false })],
    });
    expect(section).toContain('@a1 — Agent 1: Does 1 things (not available now)');
    expect(section).toContain('`agent-1` (@a1) — Agent 1: Does 1 things (not available now)');
    expect(section).not.toContain('Agent 2: Does 2 things (not available now)');
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

  it("lets an agent's own skill shadow a shared one of the same name, for that agent only", () => {
    const lines: string[] = [];
    const own = skillFile(['name: verdicts', 'description: Mine.', 'provenance: owner'].join('\n'), 'Mine, not the house one.');
    const dir = catalogDir({ 'finance-advisor': FINANCE, concierge: CONCIERGE }, { shared: { verdicts: VERDICTS }, skills: { 'finance-advisor': { verdicts: own } } });
    const open = () => loadAgentCatalog({ dir, registry: registryOf(), env: {}, log: (line) => lines.push(line) });
    const catalog = open();
    const mine = catalog.get('finance-advisor')!.skills.filter((s) => s.name === 'verdicts');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.file).toContain(path.join('finance-advisor', 'skills'));
    const theirs = catalog.get('concierge')!.skills.filter((s) => s.name === 'verdicts');
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.file).not.toContain(path.join('finance-advisor', 'skills'));
    expect(lines.filter((l) => /shadows the shared one/.test(l))).toHaveLength(1);
    open();
    expect(lines.filter((l) => /shadows the shared one/.test(l))).toHaveLength(1);
  });

  it('sends the shadowing notice to the notice channel when the loader has no log, not to the console', () => {
    const own = skillFile(['name: verdicts', 'description: Mine.', 'provenance: owner'].join('\n'), 'Mine.');
    const dir = catalogDir({ 'finance-advisor': FINANCE }, { shared: { verdicts: VERDICTS }, skills: { 'finance-advisor': { verdicts: own } } });
    const notices: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setCatalogNoticeLog((line) => notices.push(line));
    try {
      loadAgentCatalog({ dir, registry: registryOf(), env: {} });
    } finally {
      setCatalogNoticeLog(undefined);
      warn.mockRestore();
    }
    expect(notices.filter((l) => /shadows the shared one/.test(l))).toHaveLength(1);
    expect(warn.mock.calls.flat().filter((l) => /shadows the shared one/.test(String(l)))).toHaveLength(0);
  });
});

describe('selectSkills', () => {
  const shared = (name: string, agents?: string[]) =>
    parseSkillFile(
      `---\nname: ${name}\ndescription: d${agents ? `\nagents: [${agents.join(', ')}]` : ''}\n---\n\nbody\n`,
      { scope: 'shared' },
    );

  it('takes its own skill for a name it declares and owns, the shared one left out', () => {
    const own = parseSkillFile('---\nname: answering-with-sources\ndescription: mine\n---\n\nmine\n', { scope: 'private' });
    const picked = selectSkills('b', ['answering-with-sources'], [own], [shared('answering-with-sources', [])]);
    expect(picked).toEqual([own]);
  });

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
  it('loads an on-request skill (`agents: []`) only for an agent that names it, and still refuses one filtered to others', () => {
    expect(selectSkills('a', [], [], [shared('house', [])])).toEqual([]);
    expect(selectSkills('a', ['house'], [], [shared('house', [])]).map((s) => s.name)).toEqual(['house']);
    expect(() => selectSkills('a', ['house'], [], [shared('house', ['b'])])).toThrow(/lists agents b and not this one/);
  });

  it("loads another agent's own skill by its qualified name, and skips one that is gone", () => {
    const own = parseSkillFile('---\nname: compare\ndescription: d\n---\n\nRead three.\n');
    const lines: string[] = [];
    const chosen = selectSkills('a', ['b/compare', 'b/missing', 'c/compare'], [], [], (id) => (id === 'b' || id === 'c' ? [own] : undefined), (l) => lines.push(l));
    expect(chosen.map((s) => s.name)).toEqual(['compare']);
    expect(lines.join('\n')).toMatch(/b\/missing", which is no longer there/);
    expect(lines.join('\n')).toMatch(/already has a skill called "compare"/);
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
  const load = (files: Record<string, string>, env: NodeJS.ProcessEnv = {}, accounts = false) =>
    loadAgentCatalog({ dir: catalogDir(files), registry: registryOf(), env, ...(accounts ? { providerSelection: anthropicAccount(env) } : {}) });

  const files = { 'finance-advisor': FINANCE, concierge: CONCIERGE, scout: SCOUT };

  it('pins each agent to its own provider and credential', () => {
    const catalog = load(files, { OPENAI_API_KEY: 'o' }, true);
    const scout = catalog.resolve('scout');
    expect(scout.provider.kind).toBe('openai');
    expect(scout.provider.credential).toEqual({ kind: 'api-key', env: 'OPENAI_API_KEY' });
    expect(scout.model).toBe('gpt-5');
    expect(catalog.resolve('concierge').provider.kind).toBe('anthropic');
  });

  it('never lets BUDDI_MODEL leak to the openai agent', () => {
    const catalog = load(files, {
      BUDDI_MODEL: 'claude-opus-4-1',
      OPENAI_API_KEY: 'o',
    }, true);
    const scout = catalog.resolve('scout');
    expect(scout.provider.credential.kind).toBe('api-key');
    expect(scout.provider.credential.env).toBe('OPENAI_API_KEY');
    expect(scout.model).toBe('gpt-5');
    // The Anthropic agents still take the env model.
    expect(catalog.resolve('concierge').model).toBe('claude-opus-4-1');
  });

  it('loads every other agent when one agent\'s credential is missing', () => {
    // No OPENAI_API_KEY: exactly the machine this ships on.
    const catalog = load(files, {}, true);
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
    const catalog = load(files, { OPENAI_API_KEY: 'o-secret' }, true);
    expect(JSON.stringify(catalog.resolve('scout').availability)).not.toContain('o-secret');
  });
});

describe('the model catalogue in an agent file', () => {
  const load = (files: Record<string, string>, env: NodeJS.ProcessEnv = {}, accounts = false) =>
    loadAgentCatalog({ dir: catalogDir(files), registry: registryOf(), env, ...(accounts ? { providerSelection: anthropicAccount(env) } : {}) });

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
  it('names no anthropic variable, whatever the environment holds', () => {
    expect(providerFromEnv({ SOME_KEY: 'k', SOME_TOKEN: 't' }).credential).toEqual({
      kind: 'api-key',
      env: '',
    });
  });

  it('gives openai one credential kind and discovers nothing', () => {
    const ref = providerFromEnv({ SOME_TOKEN: 't' }, undefined, 'openai');
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

describe('tools registered while buddi runs', () => {
  it('a glob grant picks up runtime tools on the next load, and drops removed ones', () => {
    const registry = registryOf();
    let host: import('../host/types.js').RegisterHost | undefined;
    registry.register({ ...fakeManifest([], 'mcp'), register: (h) => { host = h; } });
    const dir = catalogDir({
      concierge: CONCIERGE,
      'github-helper': agentFile(['id: github-helper', 'handle: gh', 'name: GitHub Helper', 'description: Repos.', 'tools: [notes.search, mcp.github.*]'].join('\n')),
    });
    const load = () => loadAgentCatalog({ dir, registry, env: {}, providerSelection: anthropicAccount({}) });
    // Nothing of `mcp` is registered yet: held back as a missing family, not an error.
    expect(load().get('github-helper')?.heldBack?.families).toEqual(['mcp']);
    const tool = (name: string) => ({ name, description: name, tier: 'auto' as const, inputSchema: { type: 'object' }, execute: async () => ({}) });
    host!.tools.register([tool('mcp.github.search'), tool('mcp.github.create_issue'), tool('mcp.linear.search')]);
    expect(load().get('github-helper')?.tools).toEqual(['notes.search', 'mcp.github.search', 'mcp.github.create_issue']);
    host!.tools.unregister(['mcp.github.create_issue']);
    expect(load().get('github-helper')?.tools).toEqual(['notes.search', 'mcp.github.search']);
    // GitHub disconnected, Linear still there: held back, not a broken catalog.
    host!.tools.unregister(['mcp.github.search']);
    expect(load().get('github-helper')?.heldBack?.families).toEqual(['mcp.github']);
    expect(load().get('github-helper')?.heldBack?.message).toBe(
      'The github connection is gone or has no tools; reconnect it in Settings → Connections.',
    );
    expect(heldBackMessage(['finance', 'mcp.notion'])).toBe(
      'Needs a plugin providing the finance tools. The notion connection is gone or has no tools; reconnect it in Settings → Connections.',
    );
    expect(() => resolveToolNames(['mcp.github.*'], registry, 'x')).toThrow(/"mcp\.github\.\*"/);
  });
});

describe('the front desk and owner.notify', () => {
  const desk = agentFile('id: desk\nhandle: desk\nname: Desk\ndescription: The desk.\nroles: [front-desk]\ntools: [notes.search]');
  const other = agentFile('id: helper\nhandle: helper\nname: Helper\ndescription: Helps.\ntools: [notes.search]');
  const load = (names: string[]) => loadAgentCatalog({
    dir: catalogDir({ desk, helper: other }),
    registry: registryOf(names),
    env: {}, providerSelection: anthropicAccount({}),
    log: () => {},
  });

  it('holds it without a line in its file, while any other agent needs the grant', () => {
    const catalog = load(['notes.search', 'owner.notify']);
    expect(catalog.get('desk')?.tools).toContain('owner.notify');
    expect(catalog.get('helper')?.tools).not.toContain('owner.notify');
  });

  it('loads unchanged on an installation without the tool', () => {
    const catalog = load(['notes.search']);
    expect(catalog.get('desk')?.tools).toEqual(['notes.search']);
    expect(catalog.get('desk')?.heldBack).toBeUndefined();
  });
});
