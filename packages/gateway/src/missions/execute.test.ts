import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  loadAgentCatalog,
  type AgentCatalog,
  type Mission,
  type Occurrence,
  type CoreToolContext,
} from '@buddi/core';
import type { CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { manifest as artifactsManifest } from '@buddi/tool-artifacts';
import { fixturePluginManifest } from '../__fixtures__/plugin-manifest.js';
import { manifest as memoryManifest } from '@buddi/tool-memory';
import { createDelegationManifest } from '../agents/delegation.js';
import { createReminderManifest, createScheduleManifest } from './reminders.js';
import { OwnerNotPairedError } from '../telegram/notify.js';
import { SCHEDULED_SURFACE, surfaceSection } from '@buddi/core';
import { createMissionExecutor, SCHEDULED_RUN_SUFFIX, UnknownAgentError, type DeliverContext } from './execute.js';
import { createMissionManifest, reportMaxOf, type DecisionSink } from './report.js';
import { z } from 'zod';

/* ---------------- in-memory fake DB (only `query`) ---------------- */

class FakeDb {
  conversations: { id: string; agent_id: string }[] = [];
  offers: { id: string; agent_id: string; label: string; prompt: string }[] = [];
  messages: { conversation_id: string; role: string; content: unknown }[] = [];
  events: { kind: string; conversation_id: string | null; payload: any }[] = [];
  delivered: string[] = [];
  /** Finding keys a mute the owner set covers now. */
  muted = new Set<string>();
  /** Missions `endExpiredMissions` finds past their end. */
  ended: string[] = [];
  /** The quiet counter of the one agent mission a test runs. */
  quiet = 0;

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.includes('core.sentinel_mutes') && text.includes('core.sentinel_findings')) {
      return { rows: (params[0] as string[]).filter((k) => this.muted.has(k)).map((key) => ({ key })) };
    }
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
    if (text.startsWith('insert into core.offers')) {
      const row = {
        id: `offer-${this.offers.length + 1}`,
        agent_id: params[0],
        conversation_id: params[1],
        label: params[2],
        prompt: params[3],
        created_at: params[4],
        expires_at: params[5],
        taken_at: null,
        taken_via: null,
        taken_job_id: null,
      };
      this.offers.push(row as any);
      return { rows: [row] };
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
    if (text.startsWith('update core.sentinel_findings set delivered_at')) {
      this.delivered.push(params[0]);
      return { rows: [] };
    }
    if (text.startsWith('update core.missions set enabled = false, ended_at')) {
      return { rows: this.ended.map((id) => ({ id })) };
    }
    if (text.startsWith('with before as') && text.includes('quiet_runs')) {
      this.quiet += 1;
      return { rows: [{ quiet_runs: this.quiet, ask: this.quiet === 48 }] };
    }
    if (text.startsWith('update core.missions set quiet_runs = 0')) {
      this.quiet = 0;
      return { rows: [] };
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
    env: {},
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
  pausedReason: null,
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
  registry.register(fixturePluginManifest);
  registry.register(memoryManifest);
  registry.register(artifactsManifest);
  registry.register(createReminderManifest());
  registry.register(createScheduleManifest());
  // A mission agent's file may grant agent.delegate, so the registry a mission
  // runs against must carry it too. It is unbound here: delegation refuses.
  registry.register(createDelegationManifest(registry));
  const ctx: CoreToolContext = {
    db: {} as CoreToolContext['db'],
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
    env: {} as NodeJS.ProcessEnv,
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
      { type: 'text', text: 'Produce the weekly recap.\n\nThis run is mission "Friday recap" (id friday-recap).' },
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

  it('stores what the report offered and hands it to the delivery', async () => {
    // The offers travel with the text rather than being appended to it: how
    // they are drawn is the delivering surface's decision, and the executor
    // must not have made it already.
    const { db, deps: d } = deps();
    let seen: { text: string; offers: readonly { label: string }[] } | undefined;
    const execute = createMissionExecutor({
      ...d,
      provider: decidingProvider('mission.report', {
        urgency: 'urgent',
        text: 'Dorothée has retired and named two successors.',
        actions: [
          { label: 'Draft a reply', prompt: 'Draft a reply to Dorothée and show it to me.' },
          { label: 'Remind me tomorrow', prompt: 'Remind me tomorrow about the CdC site.' },
        ],
      }),
      deliver: async (text, offers) => {
        seen = { text, offers: offers ?? [] };
        return 'chat-42';
      },
    });

    const result = await execute(occurrence, checkMission);

    expect(result.decision).toBe('report');
    // The text is exactly what was written. Nothing was appended to it here.
    expect(seen?.text).toBe('Dorothée has retired and named two successors.');
    expect(seen?.offers.map((o) => o.label)).toEqual(['Draft a reply', 'Remind me tomorrow']);
    expect(db.offers.map((o) => o.agent_id)).toEqual([MISSION_AGENT, MISSION_AGENT]);
    expect(db.offers[0]?.prompt).toBe('Draft a reply to Dorothée and show it to me.');
    expect(result.offers).toHaveLength(2);
  });

  it('offers nothing when the report offered nothing', async () => {
    const { db, deps: d } = deps();
    let seen: readonly unknown[] | undefined;
    const execute = createMissionExecutor({
      ...d,
      provider: decidingProvider('mission.report', { urgency: 'normal', text: 'Nothing to do.' }),
      deliver: async (_text, offers) => {
        seen = offers;
        return 'chat-42';
      },
    });
    await execute(occurrence, checkMission);
    expect(seen).toEqual([]);
    expect(db.offers).toHaveLength(0);
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
        sentinelId: 'ledger.cashflow',
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

  /**
   * A goal's finding, which always names its holder: a goal belongs to one
   * agent and a different one may read it but never speak for it.
   */
  const goalOccurrence: Occurrence = {
    ...wakeOccurrence,
    id: 'occ-goal',
    payload: {
      finding: {
        key: 'goal.g-1.off-track',
        sentinelId: 'core.goals',
        severity: 'urgent',
        title: 'Off track: Debt down by 40k',
        detail:
          'Two checks running, the pace of the last four lands short.\n\n' +
          'Verify with your own tools, then report; to change the goal propose `goal.update`, never change it silently.',
        agentId: 'goal-holder',
        data: { goalId: 'g-1', metric: 'finance.total_debt' },
      },
    },
  };

  it('runs as the agent the finding names, not the one the mission is bound to', async () => {
    const { db, deps: d } = deps();
    const execute = createMissionExecutor({
      ...d,
      provider: decidingProvider('mission.report', { urgency: 'urgent', text: 'It is off track.' }),
    });
    // The wake mission is bound to the overview agent, as `sentinelWakeMission`
    // binds it. The goal is held by somebody else, and the holder must be the
    // one whose conversation this happens in.
    expect(wakeMission.agentId).toBe(MISSION_AGENT);
    await execute(goalOccurrence, wakeMission);
    expect(db.conversations.map((c) => c.agent_id)).toEqual(['goal-holder']);

    // And the goal's own instruction reaches it, inside the finding fence —
    // the generic wake prompt says nothing about goals.
    const first = db.messages[0]?.content as { type: string; text: string }[];
    expect(first[0]?.text).toContain('never change it silently');
    expect(first[0]?.text).toContain('core.goals');
  });

  it('delivers the line as the finding asks: end of the day, under its own dedupe key', async () => {
    const { deps: d } = deps();
    const contexts: unknown[] = [];
    const execute = createMissionExecutor({
      ...d,
      provider: decidingProvider('mission.report', { urgency: 'normal', text: 'You have not told me your weight this week.' }),
      deliver: async (_text, _offers, context) => {
        contexts.push(context);
        return 'chat-42';
      },
    });
    const staleOccurrence: Occurrence = {
      ...goalOccurrence,
      id: 'occ-stale',
      payload: {
        finding: {
          ...(goalOccurrence.payload as { finding: Record<string, unknown> }).finding,
          key: 'goal.g-1.stale.2026-09-29',
          severity: 'info',
          notify: { urgency: 'today', dedupeKey: 'goal:g-1:stale:2026-09-29' },
        },
      },
    };
    await execute(staleOccurrence, wakeMission);
    expect(contexts[0]).toMatchObject({ origin: 'wake', notifyUrgency: 'today', dedupeKey: 'goal:g-1:stale:2026-09-29' });

    // And a finding that asks for nothing is `now`, keyed by the finding, as before.
    contexts.length = 0;
    const again = createMissionExecutor({
      ...deps().deps,
      provider: decidingProvider('mission.report', { urgency: 'urgent', text: 'It is off track.' }),
      deliver: async (_text, _offers, context) => {
        contexts.push(context);
        return 'chat-42';
      },
    });
    await again(goalOccurrence, wakeMission);
    expect(contexts[0]).toMatchObject({ dedupeKey: 'finding:goal.g-1.off-track' });
    expect(contexts[0]).not.toHaveProperty('notifyUrgency');
  });

  it('hands a coalesced burst to the agent in one run, and stamps every finding', async () => {
    const { db, deps: d } = deps();
    const contexts: unknown[] = [];
    const execute = createMissionExecutor({
      ...d,
      provider: decidingProvider('mission.report', { urgency: 'urgent', text: 'Two cards are due this week.' }),
      deliver: async (_text, _offers, context) => { contexts.push(context); return 'chat-42'; },
    });
    const first = (wakeOccurrence.payload as { finding: Record<string, unknown> }).finding;
    const second = { ...first, key: 'finance.due:card-2', title: 'Card 2 is due on Friday' };
    await execute({ ...wakeOccurrence, id: 'occ-burst', payload: { finding: first, findings: [first, second], coalesce: { group: 'wake:x', firstAt: '2026-09-11T12:00:00Z', count: 2 } } }, wakeMission);
    expect(db.conversations).toHaveLength(1);
    const text = (db.messages[0]?.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('2 watcher findings arrived together');
    expect(text).toContain('Safety floor breaks in 19 days');
    expect(text).toContain('Card 2 is due on Friday');
    expect(db.delivered).toEqual(['finance.floor-breach:2026-10-02', 'finance.due:card-2']);
    expect(contexts[0]).not.toHaveProperty('dedupeKey');
    expect(db.events.find((e) => e.kind === 'mission.delivered')?.payload).toMatchObject({ findingKeys: ['finance.floor-breach:2026-10-02', 'finance.due:card-2'] });
  });

  it('drops a wake whose finding the owner muted after it was enqueued, and tells nobody', async () => {
    const { db, deps: d } = deps();
    const delivered: string[] = [];
    const calls: string[] = [];
    const execute = createMissionExecutor({
      ...d,
      provider: fakeProvider('should not run', calls),
      deliver: async (text) => { delivered.push(text); return 'chat-42'; },
    });
    db.muted.add('finance.floor-breach:2026-10-02');
    const result = await execute(wakeOccurrence, wakeMission);
    expect(result).toMatchObject({ delivered: false, decision: 'silent', reason: 'muted' });
    expect(calls).toHaveLength(0);
    expect(db.conversations).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    expect(db.events.find((e) => e.kind === 'mission.silent')?.payload).toMatchObject({ reason: 'muted', findingKey: 'finance.floor-breach:2026-10-02' });
  });

  it('hands a coalesced burst over without the findings muted since', async () => {
    const { db, deps: d } = deps();
    const execute = createMissionExecutor({
      ...d,
      provider: decidingProvider('mission.report', { urgency: 'urgent', text: 'Card 2 is due.' }),
      deliver: async () => 'chat-42',
    });
    const first = (wakeOccurrence.payload as { finding: Record<string, unknown> }).finding;
    const second = { ...first, key: 'finance.due:card-2', title: 'Card 2 is due on Friday' };
    db.muted.add('finance.floor-breach:2026-10-02');
    await execute({ ...wakeOccurrence, id: 'occ-burst-muted', payload: { finding: first, findings: [first, second] } }, wakeMission);
    const text = (db.messages[0]?.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('Card 2 is due on Friday');
    expect(text).not.toContain('Safety floor breaks in 19 days');
    expect(db.delivered).toEqual(['finance.due:card-2']);
  });

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
    expect(first[0]?.text).toContain('ledger.cashflow');
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

describe('missions that stop themselves', () => {
  const own: Mission = {
    ...checkMission,
    id: `agent:${MISSION_AGENT}:store-watch`,
    name: 'Store watch',
    prompt: 'Check whether the store listing is approved.',
    stopWhen: 'the listing is approved',
    endsAt: new Date('2026-10-11T12:00:00Z'),
  };

  it('tells an agent\'s own mission its id and the rule, and lends it schedule.cancel_mine', async () => {
    const seen: { tools: string[]; text: string }[] = [];
    const provider: RuntimeProvider = {
      async complete(req): Promise<CompletionResponse> {
        const first = req.messages[0]?.content as unknown;
        seen.push({ tools: req.tools.map((t) => t.name), text: JSON.stringify(first) });
        return { content: [{ type: 'tool_use', id: 'c1', name: 'mission.silent', input: { reason: 'not yet' } }], stopReason: 'tool_use', usage: { input: 1, output: 1 }, model: 'claude-test' };
      },
    };
    const { db, deps: d } = deps({ provider });
    const result = await createMissionExecutor(d)({ ...occurrence, missionId: own.id }, own);
    expect(result.decision).toBe('silent');
    expect(seen[0]!.tools).toEqual(expect.arrayContaining(['schedule.cancel_mine', 'schedule.list_mine', 'mission.silent']));
    expect(seen[0]!.text).toContain(`id ${own.id}`);
    expect(seen[0]!.text).toContain('It is done when: the listing is approved.');
    expect(seen[0]!.text).toContain('call schedule.cancel_mine');
    // The silent run counted once.
    expect(db.quiet).toBe(1);
  });

  it('gives the owner\'s missions their id, but neither the rule nor the tool', async () => {
    const seen: { tools: string[]; text: string }[] = [];
    const provider: RuntimeProvider = {
      async complete(req): Promise<CompletionResponse> {
        seen.push({ tools: req.tools.map((t) => t.name), text: JSON.stringify(req.messages[0]?.content) });
        return { content: [{ type: 'tool_use', id: 'c1', name: 'mission.silent', input: { reason: 'nothing' } }], stopReason: 'tool_use', usage: { input: 1, output: 1 }, model: 'claude-test' };
      },
    };
    const { db, deps: d } = deps({ provider });
    await createMissionExecutor(d)({ ...occurrence, missionId: checkMission.id }, checkMission);
    expect(seen[0]!.tools).not.toContain('schedule.cancel_mine');
    expect(seen[0]!.text).toContain('id daily-check');
    expect(seen[0]!.text).not.toContain('schedule.cancel_mine');
    expect(db.quiet).toBe(0);
  });

  it('switches a watch past its end off quietly, without a model call', async () => {
    let calls = 0;
    const provider: RuntimeProvider = { async complete() { calls += 1; throw new Error('no call expected'); } };
    const { db, deps: d } = deps({ provider });
    db.ended = [own.id];
    const result = await createMissionExecutor(d)({ ...occurrence, missionId: own.id }, { ...own, endsAt: new Date('2026-09-10T00:00:00Z') });
    expect(result).toMatchObject({ delivered: false, decision: 'silent', reason: 'ended' });
    expect(calls).toBe(0);
    expect(db.events.map((e) => e.kind)).toContain('mission.ended');
  });
});


describe('host API 1.27: a mission\'s context, its reportMax, and the report\'s link and audio', () => {
  const capturing = (seen: string[], report: unknown): RuntimeProvider => {
    let turn = 0;
    return {
      async complete(req): Promise<CompletionResponse> {
        turn += 1;
        if (turn === 1) {
          seen.push(JSON.stringify(req.messages[0]?.content));
          return { content: [{ type: 'tool_use', id: 'c1', name: 'mission.report', input: report }], stopReason: 'tool_use', usage: { input: 1, output: 1 }, model: 'claude-test' };
        }
        return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { input: 1, output: 1 }, model: 'claude-test' };
      },
    };
  };
  const newsManifest = {
    name: 'news', version: '0.1.0', schema: 'news', migrationsDir: '', tools: [],
    exports: {
      edition_material: {
        params: z.object({ edition: z.enum(['morning', 'evening']) }).strict(),
        produce: async (params: { edition: string }) => ({ edition: params.edition, stories: [{ id: 's1', title: 'Lomé port traffic rose 9%' }] }),
      },
    },
  };
  const edition: Mission = {
    ...checkMission,
    id: 'agent:mission-agent:morning',
    name: 'Morning edition',
    prompt: 'Write the morning edition.',
    context: { plugin: 'news', export: 'edition_material', args: { edition: 'morning' } },
    reportMax: 3800,
  };

  it('opens the run with the export\'s JSON, read once by core, and passes the link to the delivery', async () => {
    const seen: string[] = [];
    let context: DeliverContext | undefined;
    const { deps: d } = deps({
      provider: capturing(seen, { urgency: 'normal', text: 'Morning edition\n\nSix stories.', link: '#/p/news/stories', linkLabel: 'Open edition' }),
      deliver: async (_text, _offers, c) => { context = c; return 'chat-42'; },
    });
    d.registry.register(newsManifest as never);
    const result = await createMissionExecutor(d)(occurrence, edition);
    expect(seen[0]).toContain('The material this mission reads first, from news.edition_material');
    expect(seen[0]).toContain('Lomé port traffic rose 9%');
    expect(result.delivered).toBe(true);
    expect(context).toMatchObject({ link: '#/p/news/stories', origin: 'mission' });
    expect(context?.audio).toBeUndefined();
  });

  it('says so in the message when the context cannot be read, and the run goes on', async () => {
    const seen: string[] = [];
    const { deps: d } = deps({ provider: capturing(seen, { urgency: 'normal', text: 'A quiet morning.' }) });
    const result = await createMissionExecutor(d)(occurrence, edition);
    expect(seen[0]).toContain('(news.edition_material) could not be read: news is not loaded');
    expect(result.delivered).toBe(true);
  });

  it('takes a report up to its mission\'s reportMax, and refuses one past the default without it', async () => {
    const long = `Morning edition\n\n${'A story, told in a sentence or two. '.repeat(60)}`.trim();
    expect(long.length).toBeGreaterThan(1500);
    const delivered: string[] = [];
    const ok = deps({ provider: capturing([], { urgency: 'normal', text: long }), deliver: async (t) => { delivered.push(t); return 'chat-42'; } });
    ok.deps.registry.register(newsManifest as never);
    expect((await createMissionExecutor(ok.deps)(occurrence, edition)).delivered).toBe(true);
    expect(delivered).toEqual([long]);
    const refused = deps({ provider: capturing([], { urgency: 'normal', text: long }) });
    const result = await createMissionExecutor(refused.deps)(occurrence, { ...checkMission, reportMax: null });
    expect(result).toMatchObject({ delivered: false, decision: 'no-decision' });
  });

  it('refuses a link that is not a dashboard route and a voice note that is not in Files', async () => {
    for (const report of [
      { urgency: 'normal', text: 'x', link: 'https://example.com/story' },
      { urgency: 'normal', text: 'x', audio: '7c1b0a52-6f0e-4b8e-9d55-1e0f2a3b4c5d' },
    ]) {
      const { deps: d } = deps({ provider: capturing([], report) });
      expect(await createMissionExecutor(d)(occurrence, checkMission)).toMatchObject({ delivered: false, decision: 'no-decision' });
    }
  });
});

describe('mission.report audio', () => {
  const FILE = '7c1b0a52-6f0e-4b8e-9d55-1e0f2a3b4c5d';
  const db = (row: Record<string, unknown> | null, conversation: string | null) => ({
    async query(sql: string) {
      if (sql.includes('select conversation_id')) return { rows: row ? [{ conversation_id: conversation }] : [] };
      return { rows: row ? [row] : [] };
    },
  });
  const voice = { id: FILE, kind: 'audio', mime: 'audio/ogg', filename: 'edition.ogg', size_bytes: 4096, sha256: 'x', storage_path: 'p', caption: null, created_at: null };
  const report = (pool: unknown, conversationId = 'conv-1') => {
    const sink: DecisionSink = {};
    const tool = createMissionManifest(sink, { reportMax: 3800 }).tools.find((t) => t.name === 'mission.report')!;
    return { sink, run: () => tool.execute({ urgency: 'normal', text: 'Morning edition', audio: FILE } as never, { db: pool, conversationId } as never) };
  };

  it('carries a voice note this run made, with its type and size for the chat\'s player', async () => {
    const { sink, run } = report(db(voice, 'conv-1'));
    expect(await run()).toMatchObject({ audio: { fileId: FILE, mime: 'audio/ogg', filename: 'edition.ogg', sizeBytes: 4096 } });
    expect(sink.decision).toMatchObject({ kind: 'report', audio: { fileId: FILE } });
  });

  it('refuses one made elsewhere, one that is not audio, and one that is not there', async () => {
    await expect(report(db(voice, 'conv-2')).run()).rejects.toThrow(/was not made in this run/);
    await expect(report(db({ ...voice, mime: 'image/png' }, 'conv-1')).run()).rejects.toThrow(/not a voice note/);
    await expect(report(db(null, null)).run()).rejects.toThrow(/no file/);
  });

  it('bounds reportMax at the limit and keeps the default without one', () => {
    expect(reportMaxOf(undefined)).toBe(1500);
    expect(reportMaxOf(3800)).toBe(3800);
    expect(reportMaxOf(99_999)).toBe(6000);
    expect(reportMaxOf(10)).toBe(1500);
  });
});
