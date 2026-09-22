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

/* ------------------------------------------------------------------ *
 * A settled approval, classified for a human
 * ------------------------------------------------------------------ */

/**
 * A pre-dispatch refusal is not a success, and the transcript is where that
 * matters most.
 *
 * The gate's answer is replaced, on read, by the state of the action it names.
 * If the classification forgets a terminal state, the block comes back `ok`
 * with no error and `MessageList` draws a green tick — so an `email.send`
 * refused because the owner edited the draft under a standing approval would
 * read, in the one place they are most likely to look, as a send that happened.
 */
describe('a gated call whose approval has settled', () => {
  const conversationId = '00000000-0000-4000-8000-00000000000c';
  const actionId = '00000000-0000-4000-8000-00000000000d';
  const toolUseId = 'tu-1';

  function pool(state: string): never {
    return {
      query: vi.fn(async (sql: string) => {
        if (/from core\.conversations/.test(sql)) {
          return { rows: [{ id: conversationId, agent_id: 'ada', group_id: null, created_at: new Date() }] };
        }
        if (/from core\.messages/.test(sql)) {
          return {
            rows: [
              {
                id: 'm1',
                role: 'assistant',
                created_at: new Date(),
                speaker: null,
                content: [{ type: 'tool_use', id: toolUseId, name: 'email.send', input: { draftId: 'd1' } }],
              },
              {
                id: 'm2',
                role: 'user',
                created_at: new Date(),
                speaker: null,
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: `awaiting owner approval (action ${actionId}); this effect has not happened`,
                  },
                ],
              },
            ],
          };
        }
        if (/from core\.actions/.test(sql)) {
          return {
            rows: [{ id: actionId, tool: 'email.send', state, outcome: { reason: 'effect-changed' } }],
          };
        }
        return { rows: [] };
      }),
    } as never;
  }

  it('draws a refused approval as a refusal, never as a green tick', async () => {
    const transcript = await readChatTranscript(pool('refused'), conversationId);
    const blocks = transcript!.messages.flatMap((m) => m.blocks);
    const result = blocks.find((b) => b.type === 'tool_result') as never as {
      ok: boolean;
      error?: string;
      approval?: { state: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Action refused');
    expect(result.approval).toMatchObject({ state: 'refused' });
  });

  it('still draws a succeeded one as a success', async () => {
    const transcript = await readChatTranscript(pool('succeeded'), conversationId);
    const blocks = transcript!.messages.flatMap((m) => m.blocks);
    const result = blocks.find((b) => b.type === 'tool_result') as never as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * A delegation, told where it went
 * ------------------------------------------------------------------ */

/**
 * The call the dashboard draws carries the colleague's conversation long
 * before the colleague has answered. Without it the panel beside the thread
 * would have nothing to read until the run was over, which is exactly the
 * minute the owner wants to watch.
 */
describe('an agent.delegate call in a transcript', () => {
  const conversationId = '22222222-2222-2222-2222-222222222222';
  const delegated = '33333333-3333-3333-3333-333333333333';

  function pool(events: unknown[], input: unknown = { agent: 'ledger', task: 'What did we spend?' }): never {
    return {
      query: vi.fn(async (sql: string) => {
        if (/from core\.conversations/.test(sql)) {
          return { rows: [{ id: conversationId, agent_id: 'ada', group_id: null, created_at: new Date() }] };
        }
        if (/from core\.messages/.test(sql)) {
          return {
            rows: [{
              id: 'm1',
              role: 'assistant',
              created_at: new Date(),
              speaker: null,
              // The call, and no result: the colleague is still working.
              content: [{ type: 'tool_use', id: 'toolu_1', name: 'agent.delegate', input }],
            }],
          };
        }
        if (/delegation\.started/.test(sql)) return { rows: events.map((payload) => ({ payload })) };
        return { rows: [] };
      }),
    } as never;
  }

  it('carries the delegated conversation on the call, before any result', async () => {
    const transcript = await readChatTranscript(
      pool([{ from: 'ada', to: 'ledger', agentId: 'ledger', conversationId: delegated, runId: 'run-9', toolUseId: 'toolu_1' }]),
      conversationId,
    );
    expect(transcript!.messages[0]!.blocks[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'agent.delegate',
      input: { agent: 'ledger', task: 'What did we spend?', conversationId: delegated, agentId: 'ledger', runId: 'run-9' },
    });
  });

  it('carries no ids at all when no conversation was opened', async () => {
    const transcript = await readChatTranscript(pool([]), conversationId);
    expect(transcript!.messages[0]!.blocks[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'agent.delegate',
      input: { agent: 'ledger', task: 'What did we spend?' },
    });
  });

  /*
   * The one that matters: a model may write whatever it likes into a tool
   * call, and these three keys are what the dashboard opens a live panel
   * from. They are the installation's to write.
   */
  it('strips ids the model wrote itself, so no panel can be conjured', async () => {
    const written = {
      agent: 'ledger',
      task: 'What did we spend?',
      conversationId: '44444444-4444-4444-4444-444444444444',
      agentId: 'somebody-else',
      runId: 'run-invented',
    };
    const refused = await readChatTranscript(pool([], written), conversationId);
    expect(refused!.messages[0]!.blocks[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'agent.delegate',
      input: { agent: 'ledger', task: 'What did we spend?' },
    });

    // And when a delegation really did open one, the event's ids win.
    const real = await readChatTranscript(
      pool([{ agentId: 'ledger', conversationId: delegated, runId: 'run-9', toolUseId: 'toolu_1' }], written),
      conversationId,
    );
    expect((real!.messages[0]!.blocks[0] as { input: Record<string, unknown> }).input).toEqual({
      agent: 'ledger',
      task: 'What did we spend?',
      conversationId: delegated,
      agentId: 'ledger',
      runId: 'run-9',
    });
  });
});

/* ------------------------------------------------------------------ *
 * Which run finished
 * ------------------------------------------------------------------ */

/**
 * A conversation can have two runs open at once — a resumed turn, a colleague
 * writing into the thread — and a finish that is paired onto the wrong one
 * shows the owner a thread as over while it is still going. The event's own
 * `runId` decides.
 */
describe('runs in a transcript', () => {
  const conversationId = '55555555-5555-5555-5555-555555555555';

  function pool(events: Array<{ kind: string; payload: Record<string, unknown>; at: string }>): never {
    return {
      query: vi.fn(async (sql: string) => {
        if (/from core\.conversations/.test(sql)) {
          return { rows: [{ id: conversationId, agent_id: 'ada', group_id: null, created_at: new Date() }] };
        }
        if (/run\.started/.test(sql)) {
          return { rows: events.map((e) => ({ kind: e.kind, payload: e.payload, created_at: new Date(e.at) })) };
        }
        return { rows: [] };
      }),
    } as never;
  }

  it('closes the run the event names, not the first one still open', async () => {
    const transcript = await readChatTranscript(
      pool([
        { kind: 'run.started', payload: { runId: 'run-a' }, at: '2026-09-21T09:00:00Z' },
        { kind: 'run.started', payload: { runId: 'run-b' }, at: '2026-09-21T09:00:01Z' },
        { kind: 'run.finished', payload: { runId: 'run-b', turns: 2 }, at: '2026-09-21T09:00:05Z' },
      ]),
      conversationId,
    );
    const runs = transcript!.runs;
    expect(runs.map((r) => [r.runId, r.finishedAt !== null])).toEqual([['run-a', false], ['run-b', true]]);
    expect(runs[1]!.turns).toBe(2);
  });

  it('still pairs a finish that names no run onto the one that is open', async () => {
    const transcript = await readChatTranscript(
      pool([
        { kind: 'run.started', payload: { runId: 'run-a' }, at: '2026-09-21T09:00:00Z' },
        { kind: 'run.finished', payload: { turns: 1 }, at: '2026-09-21T09:00:03Z' },
      ]),
      conversationId,
    );
    expect(transcript!.runs).toHaveLength(1);
    expect(transcript!.runs[0]!.finishedAt).not.toBeNull();
  });
});
