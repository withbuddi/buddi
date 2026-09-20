/**
 * What a fresh install's roster is allowed to contain.
 *
 * Agent Father is the "make me another one" that comes after the owner has an
 * assistant of their own. Before that it is a stranger with no brain at the
 * foot of the first roster they ever see, so it is held back — from
 * `/api/agents`, the rail and Home, all of which read `list()`.
 */
import { describe, expect, it } from 'vitest';
import type { AgentCatalog, AgentSummary } from '@buddi/core';
import { EXAMPLES_HELD_BACK, withHeldBackExamples } from './catalog.js';

function summary(over: Partial<AgentSummary> & { id: string }): AgentSummary {
  return {
    handle: over.id,
    name: over.id,
    description: '',
    isDefault: false,
    roles: [],
    source: 'example',
    providerKind: 'anthropic',
    available: false,
    file: `/fixture/${over.id}/agent.md`,
    model: 'claude-sonnet-5',
    tools: [],
    maxTurns: 8,
    language: 'mirror',
    ...over,
  } as unknown as AgentSummary;
}

function catalogOf(list: AgentSummary[]): AgentCatalog {
  const find = (value: string) => list.find((a) => a.id === value || a.handle === value);
  return {
    list: () => list,
    get: (id: string) => find(id) as never,
    byHandle: (handle: string) => find(handle) as never,
    agentsWithRole: () => [],
    agentForRole: () => ({ ok: false }) as never,
    defaultAgent: () => list[0] as never,
    resolve: (value?: string) => (value ? find(value) : list[0]) as never,
  } as unknown as AgentCatalog;
}

const father = summary({ id: 'agent-father', handle: 'father', name: 'Agent Father' });
const concierge = summary({ id: 'concierge', handle: 'buddi', name: 'Concierge' });

describe('the examples a fresh install has not grown into yet', () => {
  it('names Agent Father, and only it', () => {
    expect([...EXAMPLES_HELD_BACK]).toEqual(['agent-father']);
  });

  it('keeps it off the roster while there is no assistant and no brain', () => {
    const roster = withHeldBackExamples(catalogOf([concierge, father]));
    expect(roster.list().map((a) => a.id)).toEqual(['concierge']);
  });

  it('keeps it off the roster while the owner’s own agent cannot run', () => {
    const mine = summary({ id: 'ada', source: 'private', available: false });
    expect(withHeldBackExamples(catalogOf([mine, father])).list().map((a) => a.id)).toEqual(['ada']);
  });

  it('lists it once the owner has an assistant that can run', () => {
    const mine = summary({ id: 'ada', source: 'private', available: true });
    expect(withHeldBackExamples(catalogOf([mine, father])).list().map((a) => a.id)).toEqual(['ada', 'agent-father']);
  });

  it('never hides an agent of the owner’s own, whatever it is called', () => {
    const theirs = summary({ id: 'agent-father', source: 'private', available: false });
    expect(withHeldBackExamples(catalogOf([theirs])).list().map((a) => a.id)).toEqual(['agent-father']);
  });

  it('still resolves the held-back agent by id and by handle', () => {
    // Held back is not deleted: `/new`, a handle typed by hand and the wizard's
    // own collision check all keep answering for it.
    const roster = withHeldBackExamples(catalogOf([concierge, father]));
    expect(roster.get('agent-father')?.name).toBe('Agent Father');
    expect(roster.byHandle('father')?.id).toBe('agent-father');
    expect(roster.resolve('father')?.id).toBe('agent-father');
  });
});
