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
import { APPROVAL_RESUME_SPEAKER, type AgentCatalog, type CatalogAgent } from '@buddi/core';
import { WebChat, readChatTranscript, unavailableMessage } from './chat.js';

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

/* ------------------------------------------------------------------ *
 * A decided approval is not the owner speaking
 * ------------------------------------------------------------------ */

/**
 * The run resumes with the action's outcome as a user turn — the API requires
 * it, because the tool_use it answers was closed when the run suspended. What
 * must never happen is the dashboard drawing "tool result (deferred) for
 * action …: succeeded" as a sentence the owner typed.
 */
describe('the turn that carries a decided approval', () => {
  const actionId = '3f0d2f2e-1a5f-4a1e-9d3c-2b6d1f0a7c11';
  const conversationId = '11111111-1111-1111-1111-111111111111';

  function pool(speaker: string | null): never {
    return {
      query: vi.fn(async (sql: string) => {
        if (/from core\.conversations/.test(sql)) {
          return { rows: [{ id: conversationId, agent_id: 'ada', group_id: null, created_at: new Date() }] };
        }
        if (/from core\.messages/.test(sql)) {
          return {
            rows: [{
              id: 'm1',
              role: 'user',
              created_at: new Date(),
              speaker,
              content: [{
                type: 'text',
                text: `tool result (deferred) for action ${actionId}: succeeded\nresult: {"ok":true}`,
              }],
            }],
          };
        }
        if (/from core\.actions/.test(sql)) {
          return { rows: [{ id: actionId, tool: 'platform.create_agent', state: 'succeeded', outcome: { result: { id: 'ledger' } } }] };
        }
        return { rows: [] };
      }),
    } as never;
  }

  it('comes back as the action it is, with the result the row holds', async () => {
    const transcript = await readChatTranscript(pool(APPROVAL_RESUME_SPEAKER), conversationId);
    expect(transcript!.messages[0]!.blocks).toEqual([{
      type: 'approval_result',
      actionId,
      name: 'platform.create_agent',
      state: 'succeeded',
      output: { id: 'ledger' },
    }]);
    expect(transcript!.messages[0]!.speaker).toBe(APPROVAL_RESUME_SPEAKER);
  });

  it('leaves every other turn exactly as it was', async () => {
    const transcript = await readChatTranscript(pool(null), conversationId);
    expect(transcript!.messages[0]!.blocks[0]!.type).toBe('text');
  });
});
