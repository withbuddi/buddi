import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  loadAgentCatalog,
  type AgentCatalog,
  type Mission,
  type Occurrence,
  type ToolContext,
} from '@buddi/core';
import type { CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { manifest as artifactsManifest } from '@buddi/tool-artifacts';
import { manifest as financeManifest } from '@buddi/tool-finance';
import { manifest as memoryManifest } from '@buddi/tool-memory';
import { createDelegationManifest } from '../agents/delegation.js';
import { createReminderManifest, createScheduleManifest } from './reminders.js';
import { OwnerNotPairedError } from '../telegram/notify.js';
import { SCHEDULED_SURFACE, surfaceSection } from '@buddi/core';
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

/**
 * A provider that calls one mission tool and then stops — the shape every
 * unattended run is supposed to have.
 */
function decidingProvider(
  name: 'mission.report' | 'mission.silent',
  input: unknown,
  finalText = 'done',
): RuntimeProvider {
  let turn = 0;
  return {
    async complete(): Promise<CompletionResponse> {
      turn += 1;
      if (turn === 1) {
        return {
          content: [{ type: 'tool_use', id: 'call-1', name, input }],
          stopReason: 'tool_use',
          usage: { input: 10, output: 20 },
          model: 'claude-test',
        };
      }
      return {
        content: [{ type: 'text', text: finalText }],
        stopReason: 'end_turn',
        usage: { input: 1, output: 1 },
        model: 'claude-test',
      };
    },
  };
}

/**
 * The agent a mission run resolves.
 *
 * A fixture, deliberately. Which agents are installed on the machine running
 * this suite is the owner's business — `private/` is gitignored, a fresh clone
 * has none of it, and making one more is a supported action — while what the
 * executor owes is the same for any of them.
 */
const MISSION_AGENT = 'mission-agent';

function fixtureCatalog(registry: ToolRegistry): AgentCatalog {
  return loadAgentCatalog({
    dir: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '__fixtures__',
      'mission-agents',
    ),
    registry,
    env: { ANTHROPIC_API_KEY: 'test-key' },
  });
}

/** The recap: the one mission that speaks whatever the run decided. */
const mission: Mission = {
  id: 'friday-recap',
  name: 'Friday recap',
  agentId: MISSION_AGENT,
  prompt: 'Produce the weekly recap.',
  enabled: true,
  alwaysDeliver: true,
  createdAt: new Date('2026-09-01T00:00:00Z'),
};

/** A watcher mission: silent unless it says otherwise. */
const checkMission: Mission = {
  ...mission,
  id: 'daily-check',
  name: 'Daily check',
  prompt: 'Run the daily check.',
  alwaysDeliver: false,
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
  payload: null,
};

function deps(overrides: Partial<Parameters<typeof createMissionExecutor>[0]> = {}) {
  const db = new FakeDb();
  const registry = new ToolRegistry();
  registry.register(financeManifest);
  registry.register(memoryManifest);
  registry.register(artifactsManifest);
  registry.register(createReminderManifest());
  registry.register(createScheduleManifest());
  // The finance advisor's file grants agent.delegate, so the registry a mission
  // runs against must carry it too. It is unbound here: delegation refuses.
  registry.register(createDelegationManifest(registry));
  const ctx: ToolContext = {
    db: {} as ToolContext['db'],
    ownerId: 'owner',
    now: () => new Date('2026-09-11T12:00:00Z'),
    timezone: 'UTC',
  };
  const base = {
    pool: db as unknown as Pool,
    registry,
    catalog: fixtureCatalog(registry),
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

    expect(db.conversations).toEqual([{ id: 'conv-1', agent_id: MISSION_AGENT }]);
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
    // The facts come from the declared profile, not from the suffix.
    expect(systems[0]).toContain(surfaceSection(SCHEDULED_SURFACE));
    expect(systems[0]).toContain(
      'Nobody is here: this text is delivered as a notification and cannot be answered.',
    );
    expect(systems[0]).toContain('There is no canvas here');
  });

  it('keeps in the suffix only what is about being a scheduled run', () => {
    // Everything about rendering is the profile's job now; a second copy here
    // would be the one that silently disagrees with it.
    expect(SCHEDULED_RUN_SUFFIX).toContain('scheduled run');
    expect(SCHEDULED_RUN_SUFFIX).toContain('mission.report');
    expect(SCHEDULED_RUN_SUFFIX).not.toMatch(/markdown|tables|plain text/i);
    expect(SCHEDULED_RUN_SUFFIX).not.toMatch(/Telegram/i);
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

describe('the notify policy', () => {
  it('delivers the text passed to mission.report, not the free-form answer', async () => {
    const { db, deps: d } = deps();
    const delivered: string[] = [];
    const execute = createMissionExecutor({
      ...d,
      provider: decidingProvider(
        'mission.report',
        { urgency: 'urgent', text: 'Floor breaks on 2026-10-02. Move 200 EUR.' },
        'chatty trailing prose nobody asked for',
      ),
      deliver: async (text) => {
        delivered.push(text);
        return 'chat-42';
      },
    });

    const result = await execute(occurrence, checkMission);

    expect(result.decision).toBe('report');
    expect(result.urgency).toBe('urgent');
    expect(result.delivered).toBe(true);
    expect(delivered).toEqual(['Floor breaks on 2026-10-02. Move 200 EUR.']);
    expect(db.events.find((e) => e.kind === 'mission.delivered')?.payload).toMatchObject({
      missionId: 'daily-check',
      decision: 'report',
      urgency: 'urgent',
    });
  });

  it('delivers nothing and logs the reason when the run calls mission.silent', async () => {
    const { db, deps: d } = deps();
    const delivered: string[] = [];
    const execute = createMissionExecutor({
      ...d,
      provider: decidingProvider('mission.silent', { reason: 'projection holds' }),
      deliver: async (text) => {
        delivered.push(text);
        return 'chat-42';
      },
    });

    const result = await execute(occurrence, checkMission);

    expect(result.decision).toBe('silent');
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('projection holds');
    expect(delivered).toEqual([]);
    expect(db.events.find((e) => e.kind === 'mission.silent')?.payload).toMatchObject({
      missionId: 'daily-check',
      reason: 'projection holds',
    });
    expect(db.events.some((e) => e.kind === 'mission.delivered')).toBe(false);
  });

  it('treats a run that decided nothing as silent, with a warning', async () => {
    const { db, deps: d } = deps();
    const logs: string[] = [];
    const delivered: string[] = [];
    const execute = createMissionExecutor({
      ...d,
      log: (line) => logs.push(line),
      deliver: async (text) => {
        delivered.push(text);
        return 'chat-42';
      },
    });

    const result = await execute(occurrence, checkMission);

    expect(result.decision).toBe('no-decision');
    expect(result.delivered).toBe(false);
    expect(delivered).toEqual([]);
    expect(logs.join('\n')).toMatch(/warning/);
    expect(db.events.find((e) => e.kind === 'mission.silent')?.payload).toMatchObject({
      reason: 'no-decision',
    });
  });

  it('delivers anyway when the mission is always_deliver (the Friday recap)', async () => {
    const { deps: d } = deps();
    const delivered: string[] = [];
    const execute = createMissionExecutor({
      ...d,
      provider: decidingProvider('mission.silent', { reason: 'nothing changed' }),
      deliver: async (text) => {
        delivered.push(text);
        return 'chat-42';
      },
    });

    const result = await execute(occurrence, mission);

    expect(result.decision).toBe('silent');
    expect(result.delivered).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  it('delivers anyway for an interactive run (notifyPolicy: false)', async () => {
    const { deps: d } = deps();
    const delivered: string[] = [];
    const execute = createMissionExecutor({
      ...d,
      notifyPolicy: false,
      provider: decidingProvider('mission.silent', { reason: 'nothing changed' }),
      deliver: async (text) => {
        delivered.push(text);
        return 'chat-42';
      },
    });
    const result = await execute(occurrence, checkMission);
    expect(result.delivered).toBe(true);
    expect(delivered).toHaveLength(1);
  });
});

describe('a sentinel wake', () => {
  const wakeOccurrence: Occurrence = {
    ...occurrence,
    id: 'occ-wake',
    missionId: 'sentinel-wake',
    payload: {
      finding: {
        key: 'finance.floor-breach:2026-10-02',
        sentinelId: 'finance.cashflow',
        severity: 'urgent',
        title: 'Safety floor breaks in 19 days',
        detail: 'Projected minimum 120 EUR on 2026-10-02, floor is 500 EUR.',
        agentId: MISSION_AGENT,
        data: { minimum: 120, on: '2026-10-02' },
      },
    },
  };
  const wakeMission: Mission = {
    ...checkMission,
    id: 'sentinel-wake',
    name: 'Sentinel wake',
    prompt: 'Verify the finding.',
  };

  it('hands the finding to the agent as part of the prompt', async () => {
    const { db, deps: d } = deps();
    const execute = createMissionExecutor({
      ...d,
      provider: decidingProvider('mission.report', { urgency: 'urgent', text: 'Move 200 EUR.' }),
    });
    await execute(wakeOccurrence, wakeMission);
    const first = db.messages[0]?.content as { type: string; text: string }[];
    expect(first[0]?.text).toContain('Verify the finding.');
    expect(first[0]?.text).toContain('Safety floor breaks in 19 days');
    expect(first[0]?.text).toContain('finance.cashflow');
    expect(first[0]?.text).toContain('"minimum":120');
  });
});

describe('the weekly digest', () => {
  it('appends the prepared section and consumes it only after delivery', async () => {
    const { db, deps: d } = deps();
    let committed = 0;
    const execute = createMissionExecutor({
      ...d,
      prepare: async () => ({
        appendix: 'Items noted this week:\n- Subscription doubled: Netflix 12 -> 24 EUR.',
        commit: async () => {
          committed += 1;
        },
      }),
    });

    await execute(occurrence, mission);

    const first = db.messages[0]?.content as { type: string; text: string }[];
    expect(first[0]?.text).toContain('Produce the weekly recap.');
    expect(first[0]?.text).toContain('Items noted this week:');
    expect(committed).toBe(1);
  });

  it('leaves the items pending when delivery fails', async () => {
    const { deps: d } = deps();
    let committed = 0;
    const execute = createMissionExecutor({
      ...d,
      prepare: async () => ({
        appendix: 'Items noted this week:\n- something',
        commit: async () => {
          committed += 1;
        },
      }),
      deliver: async () => {
        throw new Error('telegram 502');
      },
    });

    await expect(execute(occurrence, mission)).rejects.toThrow(/telegram 502/);
    expect(committed).toBe(0);
  });
});
