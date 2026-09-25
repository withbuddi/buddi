/**
 * Which agents Home offers: proposed with an `offer`, nobody has the id, the
 * plugin says it is wanted, and the owner has not said no.
 */
import { z } from 'zod';
import { ToolRegistry, type CoreToolContext, type PluginManifest } from '@buddi/core';
import { describe, expect, it } from 'vitest';
import { dismissAgentOffer, raiseAgentOffers, readAgentOffers, type AgentOffersDeps } from './agent-offers.js';

function manifest(wanted: { value: boolean }): PluginManifest {
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
      },
      // No `offer`: only ever on the Plugins page.
      { id: 'pruner', handle: 'prune', name: 'Pruner', description: 'Prunes.', persona: 'You prune.', tools: ['garden.plants'] },
    ],
    queries: [{ name: 'gardener_wanted', params: z.object({}), produce: async () => ({ wanted: wanted.value }) }],
  };
}

function deps(wanted: { value: boolean }, ids: string[] = []): AgentOffersDeps & { stored: Map<string, unknown> } {
  const registry = new ToolRegistry();
  registry.register(manifest(wanted));
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
  });
});
