import { describe, expect, it } from 'vitest';
import { TELEGRAM_SURFACE, ToolRegistry, surfaceSection } from '@buddi/core';
import type { AgentDefinition, PluginManifest, CoreToolContext } from '@buddi/core';
import type { CompletionResponse, RuntimeProvider } from './anthropic.js';
import type { Queryable, RunAgentOptions } from './loop.js';
import {
  createDelegateTool,
  delegationMessage,
  DELEGATE_TOOL,
  type DelegateAgent,
  type DelegateCatalog,
} from './delegate.js';

/* ---------------- in-memory fake DB (only `query`) ---------------- */

class FakeDb implements Queryable {
  conversations: { id: string; agent_id: string }[] = [];
  messages: { conversation_id: string; role: string; content: unknown }[] = [];
  events: { kind: string; conversation_id: string | null; payload: any }[] = [];

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('insert into core.conversations')) {
      const id = `conv-${this.conversations.length + 1}`;
      this.conversations.push({ id, agent_id: params[0] });
      return { rows: [{ id }] };
    }
    if (text.startsWith('insert into core.messages') || text.startsWith('with turn as ( insert into core.messages')) {
      this.messages.push({
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

  kinds(): string[] {
    return this.events.map((e) => e.kind);
  }
}

/* ---------------- fixtures ---------------- */

const provider: RuntimeProvider = {
  async complete() {
    return {
      content: [{ type: 'text', text: 'Pay 200 before the 18th.' }],
      stopReason: 'end_turn',
      usage: { input: 3, output: 4 },
      model: 'claude-sonnet-5',
    } satisfies CompletionResponse;
  },
};

function definitionOf(id: string, maxTurns: number): AgentDefinition {
  return {
    id,
    name: id,
    systemPrompt: `You are ${id}.`,
    tools: [],
    provider: {
      kind: 'anthropic',
      credential: { kind: 'api-key', env: 'ANTHROPIC_API_KEY' },
      model: 'claude-sonnet-5',
    },
    maxTurns,
  };
}

/** A catalog holding one delegate target, `credit-coach`, with a fat budget. */
function fakeCatalog(maxTurns = 12): DelegateCatalog {
  const agents: DelegateAgent[] = [
    {
      id: 'credit-coach',
      handle: 'credo',
      name: 'Credit Coach',
      definition: () => definitionOf('credit-coach', maxTurns),
    },
    {
      id: 'concierge',
      handle: 'buddi',
      name: 'Concierge',
      definition: () => definitionOf('concierge', maxTurns),
    },
  ];
  return {
    get: (id) => agents.find((a) => a.id === id),
    list: () => agents.map((a) => ({ id: a.id })),
  };
}

interface Harness {
  db: FakeDb;
  registry: ToolRegistry;
  ctx: CoreToolContext;
  captured: RunAgentOptions[];
}

function harness(
  opts: {
    allow?: Record<string, string[]>;
    catalog?: DelegateCatalog;
    depth?: number;
    surface?: CoreToolContext['surface'];
  } = {},
): Harness {
  const db = new FakeDb();
  const captured: RunAgentOptions[] = [];
  const registry = new ToolRegistry();
  const allow = opts.allow ?? { 'finance-advisor': ['credit-coach'] };
  const tool = createDelegateTool({
    catalog: () => opts.catalog ?? fakeCatalog(),
    registry,
    provider: () => provider,
    pool: db,
    allowlistFor: (agentId) => allow[agentId] ?? [],
    runAgent: async (runOpts) => {
      captured.push(runOpts);
      const { runAgent } = await import('./loop.js');
      return runAgent(runOpts);
    },
  });
  const manifest: PluginManifest = {
    name: 'agent',
    version: '0.1.0',
    schema: 'agent',
    migrationsDir: '',
    tools: [tool],
  };
  registry.register(manifest);

  const ctx: CoreToolContext = {
    db: db as unknown as CoreToolContext['db'],
    ownerId: 'owner',
    now: () => new Date('2026-09-13T00:00:00Z'),
    timezone: 'UTC',
    agentId: 'finance-advisor',
    conversationId: 'conv-caller',
    ...(opts.depth === undefined ? {} : { delegationDepth: opts.depth }),
    ...(opts.surface === undefined ? {} : { surface: opts.surface }),
  };
  return { db, registry, ctx, captured };
}

const task = { agent: 'credit-coach', task: 'Does paying 500 on the Quicksilver help?' };

/* ---------------- tests ---------------- */

describe('delegationMessage', () => {
  it('names the caller and appends the context block when there is one', () => {
    const msg = delegationMessage({ ...task, context: 'balance 1200' }, 'finance-advisor');
    expect(msg).toContain('finance-advisor');
    expect(msg).toContain(task.task);
    expect(msg).toContain('Context from finance-advisor:\nbalance 1200');
  });

  it('leaves the context block out entirely when none was given', () => {
    expect(delegationMessage(task, 'finance-advisor')).not.toContain('Context from');
  });
});

describe('agent.delegate', () => {
  it('passes the caller cancellation signal into the nested run', async () => {
    const { registry, ctx, captured } = harness();
    const signal = new AbortController().signal;
    await registry.invoke(DELEGATE_TOOL, task, { ...ctx, signal });
    expect(captured[0]?.ctx.signal).toBe(signal);
  });
  it('runs an allowlisted target in a new conversation and returns its text', async () => {
    const { db, registry, ctx } = harness();
    const out = await registry.invoke(DELEGATE_TOOL, task, ctx);

    expect(out.ok).toBe(true);
    // The handle travels with the answer: the caller quotes "@credo says: …".
    expect(out.ok && out.output).toEqual({
      agent: 'credit-coach',
      handle: 'credo',
      name: 'Credit Coach',
      status: 'answered',
      conversationId: 'conv-1',
      runId: expect.any(String),
      text: 'Pay 200 before the 18th.',
    });
    // A real, separate conversation owned by the target agent.
    expect(db.conversations).toEqual([{ id: 'conv-1', agent_id: 'credit-coach' }]);
    // The task landed as the nested run's user message.
    const first = db.messages[0];
    expect(first?.conversation_id).toBe('conv-1');
    expect(JSON.stringify(first?.content)).toContain(task.task);
  });

  it("inherits the caller's surface, because the delegate answers onto the same screen", async () => {
    const { registry, ctx, captured } = harness({ surface: TELEGRAM_SURFACE });
    const out = await registry.invoke(DELEGATE_TOOL, task, ctx);

    expect(out.ok).toBe(true);
    expect(captured[0]?.surface).toBe(TELEGRAM_SURFACE);
    // And it actually reaches the nested prompt, not just the options object.
    expect(captured[0]?.agent.systemPrompt).toBe('You are credit-coach.');
    expect(surfaceSection(captured[0]?.surface!)).toContain('You are answering on Telegram.');
  });

  it('composes no surface paragraph when the caller declared none', async () => {
    const { registry, ctx, captured } = harness();
    await registry.invoke(DELEGATE_TOOL, task, ctx);
    expect(captured[0]?.surface).toBeUndefined();
  });

  it('writes delegation.started and delegation.finished against the caller', async () => {
    const { db, registry, ctx } = harness();
    await registry.invoke(DELEGATE_TOOL, task, ctx);

    expect(db.kinds()).toContain('delegation.started');
    expect(db.kinds()).toContain('delegation.finished');
    const started = db.events.find((e) => e.kind === 'delegation.started');
    expect(started?.payload).toMatchObject({
      from: 'finance-advisor',
      to: 'credit-coach',
      conversationId: 'conv-1',
    });
    expect(started?.conversation_id).toBe('conv-caller');
    const finished = db.events.find((e) => e.kind === 'delegation.finished');
    expect(finished?.payload).toMatchObject({ ok: true, to: 'credit-coach' });
    // ... and the nested run persisted its own run events, as any run does.
    expect(db.events.some((e) => e.kind === 'run.started' && e.conversation_id === 'conv-1')).toBe(
      true,
    );
  });

  it('runs the target one level deeper, with the nested turn budget capped at 8', async () => {
    const { registry, ctx, captured } = harness();
    await registry.invoke(DELEGATE_TOOL, task, ctx);

    const nested = captured[0];
    expect(nested?.agent.id).toBe('credit-coach');
    expect(nested?.agent.maxTurns).toBe(8);
    expect(nested?.ctx.delegationDepth).toBe(1);
    expect(nested?.ctx.ownerId).toBe('owner');
  });

  it('refuses a target that is not in the caller allowlist', async () => {
    const { registry, ctx, db } = harness({ allow: { 'finance-advisor': [] } });
    const out = await registry.invoke(DELEGATE_TOOL, task, ctx);

    expect(out).toMatchObject({ ok: false, reason: 'tool-error' });
    expect(out.ok === false && out.message).toContain('may not delegate to "credit-coach"');
    expect(out.ok === false && out.message).toContain('allowed: none');
    expect(db.conversations).toEqual([]);
    expect(db.kinds()).toEqual([]);
  });

  it('refuses when the caller has no allowlist file at all', async () => {
    const { registry, ctx } = harness({ allow: {} });
    const out = await registry.invoke(DELEGATE_TOOL, task, ctx);
    expect(out.ok === false && out.message).toContain('may not delegate');
  });

  it('refuses an agent that is allowlisted but not installed', async () => {
    const { registry, ctx, db } = harness({
      allow: { 'finance-advisor': ['tax-wizard'] },
    });
    const out = await registry.invoke(DELEGATE_TOOL, { ...task, agent: 'tax-wizard' }, ctx);

    expect(out.ok === false && out.message).toContain('unknown agent "tax-wizard"');
    expect(out.ok === false && out.message).toContain('installed: credit-coach, concierge');
    expect(db.conversations).toEqual([]);
  });

  it('refuses at depth 1: a delegate may not delegate again', async () => {
    const { registry, ctx, db } = harness({ depth: 1 });
    const out = await registry.invoke(DELEGATE_TOOL, task, ctx);

    expect(out.ok === false && out.message).toContain('may not delegate again');
    expect(db.conversations).toEqual([]);
  });

  it('refuses a run with no agent identity', async () => {
    const { registry, ctx } = harness();
    const out = await registry.invoke(DELEGATE_TOOL, task, { ...ctx, agentId: undefined });
    expect(out.ok === false && out.message).toContain('no agent identity');
  });

  it('refuses invalid arguments before anything runs', async () => {
    const { registry, ctx, db } = harness();
    const out = await registry.invoke(DELEGATE_TOOL, { agent: 'credit-coach' }, ctx);
    expect(out).toMatchObject({ ok: false, reason: 'invalid-args' });
    expect(db.conversations).toEqual([]);
  });

  it('records a failed delegation and surfaces the error to the caller', async () => {
    const db = new FakeDb();
    const registry = new ToolRegistry();
    const tool = createDelegateTool({
      catalog: () => fakeCatalog(),
      registry,
      provider: () => provider,
      pool: db,
      allowlistFor: () => ['credit-coach'],
      runAgent: async () => {
        throw new Error('provider exploded');
      },
    });
    registry.register({
      name: 'agent',
      version: '0.1.0',
      schema: 'agent',
      migrationsDir: '',
      tools: [tool],
    });
    const ctx: CoreToolContext = {
      db: db as unknown as CoreToolContext['db'],
      ownerId: 'owner',
      now: () => new Date('2026-09-13T00:00:00Z'),
      timezone: 'UTC',
      agentId: 'finance-advisor',
    };

    const out = await registry.invoke(DELEGATE_TOOL, task, ctx);
    expect(out).toMatchObject({ ok: false, reason: 'tool-error' });
    expect(out.ok === false && out.message).toContain('provider exploded');
    const finished = db.events.find((e) => e.kind === 'delegation.finished');
    expect(finished?.payload).toMatchObject({ ok: false, error: 'provider exploded' });
  });
});

/* ------------------------------------------------------------------ *
 * Where the work went, said before it is done
 * ------------------------------------------------------------------ */

/**
 * A delegation is a run the owner cannot see: it happens in somebody else's
 * conversation, and the only thing the caller's transcript holds is one tool
 * row that stays open for a minute. So the ids are written the moment the
 * colleague's conversation exists — before the nested run takes a turn — and
 * carry the tool-use id of the call that asked, which is what ties them to
 * that row.
 */
describe('delegation.started', () => {
  it('names the conversation, the agent and the run, before the answer exists', async () => {
    const { db, registry, ctx } = harness();
    const out = await registry.invoke(DELEGATE_TOOL, task, { ...ctx, toolUseId: 'toolu_42' });
    expect(out.ok).toBe(true);

    const started = db.events.find((e) => e.kind === 'delegation.started');
    expect(started?.payload).toMatchObject({
      from: 'finance-advisor',
      to: 'credit-coach',
      agentId: 'credit-coach',
      conversationId: 'conv-1',
      toolUseId: 'toolu_42',
    });
    expect(typeof started?.payload.runId).toBe('string');
    // The caller's conversation carries it, because that is where the tool row
    // the panel is drawing lives.
    expect(started?.conversation_id).toBe('conv-caller');
    // And it was written before the nested run recorded anything of its own —
    // which is the whole point: the panel finds the conversation while the
    // colleague is still working, not once it has answered.
    expect(db.kinds().indexOf('delegation.started')).toBeLessThan(db.kinds().indexOf('run.started'));
  });

  it('carries the same run id the nested run was given', async () => {
    const { db, registry, ctx, captured } = harness();
    await registry.invoke(DELEGATE_TOOL, task, { ...ctx, toolUseId: 'toolu_7' });
    const started = db.events.find((e) => e.kind === 'delegation.started');
    expect(captured[0]?.runId).toBe(started?.payload.runId);
  });
});

/* ------------------------------------------------------------------ *
 * A colleague that wrote no final words
 * ------------------------------------------------------------------ */

/**
 * The owner's case: @art called `image.generate`, the call became an approval,
 * and its run ended there with nothing said. The delegation used to hand the
 * asker `text: ""` and nothing else, which it read as "returned an empty
 * result" and offered to retry — a fresh conversation, and a fresh approval.
 */
describe('a delegation whose colleague ended without an answer', () => {
  const GATED = '11111111-2222-4333-8444-555555555555';

  function scripted(
    write: (db: FakeDb, conversationId: string) => void,
    result: { text: string; stopped: 'end_turn' | 'max_turns' | 'awaiting-approval'; pendingActionId?: string },
  ): { db: FakeDb; registry: ToolRegistry; ctx: CoreToolContext; suspended: string[] } {
    const db = new FakeDb();
    const registry = new ToolRegistry();
    const suspended: string[] = [];
    registry.register({
      name: 'agent', version: '0.1.0', schema: 'agent', migrationsDir: '',
      tools: [createDelegateTool({
        catalog: () => fakeCatalog(),
        registry,
        provider: () => provider,
        pool: db,
        allowlistFor: () => ['credit-coach'],
        runAgent: async (opts) => {
          write(db, opts.conversationId as string);
          return { ...result, turns: 1, usage: { input: 1, output: 1 }, snapshot: {} as never };
        },
      })],
    });
    const ctx: CoreToolContext = {
      db: db as unknown as CoreToolContext['db'],
      ownerId: 'owner',
      now: () => new Date('2026-09-13T00:00:00Z'),
      timezone: 'UTC',
      agentId: 'finance-advisor',
      conversationId: 'conv-caller',
      toolUseId: 'toolu_ask',
      suspend: (id) => suspended.push(id),
    };
    return { db, registry, ctx, suspended };
  }

  it('says the colleague is waiting on the owner, pauses the asker on that approval, and does not finish', async () => {
    const { db, registry, ctx, suspended } = scripted((db, conversationId) => {
      db.messages.push(
        { conversation_id: conversationId, role: 'assistant', content: [{ type: 'thinking', text: '' }, { type: 'tool_use', id: 'toolu_img', name: 'image.generate', input: { prompt: 'a fisherman' } }] },
        { conversation_id: conversationId, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_img', content: `awaiting owner approval (action ${GATED}); this effect has not happened` }] },
      );
    }, { text: '', stopped: 'awaiting-approval', pendingActionId: GATED });

    const out = await registry.invoke(DELEGATE_TOOL, task, ctx);
    expect(out.ok).toBe(true);
    const output = out.ok ? (out.output as Record<string, unknown>) : {};
    expect(output).toMatchObject({ status: 'awaiting-approval', waitingOn: { action: GATED, tool: 'image.generate' } });
    expect(String(output.note)).toContain('@credo needs the owner\'s approval for image.generate');
    // Not an `actionId`: that would draw the call as gated itself.
    expect(JSON.stringify(output)).not.toContain('"actionId"');
    // The asker stops on the colleague's approval, as on a gate of its own.
    expect(suspended).toEqual([GATED]);
    expect(db.kinds()).toContain('delegation.waiting');
    expect(db.kinds()).not.toContain('delegation.finished');
    const waiting = db.events.find((e) => e.kind === 'delegation.waiting');
    expect(waiting?.conversation_id).toBe('conv-caller');
    expect(waiting?.payload).toMatchObject({ actionId: GATED, parentActionId: GATED, toolUseId: 'toolu_ask', conversationId: 'conv-1' });
  });

  it('hands back what failed and a note, never a bare empty string, when the run ended on tool results', async () => {
    const { registry, ctx, suspended } = scripted((db, conversationId) => {
      db.messages.push(
        { conversation_id: conversationId, role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'image.generate', input: {} }] },
        { conversation_id: conversationId, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'tool-error: no image account is chosen' }] },
      );
    }, { text: '', stopped: 'max_turns' });

    const out = await registry.invoke(DELEGATE_TOOL, task, ctx);
    const output = out.ok ? (out.output as Record<string, unknown>) : {};
    expect(output).toMatchObject({
      status: 'no-answer',
      text: '',
      errors: [{ tool: 'image.generate', error: 'tool-error: no image account is chosen' }],
    });
    expect(String(output.note)).toContain('@credo ended without an answer; what failed is under errors');
    expect(suspended).toEqual([]);
  });

  it("falls back to the colleague's last words in its thread when the run itself said nothing", async () => {
    const { registry, ctx } = scripted((db, conversationId) => {
      db.messages.push({ conversation_id: conversationId, role: 'assistant', content: [{ type: 'text', text: 'Saved it as fisherman.png.' }] });
    }, { text: '', stopped: 'end_turn' });
    const out = await registry.invoke(DELEGATE_TOOL, task, ctx);
    expect(out.ok && out.output).toMatchObject({ status: 'answered', text: 'Saved it as fisherman.png.' });
  });
});
