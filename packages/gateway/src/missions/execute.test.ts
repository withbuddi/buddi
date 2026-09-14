import { describe, expect, it } from 'vitest';
import { ToolRegistry, type Mission, type Occurrence, type ToolContext } from '@buddi/core';
import type { CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { manifest as artifactsManifest } from '@buddi/tool-artifacts';
import { manifest as financeManifest } from '@buddi/tool-finance';
import { manifest as memoryManifest } from '@buddi/tool-memory';
import { createDelegationManifest } from '../agents/delegation.js';
import { OwnerNotPairedError } from '../telegram/notify.js';
import { createMissionExecutor, SCHEDULED_RUN_SUFFIX, UnknownAgentError } from './execute.js';

/* ---------------- in-memory fake DB (only `query`) ---------------- */

class FakeDb {
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
      const row = {
        kind: params[0],
        conversation_id: params[1] ?? null,
        payload: JSON.parse(params[2]),
      };
      this.events.push(row);
      return {
        rows: [{ id: `evt-${this.events.length}`, created_at: new Date(), ...row }],
      };
    }
    // The memory preamble reads the plugin's own schema; a mission run in this
    // fake world simply remembers nothing.
    if (text.includes('memory.preferences') || text.includes('memory.notes')) {
      return { rows: [] };
    }
    throw new Error(`FakeDb: unexpected sql: ${text}`);
  }
}

/* ---------------- fixtures ---------------- */

function fakeProvider(text: string, calls: string[] = []): RuntimeProvider {
  return {
    async complete(req): Promise<CompletionResponse> {
      calls.push(req.system);
      return {
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
        usage: { input: 10, output: 20 },
        model: 'claude-test',
      };
    },
  };
}

const mission: Mission = {
  id: 'friday-recap',
  name: 'Friday recap',
  agentId: 'finance-advisor',
  prompt: 'Produce the weekly recap.',
  enabled: true,
  createdAt: new Date('2026-09-01T00:00:00Z'),
};

const occurrence: Occurrence = {
  id: 'occ-1',
  missionId: 'friday-recap',
  scheduleRevision: 1,
  scheduledAt: new Date('2026-09-11T12:00:00Z'),
  state: 'claimed',
  claimedAt: new Date('2026-09-11T12:00:01Z'),
  finishedAt: null,
  runConversationId: null,
  error: null,
};

function deps(overrides: Partial<Parameters<typeof createMissionExecutor>[0]> = {}) {
  const db = new FakeDb();
  const registry = new ToolRegistry();
  registry.register(financeManifest);
  registry.register(memoryManifest);
  registry.register(artifactsManifest);
  // The finance advisor's file grants agent.delegate, so the registry a mission
  // runs against must carry it too. It is unbound here: delegation refuses.
  registry.register(createDelegationManifest(registry));
  const ctx: ToolContext = {
    db: {} as ToolContext['db'],
    ownerId: 'owner',
    now: () => new Date('2026-09-11T12:00:00Z'),
  };
  const base = {
    pool: db as unknown as Pool,
    registry,
    provider: fakeProvider('Cash 1200 EUR. Minimum 340 EUR on 2026-10-02.'),
    ctx,
    env: { ANTHROPIC_API_KEY: 'test-key' } as NodeJS.ProcessEnv,
    now: () => new Date('2026-09-11T12:00:00Z'),
    deliver: async () => 'chat-42',
    log: () => {},
  };
  return { db, deps: { ...base, ...overrides } };
}

/* ---------------- tests ---------------- */

describe('createMissionExecutor', () => {
  it('runs the agent in a fresh conversation and delivers the text', async () => {
    const { db, deps: d } = deps();
    const delivered: string[] = [];
    const execute = createMissionExecutor({
      ...d,
      deliver: async (text) => {
        delivered.push(text);
        return 'chat-42';
      },
    });

    const result = await execute(occurrence, mission);

    expect(db.conversations).toEqual([{ id: 'conv-1', agent_id: 'finance-advisor' }]);
    expect(result.conversationId).toBe('conv-1');
    expect(result.delivered).toBe(true);
    expect(result.chatId).toBe('chat-42');
    expect(delivered).toEqual([result.text]);
    expect(db.messages[0]).toMatchObject({ role: 'user' });
    expect(db.messages[0]?.content).toEqual([
      { type: 'text', text: 'Produce the weekly recap.' },
    ]);
  });

  it('tells the agent the run is scheduled and unattended', async () => {
    const systems: string[] = [];
    const { deps: d } = deps();
    const execute = createMissionExecutor({
      ...d,
      provider: fakeProvider('ok', systems),
    });
    await execute(occurrence, mission);
    expect(systems[0]).toContain(SCHEDULED_RUN_SUFFIX);
  });

  it('appends mission.delivered with the mission, occurrence and size', async () => {
    const { db, deps: d } = deps();
    await createMissionExecutor(d)(occurrence, mission);
    const event = db.events.find((e) => e.kind === 'mission.delivered');
    expect(event).toBeDefined();
    expect(event?.conversation_id).toBe('conv-1');
    expect(event?.payload).toMatchObject({
      missionId: 'friday-recap',
      occurrenceId: 'occ-1',
      conversationId: 'conv-1',
    });
    expect(event?.payload.chars).toBeGreaterThan(0);
  });

  it('fails closed on an agent id this gateway does not ship', async () => {
    const { db, deps: d } = deps();
    await expect(
      createMissionExecutor(d)(occurrence, { ...mission, agentId: 'tax-wizard' }),
    ).rejects.toBeInstanceOf(UnknownAgentError);
    expect(db.conversations).toHaveLength(0);
  });

  it('propagates an unpaired owner chat so the occurrence is marked failed', async () => {
    const { db, deps: d } = deps();
    const execute = createMissionExecutor({
      ...d,
      deliver: async () => {
        throw new OwnerNotPairedError();
      },
    });
    await expect(execute(occurrence, mission)).rejects.toBeInstanceOf(OwnerNotPairedError);
    expect(db.events.some((e) => e.kind === 'mission.delivered')).toBe(false);
  });

  it('reports the skip instead of failing when delivery is optional (--inline)', async () => {
    const { db, deps: d } = deps();
    const execute = createMissionExecutor({
      ...d,
      requireDelivery: false,
      deliver: async () => {
        throw new OwnerNotPairedError();
      },
    });
    const result = await execute(occurrence, mission);
    expect(result.delivered).toBe(false);
    expect(result.skipped).toMatch(/owner chat is paired/);
    expect(result.text).not.toBe('');
    expect(db.events.some((e) => e.kind === 'mission.delivered')).toBe(false);
  });

  it('still surfaces a real delivery failure on an inline run', async () => {
    const { deps: d } = deps();
    const execute = createMissionExecutor({
      ...d,
      requireDelivery: false,
      deliver: async () => {
        throw new Error('telegram 502');
      },
    });
    await expect(execute(occurrence, mission)).rejects.toThrow(/telegram 502/);
  });

  it('refuses to deliver an empty answer', async () => {
    const { deps: d } = deps();
    const execute = createMissionExecutor({ ...d, provider: fakeProvider('   ') });
    await expect(execute(occurrence, mission)).rejects.toThrow(/no text to deliver/);
  });
});
