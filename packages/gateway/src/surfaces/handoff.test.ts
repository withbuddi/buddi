/**
 * The front desk's handoff (handoff.ts): one button, never a call. "Add Chef"
 * names a package the catalogue lists; "Continue with Agent Father" carries
 * the owner's request to the maker. `conversation.offer` cannot make either,
 * and the front desk cannot reach the maker by delegation.
 */
import { describe, expect, it } from 'vitest';
import type { Queryable } from '@buddi/core';
import { createHandoffManifest, HANDOFF_TOOL, isFrontDesk, type HandoffTargets } from './handoff.js';
import { createOfferManifest, storeTurnOffers, OFFER_TOOL, type OfferSink } from './offered-actions.js';
import { resolveAllowlist } from '../agents/delegation.js';

const targets = (over: Partial<HandoffTargets> = {}): HandoffTargets => ({
  maker: () => ({ id: 'agent-father', name: 'Agent Father' }),
  listed: async (name) => (name === 'chef' ? { name: 'chef', title: 'Chef' } : undefined),
  ...over,
});

async function call(sink: OfferSink, input: Record<string, unknown>, t = targets()): Promise<unknown> {
  const tool = createHandoffManifest(sink, t).tools.find((x) => x.name === HANDOFF_TOOL)!;
  return tool.execute(tool.input.parse(input) as never, {} as never);
}

describe('conversation.hand_off', () => {
  it('offers a listed catalogue agent as "Add <title>", opening its install sheet', async () => {
    const sink: OfferSink = {};
    await call(sink, { to: 'catalogue', name: 'chef' });
    expect(sink.handoff).toEqual({ label: 'Add Chef', prompt: "Open Chef's install sheet.", handoff: { kind: 'install', package: 'chef', title: 'Chef' } });
  });

  it('refuses a package the catalogue does not list', async () => {
    await expect(call({}, { to: 'catalogue', name: 'gardener' })).rejects.toThrow(/lists no agent "gardener"/);
  });

  it("offers Continue with Agent Father carrying the owner's request", async () => {
    const sink: OfferSink = {};
    await call(sink, { to: 'maker', request: 'I want an agent that tracks my plants' });
    expect(sink.handoff).toEqual({
      label: 'Continue with Agent Father',
      prompt: 'I want an agent that tracks my plants',
      handoff: { kind: 'maker', agentId: 'agent-father' },
    });
  });

  it('refuses without a request, or with nobody to make agents', async () => {
    await expect(call({}, { to: 'maker' })).rejects.toThrow(/request/);
    await expect(call({}, { to: 'maker', request: 'x' }, targets({ maker: () => undefined }))).rejects.toThrow(/nobody/);
  });

  it('is for the front desk only', () => {
    expect(isFrontDesk({ roles: ['front-desk'] })).toBe(true);
    expect(isFrontDesk({ roles: ['maker'] })).toBe(false);
    expect(isFrontDesk({})).toBe(false);
  });
});

describe('what conversation.offer cannot do', () => {
  it('cannot make a handoff: its input has no such field, and a smuggled one is dropped', async () => {
    const sink: OfferSink = {};
    const tool = createOfferManifest(sink).tools.find((x) => x.name === OFFER_TOOL)!;
    const parsed = tool.input.parse({ actions: [{ label: 'Go', prompt: 'go', handoff: { kind: 'maker', agentId: 'agent-father' } }] });
    await tool.execute(parsed as never, {} as never);
    expect(sink.offered).toEqual([{ label: 'Go', prompt: 'go' }]);
  });
});

describe('storing a turn with a handoff', () => {
  it('stores the handoff first, with its destination, so the cap never cuts it', async () => {
    const inserts: unknown[][] = [];
    const pool: Queryable = {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes('insert into core.offers')) {
          inserts.push(params);
          return { rows: [{ id: `o${inserts.length}`, agent_id: params[0], conversation_id: params[1], label: params[2], prompt: params[3], created_at: params[4], expires_at: params[5], handoff: params[6] }] };
        }
        return { rows: [] };
      },
    } as Queryable;
    const sink: OfferSink = {
      offered: [{ label: 'One', prompt: '1' }, { label: 'Two', prompt: '2' }, { label: 'Three', prompt: '3' }],
      handoff: { label: 'Add Chef', prompt: "Open Chef's install sheet.", handoff: { kind: 'install', package: 'chef', title: 'Chef' } },
    };
    const stored = await storeTurnOffers(pool, { sink, agentId: 'concierge', conversationId: 'c1', now: new Date() });
    expect(stored.map((o) => o.label)).toEqual(['Add Chef', 'One', 'Two']);
    expect(stored[0]?.handoff).toEqual({ kind: 'install', package: 'chef', title: 'Chef' });
    expect(stored[1]?.handoff).toBeNull();
  });
});

describe('the front desk cannot call Agent Father itself', () => {
  const catalog = {
    list: () => [{ id: 'concierge' }, { id: 'agent-father' }, { id: 'chef' }],
    get: (id: string) => {
      const tools: Record<string, string[]> = {
        concierge: ['agent.delegate', 'platform.catalogue'],
        'agent-father': ['platform.create_agent', 'platform.install_agent', 'platform.catalogue'],
        chef: ['memory.note'],
      };
      const roles: Record<string, string[]> = { concierge: ['front-desk'], 'agent-father': ['maker'], chef: [] };
      return tools[id] ? { roles: roles[id], definition: () => ({ tools: tools[id] as string[] }) } : undefined;
    },
  };

  it('its open delegation leaves the maker out', () => {
    expect(resolveAllowlist('concierge', catalog, undefined)).toEqual(['chef']);
    expect(resolveAllowlist('concierge', catalog, ['*'])).toEqual(['chef']);
  });

  it('a delegates.json naming the maker is refused, loudly', () => {
    expect(() => resolveAllowlist('concierge', catalog, ['agent-father'])).toThrow(/may not delegate to agent-father/);
  });
});
