/**
 * The `owner.*` tools, against a temporary agent file and a stub database.
 *
 * The interesting one is `rename_me`: it is the only tool in the installation
 * that rewrites the configuration it is itself running under, so what it
 * *refuses* matters more than what it does.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry, type Queryable, type ToolContext } from '@buddi/core';
import { EXAMPLES_AGENTS_DIR } from './catalog.js';
import {
  EXAMPLES_TREE_REFUSAL,
  bindOwnerTools,
  createOwnerManifest,
  handleShapeProblem,
  insideExamples,
} from './owner-tools.js';
import type { AgentCatalog, CatalogAgent } from '../telegram/types.js';

/* ---------------- a database that remembers almost nothing ---------------- */

class StubDb implements Queryable {
  profile: Record<string, unknown> = {
    preferred_name: null,
    timezone: null,
    language: null,
    display_name: null,
  };
  steps: string[] = [];
  state = 'in-progress';

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('select preferred_name')) return { rows: [this.profile] };
    if (text.startsWith('update core.owner')) {
      const [, setName, name, setTz, tz, setLang, lang] = params;
      if (setName) this.profile.preferred_name = name;
      if (setTz) this.profile.timezone = tz;
      if (setLang) this.profile.language = lang;
      return { rows: [this.profile] };
    }
    if (text.startsWith('insert into core.owner')) return { rows: [{ id: 'owner' }] };
    if (text.startsWith('select owner_id, state')) {
      return {
        rows: [
          {
            owner_id: 'owner',
            state: this.state,
            started_at: null,
            completed_at: null,
            surface: null,
            steps_done: this.steps,
            nudges_sent: 0,
            last_nudge_at: null,
            unanswered: 0,
            quiet_until: null,
            updated_at: null,
          },
        ],
      };
    }
    if (text.startsWith('insert into core.onboarding')) {
      // markStepDone and completeOnboarding both land here.
      if (text.includes("'done'")) this.state = 'done';
      const step = params[1];
      if (typeof step === 'string' && !this.steps.includes(step)) this.steps.push(step);
      return {
        rows: [
          {
            owner_id: 'owner',
            state: this.state,
            started_at: null,
            completed_at: null,
            surface: null,
            steps_done: this.steps,
            nudges_sent: 0,
            last_nudge_at: null,
            unanswered: 0,
            quiet_until: null,
            updated_at: null,
          },
        ],
      };
    }
    throw new Error(`StubDb: unexpected sql: ${text}`);
  }
}

/* ---------------- an agent file on disk ---------------- */

const BODY = `You are the scribe.

## A heading with a --- inside it
- a bullet that must survive byte for byte
`;

function agentFile(dir: string, id: string, handle: string, name: string): string {
  const agentDir = path.join(dir, id);
  mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, 'agent.md');
  writeFileSync(
    file,
    `---\nid: ${id}\nhandle: ${handle}\nname: ${name}\ndescription: a test agent\ntools: []\n---\n\n${BODY}`,
  );
  return file;
}

function stubAgent(id: string, handle: string, name: string, file: string): CatalogAgent {
  return { id, handle, name, file } as unknown as CatalogAgent;
}

function catalogOf(agents: CatalogAgent[]): AgentCatalog {
  // Annotated, not cast: a catalog that grows a method has to grow it here too,
  // and the compiler is what says so.
  const catalog: AgentCatalog = {
    get: (id: string) => agents.find((a) => a.id === id),
    byHandle: (handle: string) =>
      agents.find((a) => a.handle.toLowerCase() === handle.replace(/^@/, '').toLowerCase()),
    list: () => agents as never,
    defaultAgent: () => agents[0] as CatalogAgent,
    agentsWithRole: () => [],
    agentForRole: () => ({ ok: false, problem: { code: 'no-agent-for-role', role: '', message: '' } }),
    resolve: (id?: string) => agents.find((a) => a.id === id) as CatalogAgent,
  };
  return catalog;
}

interface Harness {
  tool(name: string): { execute(input: any, ctx: ToolContext): Promise<any> };
  ctx: ToolContext;
  db: StubDb;
  file: string;
}

function harness(opts: { file?: string; others?: CatalogAgent[]; agentId?: string } = {}): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), 'buddi-owner-'));
  const file = opts.file ?? agentFile(dir, 'scribe', 'scribe', 'Scribe');
  const self = stubAgent('scribe', 'scribe', 'Scribe', file);
  const registry = new ToolRegistry();
  const manifest = createOwnerManifest(registry);
  bindOwnerTools(registry, { catalog: catalogOf([self, ...(opts.others ?? [])]), surface: 'cli' });
  const db = new StubDb();
  const ctx = {
    db: db as unknown as ToolContext['db'],
    ownerId: 'owner',
    now: () => new Date('2026-09-14T12:00:00Z'),
    timezone: 'America/New_York',
    agentId: opts.agentId ?? 'scribe',
  } as ToolContext;
  return {
    tool: (name) => manifest.tools.find((t) => t.name === name) as never,
    ctx,
    db,
    file,
  };
}

/* ---------------- the pure bits ---------------- */

describe('handleShapeProblem', () => {
  it('accepts what the catalog accepts', () => {
    for (const handle of ['ledger', 'night-desk', '@ada', 'a1', 'Ada']) {
      expect(handleShapeProblem(handle), handle).toBeUndefined();
    }
  });

  it('refuses a shape the loader would refuse', () => {
    for (const handle of ['a', '1st', 'with space', 'ends-', '@', 'x'.repeat(21)]) {
      expect(handleShapeProblem(handle), handle).toBeTypeOf('string');
    }
  });
});

describe('insideExamples', () => {
  it('catches a file in the shipped tree and nothing that merely looks like it', () => {
    expect(insideExamples(path.join(EXAMPLES_AGENTS_DIR, 'concierge', 'agent.md'))).toBe(true);
    expect(insideExamples('/home/me/examples-of-mine/agents/x/agent.md')).toBe(false);
    expect(insideExamples('/home/me/private/agents/scribe/agent.md')).toBe(false);
  });
});

/* ---------------- the profile ---------------- */

describe('owner.set_profile', () => {
  it('records what the owner said, and marks the steps it covers', async () => {
    const h = harness();
    const result = await h
      .tool('owner.set_profile')
      .execute({ preferredName: 'Amen', timezone: 'Europe/Paris' }, h.ctx);
    expect(result.ok).toBe(true);
    expect(result.preferredName).toBe('Amen');
    expect(h.db.steps).toEqual(['name', 'timezone']);
  });

  it('refuses a zone Intl does not know, and writes nothing', async () => {
    const h = harness();
    const result = await h.tool('owner.set_profile').execute({ timezone: 'Mars/Olympus' }, h.ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown-timezone');
    expect(result.message).toContain('not a timezone I know');
    // No alternatives are offered: guessing a zone is how an installation ends
    // up a day off.
    expect(result.message).not.toContain('America/');
    expect(h.db.profile.timezone).toBeNull();
    expect(h.db.steps).toEqual([]);
  });

  it('reports the detected zone so the agent can confirm rather than ask', async () => {
    const h = harness();
    const profile = await h.tool('owner.get_profile').execute({}, h.ctx);
    expect(profile.detectedTimezone).toBe('America/New_York');
    expect(profile.preferredName).toBeNull();
  });
});

/* ---------------- renaming the caller ---------------- */

describe('owner.rename_me', () => {
  it('rewrites its own frontmatter and leaves the body byte for byte', async () => {
    const h = harness();
    const before = readFileSync(h.file, 'utf8');

    const result = await h.tool('owner.rename_me').execute({ name: 'Ada', handle: 'ada' }, h.ctx);
    expect(result.ok).toBe(true);
    expect(result.handle).toBe('ada');
    expect(result.message).toContain('restart');

    const after = readFileSync(h.file, 'utf8');
    expect(after).toContain('handle: ada');
    expect(after).toContain('name: Ada');
    expect(after.slice(after.indexOf('You are the scribe.'))).toBe(
      before.slice(before.indexOf('You are the scribe.')),
    );
    expect(h.db.steps).toEqual(['agent-name']);
  });

  it('normalizes the handle the model wrote', async () => {
    const h = harness();
    const result = await h.tool('owner.rename_me').execute({ handle: '@Ada' }, h.ctx);
    expect(result.ok).toBe(true);
    expect(readFileSync(h.file, 'utf8')).toContain('handle: ada');
  });

  it('refuses a handle another installed agent already answers to', async () => {
    const other = stubAgent('ledger', 'ada', 'Finance Advisor', '/nowhere/agent.md');
    const h = harness({ others: [other] });
    const before = readFileSync(h.file, 'utf8');

    const result = await h.tool('owner.rename_me').execute({ handle: 'ada' }, h.ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('handle-taken');
    expect(result.message).toContain('Finance Advisor');
    expect(readFileSync(h.file, 'utf8')).toBe(before);
  });

  it('refuses a handle the loader would refuse, and writes nothing', async () => {
    const h = harness();
    const before = readFileSync(h.file, 'utf8');
    const result = await h.tool('owner.rename_me').execute({ handle: 'Big Ada!' }, h.ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-handle');
    expect(readFileSync(h.file, 'utf8')).toBe(before);
  });

  it('refuses entirely when its own file is one of the shipped examples', async () => {
    const h = harness({ file: path.join(EXAMPLES_AGENTS_DIR, 'concierge', 'agent.md') });
    const before = readFileSync(h.file, 'utf8');

    const result = await h.tool('owner.rename_me').execute({ name: 'Ada' }, h.ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('examples-tree');
    expect(result.message).toBe(EXAMPLES_TREE_REFUSAL);
    expect(result.message).toContain('buddi init');
    expect(readFileSync(h.file, 'utf8')).toBe(before);
  });

  it('refuses when it cannot tell which file is its own', async () => {
    const h = harness({ agentId: 'someone-else' });
    const result = await h.tool('owner.rename_me').execute({ name: 'Ada' }, h.ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown-self');
  });
});

describe('owner.finish_onboarding', () => {
  it('marks it done and says what was configured', async () => {
    const h = harness();
    await h.tool('owner.set_profile').execute({ preferredName: 'Amen' }, h.ctx);
    const result = await h.tool('owner.finish_onboarding').execute({}, h.ctx);
    expect(result.ok).toBe(true);
    expect(result.configured.preferredName).toBe('Amen');
    expect(h.db.state).toBe('done');
  });
});

describe('the descriptions the model reads', () => {
  it('tell it to ask one thing at a time and invent nothing', () => {
    const manifest = createOwnerManifest(new ToolRegistry());
    for (const tool of manifest.tools) {
      expect(tool.tier, tool.name).toBe('auto');
      expect(tool.description, tool.name).toContain('one thing at a time');
      expect(tool.description, tool.name).toContain('never');
    }
  });
});
