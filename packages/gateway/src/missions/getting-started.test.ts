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
import { fixturePluginManifest } from '../__fixtures__/plugin-manifest.js';
import { manifest as memoryManifest } from '@buddi/tool-memory';
import { createDelegationManifest } from '../agents/delegation.js';
import { createReminderManifest, createScheduleManifest } from './reminders.js';
import { createEngagementHooks } from './engagement.js';
import { createMissionExecutor } from './execute.js';
import {
  arcNote,
  decideArc,
  withNudgeBudget,
  GETTING_STARTED_ID,
  STOPPING_TEXT,
  type MissionExecute,
} from './getting-started.js';
import { ARC_WINDOW_DAYS, MAX_NUDGES, MAX_UNANSWERED } from './nudge-policy.js';
import { noteOwnerActivity, readArcState, recordNudgeDelivered } from './nudge-state.js';
import { planArc } from './defaults.js';

const NOW = new Date('2026-09-14T09:30:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ *
 * A fake database: the onboarding row, the preferences, the event log
 * ------------------------------------------------------------------ */

interface OnboardingRow {
  owner_id: string;
  state: string;
  started_at: Date | null;
  completed_at: Date | null;
  surface: string | null;
  steps_done: string[];
  nudges_sent: number;
  last_nudge_at: Date | null;
  unanswered: number;
  quiet_until: Date | null;
  updated_at: Date | null;
}

function onboardingRow(overrides: Partial<OnboardingRow> = {}): OnboardingRow {
  return {
    owner_id: 'owner',
    state: 'done',
    started_at: new Date(NOW.getTime() - 3 * DAY),
    completed_at: new Date(NOW.getTime() - 3 * DAY),
    surface: 'telegram',
    steps_done: [],
    nudges_sent: 0,
    last_nudge_at: null,
    unanswered: 0,
    quiet_until: null,
    updated_at: null,
    ...overrides,
  };
}

class FakeDb {
  onboarding: OnboardingRow | null;
  preferences: { key: string; value: string; agent_scope: string | null; revision: number }[] = [];
  events: { kind: string; conversation_id: string | null; payload: any }[] = [];
  missions: { id: string; enabled: boolean }[] = [{ id: GETTING_STARTED_ID, enabled: true }];
  conversations: { id: string; agent_id: string }[] = [];
  messages: { conversation_id: string; role: string; content: unknown }[] = [];

  constructor(onboarding: OnboardingRow | null = onboardingRow()) {
    this.onboarding = onboarding;
  }

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();

    if (text.startsWith('select owner_id, state, started_at')) {
      return { rows: this.onboarding ? [this.onboarding] : [] };
    }
    if (text.startsWith('update core.onboarding set nudges_sent')) {
      if (!this.onboarding) return { rows: [] };
      this.onboarding.nudges_sent += 1;
      this.onboarding.last_nudge_at = params[1];
      this.onboarding.unanswered += 1;
      return { rows: [] };
    }
    if (text.startsWith('update core.onboarding set unanswered = 0')) {
      if (this.onboarding && this.onboarding.unanswered !== 0) this.onboarding.unanswered = 0;
      return { rows: [] };
    }
    if (text.startsWith('update core.onboarding set quiet_until')) {
      if (!this.onboarding) return { rows: [] };
      this.onboarding.quiet_until = params[1];
      return { rows: [{ owner_id: 'owner' }] };
    }
    if (text.includes('from memory.preferences')) {
      return { rows: this.preferences };
    }
    if (text.startsWith('update core.missions set enabled')) {
      const row = this.missions.find((m) => m.id === params[0]);
      if (!row) return { rows: [] };
      row.enabled = params[1];
      return { rows: [{ id: row.id, enabled: row.enabled, always_deliver: false }] };
    }
    if (text.startsWith('insert into core.events')) {
      const row = {
        kind: params[0],
        conversation_id: params[1] ?? null,
        payload: JSON.parse(params[2]),
      };
      this.events.push(row);
      return { rows: [{ id: `evt-${this.events.length}`, created_at: new Date(), ...row }] };
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
    if (text.includes('memory.notes')) return { rows: [] };
    throw new Error(`FakeDb: unexpected sql: ${text}`);
  }
}

/**
 * The agent the arc runs as — a fixture, never whatever this machine has
 * installed: `private/` is gitignored and the owner may make another agent at
 * any time, and neither fact changes what the budget owes.
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

const mission: Mission = {
  id: GETTING_STARTED_ID,
  name: 'Getting started',
  agentId: MISSION_AGENT,
  prompt: 'Find one genuinely useful thing.',
  enabled: true,
  alwaysDeliver: false,
  createdAt: new Date('2026-09-01T00:00:00Z'),
};

const occurrence: Occurrence = {
  id: 'occ-1',
  missionId: GETTING_STARTED_ID,
  scheduleRevision: 1,
  scheduledAt: NOW,
  state: 'claimed',
  claimedAt: NOW,
  finishedAt: null,
  runConversationId: null,
  error: null,
  payload: null,
};

/** A run that does nothing but report whether it was called. */
function spyExecute(delivered: boolean): { execute: MissionExecute; calls: Mission[] } {
  const calls: Mission[] = [];
  const execute: MissionExecute = async (_occ, m) => {
    calls.push(m);
    return {
      conversationId: 'conv-x',
      text: delivered ? 'something true' : '',
      delivered,
      decision: delivered ? 'report' : 'silent',
    };
  };
  return { execute, calls };
}

function budgetDeps(db: FakeDb, delivered: string[] = []) {
  return {
    pool: db as unknown as Pool,
    now: () => NOW,
    deliver: async (text: string): Promise<string> => {
      delivered.push(text);
      return 'chat-42';
    },
    log: () => {},
  };
}

/* ------------------------------------------------------------------ *
 * decideArc — the gate, without a database
 * ------------------------------------------------------------------ */

describe('decideArc', () => {
  const inWindow = { state: 'done', completedAt: new Date(NOW.getTime() - DAY), surface: 'cli' };
  const zeroed = { nudgesSent: 0, lastNudgeAt: null, quietUntil: null, unanswered: 0 };

  it('allows a run inside the window with budget left', () => {
    const decision = decideArc(
      { onboarding: inWindow, engagement: undefined, nudges: zeroed },
      NOW,
    );
    expect(decision).toMatchObject({ allow: true, disable: false, sayGoodbye: false });
  });

  it('refuses and disables permanently when engagement is quiet', () => {
    const decision = decideArc({ onboarding: inWindow, engagement: 'quiet', nudges: zeroed }, NOW);
    expect(decision.allow).toBe(false);
    expect(decision.disable).toBe(true);
    expect(decision.sayGoodbye).toBe(false);
    expect(decision.skip).toMatchObject({ kind: 'engagement' });
  });

  it('refuses and disables once the window has closed', () => {
    const decision = decideArc(
      {
        onboarding: {
          state: 'done',
          completedAt: new Date(NOW.getTime() - (ARC_WINDOW_DAYS + 1) * DAY),
          surface: 'cli',
        },
        engagement: undefined,
        nudges: zeroed,
      },
      NOW,
    );
    expect(decision.allow).toBe(false);
    expect(decision.disable).toBe(true);
    expect(decision.skip).toMatchObject({ kind: 'window' });
  });

  it('postpones without disabling when it is only too soon', () => {
    const decision = decideArc(
      {
        onboarding: inWindow,
        engagement: undefined,
        nudges: { ...zeroed, lastNudgeAt: new Date(NOW.getTime() - HOUR) },
      },
      NOW,
    );
    expect(decision).toMatchObject({ allow: false, disable: false, sayGoodbye: false });
  });

  it('says goodbye only when it stops for silence', () => {
    const silence = decideArc(
      { onboarding: inWindow, engagement: undefined, nudges: { ...zeroed, unanswered: MAX_UNANSWERED } },
      NOW,
    );
    expect(silence).toMatchObject({ allow: false, disable: true, sayGoodbye: true });

    const spent = decideArc(
      { onboarding: inWindow, engagement: undefined, nudges: { ...zeroed, nudgesSent: MAX_NUDGES } },
      NOW,
    );
    expect(spent).toMatchObject({ allow: false, disable: true, sayGoodbye: false });
  });
});

/* ------------------------------------------------------------------ *
 * withNudgeBudget — the gate, wired to the database
 * ------------------------------------------------------------------ */

describe('withNudgeBudget', () => {
  it('leaves every other mission alone', async () => {
    const db = new FakeDb(null);
    const { execute, calls } = spyExecute(true);
    const guarded = withNudgeBudget(execute, budgetDeps(db));
    await guarded(occurrence, { ...mission, id: 'friday-recap' });
    expect(calls).toHaveLength(1);
  });

  it('disables the mission when the 14-day window has closed, and logs why', async () => {
    const db = new FakeDb(
      onboardingRow({ completed_at: new Date(NOW.getTime() - (ARC_WINDOW_DAYS + 1) * DAY) }),
    );
    const { execute, calls } = spyExecute(true);
    const lines: string[] = [];
    const guarded = withNudgeBudget(execute, { ...budgetDeps(db), log: (l) => lines.push(l) });

    const result = await guarded(occurrence, mission);

    expect(calls).toHaveLength(0);
    expect(result.delivered).toBe(false);
    expect(result.decision).toBe('silent');
    expect(db.missions[0]?.enabled).toBe(false);
    expect(db.events.map((e) => e.kind)).toContain('mission.disabled');
    expect(lines.join('\n')).toContain('disabled');
  });

  it('sends the closing message exactly once when it stops for silence', async () => {
    const db = new FakeDb(onboardingRow({ unanswered: MAX_UNANSWERED, nudges_sent: 3 }));
    const delivered: string[] = [];
    const { execute } = spyExecute(true);
    const guarded = withNudgeBudget(execute, budgetDeps(db, delivered));

    await guarded(occurrence, mission);
    expect(delivered).toEqual([STOPPING_TEXT]);
    expect(db.missions[0]?.enabled).toBe(false);

    // The scheduler will not run a disabled mission again — but `run-now` would,
    // and the message must still be said only once.
    await guarded(occurrence, { ...mission, enabled: false });
    expect(delivered).toEqual([STOPPING_TEXT]);
  });

  it('never sends a closing message when the budget merely ran out', async () => {
    const db = new FakeDb(onboardingRow({ nudges_sent: MAX_NUDGES }));
    const delivered: string[] = [];
    const { execute } = spyExecute(true);
    await withNudgeBudget(execute, budgetDeps(db, delivered))(occurrence, mission);
    expect(delivered).toEqual([]);
    expect(db.missions[0]?.enabled).toBe(false);
  });

  it('refuses before the run, so a blocked day costs no model call', async () => {
    const db = new FakeDb(onboardingRow({ quiet_until: new Date(NOW.getTime() + DAY) }));
    const { execute, calls } = spyExecute(true);
    await withNudgeBudget(execute, budgetDeps(db))(occurrence, mission);
    expect(calls).toHaveLength(0);
    // Quiet postpones; it does not end the arc.
    expect(db.missions[0]?.enabled).toBe(true);
  });

  it('counts a delivered message and tells the run where it stands', async () => {
    const db = new FakeDb(onboardingRow());
    const { execute, calls } = spyExecute(true);
    await withNudgeBudget(execute, budgetDeps(db))(occurrence, mission);
    expect(calls[0]?.prompt).toContain('message 1 of');
    expect(db.onboarding?.nudges_sent).toBe(1);
    expect(db.onboarding?.unanswered).toBe(1);
    expect(db.onboarding?.last_nudge_at).toEqual(NOW);
  });

  it('steers only the first two runs towards demonstrating on the owner\'s data', () => {
    expect(arcNote(0)).toContain('DEMONSTRATING');
    expect(arcNote(1)).toContain('DEMONSTRATING');
    expect(arcNote(2)).not.toContain('DEMONSTRATING');
    expect(arcNote(2)).toContain(`message 3 of at most ${MAX_NUDGES}`);
  });
});

/* ------------------------------------------------------------------ *
 * A real run that finds nothing
 * ------------------------------------------------------------------ */

/** A provider that calls one mission tool and then stops. */
function decidingProvider(
  name: 'mission.report' | 'mission.silent',
  input: unknown,
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
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input: 1, output: 1 },
        model: 'claude-test',
      };
    },
  };
}

function realExecutorOver(db: FakeDb, provider: RuntimeProvider): MissionExecute {
  const registry = new ToolRegistry();
  registry.register(fixturePluginManifest);
  registry.register(memoryManifest);
  registry.register(artifactsManifest);
  registry.register(createReminderManifest());
  registry.register(createScheduleManifest());
  registry.register(createDelegationManifest(registry));
  const ctx: ToolContext = {
    db: {} as ToolContext['db'],
    ownerId: 'owner',
    now: () => NOW,
    timezone: 'UTC',
  };
  return createMissionExecutor({
    pool: db as unknown as Pool,
    registry,
    catalog: fixtureCatalog(registry),
    provider,
    ctx,
    env: { ANTHROPIC_API_KEY: 'test-key' } as NodeJS.ProcessEnv,
    now: () => NOW,
    deliver: async () => 'chat-42',
    log: () => {},
  });
}

describe('a getting-started run that finds nothing', () => {
  it('calls mission.silent and spends none of the budget', async () => {
    const db = new FakeDb(onboardingRow());
    const provider = decidingProvider('mission.silent', {
      reason: 'nothing specific to this owner today',
    });
    const guarded = withNudgeBudget(realExecutorOver(db, provider), budgetDeps(db));

    const result = await guarded(occurrence, mission);

    expect(result.decision).toBe('silent');
    expect(result.delivered).toBe(false);
    expect(db.onboarding?.nudges_sent).toBe(0);
    expect(db.onboarding?.unanswered).toBe(0);
    expect(db.onboarding?.last_nudge_at).toBeNull();
    expect(db.events.map((e) => e.kind)).toContain('mission.silent');
  });

  it('spends one message when the run does find something', async () => {
    const db = new FakeDb(onboardingRow());
    const provider = decidingProvider('mission.report', {
      urgency: 'normal',
      text: 'Your rent leaves on the 3rd. Want me to watch it?',
    });
    const guarded = withNudgeBudget(realExecutorOver(db, provider), budgetDeps(db));

    const result = await guarded(occurrence, mission);

    expect(result.delivered).toBe(true);
    expect(db.onboarding?.nudges_sent).toBe(1);
    expect(db.onboarding?.unanswered).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * The owner answering, and /quiet
 * ------------------------------------------------------------------ */

describe('an inbound owner message', () => {
  it('resets the unanswered counter on any surface', async () => {
    const db = new FakeDb(onboardingRow({ unanswered: 2, nudges_sent: 4 }));
    await noteOwnerActivity(db as unknown as Pool, NOW);
    expect(db.onboarding?.unanswered).toBe(0);
    // What it spent is history and is never rewound.
    expect(db.onboarding?.nudges_sent).toBe(4);
  });

  it('is what the surfaces call, through the same hook', async () => {
    const db = new FakeDb(onboardingRow({ unanswered: MAX_UNANSWERED }));
    const hooks = createEngagementHooks({
      pool: db as unknown as Pool,
      now: () => NOW,
      timezone: 'UTC',
      unavailableText: 'nothing to quieten',
    });
    await hooks.noteActivity();
    expect(db.onboarding?.unanswered).toBe(0);

    // And the arc is allowed to speak again on the next run.
    const { execute, calls } = spyExecute(true);
    await withNudgeBudget(execute, budgetDeps(db))(occurrence, mission);
    expect(calls).toHaveLength(1);
  });

  it('never costs the owner their answer when the counter cannot be written', async () => {
    const broken = {
      async query(): Promise<{ rows: any[] }> {
        throw Object.assign(new Error('boom'), { code: '08006' });
      },
    };
    const lines: string[] = [];
    const hooks = createEngagementHooks({
      pool: broken as unknown as Pool,
      now: () => NOW,
      timezone: 'UTC',
      unavailableText: 'nothing to quieten',
      log: (l) => lines.push(l),
    });
    await expect(hooks.noteActivity()).resolves.toBeUndefined();
    expect(lines.join('\n')).toContain('unanswered');
  });
});

describe('/quiet', () => {
  function hooksOver(db: FakeDb) {
    return createEngagementHooks({
      pool: db as unknown as Pool,
      now: () => NOW,
      timezone: 'UTC',
      unavailableText: 'nothing to quieten',
    });
  }

  it('sets quiet_until seven days out by default, and silences the arc', async () => {
    const db = new FakeDb(onboardingRow());
    const line = await hooksOver(db).quiet('');
    expect(line.split('\n')).toHaveLength(1);
    expect(db.onboarding?.quiet_until?.getTime()).toBe(NOW.getTime() + 7 * DAY);

    const { execute, calls } = spyExecute(true);
    await withNudgeBudget(execute, budgetDeps(db))(occurrence, mission);
    expect(calls).toHaveLength(0);
  });

  it('takes 1d and 1w', async () => {
    const db = new FakeDb(onboardingRow());
    await hooksOver(db).quiet('1d');
    expect(db.onboarding?.quiet_until?.getTime()).toBe(NOW.getTime() + DAY);
    await hooksOver(db).quiet('1w');
    expect(db.onboarding?.quiet_until?.getTime()).toBe(NOW.getTime() + 7 * DAY);
  });

  it('clears it with off, and the arc speaks again', async () => {
    const db = new FakeDb(onboardingRow({ quiet_until: new Date(NOW.getTime() + 5 * DAY) }));
    const line = await hooksOver(db).quiet('off');
    expect(line).toContain('Quiet off');
    expect(db.onboarding?.quiet_until).toBeNull();

    const { execute, calls } = spyExecute(true);
    await withNudgeBudget(execute, budgetDeps(db))(occurrence, mission);
    expect(calls).toHaveLength(1);
  });

  it('says there is nothing to quieten when no onboarding row exists', async () => {
    const db = new FakeDb(null);
    expect(await hooksOver(db).quiet('1w')).toBe('nothing to quieten');
  });
});

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

describe('planArc', () => {
  const inWindow = { state: 'done', completedAt: new Date(NOW.getTime() - DAY), surface: 'cli' };

  it('skips the arc entirely when the owner preference is quiet', () => {
    const arc = planArc({ engagement: 'quiet', onboarding: inWindow }, NOW);
    expect(arc.register).toBe(false);
  });

  it('registers it enabled inside the window', () => {
    expect(planArc({ engagement: undefined, onboarding: inWindow }, NOW)).toMatchObject({
      register: true,
      enabled: true,
    });
  });

  it('registers it disabled outside the window', () => {
    expect(
      planArc(
        {
          engagement: 'arc',
          onboarding: {
            state: 'done',
            completedAt: new Date(NOW.getTime() - (ARC_WINDOW_DAYS + 1) * DAY),
            surface: 'cli',
          },
        },
        NOW,
      ),
    ).toMatchObject({ register: true, enabled: false });
  });

  it('registers it disabled for an installation that predates onboarding', () => {
    expect(
      planArc(
        {
          engagement: undefined,
          onboarding: { state: 'done', completedAt: NOW, surface: 'pre-existing' },
        },
        NOW,
      ),
    ).toMatchObject({ register: true, enabled: false });
  });

  it('does not re-enable an arc that already stopped for silence', () => {
    const arc = planArc(
      {
        engagement: undefined,
        onboarding: inWindow,
        nudges: {
          nudgesSent: 5,
          lastNudgeAt: null,
          quietUntil: null,
          unanswered: MAX_UNANSWERED,
        },
      },
      NOW,
    );
    expect(arc).toMatchObject({ register: true, enabled: false });
  });
});

describe('readArcState', () => {
  it('reads the row, and reads a missing row as no record at all', async () => {
    const present = new FakeDb(onboardingRow({ nudges_sent: 2 }));
    expect((await readArcState(present as unknown as Pool))?.nudgesSent).toBe(2);
    expect(await readArcState(new FakeDb(null) as unknown as Pool)).toBeNull();
  });

  it('reads an unmigrated installation as no record rather than throwing', async () => {
    const unmigrated = {
      async query(): Promise<{ rows: any[] }> {
        throw Object.assign(new Error('relation "core.onboarding" does not exist'), {
          code: '42P01',
        });
      },
    };
    expect(await readArcState(unmigrated as unknown as Pool)).toBeNull();
    await expect(recordNudgeDelivered(unmigrated as unknown as Pool, NOW)).resolves.toBeUndefined();
  });
});
