/**
 * The reminder and schedule tools, and the loop that fires a reminder.
 *
 * The database is faked here on purpose: what these tests are about is the tool
 * surface an agent sees — the refusals it gets back, the ids it is handed, the
 * one job a due reminder becomes — and none of that should need postgres to
 * pin down. The rows themselves are core's, and `reminders.db.test.ts` there
 * holds the store to the real thing.
 */
import { MAX_PENDING_PER_AGENT, ToolRegistry, type ToolContext } from '@buddi/core';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  agentMissionId,
  createReminderManifest,
  createReminderTick,
  createScheduleManifest,
  describeCadence,
  missionOwnerAgent,
  reminderDedupKey,
  reminderRunPrompt,
  slugify,
  tooFrequent,
} from './reminders.js';

const NOW = new Date('2026-09-14T12:00:00Z');
const TZ = 'America/New_York';
const hours = (n: number): Date => new Date(NOW.getTime() + n * 3_600_000);

/* ---------------- a fake `core.reminders` ---------------- */

type Row = {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  due_at: Date;
  text: string;
  context: unknown;
  state: string;
  created_at: Date;
  fired_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
};

class FakeDb {
  rows: Row[] = [];
  missions: { id: string; name: string; agent_id: string; enabled: boolean }[] = [];
  #seq = 0;

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();

    if (text.startsWith('insert into core.reminders')) {
      const [agentId, conversationId, dueAt, body, context, perAgent, total] = params;
      const pending = this.rows.filter((r) => r.state === 'pending');
      if (
        pending.filter((r) => r.agent_id === agentId).length >= perAgent ||
        pending.length >= total
      ) {
        return { rows: [] };
      }
      this.#seq += 1;
      const row: Row = {
        id: `00000000-0000-4000-8000-${String(this.#seq).padStart(12, '0')}`,
        agent_id: agentId,
        conversation_id: conversationId,
        due_at: new Date(dueAt),
        text: body,
        context: context === null ? null : JSON.parse(context),
        state: 'pending',
        created_at: NOW,
        fired_at: null,
        cancelled_at: null,
        cancel_reason: null,
      };
      this.rows.push(row);
      return { rows: [row] };
    }

    if (text.startsWith('select count(*) filter')) {
      const pending = this.rows.filter((r) => r.state === 'pending');
      return {
        rows: [
          {
            mine: pending.filter((r) => r.agent_id === params[0]).length,
            total: pending.length,
          },
        ],
      };
    }

    if (text.includes('from core.reminders where id =')) {
      return { rows: this.rows.filter((r) => r.id === params[0]) };
    }

    if (text.startsWith('select') && text.includes('from core.reminders')) {
      const [agentId, state] = params;
      let rows = this.rows;
      if (text.includes("state = 'pending' and due_at <=")) {
        const now = new Date(params[0]).getTime();
        const floor = new Date(params[1]).getTime();
        rows = rows.filter(
          (r) => r.state === 'pending' && r.due_at.getTime() <= now && r.due_at.getTime() > floor,
        );
      } else {
        if (agentId !== null) rows = rows.filter((r) => r.agent_id === agentId);
        if (state !== null) rows = rows.filter((r) => r.state === state);
      }
      return { rows: [...rows].sort((a, b) => a.due_at.getTime() - b.due_at.getTime()) };
    }

    if (text.startsWith('update core.reminders')) {
      const state = text.includes("'cancelled'")
        ? 'cancelled'
        : text.includes("'fired'")
          ? 'fired'
          : 'expired';
      if (state === 'expired') {
        const floor = new Date(params[0]).getTime();
        const hit = this.rows.filter(
          (r) => r.state === 'pending' && r.due_at.getTime() <= floor,
        );
        for (const row of hit) row.state = 'expired';
        return { rows: hit };
      }
      const row = this.rows.find((r) => r.id === params[0] && r.state === 'pending');
      if (!row) return { rows: [] };
      row.state = state;
      if (state === 'cancelled') {
        row.cancelled_at = new Date(params[2]);
        row.cancel_reason = params[1];
      } else {
        row.fired_at = new Date(params[1]);
      }
      return { rows: [row] };
    }

    if (text.startsWith('select id, name, agent_id')) {
      return { rows: this.missions };
    }
    if (text.startsWith('update core.missions set enabled')) {
      const mission = this.missions.find((m) => m.id === params[0]);
      if (!mission) return { rows: [] };
      mission.enabled = params[1];
      return { rows: [mission] };
    }
    if (text.startsWith('select id, mission_id, revision')) {
      return { rows: [] };
    }
    if (text.startsWith('select id, name, agent_id, prompt') || text.includes('from core.missions where id')) {
      return { rows: this.missions.filter((m) => m.id === params[0]) };
    }

    throw new Error(`FakeDb: unexpected sql: ${text}`);
  }
}

function contextFor(db: FakeDb, agentId = 'finance-advisor'): ToolContext {
  return {
    db: db as unknown as Pool,
    ownerId: 'owner',
    now: () => NOW,
    timezone: TZ,
    agentId,
    conversationId: undefined,
  };
}

function reminderRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createReminderManifest());
  return registry;
}

/* ---------------- reminder.set / list / cancel ---------------- */

describe('reminder.set', () => {
  it('puts one on the clock and hands back its id and local time', async () => {
    const db = new FakeDb();
    const result = await reminderRegistry().invoke(
      'reminder.set',
      { when: '2026-09-20', text: 'check whether the card payment went out' },
      contextFor(db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.output as { ok: boolean; id: string; dueAt: string; dueLocal: string };
    expect(out.ok).toBe(true);
    // A date alone is 09:00 in the owner's zone, never UTC midnight.
    expect(out.dueAt).toBe('2026-09-20T13:00:00.000Z');
    expect(out.dueLocal).toContain('09:00');
    expect(db.rows).toHaveLength(1);
  });

  it('refuses a phrase instead of guessing what "next Friday" means', async () => {
    const db = new FakeDb();
    const result = await reminderRegistry().invoke(
      'reminder.set',
      { when: 'next Friday', text: 'pay the card' },
      contextFor(db),
    );
    expect(result.ok).toBe(true); // a refusal the model can read, not a throw
    if (!result.ok) return;
    expect(result.output).toMatchObject({ ok: false, reason: 'invalid-when' });
    expect(db.rows).toHaveLength(0);
  });

  it('takes one six minutes out: the default lead is five minutes, not thirty', async () => {
    const db = new FakeDb();
    // NOW is 08:00 in the owner's zone, so this is six minutes from now.
    const result = await reminderRegistry().invoke(
      'reminder.set',
      { when: '2026-09-14T08:06', text: 'check the transfer landed' },
      contextFor(db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toMatchObject({ ok: true });
    expect(db.rows).toHaveLength(1);
  });

  it('refuses one two minutes out, and says five minutes in the refusal', async () => {
    const db = new FakeDb();
    const result = await reminderRegistry().invoke(
      'reminder.set',
      { when: '2026-09-14T08:02', text: 'now-ish' },
      contextFor(db),
    );
    expect(result.ok).toBe(true); // a refusal the model can read, not a throw
    if (!result.ok) return;
    const out = result.output as { ok: boolean; reason: string; message: string };
    expect(out).toMatchObject({ ok: false, reason: 'too-soon' });
    expect(out.message).toContain('at least 5 minutes out');
    expect(db.rows).toHaveLength(0);
  });

  it('refuses one past the budget', async () => {
    const db = new FakeDb();
    const registry = reminderRegistry();

    for (let i = 0; i < MAX_PENDING_PER_AGENT; i += 1) {
      await registry.invoke(
        'reminder.set',
        { when: `2026-10-${String(i + 1).padStart(2, '0')}`, text: `item ${i}` },
        contextFor(db),
      );
    }
    const over = await registry.invoke(
      'reminder.set',
      { when: '2026-11-01', text: 'one too many' },
      contextFor(db),
    );
    expect(over.ok && (over.output as { reason: string }).reason).toBe('too-many-for-agent');
  });

  it('describes the limits this installation actually has, not the shipped ones', async () => {
    const tight = createReminderManifest({
      minLeadMinutes: 90,
      maxHorizonDays: 7,
      maxPendingPerAgent: 2,
      maxPendingTotal: 4,
      maxTextChars: 500,
    });
    const description = tight.tools.find((t) => t.name === 'reminder.set')?.description ?? '';
    expect(description).toContain('At least 90 minutes out, at most 7 days, 2 pending at a time.');
    expect(description).toContain('within about a minute');

    // And the numbers it advertises are the numbers it enforces.
    const db = new FakeDb();
    const registry = new ToolRegistry();
    registry.register(tight);
    const result = await registry.invoke(
      'reminder.set',
      { when: '2026-09-14T09:00', text: 'an hour out, under the tightened lead' },
      contextFor(db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toMatchObject({ ok: false, reason: 'too-soon' });
  });

  it('describes the default budget with the five-minute lead', () => {
    const description =
      createReminderManifest().tools.find((t) => t.name === 'reminder.set')?.description ?? '';
    expect(description).toContain(
      `At least 5 minutes out, at most 365 days, ${MAX_PENDING_PER_AGENT} pending at a time.`,
    );
  });

  it('is a fail-closed tool like any other: bad args refuse', async () => {
    const db = new FakeDb();
    const result = await reminderRegistry().invoke('reminder.set', { text: 'no when' }, contextFor(db));
    expect(result).toMatchObject({ ok: false, reason: 'invalid-args' });
  });
});

describe('reminder.list and reminder.cancel', () => {
  it('lists only this agent\'s pending ones', async () => {
    const db = new FakeDb();
    const registry = reminderRegistry();
    await registry.invoke('reminder.set', { when: '2026-09-20', text: 'mine' }, contextFor(db));
    await registry.invoke(
      'reminder.set',
      { when: '2026-09-21', text: 'theirs' },
      contextFor(db, 'credit-coach'),
    );

    const listed = await registry.invoke('reminder.list', {}, contextFor(db));
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const { reminders } = listed.output as { reminders: { text: string }[] };
    expect(reminders.map((r) => r.text)).toEqual(['mine']);
  });

  it('cancels its own and refuses another agent\'s', async () => {
    const db = new FakeDb();
    const registry = reminderRegistry();
    const created = await registry.invoke(
      'reminder.set',
      { when: '2026-09-20', text: 'mine' },
      contextFor(db),
    );
    const id = (created as { output: { id: string } }).output.id;

    const stranger = await registry.invoke(
      'reminder.cancel',
      { id },
      contextFor(db, 'credit-coach'),
    );
    expect(stranger.ok && (stranger.output as { reason: string }).reason).toBe('not-yours');
    expect(db.rows[0]?.state).toBe('pending');

    const mine = await registry.invoke('reminder.cancel', { id, reason: 'paid it' }, contextFor(db));
    expect(mine.ok && (mine.output as { ok: boolean }).ok).toBe(true);
    expect(db.rows[0]?.state).toBe('cancelled');

    // Twice is a no-op that says so.
    const again = await registry.invoke('reminder.cancel', { id }, contextFor(db));
    expect(again.ok && (again.output as { reason: string }).reason).toBe('not-pending');
  });
});

/* ---------------- firing ---------------- */

describe('the firing loop', () => {
  const dueDb = async (): Promise<FakeDb> => {
    const db = new FakeDb();
    const registry = reminderRegistry();
    await registry.invoke('reminder.set', { when: '2026-09-20', text: 'one' }, contextFor(db));
    await registry.invoke(
      'reminder.set',
      { when: '2026-09-20T10:00', text: 'two' },
      contextFor(db, 'credit-coach'),
    );
    return db;
  };

  it('enqueues exactly one agent run per due reminder, and is idempotent', async () => {
    const db = await dueDb();
    const enqueued: { agentId: string; dedupKey: string }[] = [];
    const tick = createReminderTick({
      pool: db as unknown as Pool,
      now: () => new Date('2026-09-20T15:00:00Z'),
      timezone: TZ,
      enqueueRun: async (input) => {
        enqueued.push({ agentId: input.agentId, dedupKey: input.dedupKey });
      },
      log: () => {},
    });

    const first = await tick();
    expect(first).toEqual({ fired: 2, expired: 0 });
    expect(enqueued).toHaveLength(2);
    expect(enqueued.map((e) => e.agentId)).toEqual(['finance-advisor', 'credit-coach']);
    expect(enqueued[0]?.dedupKey).toBe(reminderDedupKey(db.rows[0]?.id as string));

    // The second pass finds nothing: the rows are fired, so they are not due.
    const second = await tick();
    expect(second).toEqual({ fired: 0, expired: 0 });
    expect(enqueued).toHaveLength(2);
  });

  it('leaves a reminder pending when the queue refuses it', async () => {
    const db = await dueDb();
    const tick = createReminderTick({
      pool: db as unknown as Pool,
      now: () => new Date('2026-09-20T15:00:00Z'),
      timezone: TZ,
      enqueueRun: async () => {
        throw new Error('queue down');
      },
      log: () => {},
    });
    expect(await tick()).toEqual({ fired: 0, expired: 0 });
    expect(db.rows.every((r) => r.state === 'pending')).toBe(true);
  });

  it('expires what the machine slept through instead of firing it late', async () => {
    const db = await dueDb();
    const enqueued: string[] = [];
    const tick = createReminderTick({
      pool: db as unknown as Pool,
      now: () => new Date('2026-10-05T12:00:00Z'),
      timezone: TZ,
      enqueueRun: async (input) => {
        enqueued.push(input.dedupKey);
      },
      log: () => {},
    });
    expect(await tick()).toEqual({ fired: 0, expired: 2 });
    expect(enqueued).toEqual([]);
    expect(db.rows.every((r) => r.state === 'expired')).toBe(true);
  });

  it('writes a prompt that tells the run to verify first and offers silence', () => {
    const prompt = reminderRunPrompt(
      {
        id: 'r1',
        agentId: 'finance-advisor',
        conversationId: null,
        dueAt: hours(24),
        text: 'check whether the card payment went out',
        context: { card: 'NFCU' },
        state: 'pending',
        createdAt: NOW,
        firedAt: null,
        cancelledAt: null,
        cancelReason: null,
      },
      TZ,
    );
    expect(prompt).toContain('check whether the card payment went out');
    expect(prompt).toContain('"card":"NFCU"');
    expect(prompt).toContain('check with your tools that this is still true');
    expect(prompt).toContain('mission.report');
    expect(prompt).toContain('mission.silent');
  });
});

/* ---------------- schedule.propose ---------------- */

describe('schedule.propose', () => {
  const scheduleRegistry = (): ToolRegistry => {
    const registry = new ToolRegistry();
    registry.register(createScheduleManifest());
    return registry;
  };

  it('names the cadence in words', () => {
    expect(describeCadence('0 8 * * MON', TZ)).toBe('every Monday at 08:00 America/New_York');
    expect(describeCadence('30 7 * * *', TZ)).toBe('every day at 07:30 America/New_York');
    expect(describeCadence('0 9 1 * *', TZ)).toBe(
      'on the 1st of every month at 09:00 America/New_York',
    );
  });

  it('refuses anything more often than hourly, whatever the spelling', () => {
    expect(tooFrequent('* * * * *', TZ, NOW)).toBe(true);
    expect(tooFrequent('*/15 * * * *', TZ, NOW)).toBe(true);
    expect(tooFrequent('0,30 * * * *', TZ, NOW)).toBe(true);
    expect(tooFrequent('0 * * * *', TZ, NOW)).toBe(false);
    expect(tooFrequent('0 8 * * MON', TZ, NOW)).toBe(false);
  });

  it('is gated: the call becomes an approval request with the preview', async () => {
    const actions: any[] = [];
    const db = {
      async query(sql: string, params: any[]) {
        if (sql.replace(/\s+/g, ' ').includes('insert into core.actions')) {
          actions.push(params);
          return {
            rows: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                tool: 'schedule.propose',
                tool_version: '0.1.0',
                agent_id: 'finance-advisor',
                conversation_id: null,
                job_id: null,
                canonical_args: {},
                envelope: {},
                args_hash: 'h',
                preview: String(
              params.find((p) => typeof p === 'string' && p.includes('Cadence:')) ?? '',
            ),
                expires_at: hours(24),
                policy_version: 1,
                created_at: NOW,
                state: 'pending',
                decided_by: null,
                decided_via: null,
                decided_at: null,
                claimed_by: null,
                claimed_at: null,
                outcome: null,
                updated_at: NOW,
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const result = await scheduleRegistry().invoke(
      'schedule.propose',
      {
        name: 'Monday card check',
        cron: '0 8 * * MON',
        prompt: 'Check whether last week transfers landed.',
      },
      contextFor(db as unknown as FakeDb),
    );
    expect(result).toMatchObject({ ok: false, reason: 'approval-required' });
    if (result.ok || result.reason !== 'approval-required') return;
    expect(result.preview).toContain('every Monday at 08:00 America/New_York');
    expect(result.preview).toContain('Check whether last week transfers landed.');
    // Next three runs, rendered in the owner's zone.
    expect(result.preview.split('\n').filter((l) => l.startsWith('  2026-')).length).toBe(3);
  });

  it('refuses a too-frequent cron before any approval exists', async () => {
    const asked = vi.fn();
    const db = { async query() { asked(); return { rows: [] }; } };
    const result = await scheduleRegistry().invoke(
      'schedule.propose',
      { name: 'Constant', cron: '*/5 * * * *', prompt: 'look again' },
      contextFor(db as unknown as FakeDb),
    );
    expect(result).toMatchObject({ ok: false, reason: 'tool-error' });
    if (result.ok || result.reason === 'approval-required') return;
    expect(result.message).toContain('more than once an hour');
    // Nothing was recorded: the refusal happens in `describe`.
    expect(asked).not.toHaveBeenCalled();
  });
});

describe('schedule.cancel_mine', () => {
  const registry = (): ToolRegistry => {
    const r = new ToolRegistry();
    r.register(createScheduleManifest());
    return r;
  };

  it('builds and reads the owning agent out of the mission id', () => {
    expect(agentMissionId('finance-advisor', slugify('Monday card check'))).toBe(
      'agent:finance-advisor:monday-card-check',
    );
    expect(missionOwnerAgent('agent:finance-advisor:monday-card-check')).toBe('finance-advisor');
    expect(missionOwnerAgent('friday-recap')).toBeNull();
  });

  it('disables its own schedule', async () => {
    const db = new FakeDb();
    const id = agentMissionId('finance-advisor', 'monday-card-check');
    db.missions.push({ id, name: 'Monday card check', agent_id: 'finance-advisor', enabled: true });
    const result = await registry().invoke('schedule.cancel_mine', { missionId: id }, contextFor(db));
    expect(result.ok && (result.output as { ok: boolean }).ok).toBe(true);
    expect(db.missions[0]?.enabled).toBe(false);
  });

  it('never touches the owner\'s missions or another agent\'s', async () => {
    const db = new FakeDb();
    db.missions.push({ id: 'friday-recap', name: 'Friday recap', agent_id: 'finance-advisor', enabled: true });
    const theirs = agentMissionId('credit-coach', 'weekly-utilization');
    db.missions.push({ id: theirs, name: 'Weekly utilization', agent_id: 'credit-coach', enabled: true });

    const owner = await registry().invoke(
      'schedule.cancel_mine',
      { missionId: 'friday-recap' },
      contextFor(db),
    );
    expect(owner.ok && (owner.output as { reason: string }).reason).toBe('not-yours');

    const other = await registry().invoke(
      'schedule.cancel_mine',
      { missionId: theirs },
      contextFor(db),
    );
    expect(other.ok && (other.output as { reason: string }).reason).toBe('not-yours');

    expect(db.missions.every((m) => m.enabled)).toBe(true);
  });
});
