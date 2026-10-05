/**
 * Which agents Home offers: proposed with an `offer`, nobody has the id, the
 * plugin says it is wanted, and the owner has not said no.
 */
import { z } from 'zod';
import { ToolRegistry, type CoreToolContext, type PluginManifest } from '@buddi/core';
import { describe, expect, it } from 'vitest';
import { dismissAgentOffer, raiseAgentOffers, readAgentOffers, type AgentOffersDeps } from './agent-offers.js';

function manifest(wanted: { value: boolean }, roles?: string[]): PluginManifest {
  return {
    name: 'garden',
    version: '1.0.0',
    schema: 'garden',
    migrationsDir: '',
    tools: [{ name: 'garden.plants', description: 'Plants.', tier: 'auto', input: z.object({}), execute: async () => [] }],
    agents: [
      {
        id: 'gardener',
        handle: 'garden',
        name: 'Gardener',
        description: 'Waters things.',
        persona: 'You water things.',
        tools: ['garden.plants'],
        offer: { text: 'The plants need someone to water them.', query: 'gardener_wanted' },
        ...(roles ? { roles } : {}),
      },
      // No `offer`: only ever on the Plugins page.
      { id: 'pruner', handle: 'prune', name: 'Pruner', description: 'Prunes.', persona: 'You prune.', tools: ['garden.plants'] },
    ],
    queries: [{ name: 'gardener_wanted', params: z.object({}), produce: async () => ({ wanted: wanted.value }) }],
  };
}

function deps(wanted: { value: boolean }, ids: string[] = [], roles?: string[]): AgentOffersDeps & { stored: Map<string, unknown> } {
  const registry = new ToolRegistry();
  registry.register(manifest(wanted, roles));
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
  return { registry, ctx, now: () => new Date(), pool, agentIds: () => ids, stored };
}

describe('agent offers on Home', () => {
  it('offers an agent while nobody has it and the plugin wants it', async () => {
    const wanted = { value: true };
    expect((await readAgentOffers(deps(wanted))).offers).toEqual([
      {
        plugin: 'garden',
        agent: 'gardener',
        handle: 'garden',
        name: 'Gardener',
        description: 'Waters things.',
        text: 'The plants need someone to water them.',
      },
    ]);
    // Not wanted yet: nothing to offer.
    wanted.value = false;
    expect((await readAgentOffers(deps(wanted))).offers).toEqual([]);
    // Already there: nothing to offer either.
    expect((await readAgentOffers(deps({ value: true }, ['gardener']))).offers).toEqual([]);
  });

  it('stays quiet while first run is still on: its mailbox sheet brings Mail Triage in itself', async () => {
    const wanted = { value: true };
    let over = false;
    const during = { ...deps(wanted), firstRunDone: async () => over };
    expect((await readAgentOffers(during)).offers).toEqual([]);
    over = true;
    expect((await readAgentOffers(during)).offers.map((o) => o.agent)).toEqual(['gardener']);
  });

  it('does not offer a mail agent while somebody on the team already carries the mail role', async () => {
    const wanted = { value: true };
    // buddi or a Chief of Staff with the mail role already reads mail: no card.
    const covered = { ...deps(wanted, ['concierge', 'chief'], ['mail']), agentRoles: () => ['front-desk', 'mail'] };
    expect((await readAgentOffers(covered)).offers).toEqual([]);
    covered.registry.invoke = (async () => { throw new Error('never invoked'); }) as never;
    expect(await raiseAgentOffers(covered, 'garden')).toEqual([]);
    // Nobody in the role: the card stands.
    const open = { ...deps(wanted, ['concierge'], ['mail']), agentRoles: () => ['front-desk'] };
    expect((await readAgentOffers(open)).offers.map((o) => o.agent)).toEqual(['gardener']);
    // An agent that is not a mail agent is offered whoever carries the mail role.
    const other = { ...deps(wanted), agentRoles: () => ['mail'] };
    expect((await readAgentOffers(other)).offers.map((o) => o.agent)).toEqual(['gardener']);
  });

  it('stops offering once dismissed, and refuses to dismiss what nobody offers', async () => {
    const d = deps({ value: true });
    expect(await dismissAgentOffer(d, 'garden', 'gardener')).toEqual({ status: 200, body: { dismissed: true } });
    expect(d.stored.get('agent-offers')).toEqual({ dismissed: ['garden/gardener'] });
    expect((await readAgentOffers(d)).offers).toEqual([]);
    expect((await dismissAgentOffer(d, 'garden', 'pruner')).status).toBe(404);
  });

  /*
   * The card raised without a click: once per installation per agent, never
   * after a no, never while nobody wants it. The accept itself is stubbed
   * here; the database suite runs the real one.
   */
  it('raises the accept once when the offer becomes wanted, and never after a no', async () => {
    const wanted = { value: false };
    const d = deps(wanted);
    const invoked: unknown[] = [];
    d.registry.invoke = (async (tool: string, args: unknown) => {
      invoked.push({ tool, args });
      return { ok: false, reason: 'approval-required', actionId: `a-${invoked.length}`, preview: '' };
    }) as never;
    expect(await raiseAgentOffers(d, 'garden')).toEqual([]);
    wanted.value = true;
    expect(await raiseAgentOffers(d, 'garden')).toEqual(['a-1']);
    expect(invoked).toEqual([{ tool: 'platform.accept_plugin_agent', args: { plugin: 'garden', agent: 'gardener' } }]);
    expect(d.stored.get('agent-offers')).toEqual({ raised: ['garden/gardener'] });
    // The next save raises nothing, whatever became of the first card.
    expect(await raiseAgentOffers(d, 'garden')).toEqual([]);
    // A dismissal keeps the record of the raise.
    await dismissAgentOffer(d, 'garden', 'gardener');
    expect(d.stored.get('agent-offers')).toEqual({ raised: ['garden/gardener'], dismissed: ['garden/gardener'] });

    const said = deps({ value: true });
    await dismissAgentOffer(said, 'garden', 'gardener');
    said.registry.invoke = (async () => { throw new Error('never invoked'); }) as never;
    expect(await raiseAgentOffers(said, 'garden')).toEqual([]);

    // During first run: nothing raised, the mailbox sheet accepts it itself.
    const early = { ...deps({ value: true }), firstRunDone: async () => false };
    early.registry.invoke = (async () => { throw new Error('never invoked'); }) as never;
    expect(await raiseAgentOffers(early, 'garden')).toEqual([]);
    expect(early.stored.get('agent-offers')).toBeUndefined();
  });
});
