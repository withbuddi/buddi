import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CLI_SURFACE, OWNER_INTERJECTION_SPEAKER, SCHEDULED_SURFACE, TELEGRAM_SURFACE, ToolRegistry, surfaceSection } from '@buddi/core';
import type { AgentDefinition, PluginManifest, ToolContext } from '@buddi/core';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  NeutralMessage,
  RuntimeProvider,
} from './anthropic.js';
import { providerCapabilities, type ProviderCapabilities } from './capabilities.js';
import {
  InterjectionQueue,
  MAX_TOKENS_NOTICE,
  approvalOutcomeText,
  composeSystem,
  createConversation,
  isPreamble,
  joinSpoken,
  loadMessages,
  maxTurnsNotice,
  normalizeForReplay,
  producedArtifactIds,
  runAgent,
  selectTools,
  type Queryable,
} from './loop.js';

/* ---------------- in-memory fake DB (only `query`) ---------------- */

type MessageRow = { id: number; conversation_id: string; role: string; content: unknown; speaker?: string | null };
type EventRow = { kind: string; conversation_id: string; payload: unknown };

const ACTION_ID = '22222222-2222-2222-2222-222222222222';

class FakeDb implements Queryable {
  actions: { tool: string; args: unknown }[] = [];
  conversations: { id: string; agent_id: string }[] = [];
  messages: MessageRow[] = [];
  events: EventRow[] = [];
  /** Every durable write, in the order it happened, so ordering can be asserted. */
  writes: string[] = [];
  #seq = 0;

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('insert into core.conversations')) {
      const id = `conv-${this.conversations.length + 1}`;
      this.conversations.push({ id, agent_id: params[0] });
      return { rows: [{ id }] };
    }
    if (text.startsWith('insert into core.messages') || text.startsWith('with turn as ( insert into core.messages')) {
      this.writes.push(`message:${params[1]}`);
      this.messages.push({
        id: ++this.#seq,
        conversation_id: params[0],
        role: params[1],
        content: JSON.parse(params[2]),
        speaker: (params[3] as string | undefined) ?? null,
      });
      return { rows: [{ id: this.messages.at(-1)!.id }] };
    }
    if (text.startsWith('select role, content from core.messages')) {
      return {
        rows: this.messages
          .filter((m) => m.conversation_id === params[0])
          .map((m) => ({ role: m.role, content: m.content })),
      };
    }
    if (text.startsWith('with a as ( insert into core.actions')) {
      // The gated path records an action plus its pending approval in one
      // statement; the fake answers it with the row it would have written.
      this.actions.push({ tool: params[0], args: JSON.parse(params[5]) });
      return {
        rows: [
          {
            id: ACTION_ID,
            tool: params[0],
            tool_version: params[1],
            agent_id: params[2],
            conversation_id: params[3],
            job_id: params[4],
            canonical_args: JSON.parse(params[5]),
            envelope: JSON.parse(params[6]),
            args_hash: params[7],
            preview: params[8],
            expires_at: params[9],
            policy_version: params[10],
            created_at: params[11],
            state: 'pending',
            updated_at: params[11],
          },
        ],
      };
    }
    if (text.startsWith('insert into core.events')) {
      this.writes.push(`event:${params[0]}`);
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
  timezone: 'UTC',
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

it('includes registered system tools even without an agent grant, once only', () => {
  const registry = registryWithDouble();
  registry.register({ name: 'system', version: '0.1.0', schema: 'system', migrationsDir: '', tools:
    ['system.time', 'system.info'].map(name => ({ name, description: 'Platform facts', tier: 'auto' as const, input: z.object({}), execute: async () => ({}) })) });
  expect(selectTools(registry, agent).map(t => t.name)).toEqual(['demo.double', 'system.time', 'system.info']);
  expect(selectTools(registry, { ...agent, tools: [...agent.tools, 'system.time'] }).filter(t => t.name === 'system.time')).toHaveLength(1);
});

it('injects platform context on every surface and applies owner timezone to tools without mutating shared context', async () => {
  for (const surface of [CLI_SURFACE, TELEGRAM_SURFACE, SCHEDULED_SURFACE]) {
    const db = new FakeDb();
    const registry = registryWithDouble();
    let seenTimezone = '';
    registry.register({ name: 'check', version: '0.1.0', schema: 'check', migrationsDir: '', tools: [{
      name: 'check.timezone', description: 'Check timezone', tier: 'auto', input: z.object({}),
      execute: async (_input, toolCtx) => { seenTimezone = toolCtx.timezone; return {}; },
    }] });
    const provider = scriptedProvider([
      { model: 'fixture', content: [{ type: 'tool_use', id: 'tz', name: 'check.timezone', input: {} }], stopReason: 'tool_use', usage },
      { model: 'fixture', content: [{ type: 'text', text: 'Done' }], stopReason: 'end_turn', usage },
    ]);
    const runCtx = { ...ctx, systemContext: async () => ({ timezone: 'Asia/Tokyo', prompt: 'Current host: fixture macOS. Local date: 2026-01-01.' }) };
    await runAgent({ agent: { ...agent, tools: ['check.timezone'] }, provider, registry, ctx: runCtx, pool: db,
      conversationId: await createConversation(db, agent.id), userMessage: 'Check time', surface });
    expect(provider.calls[0]!.system).toContain('Current host: fixture macOS');
    expect(seenTimezone).toBe('Asia/Tokyo');
    expect(runCtx.timezone).toBe('UTC');
  }
});

/* ---------------- tests ---------------- */

describe('createConversation / loadMessages', () => {
  it('creates a conversation and reads back persisted messages', async () => {
    const db = new FakeDb();
    const id = await createConversation(db, 'finance');
    expect(id).toBe('conv-1');
    expect(await loadMessages(db, id)).toEqual([]);
  });
});

describe('producedArtifactIds', () => {
  it('reads files a tool names in a list, or the one it names at the top', () => {
    const a = '0f6eda1f-2ac5-4a79-b9f1-548d216a797a';
    const b = '1f6eda1f-2ac5-4a79-b9f1-548d216a797a';
    expect(producedArtifactIds({ artifacts: [{ id: a }, { artifactId: b }, { id: 'nope' }] })).toEqual([a, b]);
    expect(producedArtifactIds({ artifactId: a, sent: false })).toEqual([a]);
    expect(producedArtifactIds({ artifacts: [{ id: a }], artifactId: a })).toEqual([a]);
    expect(producedArtifactIds('text')).toEqual([]);
  });
});

describe('composeSystem', () => {
  it('returns the agent prompt untouched when there is neither surface nor suffix', () => {
    expect(composeSystem('base')).toBe('base');
    expect(composeSystem('base', '   ')).toBe('base');
  });

  it('appends the one-off suffix last, so it is the final word', () => {
    expect(composeSystem('base', 'This is the first run.')).toBe(
      'base\n\nThis is the first run.',
    );
  });

  it('prepends the memory preamble, so the persona still reads last', () => {
    expect(composeSystem('base', undefined, '## What you remember\n- paid biweekly')).toBe(
      '## What you remember\n- paid biweekly\n\nbase',
    );
    expect(composeSystem('base', 'first run', 'remembered')).toBe(
      'remembered\n\nbase\n\nfirst run',
    );
  });

  it('treats an empty memory block as no block at all', () => {
    expect(composeSystem('base', undefined, '')).toBe('base');
    expect(composeSystem('base', undefined, '  \n ')).toBe('base');
  });

  it('composes memory, persona, surface and suffix in that fixed order', () => {
    // The order is the contract: the surface paragraph is authoritative over
    // the persona, and the one-off suffix is the only part about *this* turn.
    expect(composeSystem('base', 'first run', 'remembered', TELEGRAM_SURFACE)).toBe(
      `remembered\n\nbase\n\n${surfaceSection(TELEGRAM_SURFACE)}\n\nfirst run`,
    );
  });

  it('composes the surface with no suffix, and a suffix with no surface', () => {
    expect(composeSystem('base', undefined, undefined, CLI_SURFACE)).toBe(
      `base\n\n${surfaceSection(CLI_SURFACE)}`,
    );
    expect(composeSystem('base', 'first run')).toBe('base\n\nfirst run');
  });
});

describe('runAgent', () => {
  it('blocks same-batch and later tools after a question, then allows work on the next owner turn', async () => {
    const db = new FakeDb();
    const execute = vi.fn(async () => 'done');
    const registry = new ToolRegistry();
    registry.register({ name: 'demo', version: '1', schema: 'demo', migrationsDir: '', tools: [
      { name: 'demo.ask', description: 'ask', tier: 'auto', waitsForOwner: true, input: z.object({}), execute: async () => ({ pending: true }) },
      { name: 'demo.double', description: 'work', tier: 'auto', input: z.object({}), execute },
    ] });
    const call = (id: string, name: string) => ({ type: 'tool_use' as const, id, name, input: {} });
    const provider = scriptedProvider([
      { content: [call('question', 'demo.ask'), call('same-batch', 'demo.double')], stopReason: 'tool_use', usage, model: 'test' },
      { content: [call('later-batch', 'demo.double')], stopReason: 'tool_use', usage, model: 'test' },
      { content: [{ type: 'text', text: 'Wait for the export?' }], stopReason: 'end_turn', usage, model: 'test' },
    ]);
    const askingAgent = { ...agent, tools: ['demo.ask', 'demo.double'] };
    const result = await runAgent({ agent: askingAgent, provider, registry, ctx, pool: db, conversationId: 'probe', userMessage: 'Consolidate these' });
    expect(result.text).toBe('Wait for the export?');
    expect(execute).not.toHaveBeenCalled();
    expect(provider.calls[1]?.tools).toEqual([]);
    expect(provider.calls[2]?.tools).toEqual([]);
    expect(provider.calls[1]?.nativeSearch).toBeUndefined();
    for (const id of ['same-batch', 'later-batch']) {
      expect(db.messages.flatMap((m) => m.content as unknown[])).toContainEqual(expect.objectContaining({
        tool_use_id: id, is_error: true, content: expect.stringContaining('waiting for the owner to answer'),
      }));
    }
    const answer = scriptedProvider([
      { content: [call('after-answer', 'demo.double')], stopReason: 'tool_use', usage, model: 'test' },
      { content: [{ type: 'text', text: 'Done' }], stopReason: 'end_turn', usage, model: 'test' },
    ]);
    await runAgent({ agent: askingAgent, provider: answer, registry, ctx, pool: db, conversationId: 'probe', userMessage: 'Proceed now' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not block tools for a failed question or an ordinary pending-shaped tool result', async () => {
    for (const failing of [true, false]) {
      const db = new FakeDb();
      const execute = vi.fn(async () => 'done');
      const registry = new ToolRegistry();
      registry.register({ name: 'demo', version: '1', schema: 'demo', migrationsDir: '', tools: [
        { name: 'demo.ask', description: 'ask', tier: 'auto', waitsForOwner: failing, input: z.object({}), execute: async () => {
          if (failing) throw new Error('question not recorded');
          return { pending: true };
        } },
        { name: 'demo.double', description: 'work', tier: 'auto', input: z.object({}), execute },
      ] });
      const provider = scriptedProvider([
        { content: ['demo.ask', 'demo.double'].map((name) => ({ type: 'tool_use' as const, id: name, name, input: {} })), stopReason: 'tool_use', usage, model: 'test' },
        { content: [{ type: 'text', text: 'Done' }], stopReason: 'end_turn', usage, model: 'test' },
      ]);
      await runAgent({ agent: { ...agent, tools: ['demo.ask', 'demo.double'] }, provider, registry, ctx, pool: db, conversationId: 'probe', userMessage: 'hello' });
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });
  it('issues only the agent’s resolved session grants and refuses delegated authority', async () => {
    for (const delegationDepth of [0, 1]) {
      const db = new FakeDb();
      const execute = vi.fn(async () => 'browsed');
      const registry = new ToolRegistry();
      registry.register({ name: 'browser', version: '1', schema: 'browser', migrationsDir: '', tools: [{
        name: 'browser.act', description: 'browser', tier: 'session', input: z.object({}), execute,
      }] });
      const provider = scriptedProvider([
        { content: [{ type: 'tool_use', id: 'b1', name: 'browser.act', input: {} }], stopReason: 'tool_use', usage, model: 'test' },
        { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage, model: 'test' },
      ]);
      await runAgent({ agent: { ...agent, tools: ['browser.act'] }, provider, registry,
        ctx: { ...ctx, delegationDepth, ownerRequest: { id: 'owner-message', text: 'Open the site', expiresAt: Date.now() + 60_000 } },
        pool: db, conversationId: 'probe', userMessage: 'hello' });
      expect(execute).toHaveBeenCalledTimes(delegationDepth === 0 ? 1 : 0);
    }
  });

  it('skips later dependent actions after a browser failure and keeps all tool results paired', async () => {
    const db = new FakeDb();
    const execute = vi.fn(async () => { throw new Error('stale observation'); });
    const registry = new ToolRegistry();
    registry.register({ name: 'demo', version: '1', schema: 'demo', migrationsDir: '', tools: [{
      name: 'demo.double', description: 'sequential', tier: 'auto', sequential: true, input: z.object({}), execute,
    }] });
    const provider = scriptedProvider([
      { content: ['first', 'second'].map((id) => ({ type: 'tool_use' as const, id, name: 'demo.double', input: {} })), stopReason: 'tool_use', usage, model: 'test' },
      { content: [{ type: 'text', text: 'stopped' }], stopReason: 'end_turn', usage, model: 'test' },
    ]);
    await runAgent({ agent, provider, registry, ctx, pool: db, conversationId: 'probe', userMessage: 'hello' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.messages[2]?.content).toEqual([
      expect.objectContaining({ tool_use_id: 'first', is_error: true }),
      expect.objectContaining({ tool_use_id: 'second', is_error: true, content: expect.stringContaining('not-executed') }),
    ]);
  });

  it('sends only the latest tool image and never persists its base64', async () => {
    const db = new FakeDb();
    let imageNumber = 0;
    const registry = new ToolRegistry();
    registry.register({ name: 'demo', version: '1', schema: 'demo', migrationsDir: '', tools: [{
      name: 'demo.double', description: 'observe', tier: 'auto', input: z.object({}), execute: async () => ({ observed: true }),
      image: async () => ({ mime: 'image/jpeg', data: `picture-${++imageNumber}` }),
    }] });
    const call = (id: string): CompletionResponse => ({ content: [{ type: 'tool_use', id, name: 'demo.double', input: {} }], stopReason: 'tool_use', usage, model: 'test' });
    const provider = scriptedProvider([call('1'), call('2'), { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage, model: 'test' }]);
    await runAgent({ agent, provider, registry, ctx, pool: db, conversationId: 'probe', userMessage: 'hello' });
    expect(JSON.stringify(provider.calls[1])).toContain('picture-1');
    expect(JSON.stringify(provider.calls[2])).toContain('picture-2');
    expect(JSON.stringify(provider.calls[2])).not.toContain('picture-1');
    expect(JSON.stringify(db.messages)).not.toContain('picture-');
  });

  it.each(['auto', 'gated'] as const)('refuses an installed but ungranted %s tool at dispatch', async (tier) => {
    const db = new FakeDb();
    const execute = vi.fn(async () => 'should never run');
    const describeEffect = vi.fn(() => ({ envelope: {}, preview: 'should never be proposed' }));
    const registry = new ToolRegistry();
    registry.register({ name: 'hidden', version: '1', schema: 'hidden', migrationsDir: '', tools: [{
      name: 'hidden.call', description: 'hidden', tier, input: z.object({}),
      execute, describe: describeEffect,
    }] });
    const provider = scriptedProvider([
      { content: [{ type: 'tool_use', id: 'hidden-1', name: 'hidden.call', input: {} }], stopReason: 'tool_use', usage, model: 'test' },
      { content: [{ type: 'text', text: 'refused' }], stopReason: 'end_turn', usage, model: 'test' },
    ]);
    await runAgent({ agent: { ...agent, tools: [] }, provider, registry, ctx,
      pool: db, conversationId: 'probe', userMessage: 'hello' });
    expect(provider.calls[0]?.tools).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(describeEffect).not.toHaveBeenCalled();
    expect(db.actions).toEqual([]);
    expect(db.messages[2]?.content).toEqual([expect.objectContaining({
      is_error: true, content: expect.stringContaining('tool-not-granted'),
    })]);
  });

  it('stops between calls in a batch when the run is cancelled', async () => {
    const db = new FakeDb();
    const controller = new AbortController();
    const execute = vi.fn(async (_input: unknown, _ctx: ToolContext) => { controller.abort(new Error('stop now')); return 'stopped'; });
    const registry = new ToolRegistry();
    registry.register({ name: 'demo', version: '1', schema: 'demo', migrationsDir: '', tools: [{
      name: 'demo.double', description: 'probe', tier: 'auto', input: z.object({}), execute,
    }] });
    const provider = scriptedProvider([{
      content: ['first', 'second'].map((id) => ({ type: 'tool_use' as const, id, name: 'demo.double', input: {} })),
      stopReason: 'tool_use', usage, model: 'test',
    }]);
    await expect(runAgent({ agent, provider, registry, ctx: { ...ctx, signal: controller.signal },
      pool: db, conversationId: 'probe', userMessage: 'hello' })).rejects.toThrow('stop now');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
    expect(db.messages.at(-1)?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'first', content: '"stopped"' },
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'second', is_error: true, content: expect.stringContaining('not-executed') }),
    ]);
  });

  it('passes the one-off suffix to the provider as part of the system prompt', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage,
        model: 'claude-sonnet-5',
      },
    ]);
    await runAgent({
      agent,
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'hi',
      systemSuffix: 'This is the first run.',
    });
    expect(provider.calls[0]?.system).toBe(
      'You advise on money.\n\nThis is the first run.',
    );
    // The agent definition itself is untouched.
    expect(agent.systemPrompt).toBe('You advise on money.');
  });

  it('composes the declared surface profile into the system prompt', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage,
        model: 'claude-sonnet-5',
      },
    ]);
    await runAgent({
      agent,
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'hi',
      surface: TELEGRAM_SURFACE,
    });
    const system = provider.calls[0]?.system ?? '';
    expect(system).toContain('You are answering on Telegram.');
    expect(system).toContain('Markdown is not rendered here');
    expect(system).not.toContain('There is a canvas here');
  });

  it('tells a scheduled run that nobody is there to answer it', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage,
        model: 'claude-sonnet-5',
      },
    ]);
    await runAgent({
      agent,
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'hi',
      surface: SCHEDULED_SURFACE,
    });
    expect(provider.calls[0]?.system).toContain(
      'Nobody is here: this text is delivered as a notification and cannot be answered.',
    );
  });

  it('records the surface id on the run events, as provenance', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage,
        model: 'claude-sonnet-5',
      },
    ]);
    await runAgent({
      agent,
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'hi',
      surface: CLI_SURFACE,
    });
    const started = db.events.find((e) => e.kind === 'run.started');
    expect((started?.payload as { surface?: string }).surface).toBe('cli');
  });

  it('asks the memory hook for this agent and prepends what it returns', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage,
        model: 'claude-sonnet-5',
      },
    ]);
    const memoryPreamble = vi.fn(async (agentId: string) => `## What you remember (${agentId})`);

    await runAgent({
      agent,
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'hi',
      memoryPreamble,
    });

    expect(memoryPreamble).toHaveBeenCalledWith('finance');
    expect(provider.calls[0]?.system).toBe(
      '## What you remember (finance)\n\nYou advise on money.',
    );
  });

  it('gives tools the run provenance without mutating the caller context', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const seen: ToolContext[] = [];
    const manifest: PluginManifest = {
      name: 'probe',
      version: '0.0.1',
      schema: 'probe',
      migrationsDir: '/tmp/probe',
      tools: [
        {
          name: 'probe.ctx',
          description: 'Reports its context.',
          tier: 'auto',
          input: z.object({}),
          execute: async (_input: unknown, toolCtx: ToolContext) => {
            seen.push(toolCtx);
            return { ok: true };
          },
        },
      ],
    };
    const registry = new ToolRegistry();
    registry.register(manifest);

    const provider = scriptedProvider([
      {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'probe.ctx', input: {} }],
        stopReason: 'tool_use',
        usage,
        model: 'claude-sonnet-5',
      },
      {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage,
        model: 'claude-sonnet-5',
      },
    ]);

    await runAgent({
      agent: { ...agent, tools: ['probe.ctx'] },
      provider,
      registry,
      ctx,
      pool: db,
      conversationId,
      userMessage: 'go',
    });

    expect(seen[0]).toMatchObject({
      ownerId: 'owner-1',
      agentId: 'finance',
      conversationId,
    });
    expect(ctx).not.toHaveProperty('agentId');
    expect(ctx).not.toHaveProperty('conversationId');
  });

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

    expect(result).toMatchObject({
      // 'let me compute' is a preamble — single line, short, and followed by a
      // tool call the spinner already announced. The answer is what is left.
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

  /*
   * The silent ending, ended. A run that hits the budget used to leave a tool
   * result as the last thing in the transcript and say nothing to anybody; now
   * it says so itself, in the transcript, in `result.text` (which is what
   * Telegram and the CLI send) and through `onText` (which is what the browser
   * refreshes on) — all before `run.finished`, and with no model call.
   */
  it('says so in the transcript when it runs out of turns', async () => {
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
    const spoken: string[] = [];

    const result = await runAgent({
      agent: { ...agent, maxTurns: 3 },
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'loop forever',
      onText: (text) => { spoken.push(text); },
    });

    const notice = maxTurnsNotice(3);
    expect(notice).toContain('3 steps');
    // No extra provider call bought the sentence.
    expect(provider.calls).toHaveLength(3);
    expect(db.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: notice }],
    });
    expect(result.text).toBe(notice);
    expect(spoken).toEqual([notice]);
    // The owner is told before the run is recorded as over: a surface that
    // acts on `run.finished` must not beat the sentence into the transcript.
    expect(db.writes.slice(-2)).toEqual(['message:assistant', 'event:run.finished']);
    // And the event says the sentence was said, which is what the page needs
    // to know before it draws a marker under it.
    expect(db.events.at(-1)).toMatchObject({ payload: { stopped: 'max_turns', noticed: true } });
  });

  /*
   * The owner pressed Stop. They know it stopped; being told so is not news,
   * and the surface records the run as cancelled. The signal is re-read at the
   * end rather than trusted from the last time round the loop, because Stop
   * can land while the final tool result is being written.
   */
  it('says nothing about the budget when the owner cancelled the run', async () => {
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
    /*
     * A Stop that landed *after* the loop's last checkpoint. The double is a
     * signal that reports itself aborted and throws for nobody — which is
     * exactly the window this guard exists for: every `throwIfAborted` has
     * already been passed, and the only thing left to decide is whether to
     * speak.
     */
    const signal = new AbortController().signal;
    Object.defineProperty(signal, 'aborted', { get: () => true });
    const spoken: string[] = [];

    const result = await runAgent({
      agent: { ...agent, maxTurns: 1 },
      provider,
      registry: registryWithDouble(),
      ctx: { ...ctx, signal },
      pool: db,
      conversationId,
      userMessage: 'loop forever',
      onText: (text) => { spoken.push(text); },
    });

    expect(result.stopped).toBe('max_turns');
    expect(result.text).toBe('');
    expect(spoken).toEqual([]);
    expect(db.messages.map((m) => JSON.stringify(m.content)).join()).not.toContain('Stopped after');
    expect(db.events.at(-1)).toMatchObject({ kind: 'run.finished', payload: { noticed: false } });
  });

  /*
   * A run the owner is not in the room with keeps the budget to itself: the
   * cap is the platform's, not the agent's, and the answer is quoted into
   * somebody else's. See `budgetNotice`.
   */
  it('says nothing about the budget when the run is a delegate or a room member', async () => {
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
    const spoken: string[] = [];

    const result = await runAgent({
      agent: { ...agent, maxTurns: 2 },
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'loop forever',
      budgetNotice: false,
      onText: (text) => { spoken.push(text); },
    });

    expect(result.stopped).toBe('max_turns');
    expect(result.text).toBe('');
    expect(spoken).toEqual([]);
    expect(db.messages.map((m) => JSON.stringify(m.content)).join()).not.toContain('Stopped after');
    // The fact is still on the record, where a surface can read it.
    expect(db.events.at(-1)).toMatchObject({ kind: 'run.finished', payload: { stopped: 'max_turns' } });
  });

  /*
   * A transcript row the loop could not write must not cost the run its
   * ending: `run.finished` is what every surface reads to stop drawing a
   * spinner, and the sentence still travels in `result.text`.
   */
  it('still finishes the run when the budget sentence cannot be written', async () => {
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
      agent: { ...agent, maxTurns: 2 },
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'loop forever',
      onText: () => { throw new Error('the browser went away'); },
    });

    expect(result.text).toBe(maxTurnsNotice(2));
    expect(db.events.at(-1)).toMatchObject({ kind: 'run.finished', payload: { stopped: 'max_turns' } });
  });

  it('says so in the transcript when one answer ran too long', async () => {
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

    expect(db.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: MAX_TOKENS_NOTICE }],
    });
    expect(result.text).toBe(`truncat\n\n${MAX_TOKENS_NOTICE}`);
  });

  /*
   * The notice lands next to the assistant turn it follows, and two assistant
   * rows in a row are a 400 on the wire. The transcript keeps both; the replay
   * hands the provider one turn.
   */
  it('replays two adjacent assistant turns as one, and drops a call nobody answered', () => {
    expect(
      normalizeForReplay([
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'truncat' },
            { type: 'tool_use', id: 'tu_partial', name: 'demo.double', input: {} },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: MAX_TOKENS_NOTICE }] },
      ]),
    ).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'truncat' }, { type: 'text', text: MAX_TOKENS_NOTICE }],
      },
    ]);
  });

  it('drops a turn that was nothing but a call nobody answered', () => {
    expect(
      normalizeForReplay([
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_partial', name: 'demo.double', input: {} }] },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ]),
    ).toEqual([
      // The turn is gone, and the two user turns it separated are now one:
      // an empty content array and two user turns in a row are both 400s.
      { role: 'user', content: [{ type: 'text', text: 'go' }, { type: 'text', text: 'continue' }] },
    ]);
  });

  it('keeps a tool_use that its result answers', () => {
    const history: NeutralMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'demo.double', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '2' }] },
    ];
    expect(normalizeForReplay(history)).toEqual(history);
  });

  /*
   * The normalisation has to be *wired in*, not merely exported: the run after
   * a `max_tokens` stop is the one that would 400, and it is `runAgent` that
   * builds its request.
   */
  it('hands the provider one assistant turn when the transcript holds two', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    for (const text of ['earlier', 'and then']) {
      await db.query(
        `insert into core.messages (conversation_id, role, content) values ($1, $2, $3::jsonb)`,
        [conversationId, 'assistant', JSON.stringify([{ type: 'text', text }])],
      );
    }
    const provider = scriptedProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage, model: 'claude-sonnet-5' },
    ]);

    await runAgent({
      agent, provider, registry: registryWithDouble(), ctx, pool: db, conversationId,
      userMessage: 'continue',
    });

    const sent = provider.calls[0]!.messages;
    expect(sent.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(sent[0]!.content).toEqual([
      { type: 'text', text: 'earlier' },
      { type: 'text', text: 'and then' },
    ]);
  });

  /*
   * The worst shape the new silence can leave behind, end to end.
   *
   * A room member is cut off at `max_tokens` part-way through emitting a tool
   * call, so its turn is stored as that call and nothing else. It says nothing
   * — a member never does (`budgetNotice: false`) — so there is no text turn
   * after it either. Ask the same member again in the same room and the turn
   * has to vanish from the replay altogether: the call has no result, and what
   * is left of the turn is an empty content array.
   */
  it('replays a valid request after a member run was cut off mid tool call', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'room');
    const room = (speaker: string) => ({
      load: () => loadMessages(db, conversationId),
      speaker,
      openingSpeaker: 'coordinator',
    });

    const cutOff = scriptedProvider([
      {
        content: [{ type: 'tool_use', id: 'tu_partial', name: 'demo.double', input: {} }],
        stopReason: 'max_tokens',
        usage,
        model: 'claude-sonnet-5',
      },
    ]);
    const first = await runAgent({
      agent, provider: cutOff, registry: registryWithDouble(), ctx, pool: db, conversationId,
      userMessage: 'what do the books say?',
      transcript: room('ledger'),
      budgetNotice: false,
    });
    expect(first.stopped).toBe('max_tokens');
    // The record keeps the half-written call; it is the replay that must cope.
    expect(db.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_partial', name: 'demo.double', input: {} }],
    });

    const again = scriptedProvider([
      { content: [{ type: 'text', text: 'Here they are.' }], stopReason: 'end_turn', usage, model: 'claude-sonnet-5' },
    ]);
    await runAgent({
      agent, provider: again, registry: registryWithDouble(), ctx, pool: db, conversationId,
      userMessage: 'try again',
      transcript: room('ledger'),
      budgetNotice: false,
    });

    const sent = again.calls[0]!.messages;
    // Nothing empty, no role twice in a row, and no call left unanswered.
    expect(sent.every((m) => m.content.length > 0)).toBe(true);
    expect(sent.every((m, i) => i === 0 || m.role !== sent[i - 1]!.role)).toBe(true);
    expect(sent.flatMap((m) => m.content).some((b) => b.type === 'tool_use')).toBe(false);
    expect(sent.map((m) => m.role)).toEqual(['user']);
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

    // A history that ends on the owner — the run before this one never
    // answered — puts two owner turns side by side, which the wire refuses.
    // They go as one turn, in order, both messages intact.
    expect(provider.calls[0]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'earlier' }, { type: 'text', text: 'now' }] },
    ]);
  });
});

/* ---------------- approvals ---------------- */

/** A gated tool: proposing it is never executing it. */
function registryWithGatedSend(execute = vi.fn()): ToolRegistry {
  const manifest: PluginManifest = {
    name: 'mail',
    version: '1.0.0',
    schema: 'mail',
    migrationsDir: '/tmp/mail',
    tools: [
      {
        name: 'mail.send',
        description: 'Send an email.',
        tier: 'gated',
        input: z.object({ to: z.string() }),
        describe: (input: { to: string }) => ({
          envelope: { to: [input.to], bcc: ['archive@example.com'] },
          preview: `Send to ${input.to}`,
        }),
        execute: execute as never,
      },
    ],
  };
  const r = new ToolRegistry();
  r.register(manifest);
  return r;
}

const mailAgent: AgentDefinition = { ...agent, tools: ['mail.send'] };

describe('runAgent and approvals', () => {
  const proposeSend: CompletionResponse = {
    content: [{ type: 'tool_use', id: 'call-1', name: 'mail.send', input: { to: 'a@b.c' } }],
    stopReason: 'tool_use',
    usage,
    model: 'm',
  };

  it('stops awaiting approval, answers the tool_use, and executes nothing', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const execute = vi.fn();
    const provider = scriptedProvider([proposeSend]);
    const seen: string[] = [];

    const result = await runAgent({
      agent: mailAgent,
      provider,
      registry: registryWithGatedSend(execute),
      ctx: { ...ctx, db: db as unknown as ToolContext['db'] },
      pool: db,
      conversationId,
      userMessage: 'email a@b.c',
      onApprovalRequired: (id) => seen.push(id),
    });

    expect(result.stopped).toBe('awaiting-approval');
    expect(result.pendingActionId).toBe(ACTION_ID);
    expect(execute).not.toHaveBeenCalled();
    expect(seen).toEqual([ACTION_ID]);
    // The action was recorded before anyone was asked.
    expect(db.actions).toEqual([{ tool: 'mail.send', args: { to: 'a@b.c' } }]);
    // The proposal stopped the run: the provider was called exactly once.
    expect(provider.calls).toHaveLength(1);

    // The tool_use is answered — not as an error, because nothing went wrong.
    const last = db.messages.at(-1);
    expect(last?.role).toBe('user');
    const block = (last?.content as any[])[0];
    expect(block).toMatchObject({ type: 'tool_result', tool_use_id: 'call-1' });
    expect(block.is_error).toBeUndefined();
    expect(block.content).toContain(ACTION_ID);
    expect(db.eventKinds()).toContain('tool.result');
    expect(db.events.at(-1)?.payload).toMatchObject({ stopped: 'awaiting-approval' });
  });

  it('resumes with the outcome and carries on', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider([
      { content: [{ type: 'text', text: 'Sent.' }], stopReason: 'end_turn', usage, model: 'm' },
    ]);

    const result = await runAgent({
      agent: mailAgent,
      provider,
      registry: registryWithGatedSend(),
      ctx: { ...ctx, db: db as unknown as ToolContext['db'] },
      pool: db,
      conversationId,
      resume: { actionId: ACTION_ID, state: 'succeeded', result: { messageId: 'mid-1' } },
    });

    expect(result.stopped).toBe('end_turn');
    expect(result.text).toBe('Sent.');
    const opening = provider.calls[0]?.messages.at(-1);
    const text = (opening?.content as any[])[0].text as string;
    expect(text).toContain(ACTION_ID);
    expect(text).toContain('succeeded');
    expect(text).toContain('mid-1');
    expect(db.eventKinds()[0]).toBe('run.resumed');
  });

  it('tells the model plainly when the owner rejected it', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider([
      { content: [{ type: 'text', text: 'Understood.' }], stopReason: 'end_turn', usage, model: 'm' },
    ]);
    await runAgent({
      agent: mailAgent,
      provider,
      registry: registryWithGatedSend(),
      ctx: { ...ctx, db: db as unknown as ToolContext['db'] },
      pool: db,
      conversationId,
      resume: { actionId: ACTION_ID, state: 'rejected' },
    });
    const text = ((provider.calls[0]?.messages.at(-1)?.content as any[])[0].text as string);
    expect(text).toContain('rejected');
    expect(text).toMatch(/Do not propose the same effect again/);
  });

  it('refuses a run that carries both a message and a resume, or neither', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const base = {
      agent: mailAgent,
      provider: scriptedProvider([]),
      registry: registryWithGatedSend(),
      ctx,
      pool: db,
      conversationId,
    };
    await expect(runAgent({ ...base })).rejects.toThrow(/exactly one/);
    await expect(
      runAgent({
        ...base,
        userMessage: 'hi',
        resume: { actionId: ACTION_ID, state: 'succeeded' },
      }),
    ).rejects.toThrow(/exactly one/);
  });
});

/* ---------------- provider awareness ---------------- */

describe('runAgent — the per-run snapshot', () => {
  it('records provider, pinned model and credential kind before the first call', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage,
        // The endpoint served a dated snapshot behind the alias; that is
        // exactly what the pin alone cannot tell you.
        model: 'claude-sonnet-5-20260401',
      },
    ]);
    const result = await runAgent({
      agent,
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'hi',
    });

    expect(result.snapshot).toMatchObject({
      provider: 'anthropic',
      credentialKind: 'api-key',
      model: 'claude-sonnet-5',
      servedModel: 'claude-sonnet-5-20260401',
    });

    const started = db.events.find((e) => e.kind === 'run.started')?.payload as any;
    expect(started).toMatchObject({
      provider: 'anthropic',
      credentialKind: 'api-key',
      model: 'claude-sonnet-5',
    });
    expect(started.capabilities.kind).toBe('anthropic');

    const finished = db.events.find((e) => e.kind === 'run.finished')?.payload as any;
    expect(finished).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      servedModel: 'claude-sonnet-5-20260401',
      credentialKind: 'api-key',
    });
  });

  it('snapshots the provider pinned on the agent, not a process-wide one', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'scout');
    const provider = scriptedProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage, model: 'gpt-5' },
    ]);
    const result = await runAgent({
      agent: {
        ...agent,
        id: 'scout',
        tools: [],
        provider: {
          kind: 'openai',
          credential: { kind: 'api-key', env: 'OPENAI_API_KEY' },
          model: 'gpt-5',
        },
      },
      provider: { ...provider, capabilities: providerCapabilities('openai') },
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'hi',
    });
    expect(result.snapshot.provider).toBe('openai');
    expect(result.snapshot.model).toBe('gpt-5');
    expect(result.snapshot.capabilities.document).toBe(false);
  });
});

describe('runAgent — the capability matrix is honoured', () => {
  /** One run with a hydrated PDF in the owner's turn. */
  async function runWithPdf(capabilities?: ProviderCapabilities) {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const base = scriptedProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage, model: 'm' },
    ]);
    const provider = capabilities ? { ...base, capabilities } : base;
    await runAgent({
      agent: { ...agent, tools: [] },
      provider,
      registry: registryWithDouble(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'what does this say?',
      attachments: [{ artifactId: 'art-1', mime: 'application/pdf', kind: 'document' }],
      loadArtifact: async () => ({ mime: 'application/pdf', data: 'JVBERi0x' }),
    });
    return { db, sent: base.calls[0] };
  }

  it('sends the document to a provider whose wire carries one', async () => {
    const { sent } = await runWithPdf(providerCapabilities('anthropic'));
    expect(sent?.messages[0]?.content[2]).toMatchObject({ type: 'document' });
  });

  it('degrades it to a visible placeholder for a provider whose wire cannot', async () => {
    const { db, sent } = await runWithPdf(providerCapabilities('openai'));
    const block = sent?.messages[0]?.content[2] as { type: string; text: string };
    expect(block.type).toBe('text');
    expect(block.text).toContain('openai');
    // What is *persisted* is still the reference: the same history sent to an
    // Anthropic agent tomorrow still carries the real file.
    const persisted = db.messages[0]?.content as any[];
    expect(persisted[1]).toMatchObject({ type: 'artifact_ref', artifactId: 'art-1' });
  });

  it('treats a provider that declares nothing as the native wire', async () => {
    const { sent } = await runWithPdf();
    expect(sent?.messages[0]?.content[2]).toMatchObject({ type: 'document' });
  });
});

/* ------------------------------------------------------------------ *
 * One grant, two ways of honouring it
 * ------------------------------------------------------------------ */

/** The three tools `web.*` resolves to, as the catalog would have resolved it. */
const WEB_TOOLS = ['web.read', 'web.search', 'web.status'];

function registryWithWeb(searched: string[] = []): ToolRegistry {
  const tool = (name: string) => ({
    name,
    description: `The ${name} tool.`,
    tier: 'auto' as const,
    input: z.object({}).passthrough(),
    execute: async () => {
      searched.push(name);
      return { ok: true };
    },
  });
  const manifest: PluginManifest = {
    name: 'web',
    version: '0.0.1',
    schema: 'web',
    migrationsDir: '/tmp/web',
    tools: WEB_TOOLS.map(tool),
  };
  const r = new ToolRegistry();
  r.register(manifest);
  return r;
}

const webAgent: AgentDefinition = { ...agent, id: 'garage', tools: WEB_TOOLS };

const scoutAgent: AgentDefinition = {
  ...webAgent,
  id: 'scout',
  provider: {
    kind: 'openai',
    credential: { kind: 'api-key', env: 'OPENAI_API_KEY' },
    model: 'gpt-5',
  },
};

/** The same script the adapter would produce from a live server-side search. */
function nativeSearchTurn(): CompletionResponse {
  return {
    content: [
      {
        type: 'provider_native',
        provider: 'anthropic',
        raw: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } },
      },
      {
        type: 'provider_native',
        provider: 'anthropic',
        raw: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
      },
      { type: 'text', text: 'cargurus.com says about $43,753.' },
    ],
    stopReason: 'end_turn',
    usage: { input: 5, output: 2, webSearches: 1 },
    model: 'claude-sonnet-5',
    searches: [
      { query: 'used bronco price nj', hosts: ['www.cargurus.com'], resultCount: 7, outcome: 'ok' },
    ],
  };
}

function endTurn(text = 'done'): CompletionResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage, model: 'm' };
}

function openAiProvider(script: CompletionResponse[]): RuntimeProvider & {
  calls: CompletionRequest[];
} {
  return { ...scriptedProvider(script), capabilities: providerCapabilities('openai') };
}

describe('what an agent granted web.* is actually shown', () => {
  it('on Anthropic: web.read and web.status, no web.search, and the provider searching instead', async () => {
    const db = new FakeDb();
    const provider = scriptedProvider([endTurn()]);
    await runAgent({
      agent: webAgent,
      provider,
      registry: registryWithWeb(),
      ctx,
      pool: db,
      conversationId: 'c1',
      userMessage: 'what is a used bronco worth?',
      env: {},
    });

    const shown = provider.calls[0]!.tools.map((t) => t.name);
    expect(shown).toEqual(['web.read', 'web.status']);
    expect(provider.calls[0]!.nativeSearch).toEqual({ maxUses: 3 });
    // The untrusted rule has nowhere else to live on this path, so it is in the
    // system prompt for the turn that does the searching.
    expect(provider.calls[0]!.system).toContain('UNTRUSTED CONTENT');
  });

  it('on OpenAI: all three tools, and no server-side search asked for', async () => {
    const db = new FakeDb();
    const provider = openAiProvider([endTurn()]);
    await runAgent({
      agent: scoutAgent,
      provider,
      registry: registryWithWeb(),
      ctx,
      pool: db,
      conversationId: 'c1',
      userMessage: 'what is a used bronco worth?',
      env: {},
    });

    expect(provider.calls[0]!.tools.map((t) => t.name)).toEqual(WEB_TOOLS);
    expect(provider.calls[0]!.nativeSearch).toBeUndefined();
    expect(provider.calls[0]!.system).not.toContain('UNTRUSTED CONTENT');
  });

  it('with BUDDI_SEARCH_PROVIDER=tavily: the plugin tool comes back, even on Anthropic', async () => {
    const db = new FakeDb();
    const provider = scriptedProvider([endTurn()]);
    await runAgent({
      agent: webAgent,
      provider,
      registry: registryWithWeb(),
      ctx,
      pool: db,
      conversationId: 'c1',
      userMessage: 'hi',
      env: { BUDDI_SEARCH_PROVIDER: 'tavily' },
    });

    expect(provider.calls[0]!.tools.map((t) => t.name)).toEqual(WEB_TOOLS);
    expect(provider.calls[0]!.nativeSearch).toBeUndefined();
  });

  it('records which backend honoured the grant, before the first call', async () => {
    const db = new FakeDb();
    await runAgent({
      agent: webAgent,
      provider: scriptedProvider([endTurn()]),
      registry: registryWithWeb(),
      ctx,
      pool: db,
      conversationId: 'c1',
      userMessage: 'hi',
      env: {},
    });
    const started = db.events.find((e) => e.kind === 'run.started')!.payload as any;
    expect(started.webSearch).toMatchObject({ native: true, maxUses: 3 });
  });
});

describe('a search the loop did not run', () => {
  it('dispatches nothing, and leaves the audit trail a web.search call would have left', async () => {
    const db = new FakeDb();
    const dispatched: string[] = [];
    const recorded: unknown[] = [];
    const result = await runAgent({
      agent: webAgent,
      provider: scriptedProvider([nativeSearchTurn()]),
      registry: registryWithWeb(dispatched),
      ctx,
      pool: db,
      conversationId: 'c1',
      userMessage: 'what is a used bronco worth?',
      env: {},
      onNativeSearch: (events) => {
        recorded.push(...events);
      },
    });

    // Nothing was executed: a server tool block is a report, not a proposal.
    expect(dispatched).toEqual([]);
    expect(db.eventKinds()).not.toContain('tool.called');
    expect(result.stopped).toBe('end_turn');
    expect(result.text).toContain('$43,753');

    // …and it is still accounted for, with the same facts a `web.fetches` row
    // needs: who asked, in which conversation, what for, where it went.
    expect(recorded).toEqual([
      {
        query: 'used bronco price nj',
        hosts: ['www.cargurus.com'],
        resultCount: 7,
        outcome: 'ok',
        agentId: 'garage',
        conversationId: 'c1',
        provider: 'anthropic',
      },
    ]);
    expect(db.eventKinds()).toContain('web.searched');
    expect(result.usage.webSearches).toBe(1);
  });

  it('keeps the provider blocks out of durable history, and the answer in it', async () => {
    const db = new FakeDb();
    await runAgent({
      agent: webAgent,
      provider: scriptedProvider([nativeSearchTurn()]),
      registry: registryWithWeb(),
      ctx,
      pool: db,
      conversationId: 'c1',
      userMessage: 'hi',
      env: {},
    });

    const assistant = db.messages.find((m) => m.role === 'assistant')!.content as any[];
    // Untrusted search results do not get replayed into every future turn of
    // this conversation, and one vendor's private block shapes never reach
    // another vendor's endpoint tomorrow.
    expect(assistant.map((b) => b.type)).toEqual(['text']);
  });

  it('never fails a turn because the audit sink threw', async () => {
    const db = new FakeDb();
    const result = await runAgent({
      agent: webAgent,
      provider: scriptedProvider([nativeSearchTurn()]),
      registry: registryWithWeb(),
      ctx,
      pool: db,
      conversationId: 'c1',
      userMessage: 'hi',
      env: {},
      onNativeSearch: () => {
        throw new Error('the web schema was dropped');
      },
    });
    expect(result.stopped).toBe('end_turn');
    expect(result.text).toContain('$43,753');
  });

  it('continues a paused turn instead of ending it, with no user message invented', async () => {
    const db = new FakeDb();
    const paused: CompletionResponse = { ...nativeSearchTurn(), stopReason: 'pause_turn' };
    const provider = scriptedProvider([paused, endTurn('and here is the answer')]);
    const result = await runAgent({
      agent: webAgent,
      provider,
      registry: registryWithWeb(),
      ctx,
      pool: db,
      conversationId: 'c1',
      userMessage: 'hi',
      env: {},
    });

    expect(result.turns).toBe(2);
    expect(result.stopped).toBe('end_turn');
    // Both halves: the model wrote a sentence before the API paused the turn
    // and another after it resumed, and the owner is owed both.
    expect(result.text).toBe('cargurus.com says about $43,753.\n\nand here is the answer');
    // The continuation carries the paused turn back, provider blocks and all,
    // and adds nothing from the owner that the owner did not say.
    const second = provider.calls[1]!.messages;
    expect(second[second.length - 1]!.role).toBe('assistant');
    expect(second[second.length - 1]!.content.map((b) => b.type)).toEqual([
      'provider_native',
      'provider_native',
      'text',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * What a run's answer is
 * ------------------------------------------------------------------ */

/** A registry with the two conversation tools a run can stop the owner with. */
function registryWithConversation(): ToolRegistry {
  const manifest: PluginManifest = {
    name: 'conversation',
    version: '0.0.1',
    schema: 'conversation',
    migrationsDir: '/tmp/conversation',
    tools: [
      {
        name: 'conversation.offer',
        description: 'Puts choices in front of the owner.',
        tier: 'auto',
        input: z.object({ options: z.array(z.string()) }),
        execute: async () => ({ ok: true }),
      },
      {
        name: 'conversation.ask',
        description: 'Asks the owner a question.',
        tier: 'auto',
        input: z.object({ question: z.string() }),
        execute: async () => ({ ok: true }),
      },
    ],
  };
  const r = new ToolRegistry();
  r.register(manifest);
  return r;
}

const conversationAgent: AgentDefinition = {
  ...agent,
  tools: ['conversation.offer', 'conversation.ask'],
};

/** The shape that broke: prose, a tool call, a closing line. */
const DRAFT = [
  'Bonjour Dorothée,',
  '',
  'Merci pour votre message. Je vous confirme le rendez-vous de jeudi à 14h.',
  '',
  'Bien à vous,',
].join('\n');

async function textOfRun(
  script: CompletionResponse[],
  over: Partial<Parameters<typeof runAgent>[0]> = {},
): Promise<string> {
  const db = new FakeDb();
  const conversationId = await createConversation(db, 'finance');
  const result = await runAgent({
    agent: conversationAgent,
    provider: scriptedProvider(script),
    registry: registryWithConversation(),
    ctx,
    pool: db,
    conversationId,
    userMessage: 'répond à Dorothée',
    ...over,
  } as Parameters<typeof runAgent>[0]);
  return result.text;
}

function toolTurn(text: string, name = 'conversation.offer'): CompletionResponse {
  return {
    content: [
      { type: 'text', text },
      {
        type: 'tool_use',
        id: `tu_${Math.random().toString(36).slice(2, 8)}`,
        name,
        input: name === 'conversation.ask' ? { question: 'laquelle ?' } : { options: ['a', 'b'] },
      },
    ],
    stopReason: 'tool_use',
    usage,
    model: 'claude-sonnet-5',
  };
}

describe("a run's answer is everything the model said, in order", () => {
  it('keeps the draft written before a tool call, not just the closing line', async () => {
    const text = await textOfRun([toolTurn(DRAFT), endTurn('Voilà — à toi de choisir.')]);
    expect(text).toBe(`${DRAFT}\n\nVoilà — à toi de choisir.`);
    // The regression in one line: the draft is not thrown away.
    expect(text).toContain('Merci pour votre message');
  });

  it('keeps text written between several tool calls, in the order it was said', async () => {
    const text = await textOfRun([
      toolTurn('Here is the first half of the summary, which runs on for a while and is plainly meant for you to read. It is comfortably longer than any preamble could be.'),
      toolTurn('And here is the second half, also plainly written for the owner rather than as a note to self. It, too, is far longer than a line of progress chatter.'),
      endTurn('That is everything.'),
    ]);
    expect(text).toBe(
      [
        'Here is the first half of the summary, which runs on for a while and is plainly meant for you to read. It is comfortably longer than any preamble could be.',
        'And here is the second half, also plainly written for the owner rather than as a note to self. It, too, is far longer than a line of progress chatter.',
        'That is everything.',
      ].join('\n\n'),
    );
  });

  it('is unchanged for a run whose only text is at the end', async () => {
    const text = await textOfRun([endTurn('It is 42.')]);
    expect(text).toBe('It is 42.');
  });

  it('is empty for a run that said nothing', async () => {
    const text = await textOfRun([
      {
        content: [
          { type: 'tool_use', id: 'tu_x', name: 'conversation.offer', input: { options: ['a'] } },
        ],
        stopReason: 'tool_use',
        usage,
        model: 'm',
      },
      { content: [], stopReason: 'end_turn', usage, model: 'm' },
    ]);
    expect(text).toBe('');
  });

  it('survives conversation.ask followed by a closing line', async () => {
    const question = [
      'Deux options pour la réponse à Dorothée :',
      '',
      '1. Confirmer jeudi 14h.',
      '2. Proposer vendredi matin.',
    ].join('\n');
    const text = await textOfRun([
      toolTurn(question, 'conversation.ask'),
      endTurn('Dis-moi laquelle.'),
    ]);
    expect(text).toBe(`${question}\n\nDis-moi laquelle.`);
  });

  describe('the preamble rule', () => {
    it('drops a short single line that precedes a tool call — the spinner already said that', async () => {
      const text = await textOfRun([toolTurn('Let me check that.'), endTurn('It is 42.')]);
      expect(text).toBe('It is 42.');
    });

    it('keeps a short line that did *not* precede a tool call', async () => {
      const text = await textOfRun([endTurn('Let me check that.')]);
      expect(text).toBe('Let me check that.');
    });

    it('keeps a multi-line block before a tool call, however short', async () => {
      const text = await textOfRun([toolTurn('Option A\nOption B'), endTurn('Choisis.')]);
      expect(text).toBe('Option A\nOption B\n\nChoisis.');
    });

    it('keeps a long single line before a tool call — a draft is never a preamble', async () => {
      const long = `x${'y'.repeat(200)}`;
      const text = await textOfRun([toolTurn(long), endTurn('Voilà.')]);
      expect(text).toBe(`${long}\n\nVoilà.`);
    });

    it('never leaves a run mute: a preamble is kept when it is all there was', async () => {
      const text = await textOfRun([
        toolTurn('Let me check that.'),
        { content: [], stopReason: 'end_turn', usage, model: 'm' },
      ]);
      expect(text).toBe('Let me check that.');
    });

    it('is decided on the boundary, not on taste', () => {
      expect(isPreamble({ text: 'z'.repeat(120), beforeToolCall: true })).toBe(true);
      expect(isPreamble({ text: 'z'.repeat(121), beforeToolCall: true })).toBe(false);
      expect(isPreamble({ text: 'z'.repeat(120), beforeToolCall: false })).toBe(false);
      expect(isPreamble({ text: '', beforeToolCall: true })).toBe(false);
    });
  });

  it('joins with a blank line, trimming each block', () => {
    expect(
      joinSpoken([
        { text: '  first  ', beforeToolCall: false },
        { text: '\nsecond\n', beforeToolCall: false },
      ]),
    ).toBe('first\n\nsecond');
  });
});

/* ------------------------------------------------------------------ *
 * What the owner says while the agent is working
 * ------------------------------------------------------------------ */

/**
 * The promise the interjection point makes is about *where*, not whether:
 * inside the tool-results turn, after the results, and never while an effect
 * is half-done. Everything here is that promise, said several ways — plus the
 * bargain that goes with it, which is that a line is only ever called
 * delivered once a model has actually been shown it.
 */
describe('an interjection', () => {
  /** Two tool calls and then an answer, so there is a gap to land in. */
  const twoCalls = (): CompletionResponse[] => [
    { model: 'fixture', content: [{ type: 'tool_use', id: 'a', name: 'demo.double', input: { n: 1 } }], stopReason: 'tool_use', usage },
    { model: 'fixture', content: [{ type: 'tool_use', id: 'b', name: 'demo.double', input: { n: 2 } }], stopReason: 'tool_use', usage },
    { model: 'fixture', content: [{ type: 'text', text: 'Done.' }], stopReason: 'end_turn', usage },
  ];

  /** The shape a provider checks: role, then the kind of each block. */
  const shapeOf = (messages: readonly { role: string; content: readonly ContentBlock[] }[]): string[] =>
    messages.map((m) => `${m.role}:${m.content.map((b) => b.type).join(',')}`);

  it('rides in the tool-results turn, after the results, and never as a turn of its own', async () => {
    const db = new FakeDb();
    const queue = new InterjectionQueue();
    const provider = scriptedProvider(twoCalls());
    queue.push({ text: 'in euros, not dollars' });

    await runAgent({
      agent, provider, registry: registryWithDouble(), ctx, pool: db,
      conversationId: await createConversation(db, agent.id),
      userMessage: 'What did we spend?',
      interjections: queue,
    });

    /*
     * The whole sequence, as the provider sees it. Two things are load-
     * bearing and both were wrong before: the tool_result follows its
     * tool_use immediately, and no two user messages are adjacent.
     */
    expect(shapeOf(provider.calls[1]!.messages)).toEqual([
      'user:text',
      'assistant:tool_use',
      'user:tool_result,text',
    ]);
    const added = provider.calls[1]!.messages.at(-1)!;
    expect(added.content[0]!.type).toBe('tool_result');
    expect(JSON.stringify(added.content[1])).toContain('the owner adds: in euros, not dollars');
    for (let i = 1; i < provider.calls[1]!.messages.length; i += 1) {
      expect(provider.calls[1]!.messages[i]!.role).not.toBe(provider.calls[1]!.messages[i - 1]!.role);
    }

    // The transcript keeps the owner's own words, in that same turn.
    const stored = db.messages.find((m) => JSON.stringify(m.content).includes('tool_result'))!;
    expect(stored.role).toBe('user');
    expect(stored.content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: JSON.stringify({ doubled: 2 }) },
      { type: 'text', text: 'in euros, not dollars' },
    ]);
    expect(db.eventKinds()).toContain('run.interjected');
  });

  it('is never delivered inside a tool call: the running tool sees nothing of it', async () => {
    const db = new FakeDb();
    const queue = new InterjectionQueue();
    const registry = new ToolRegistry();
    /** How much of the owner's text was in the transcript as each tool ran. */
    const seen: number[] = [];
    const provider = scriptedProvider(twoCalls());
    registry.register({
      name: 'demo', version: '0.0.1', schema: 'demo', migrationsDir: '/tmp/demo',
      tools: [{
        name: 'demo.double', description: 'Doubles a number.', tier: 'auto', input: z.object({ n: z.number() }),
        execute: async (input: { n: number }) => {
          // The owner types mid-effect. It must not join this turn's results.
          queue.push({ text: 'stop, wrong account' });
          seen.push(db.messages.filter((m) => JSON.stringify(m.content).includes('wrong account')).length);
          return { doubled: input.n * 2 };
        },
      }],
    });

    await runAgent({
      agent, provider, registry, ctx, pool: db,
      conversationId: await createConversation(db, agent.id),
      userMessage: 'Pay it',
      interjections: queue,
    });

    // Nothing was written while the first tool was running…
    expect(seen[0]).toBe(0);
    // …and the turn the model was sent still opens with its results.
    const results = provider.calls[1]!.messages.at(-1)!;
    expect(results.content[0]!.type).toBe('tool_result');
  });

  it('arriving after the answer is left for the next turn, not squeezed into this one', async () => {
    const db = new FakeDb();
    const queue = new InterjectionQueue();
    const provider = scriptedProvider([
      { model: 'fixture', content: [{ type: 'text', text: 'Done.' }], stopReason: 'end_turn', usage },
    ]);

    const result = await runAgent({
      agent, provider, registry: registryWithDouble(), ctx, pool: db,
      conversationId: await createConversation(db, agent.id),
      userMessage: 'What did we spend?',
      interjections: queue,
    });
    // The model has said its last word; only now does the owner add something.
    queue.push({ text: 'and last month?' });

    expect(result.stopped).toBe('end_turn');
    expect(JSON.stringify(db.messages)).not.toContain('and last month?');
    expect(queue.close().map((i) => i.text)).toEqual(['and last month?']);
  });

  it('is not taken on the last turn the run is allowed, where no model step is left', async () => {
    const db = new FakeDb();
    const queue = new InterjectionQueue();
    queue.push({ text: 'one more thing' });
    const provider = scriptedProvider([
      { model: 'fixture', content: [{ type: 'tool_use', id: 'a', name: 'demo.double', input: { n: 1 } }], stopReason: 'tool_use', usage },
    ]);

    const result = await runAgent({
      agent: { ...agent, maxTurns: 1 }, provider, registry: registryWithDouble(), ctx, pool: db,
      conversationId: await createConversation(db, agent.id),
      userMessage: 'Do it',
      interjections: queue,
    });

    expect(result.stopped).toBe('max_turns');
    expect(JSON.stringify(db.messages)).not.toContain('one more thing');
    // Still queued, so the next turn carries it rather than nobody carrying it.
    expect(queue.close().map((i) => i.text)).toEqual(['one more thing']);
  });

  it('is only called delivered once a model has been shown it', async () => {
    const db = new FakeDb();
    const queue = new InterjectionQueue();
    const delivered: string[] = [];
    const released: string[] = [];
    /** The queue, watched: who was told what, and in which order. */
    const watched = {
      lease: () => queue.lease(),
      deliver: (items: readonly { text: string }[]) => { delivered.push(...items.map((i) => i.text)); queue.deliver(items as never); },
      release: (items: readonly { text: string }[]) => { released.push(...items.map((i) => i.text)); queue.release(items as never); },
    };
    queue.push({ text: 'in euros' });

    let calls = 0;
    const provider: RuntimeProvider = {
      async complete(req) {
        calls += 1;
        if (calls === 1) {
          return { model: 'fixture', content: [{ type: 'tool_use', id: 'a', name: 'demo.double', input: { n: 1 } }], stopReason: 'tool_use', usage };
        }
        // The step the interjection was leased for never lands.
        expect(delivered).toEqual([]);
        expect(JSON.stringify(req.messages)).toContain('the owner adds: in euros');
        throw new Error('the provider fell over');
      },
    };

    await expect(runAgent({
      agent, provider, registry: registryWithDouble(), ctx, pool: db,
      conversationId: await createConversation(db, agent.id),
      userMessage: 'What did we spend?',
      interjections: watched,
    })).rejects.toThrow('the provider fell over');

    // Never acknowledged, handed back, and waiting for whoever runs next.
    expect(delivered).toEqual([]);
    expect(released).toEqual(['in euros']);
    expect(queue.close().map((i) => i.text)).toEqual(['in euros']);
  });

  it('hands back what it was holding when the owner cancels the run', async () => {
    const db = new FakeDb();
    const queue = new InterjectionQueue();
    const controller = new AbortController();
    queue.push({ text: 'stop, wrong account' });
    const provider: RuntimeProvider = {
      async complete() {
        if (controller.signal.aborted) throw controller.signal.reason;
        controller.abort(new Error('The owner cancelled this run.'));
        return { model: 'fixture', content: [{ type: 'tool_use', id: 'a', name: 'demo.double', input: { n: 1 } }], stopReason: 'tool_use', usage };
      },
    };

    await expect(runAgent({
      agent, provider, registry: registryWithDouble(), ctx: { ...ctx, signal: controller.signal }, pool: db,
      conversationId: await createConversation(db, agent.id),
      userMessage: 'Pay it', interjections: queue,
    })).rejects.toThrow();

    expect(queue.close().map((i) => i.text)).toEqual(['stop, wrong account']);
  });

  it('a turn the surface already stored is neither written again nor shown twice', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, agent.id);
    // The surface promoted it: the row is already the owner's turn.
    await db.query(
      `insert into core.messages (conversation_id, role, content, speaker) values ($1, $2, $3::jsonb, $4)`,
      [conversationId, 'user', JSON.stringify([{ type: 'text', text: 'and last month?' }]), null],
    );
    const before = db.messages.length;
    const provider = scriptedProvider([
      { model: 'fixture', content: [{ type: 'text', text: 'Here.' }], stopReason: 'end_turn', usage },
    ]);

    await runAgent({
      agent, provider, registry: registryWithDouble(), ctx, pool: db,
      conversationId, userMessage: 'and last month?', openingPersisted: true,
    });

    // One user turn, and it is the row that was already there.
    expect(db.messages.filter((m) => m.role === 'user')).toHaveLength(before);
    const sent = provider.calls[0]!.messages.filter((m) => m.role === 'user');
    expect(sent).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * What the agent is told when its approval settled
 * ------------------------------------------------------------------ */

describe('the deferred tool result', () => {
  const resume = (state: string, error?: string) =>
    approvalOutcomeText({ actionId: 'a1', state, ...(error ? { error } : {}) } as never);

  it('says plainly that a refused effect was never dispatched', () => {
    // The whole reason `refused` exists beside `failed`: an agent that read it
    // as a half-success would go looking for an effect that is not there — or
    // warn the owner about one.
    const text = resume('refused', 'the draft was edited since you approved it');
    expect(text).toContain('Nothing was dispatched');
    expect(text).toContain('the draft was edited since you approved it');
  });

  it('still tells the difference between that and an unknown one', () => {
    expect(resume('unknown')).toContain('dispatched and never confirmed');
    expect(resume('rejected')).toContain('The owner rejected it');
  });
});
