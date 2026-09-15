import { describe, expect, it } from 'vitest';
import { TELEGRAM_SURFACE, ToolRegistry, surfaceSection } from '@buddi/core';
import type { AgentDefinition, PluginManifest, ToolContext } from '@buddi/core';
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
    if (text.startsWith('insert into core.messages')) {
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
  ctx: ToolContext;
  captured: RunAgentOptions[];
}

function harness(
  opts: {
    allow?: Record<string, string[]>;
    catalog?: DelegateCatalog;
    depth?: number;
    surface?: ToolContext['surface'];
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

  const ctx: ToolContext = {
    db: db as unknown as ToolContext['db'],
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
  it('runs an allowlisted target in a new conversation and returns its text', async () => {
    const { db, registry, ctx } = harness();
    const out = await registry.invoke(DELEGATE_TOOL, task, ctx);

    expect(out.ok).toBe(true);
    // The handle travels with the answer: the caller quotes "@credo says: …".
    expect(out.ok && out.output).toEqual({
      agent: 'credit-coach',
      handle: 'credo',
      name: 'Credit Coach',
      conversationId: 'conv-1',
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
    const ctx: ToolContext = {
      db: db as unknown as ToolContext['db'],
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
