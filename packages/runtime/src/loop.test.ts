import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '@buddi/core';
import type { AgentDefinition, PluginManifest, ToolContext } from '@buddi/core';
import type {
  CompletionRequest,
  CompletionResponse,
  RuntimeProvider,
} from './anthropic.js';
import { createConversation, loadMessages, runAgent, type Queryable } from './loop.js';

/* ---------------- in-memory fake DB (only `query`) ---------------- */

type MessageRow = { id: number; conversation_id: string; role: string; content: unknown };
type EventRow = { kind: string; conversation_id: string; payload: unknown };

class FakeDb implements Queryable {
  conversations: { id: string; agent_id: string }[] = [];
  messages: MessageRow[] = [];
  events: EventRow[] = [];
  #seq = 0;

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('insert into core.conversations')) {
      const id = `conv-${this.conversations.length + 1}`;
      this.conversations.push({ id, agent_id: params[0] });
      return { rows: [{ id }] };
    }
    if (text.startsWith('insert into core.messages')) {
      this.messages.push({
        id: ++this.#seq,
        conversation_id: params[0],
        role: params[1],
        content: JSON.parse(params[2]),
      });
      return { rows: [] };
    }
    if (text.startsWith('select role, content from core.messages')) {
      return {
        rows: this.messages
          .filter((m) => m.conversation_id === params[0])
          .map((m) => ({ role: m.role, content: m.content })),
      };
    }
    if (text.startsWith('insert into core.events')) {
      this.events.push({
        kind: params[0],
        conversation_id: params[1],
        payload: JSON.parse(params[2]),
      });
      return { rows: [] };
    }
    throw new Error(`FakeDb: unexpected sql: ${text}`);
  }

  eventKinds(): string[] {
    return this.events.map((e) => e.kind);
  }
}

/* ---------------- fixtures ---------------- */

const ctx: ToolContext = {
  db: {} as ToolContext['db'],
  ownerId: 'owner-1',
  now: () => new Date('2026-01-01T00:00:00Z'),
};

const agent: AgentDefinition = {
  id: 'finance',
  name: 'Finance',
  systemPrompt: 'You advise on money.',
  tools: ['demo.double'],
  provider: {
    kind: 'anthropic',
    credential: { kind: 'api-key', env: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-5',
  },
  maxTurns: 4,
};

function registryWithDouble(): ToolRegistry {
  const manifest: PluginManifest = {
    name: 'demo',
    version: '0.0.1',
    schema: 'demo',
    migrationsDir: '/tmp/demo',
    tools: [
      {
        name: 'demo.double',
        description: 'Doubles a number.',
        tier: 'auto',
        input: z.object({ n: z.number() }),
        execute: async (input: { n: number }) => ({ doubled: input.n * 2 }),
      },
    ],
  };
  const r = new ToolRegistry();
  r.register(manifest);
  return r;
}

/** A provider that replays a scripted sequence of responses. */
function scriptedProvider(script: CompletionResponse[]): RuntimeProvider & {
  calls: CompletionRequest[];
} {
  const calls: CompletionRequest[] = [];
  let i = 0;
  return {
    calls,
    async complete(req) {
      calls.push(structuredClone(req));
      const next = script[Math.min(i, script.length - 1)];
      i++;
      if (!next) throw new Error('script exhausted');
      return next;
    },
  };
}

const usage = { input: 5, output: 2 };

/* ---------------- tests ---------------- */

describe('createConversation / loadMessages', () => {
  it('creates a conversation and reads back persisted messages', async () => {
    const db = new FakeDb();
    const id = await createConversation(db, 'finance');
    expect(id).toBe('conv-1');
    expect(await loadMessages(db, id)).toEqual([]);
  });
});

describe('runAgent', () => {
  it('fails closed when the agent names an unregistered tool — before any API call', async () => {
    const db = new FakeDb();
    const provider = scriptedProvider([]);
    await expect(
      runAgent({
        agent: { ...agent, tools: ['demo.double', 'ghost.tool'] },
        provider,
        registry: registryWithDouble(),
        ctx,
        pool: db,
        conversationId: 'conv-1',
        userMessage: 'hi',
      }),
    ).rejects.toThrow(/ghost\.tool/);
    expect(provider.calls).toHaveLength(0);
    expect(db.messages).toHaveLength(0);
    expect(db.events).toHaveLength(0);
  });

  it('runs one tool-call round trip and persists everything', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider([
      {
        content: [
          { type: 'text', text: 'let me compute' },
          { type: 'tool_use', id: 'tu_1', name: 'demo.double', input: { n: 21 } },
        ],
        stopReason: 'tool_use',
        usage,
        model: 'claude-sonnet-5',
      },
      {
        content: [{ type: 'text', text: 'It is 42.' }],
        stopReason: 'end_turn',
        usage,
        model: 'claude-sonnet-5',
      },
    ]);
    const onText = vi.fn();
    const onToolCall = vi.fn();

    const result = await runAgent({
      agent,
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'double 21',
      onText,
      onToolCall,
    });

    expect(result).toEqual({
      text: 'It is 42.',
      turns: 2,
      stopped: 'end_turn',
      usage: { input: 10, output: 4 },
    });
    expect(onToolCall).toHaveBeenCalledWith('demo.double', { n: 21 });
    expect(onText).toHaveBeenNthCalledWith(1, 'let me compute');
    expect(onText).toHaveBeenNthCalledWith(2, 'It is 42.');

    // The tool schema reached the model.
    expect(provider.calls[0]?.tools).toEqual([
      {
        name: 'demo.double',
        description: 'Doubles a number.',
        input_schema: expect.objectContaining({ type: 'object' }),
      },
    ]);
    expect(provider.calls[0]?.system).toBe('You advise on money.');

    // user, assistant, user(tool_result), assistant
    expect(db.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(db.messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: JSON.stringify({ doubled: 42 }) },
    ]);

    // The second provider call saw the whole transcript.
    expect(provider.calls[1]?.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);

    expect(db.eventKinds()).toEqual([
      'run.started',
      'tool.called',
      'tool.result',
      'run.finished',
    ]);
    expect(db.events.at(-1)?.payload).toMatchObject({ turns: 2, stopped: 'end_turn' });
    expect(db.events[2]?.payload).toEqual({ name: 'demo.double', ok: true });
  });

  it('returns an is_error tool_result for an unknown tool and keeps going', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider([
      {
        content: [{ type: 'tool_use', id: 'tu_x', name: 'demo.nope', input: {} }],
        stopReason: 'tool_use',
        usage,
        model: 'claude-sonnet-5',
      },
      {
        content: [{ type: 'text', text: 'sorry, I cannot.' }],
        stopReason: 'end_turn',
        usage,
        model: 'claude-sonnet-5',
      },
    ]);

    const result = await runAgent({
      agent,
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'do the impossible',
    });

    expect(result.stopped).toBe('end_turn');
    expect(result.turns).toBe(2);

    const toolResultMsg = db.messages.find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as any[])[0]?.type === 'tool_result',
    );
    expect((toolResultMsg?.content as any[])[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_x',
      is_error: true,
    });
    expect((toolResultMsg?.content as any[])[0].content).toMatch(/^unknown-tool: /);

    expect(db.events.find((e) => e.kind === 'tool.result')?.payload).toEqual({
      name: 'demo.nope',
      ok: false,
      reason: 'unknown-tool',
    });
  });

  it('surfaces a refusal (invalid args) to the model without throwing', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider([
      {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'demo.double', input: { n: 'x' } }],
        stopReason: 'tool_use',
        usage,
        model: 'claude-sonnet-5',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage, model: 'm' },
    ]);

    await runAgent({
      agent,
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'double x',
    });

    expect(db.events.find((e) => e.kind === 'tool.result')?.payload).toMatchObject({
      ok: false,
      reason: 'invalid-args',
    });
  });

  it('stops at maxTurns when the model keeps calling tools', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider([
      {
        content: [{ type: 'tool_use', id: 'tu_loop', name: 'demo.double', input: { n: 1 } }],
        stopReason: 'tool_use',
        usage,
        model: 'claude-sonnet-5',
      },
    ]);

    const result = await runAgent({
      agent: { ...agent, maxTurns: 3 },
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'loop forever',
    });

    expect(result.stopped).toBe('max_turns');
    expect(result.turns).toBe(3);
    expect(provider.calls).toHaveLength(3);
    expect(db.events.at(-1)).toMatchObject({
      kind: 'run.finished',
      payload: { turns: 3, stopped: 'max_turns' },
    });
  });

  it('reports max_tokens as its own stop reason', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider([
      {
        content: [{ type: 'text', text: 'truncat' }],
        stopReason: 'max_tokens',
        usage,
        model: 'claude-sonnet-5',
      },
    ]);
    const result = await runAgent({
      agent,
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'write an epic',
    });
    expect(result.stopped).toBe('max_tokens');
    expect(result.turns).toBe(1);
  });

  it('replays prior conversation history into the first provider call', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    await db.query(
      `insert into core.messages (conversation_id, role, content) values ($1, $2, $3::jsonb)`,
      [conversationId, 'user', JSON.stringify([{ type: 'text', text: 'earlier' }])],
    );
    const provider = scriptedProvider([
      { content: [{ type: 'text', text: 'hi' }], stopReason: 'end_turn', usage, model: 'm' },
    ]);

    await runAgent({
      agent,
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'now',
    });

    expect(provider.calls[0]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'earlier' }] },
      { role: 'user', content: [{ type: 'text', text: 'now' }] },
    ]);
  });
});
