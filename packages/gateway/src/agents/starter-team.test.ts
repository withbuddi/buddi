/**
 * The starter team: its files load, its grants resolve against the real
 * registry, and "Add a teammate" draws each card as added, addable, or greyed
 * with why — never a dismissed one.
 */
import { z } from 'zod';
import { resolveToolNames, ToolRegistry, type CoreToolContext, type PluginManifest } from '@buddi/core';
import { describe, expect, it } from 'vitest';
import { createToolRegistry } from './catalog.js';
import { pluginAgentProposals } from './platform.js';
import { PLUGIN_TEAMMATES, STARTER_IDS, STARTER_PLUGIN, starterAgents, starterMission } from './starter-team.js';
import { dismissAgentOffer, readAgentOffers, readTeammates, type AgentOffersDeps } from '../web/agent-offers.js';

describe('the starter catalogue', () => {
  it('parses, one agent per id, each with a persona, skills and an offer line', () => {
    const agents = starterAgents();
    expect(agents.map((a) => a.id)).toEqual([...STARTER_IDS]);
    expect(agents.map((a) => a.handle)).toEqual(['scout', 'planner', 'keeper']);
    for (const agent of agents) {
      expect(agent.persona.length).toBeGreaterThan(200);
      expect(agent.skills?.length ?? 0).toBeGreaterThan(0);
      expect(agent.offer?.text).toBeTruthy();
      // buddi's voice: no exclamation marks, no excitement.
      const text = [agent.persona, ...(agent.skills ?? []).map((s) => s.body)].join('\n');
      expect(text).not.toMatch(/!\s/);
      expect(text).not.toMatch(/excited/i);
    }
  });

  it('grants only memory, reminders, schedules, the web and browser.status, and every tool exists', () => {
    const registry = createToolRegistry({});
    const installed = new Set(registry.list().map((t) => t.name));
    for (const agent of starterAgents()) {
      const tools = resolveToolNames(agent.tools, registry, agent.id);
      expect(tools.length, agent.id).toBeGreaterThan(0);
      for (const name of tools) {
        expect(installed.has(name), `${agent.id}: ${name}`).toBe(true);
        expect(name, `${agent.id}: ${name}`).toMatch(/^(memory|reminder|schedule|web)\.|^browser\.status$/);
      }
      for (const family of agent.tools) expect(family).not.toMatch(/^(email|finance|host|platform)\.|browser\.act/);
    }
    expect(starterAgents().find((a) => a.id === 'scout')?.tools).toContain('web.*');
    expect(starterAgents().find((a) => a.id === 'keeper')?.tools).toEqual(['memory.*', 'reminder.*']);
  });

  it('gives Planner, and only Planner, a morning brief at 08:00', () => {
    expect(starterMission(STARTER_PLUGIN, 'planner')).toMatchObject({ name: 'Morning brief', cron: '0 8 * * *' });
    expect(starterMission(STARTER_PLUGIN, 'scout')).toBeNull();
    expect(starterMission('email', 'planner')).toBeNull();
  });

  it('is proposed under the built-in source, beside what the plugins propose', () => {
    const proposals = pluginAgentProposals(new ToolRegistry()).filter((p) => p.plugin === STARTER_PLUGIN);
    expect(proposals.map((p) => p.agent.id)).toEqual([...STARTER_IDS]);
  });
});

/** A registry with the email-like plugin: proposes `mail-triage`, wanted when there is a mailbox. */
function deps(opts: { mailbox?: boolean; ids?: string[] } = {}): AgentOffersDeps & { stored: Map<string, unknown> } {
  const registry = new ToolRegistry();
  const email: PluginManifest = {
    name: 'email',
    version: '1.0.0',
    schema: 'email',
    migrationsDir: '',
    tools: [{ name: 'email.search', description: 'Search.', tier: 'auto', input: z.object({}), execute: async () => [] }],
    agents: [
      {
        id: 'mail-triage',
        handle: 'mail',
        name: 'Mail',
        description: 'Reads mail.',
        persona: 'You read mail.',
        tools: ['email.search'],
        offer: { text: 'Someone should read the mail.', query: 'triage_offer' },
      },
    ],
    queries: [{ name: 'triage_offer', params: z.object({}), produce: async () => ({ wanted: opts.mailbox === true }) }],
  };
  registry.register(email);
  const stored = new Map<string, unknown>();
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.startsWith('select')) {
        const value = stored.get(params?.[0] as string);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      stored.set(params?.[0] as string, JSON.parse(params?.[1] as string));
      return { rows: [] };
    },
  };
  const ctx = { db: pool as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC', agentId: 'owner' } as CoreToolContext;
  return { registry, ctx, now: () => new Date(), pool, agentIds: () => opts.ids ?? ['concierge', 'agent-father'], stored };
}

const stateOf = (rows: Array<{ agent: string; state: string; reason?: string }>) =>
  Object.fromEntries(rows.map((r) => [r.agent, r.reason ? `${r.state}: ${r.reason}` : r.state]));

describe('Add a teammate', () => {
  it('offers the starter team while nobody has it, and greys the plugin agents with why', async () => {
    const { teammates } = await readTeammates(deps());
    expect(stateOf(teammates)).toEqual({
      scout: 'available',
      planner: 'available',
      keeper: 'available',
      'mail-triage': 'unavailable: Needs a mailbox',
      ledger: 'unavailable: From the finance plugin',
      illustrator: 'unavailable: Needs the image plugin and an account that draws',
    });
    expect(teammates.find((t) => t.agent === 'scout')).toMatchObject({
      plugin: 'buddi',
      name: 'Scout',
      text: 'Reads the web, gives a second opinion, watches pages you name.',
      needs: 'Needs a brain',
    });
    expect(teammates.find((t) => t.agent === 'mail-triage')).toMatchObject({ fix: 'mailbox' });
    expect(teammates.find((t) => t.agent === 'ledger')).toMatchObject({ fix: 'plugins' });
  });

  it('says added for an agent the roster holds, and lets a plugin agent in once its plugin wants it', async () => {
    const { teammates } = await readTeammates(deps({ mailbox: true, ids: ['concierge', 'planner'] }));
    expect(stateOf(teammates)).toMatchObject({ planner: 'added', scout: 'available', 'mail-triage': 'available' });
  });

  it('leaves a dismissed card out, starter or plugin, and keeps starters off the Home offers', async () => {
    const d = deps();
    expect(await dismissAgentOffer(d, 'buddi', 'keeper')).toEqual({ status: 200, body: { dismissed: true } });
    // A plugin teammate whose plugin is absent can still be dismissed.
    expect((await dismissAgentOffer(d, 'finance', 'ledger')).status).toBe(200);
    expect((await dismissAgentOffer(d, 'buddi', 'nobody')).status).toBe(404);
    const agents = (await readTeammates(d)).teammates.map((t) => t.agent);
    expect(agents).not.toContain('keeper');
    expect(agents).not.toContain('ledger');
    expect(agents).toContain('scout');
    // The starter team is drawn as cards, not as something that needs the owner.
    expect((await readAgentOffers(deps({ mailbox: true }))).offers.map((o) => o.agent)).toEqual(['mail-triage']);
  });

  it('names exactly the three plugin agents the spec lists', () => {
    expect(PLUGIN_TEAMMATES.map((t) => `${t.plugin}/${t.agent}`)).toEqual(['email/mail-triage', 'finance/ledger', 'image/illustrator']);
  });
});
