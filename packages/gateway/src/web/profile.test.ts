/**
 * `GET /api/agents/:id/profile` — what an agent is, and what it may never do.
 *
 * The fixtures are an invented plugin (`orchard`), for the reason every fixture
 * in this repository is invented: the properties panel is about *tiers*, and a
 * tier is a property of the platform rather than of any plugin that ships with
 * it. An installation with no finance plugin must get the same answer.
 *
 * The properties asserted here are, in order of how much they would cost to
 * lose:
 *
 *  - a gated tool is reported as gated, and an `auto` one is not. This is the
 *    privilege boundary; a panel that drew them the same way would be worse
 *    than no panel, because it would be reassuring and wrong;
 *  - no credential *value* is ever in the response, whatever it is called;
 *  - an agent that cannot run says why;
 *  - an agent with no skills and no delegates reports empty lists, so the page
 *    can leave those sections out entirely rather than draw empty headings;
 *  - the route is a read. There is no write beside it, and the file on disk is
 *    untouched by anything this endpoint can be asked to do.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { ToolRegistry, type AgentCatalog, type PluginManifest, type CoreToolContext } from '@buddi/core';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGatewayCatalog } from '../agents/catalog.js';
import {
  MAKER_ITSELF_NOTE,
  NO_MAKER_NOTE,
  READ_ONLY_NOTE,
  readAgentProfile,
  type AgentProfileView,
} from './profile.js';
import { mintTicket } from './token.js';
import { createWebApp } from './server.js';
import { csrfCookieName, portOf } from './http.js';

const TOKEN = 'a-test-dashboard-token-long-enough';

/** The secret this installation holds. It must never appear in an answer. */
const SECRET = 'sk-ant-the-owners-actual-key-0001';

const env = { ANTHROPIC_API_KEY: SECRET } as NodeJS.ProcessEnv;

/**
 * One invented plugin with one tool of each tier — a read that runs on its own
 * and a send that stops for the owner. That pairing is the whole subject.
 */
function orchard(): PluginManifest {
  const tool = (name: string, description: string, tier: 'auto' | 'gated') => ({
    name,
    description,
    tier,
    input: z.object({}).strict(),
    execute: async () => ({ ok: true }),
  });
  return {
    name: 'orchard',
    version: '0.1.0',
    schema: 'orchard',
    migrationsDir: '',
    tools: [
      tool('orchard.forecast', 'Project the harvest for the next eight weeks.', 'auto'),
      tool('orchard.rows', 'List the rows and what is planted in them.', 'auto'),
      tool('orchard.dispatch', 'Send a crate to a buyer. Leaves the farm.', 'gated'),
    ],
  };
}

function shed(): PluginManifest {
  return {
    name: 'shed',
    version: '0.1.0',
    schema: 'shed',
    migrationsDir: '',
    tools: [
      {
        name: 'shed.inventory',
        description: 'What is on the shelves.',
        tier: 'auto',
        input: z.object({}).strict(),
        execute: async () => ({ ok: true }),
      },
    ],
  };
}

function registryWithPlugins(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(orchard());
  registry.register(shed());
  return registry;
}

function agentFile(opts: {
  id: string;
  handle: string;
  name: string;
  tools: string[];
  extra?: string[];
}): string {
  return [
    '---',
    `id: ${opts.id}`,
    `handle: ${opts.handle}`,
    `name: ${opts.name}`,
    `description: ${opts.name} minds things.`,
    'provider: anthropic',
    'model: claude-sonnet-5',
    `tools: [${opts.tools.join(', ')}]`,
    ...(opts.extra ?? []),
    '---',
    '',
    `You are ${opts.name}.`,
    '',
  ].join('\n');
}

describe('an agent profile', () => {
  let dir: string;
  let agentsDir: string;
  let catalog: AgentCatalog;
  let registry: ToolRegistry;

  const write = (id: string, contents: string): string => {
    mkdirSync(path.join(agentsDir, id), { recursive: true });
    const file = path.join(agentsDir, id, 'agent.md');
    writeFileSync(file, contents);
    return file;
  };

  const load = (): void => {
    catalog = loadGatewayCatalog({ dir: agentsDir, env, registry });
  };

  const profileOf = (id: string): AgentProfileView => {
    const view = readAgentProfile({ catalog, registry }, id);
    expect(view, `no profile for ${id}`).toBeDefined();
    return view as AgentProfileView;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'buddi-profile-'));
    agentsDir = path.join(dir, 'agents');
    registry = registryWithPlugins();

    write(
      'keeper',
      agentFile({
        id: 'keeper',
        handle: 'keeper',
        name: 'The Keeper',
        tools: ["'orchard.*'", "'shed.inventory'"],
        extra: ['maxTurns: 9', 'default: true', 'roles: [overview]'],
      }),
    );
    // A private skill of its own, so provenance and scope have something to say.
    mkdirSync(path.join(agentsDir, 'keeper', 'skills'), { recursive: true });
    writeFileSync(
      path.join(agentsDir, 'keeper', 'skills', 'pruning.md'),
      ['---', 'name: pruning', 'description: How this farm prunes in February.', 'provenance: owner', '---', '', 'Cut above the bud.', ''].join('\n'),
    );
    // Somebody to hand work to.
    write(
      'picker',
      agentFile({ id: 'picker', handle: 'picker', name: 'The Picker', tools: ["'shed.inventory'"] }),
    );
    writeFileSync(path.join(agentsDir, 'keeper', 'delegates.json'), JSON.stringify(['picker']));
    load();
  });

  it('reports each tool with its own description and its tier', () => {
    const profile = profileOf('keeper');

    expect(profile.toolCount).toBe(4);
    expect(profile.gatedCount).toBe(1);
    expect(profile.tools.map((family) => family.family)).toEqual(['orchard', 'shed']);

    const orchardFamily = profile.tools[0]!;
    expect(orchardFamily.gated).toBe(1);
    const dispatch = orchardFamily.tools.find((tool) => tool.name === 'orchard.dispatch');
    expect(dispatch).toMatchObject({
      tier: 'gated',
      gated: true,
      description: 'Send a crate to a buyer. Leaves the farm.',
    });
    const forecast = orchardFamily.tools.find((tool) => tool.name === 'orchard.forecast');
    expect(forecast).toMatchObject({ tier: 'auto', gated: false });
    // The description is the tool's own, not a sentence invented for the page.
    expect(forecast?.description).toBe('Project the harvest for the next eight weeks.');

    expect(profile.tools[1]!.gated).toBe(0);
  });

  it('says plainly when an agent has nothing gated at all', () => {
    const profile = profileOf('picker');
    expect(profile.toolCount).toBe(1);
    expect(profile.gatedCount).toBe(0);
    expect(profile.tools.every((family) => family.gated === 0)).toBe(true);
  });

  it('names the credential and never carries its value', () => {
    const profile = profileOf('keeper');
    expect(profile.engine).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      maxTurns: 9,
      language: 'mirror',
      credentialKind: 'api-key',
      credentialEnv: 'ANTHROPIC_API_KEY',
    });
    // The whole answer, not just the engine block: a secret that leaked into a
    // reason, a path or a description would still be a leak.
    expect(JSON.stringify(profile)).not.toContain(SECRET);
  });

  it('reports an agent that cannot run, with the reason', () => {
    catalog = loadGatewayCatalog({ dir: agentsDir, env: {} as NodeJS.ProcessEnv, registry });
    const profile = profileOf('keeper');
    expect(profile.available).toBe(false);
    expect(profile.unavailableReason).toMatch(/ANTHROPIC_API_KEY/);
    // Still a complete answer: an agent you cannot run is exactly the one whose
    // configuration you are looking at.
    expect(profile.toolCount).toBe(4);
  });

  it('carries skills, delegates and roles when there are any', () => {
    const profile = profileOf('keeper');
    expect(profile.roles).toEqual(['overview']);
    expect(profile.skills).toEqual([
      {
        name: 'pruning',
        description: 'How this farm prunes in February.',
        provenance: 'owner',
        scope: 'private',
        file: path.join(agentsDir, 'keeper', 'skills', 'pruning.md'),
      },
    ]);
    expect(profile.delegates).toEqual([
      {
        id: 'picker',
        handle: 'picker',
        name: 'The Picker',
        description: 'The Picker minds things.',
        available: true,
      },
    ]);
  });

  it('reports empty lists for an agent with no skills and no delegates', () => {
    const profile = profileOf('picker');
    expect(profile.skills).toEqual([]);
    expect(profile.delegates).toEqual([]);
    expect(profile.roles).toEqual([]);
  });

  it('drops a delegate id that names no installed agent', () => {
    writeFileSync(
      path.join(agentsDir, 'keeper', 'delegates.json'),
      JSON.stringify(['picker', 'somebody-who-left']),
    );
    load();
    expect(profileOf('keeper').delegates.map((d) => d.id)).toEqual(['picker']);
  });

  it('points at the maker for a change, and never at itself', () => {
    write(
      'father',
      agentFile({
        id: 'father',
        handle: 'father',
        name: 'Agent Father',
        tools: [],
        extra: ['roles: [maker]'],
      }),
    );
    load();

    const keeper = profileOf('keeper');
    expect(keeper.changeVia).toMatchObject({ agentId: 'father', handle: 'father', available: true });
    expect(keeper.changeVia?.prompt).toContain('@keeper');
    expect(keeper.note).toBe(READ_ONLY_NOTE);
    // Honest about where a change is made since the tool picker, and not the stale "read-only view".
    expect(keeper.note).toContain('Setup tab');
    expect(keeper.note).toContain('buddi.agent_update');
    expect(keeper.note).not.toMatch(/read-only view/);

    // The maker is not the route to changing the maker; it says so instead of
    // sending the owner in a circle.
    const father = profileOf('father');
    expect(father.changeVia).toBeUndefined();
    expect(father.note).toBe(MAKER_ITSELF_NOTE);
  });

  it('says so when no agent claims the maker role', () => {
    const profile = profileOf('keeper');
    expect(profile.changeVia).toBeUndefined();
    expect(profile.note).toBe(NO_MAKER_NOTE);
  });

  it('is resolvable by handle and refuses an unknown name', () => {
    expect(readAgentProfile({ catalog, registry }, 'picker')?.id).toBe('picker');
    expect(readAgentProfile({ catalog, registry }, 'nobody')).toBeUndefined();
  });

  /* ---------------- over the wire ---------------- */

  describe('over the wire', () => {
    let server: ReturnType<typeof createWebApp>;
    let base: string;

    beforeEach(async () => {
      server = createWebApp({
        pool: {} as Pool,
        registry,
        catalog,
        ctx: { ownerId: 'owner' } as unknown as CoreToolContext,
        timezone: 'Europe/Paris',
        now: () => new Date('2026-09-15T09:00:00Z'),
        config: { enabled: true, host: '127.0.0.1', port: 0 },
        token: TOKEN,
        env,
        log: () => {},
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    });

    const signIn = async (): Promise<{ cookie: string; csrf: string }> => {
      const res = await fetch(`${base}/?t=${encodeURIComponent(mintTicket(TOKEN))}`, {
        redirect: 'manual',
      });
      const jar = new Map<string, string>();
      for (const raw of res.headers.getSetCookie()) {
        const [pair] = raw.split(';');
        const [name, value] = (pair as string).split('=');
        jar.set(name as string, value as string);
      }
      return {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        csrf: jar.get(csrfCookieName(portOf(new URL(base)))) as string,
      };
    };

    it('answers the profile read, signed in or not — and leaks the secret to neither', async () => {
      // The gate is open on this loopback binding, so the anonymous read is
      // served: what matters here is what the view says, not who asked.
      const anonymous = await fetch(`${base}/api/agents/keeper/profile`);
      expect(anonymous.status).toBe(200);
      expect(JSON.stringify(await anonymous.json())).not.toContain(SECRET);

      const { cookie } = await signIn();
      const res = await fetch(`${base}/api/agents/keeper/profile`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as AgentProfileView;
      expect(body.handle).toBe('keeper');
      expect(body.gatedCount).toBe(1);
      expect(JSON.stringify(body)).not.toContain(SECRET);

      expect((await fetch(`${base}/api/agents/nobody/profile`, { headers: { cookie } })).status).toBe(404);
    });

    it('is a read: there is no write on this route, and the file is untouched', async () => {
      const { cookie, csrf } = await signIn();
      const before = readFileSync(path.join(agentsDir, 'keeper', 'agent.md'), 'utf8');

      for (const body of [
        { tools: [] },
        { tools: ['orchard.dispatch'], tier: 'auto' },
        { skills: [], delegates: [] },
      ]) {
        const res = await fetch(`${base}/api/agents/keeper/profile`, {
          method: 'POST',
          headers: { cookie, 'x-buddi-csrf': csrf, origin: base, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        // Whatever the server chooses to say, it must not be a success: the
        // only path that changes a grant is an approval the owner reads.
        expect(res.status).toBeGreaterThanOrEqual(400);
      }

      expect(readFileSync(path.join(agentsDir, 'keeper', 'agent.md'), 'utf8')).toBe(before);
      // And the grant is still what it was.
      const res = await fetch(`${base}/api/agents/keeper/profile`, { headers: { cookie } });
      expect(((await res.json()) as AgentProfileView).gatedCount).toBe(1);
    });
  });
});
