/**
 * No brain, no turn.
 *
 * The dashboard replaces the composer with a sentence when an agent's account
 * is missing, disabled or unconfigured. This is the half that makes it true:
 * the send is refused here, before a row is written or a provider is reached,
 * with the same sentence the page shows. The rest of the send path needs a
 * database and lives in `chat.web.db.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentCatalog, CatalogAgent } from '@buddi/core';
import { WebChat, unavailableMessage } from './chat.js';

const problem = 'Provider account “Work API” is disabled.';

function agent(available: boolean): CatalogAgent {
  return {
    id: 'ada',
    handle: 'ada',
    name: 'Ada',
    availability: available ? { ok: true } : { ok: false, problem: { code: 'missing-credential', message: problem } },
  } as unknown as CatalogAgent;
}

/** A pool that fails the test if the refusal ever reaches the database. */
const refusingPool = {
  query: () => {
    throw new Error('the database was touched for a turn that should have been refused');
  },
  connect: () => {
    throw new Error('the database was touched for a turn that should have been refused');
  },
};

function service(available: boolean): WebChat {
  const one = agent(available);
  const catalog = {
    get: (id: string) => (id === 'ada' ? one : undefined),
    byHandle: (handle: string) => (handle === 'ada' ? one : undefined),
    list: () => [],
  } as unknown as AgentCatalog;
  return new WebChat({
    pool: refusingPool as never,
    catalog,
    registry: {} as never,
    ctx: { ownerId: 'owner' } as never,
    now: () => new Date(),
    timezone: 'UTC',
    providerFor: () => ({}) as never,
    log: vi.fn(),
  });
}

describe('sending to an agent whose account cannot run', () => {
  it('is refused with the reason, and never reaches the database', async () => {
    const sent = await service(false).send({ agentId: 'ada', text: 'Are you there?' } as never);
    expect(sent).toEqual({ ok: false, status: 409, error: `Ada cannot run here: ${problem}` });
  });

  it('says the same sentence the page prints above its composer', () => {
    expect(unavailableMessage(agent(false) as never)).toBe(`Ada cannot run here: ${problem}`);
    expect(unavailableMessage(agent(true) as never)).toBe('');
  });

  it('still refuses an agent that is not installed at all, with a 404', async () => {
    const sent = await service(false).send({ agentId: 'nobody', text: 'Hello?' } as never);
    expect(sent).toMatchObject({ ok: false, status: 404 });
  });
});
