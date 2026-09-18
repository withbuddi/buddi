/**
 * The dead-letter watch: one message for a wave, and never a second one.
 *
 * The database is faked here — three statements are involved and none of them
 * is what these tests are about. What is under test is the *policy*: when the
 * owner is told, how much is folded into one telling, and the words they read.
 */
import type { Job } from '@buddi/core';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  createDeadLetterWatch,
  DEAD_LETTER_FLAG,
  DEAD_LETTER_INCIDENT_GAP_MS,
  formatDeadLetterMessage,
} from './dead-letter.js';
import { OwnerNotPairedError } from '../telegram/notify.js';

const TZ = 'America/New_York';

function job(over: Partial<Job> & { id: string; createdAt: Date; updatedAt: Date }): Job {
  return {
    kind: 'agent-run',
    payload: { agentId: 'mail-triage', prompt: 'triage this' },
    state: 'failed',
    priority: 0,
    runAfter: over.createdAt,
    attempts: 8,
    maxAttempts: 8,
    leaseOwner: null,
    leaseUntil: null,
    lastError: 'fetch failed',
    result: null,
    conversationId: null,
    dedupKey: `triage:${over.id}`,
    suspendedReason: null,
    ...over,
  } as Job;
}

/** A death at `failedAt`, for work that was queued `queuedAt`. */
function death(id: string, queuedAt: string, failedAt: string, over: Partial<Job> = {}): Job {
  return job({ id, createdAt: new Date(queuedAt), updatedAt: new Date(failedAt), ...over });
}

/** Just enough postgres: one flag row, a list of dead jobs, an event log. */
class FakeDb {
  flags = new Map<string, unknown>();
  events: { kind: string; payload: any }[] = [];
  constructor(public jobs: Job[] = []) {}

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('select value from core.system_flags')) {
      const value = this.flags.get(params[0]);
      return { rows: value === undefined ? [] : [{ value }] };
    }
    if (text.startsWith('insert into core.system_flags')) {
      this.flags.set(params[0], JSON.parse(params[1]));
      return { rows: [] };
    }
    if (text.startsWith('insert into core.events')) {
      this.events.push({ kind: params[0], payload: JSON.parse(params[2]) });
      return { rows: [{ id: '1', kind: params[0], conversation_id: null, payload: {}, created_at: new Date() }] };
    }
    if (text.includes("from core.jobs") && text.includes("state = 'failed'")) {
      const [kinds, after, until, _limit, afterId] = params;
      const afterMs = Date.parse(after);
      const rows = this.jobs
        .filter(
          (j) =>
            (kinds as string[]).includes(j.kind) &&
            (afterId === null
              ? j.updatedAt.getTime() > afterMs
              : j.updatedAt.getTime() > afterMs ||
                (j.updatedAt.getTime() === afterMs && j.id > afterId)) &&
            (until === null || j.updatedAt.getTime() <= Date.parse(until)),
        )
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
      // The store returns rows; the watch only reads the mapped shape, so the
      // fake short-circuits `toJob` by handing back rows that already are jobs.
      return { rows: rows.map((j) => toRow(j)) };
    }
    throw new Error(`unexpected sql: ${text}`);
  }
}

function toRow(j: Job): Record<string, unknown> {
  return {
    id: j.id,
    kind: j.kind,
    payload: j.payload,
    state: j.state,
    priority: j.priority,
    run_after: j.runAfter,
    attempts: j.attempts,
    max_attempts: j.maxAttempts,
    lease_owner: j.leaseOwner,
    lease_until: j.leaseUntil,
    last_error: j.lastError,
    result: j.result,
    conversation_id: j.conversationId,
    dedup_key: j.dedupKey,
    suspended_reason: j.suspendedReason,
    created_at: j.createdAt,
    updated_at: j.updatedAt,
  };
}

function watchOn(
  db: FakeDb,
  now: () => Date,
  deliver: (text: string) => Promise<string> = vi.fn(async () => 'chat'),
) {
  return {
    deliver,
    tick: createDeadLetterWatch({
      pool: db as unknown as Pool,
      now,
      timezone: TZ,
      deliver,
      log: () => {},
    }),
  };
}

/** The real evening: twelve triage runs, killed by one network blip. */
const THE_WAVE: Job[] = [
  death('00000000-0000-4000-8000-000000000000', '2026-09-14T17:25:07Z', '2026-09-14T17:31:30Z'),
  death('00000000-0000-4000-8000-000000000001', '2026-09-14T17:35:10Z', '2026-09-14T17:41:29Z'),
  death('00000000-0000-4000-8000-000000000002', '2026-09-14T17:35:10Z', '2026-09-14T17:41:35Z'),
  death('00000000-0000-4000-8000-000000000003', '2026-09-14T17:35:10Z', '2026-09-14T17:41:41Z'),
  death('00000000-0000-4000-8000-000000000004', '2026-09-14T19:11:24Z', '2026-09-14T19:17:45Z'),
  death('00000000-0000-4000-8000-000000000005', '2026-09-14T19:26:27Z', '2026-09-14T19:32:48Z'),
  death('00000000-0000-4000-8000-000000000006', '2026-09-14T19:31:29Z', '2026-09-14T19:37:48Z'),
  death('00000000-0000-4000-8000-000000000007', '2026-09-14T19:56:35Z', '2026-09-14T20:02:56Z'),
  death('00000000-0000-4000-8000-000000000008', '2026-09-14T20:01:37Z', '2026-09-14T20:07:58Z'),
  death('00000000-0000-4000-8000-000000000009', '2026-09-14T20:06:38Z', '2026-09-14T20:12:59Z'),
  death('00000000-0000-4000-8000-000000000010', '2026-09-15T00:43:21Z', '2026-09-15T00:49:41Z'),
  death('00000000-0000-4000-8000-000000000011', '2026-09-15T03:14:53Z', '2026-09-15T03:21:12Z'),
];

/** Run the watch every minute across a span, collecting what was delivered. */
async function replay(db: FakeDb, from: string, to: string): Promise<string[]> {
  let clock = new Date(from);
  const sent: string[] = [];
  const { tick } = watchOn(db, () => clock, async (text: string) => {
    sent.push(text);
    return 'chat';
  });
  const end = Date.parse(to);
  while (clock.getTime() <= end) {
    await tick();
    clock = new Date(clock.getTime() + 60_000);
  }
  return sent;
}

describe('the fold', () => {
  it('turns twelve dead jobs into exactly one message', async () => {
    const db = new FakeDb(THE_WAVE);
    const sent = await replay(db, '2026-09-14T17:20:00Z', '2026-09-15T04:00:00Z');
    expect(sent).toHaveLength(1);
  });

  it('waits out the aggregation window so the burst is counted, not just its first job', async () => {
    const db = new FakeDb(THE_WAVE);
    const sent = await replay(db, '2026-09-14T17:20:00Z', '2026-09-14T18:00:00Z');
    expect(sent).toHaveLength(1);
    // First death 17:31:30, window 15 minutes: the three deaths at 17:41 are in.
    expect(sent[0]).toContain('4 emails');
  });

  it('says nothing at all before the window is up', async () => {
    const db = new FakeDb(THE_WAVE);
    const sent = await replay(db, '2026-09-14T17:20:00Z', '2026-09-14T17:40:00Z');
    expect(sent).toEqual([]);
  });

  it('never repeats itself for the same wave, however many more die', async () => {
    const db = new FakeDb(THE_WAVE);
    const first = await replay(db, '2026-09-14T17:20:00Z', '2026-09-14T18:00:00Z');
    expect(first).toHaveLength(1);
    // Everything from 19:11 onwards belongs to the same outage and is silent.
    const rest = await replay(db, '2026-09-14T18:00:00Z', '2026-09-15T04:00:00Z');
    expect(rest).toEqual([]);
  });

  it('speaks again for a genuinely separate outage', async () => {
    const later = new Date(
      Date.parse('2026-09-15T03:21:12Z') + DEAD_LETTER_INCIDENT_GAP_MS + 60 * 60_000,
    );
    const db = new FakeDb([
      ...THE_WAVE,
      death('00000000-0000-4000-8000-000000000012', later.toISOString(), later.toISOString(), { lastError: 'fetch failed' }),
    ]);
    const sent = await replay(db, '2026-09-14T17:20:00Z', '2026-09-15T18:00:00Z');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('1 email');
  });

  it('remembers across a restart that it already said this', async () => {
    const db = new FakeDb(THE_WAVE);
    await replay(db, '2026-09-14T17:20:00Z', '2026-09-14T18:00:00Z');
    expect(db.flags.get(DEAD_LETTER_FLAG)).toMatchObject({ incident: { reported: true } });
    // A brand new watch object, the same flag row: still silent.
    const sent = await replay(db, '2026-09-14T18:00:00Z', '2026-09-15T04:00:00Z');
    expect(sent).toEqual([]);
  });

  it('does not rediscover PostgreSQL microseconds lost by JavaScript Date', async () => {
    const db = new FakeDb(THE_WAVE.slice(0, 1));
    let clock = new Date('2026-09-14T18:00:00Z');
    const sent: string[] = [];
    const tick = createDeadLetterWatch({
      pool: db as unknown as Pool,
      now: () => clock,
      timezone: TZ,
      deliver: async (text) => {
        sent.push(text);
        return 'chat';
      },
      log: () => {},
    });

    await tick();
    expect(sent).toHaveLength(1);
    expect(db.flags.get(DEAD_LETTER_FLAG)).toMatchObject({
      watermarkJobId: THE_WAVE[0]?.id,
      incident: { reported: true },
    });

    // PostgreSQL may retain .5009 while node-postgres gives us .500. Model
    // that precision loss as the same Date plus the same id: the composite
    // cursor must exclude it on every later pass.
    clock = new Date(clock.getTime() + DEAD_LETTER_INCIDENT_GAP_MS + 1);
    await tick(); // closes the old incident
    await tick(); // used to rediscover and report the same row
    expect(sent).toHaveLength(1);
  });

  it('does not announce an installation’s ancient history on first run', async () => {
    const db = new FakeDb([death('00000000-0000-4000-8000-000000000099', '2026-09-01T10:00:00Z', '2026-09-01T10:06:00Z')]);
    const sent = await replay(db, '2026-09-14T17:20:00Z', '2026-09-14T18:00:00Z');
    expect(sent).toEqual([]);
  });

  it('keeps the message pending when it cannot be delivered, and sends it once later', async () => {
    const db = new FakeDb(THE_WAVE);
    let clock = new Date('2026-09-14T17:20:00Z');
    let broken = true;
    const deliver = vi.fn(async () => {
      if (broken) throw new Error('fetch failed');
      return 'chat';
    });
    const tick = createDeadLetterWatch({
      pool: db as unknown as Pool,
      now: () => clock,
      timezone: TZ,
      deliver,
      log: () => {},
    });
    for (let i = 0; i < 40; i += 1) {
      await tick();
      clock = new Date(clock.getTime() + 60_000);
    }
    expect(deliver.mock.calls.length).toBeGreaterThan(1); // kept trying
    broken = false;
    const before = deliver.mock.calls.length;
    for (let i = 0; i < 40; i += 1) {
      await tick();
      clock = new Date(clock.getTime() + 60_000);
    }
    // Exactly one more call: the one that got through. Then silence.
    expect(deliver.mock.calls.length).toBe(before + 1);
  });

  it('gives up on an unpaired installation rather than trying for ever', async () => {
    const db = new FakeDb(THE_WAVE);
    let clock = new Date('2026-09-14T17:20:00Z');
    const deliver = vi.fn(async () => {
      throw new OwnerNotPairedError();
    });
    const tick = createDeadLetterWatch({
      pool: db as unknown as Pool,
      now: () => clock,
      timezone: TZ,
      deliver,
      log: () => {},
    });
    for (let i = 0; i < 60; i += 1) {
      await tick();
      clock = new Date(clock.getTime() + 60_000);
    }
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(db.events.at(-1)).toMatchObject({
      kind: 'queue.dead_letter_reported',
      payload: { delivered: false },
    });
  });
});

describe('the message', () => {
  it('says what did not happen, to whom, when, and what to do', () => {
    const text = formatDeadLetterMessage(THE_WAVE.slice(0, 4), { timezone: TZ });
    expect(text).toBe(
      [
        'Mail is not being read.',
        '4 emails between 2026-09-14 13:25 EDT and 13:35 were never looked at, and nothing is still trying — every attempt failed the same way: fetch failed.',
        'Nothing more will be sent about this outage.',
        'To see what was lost: buddi jobs --state failed',
        'To run it all again: buddi jobs retry --all',
      ].join('\n'),
    );
  });

  it('carries no job ids, no kinds and no tool names', () => {
    const text = formatDeadLetterMessage(THE_WAVE, { timezone: TZ });
    expect(text).not.toContain('agent-run');
    expect(text).not.toContain('mission.report');
    for (const j of THE_WAVE) expect(text).not.toContain(j.id);
  });

  it('is plain text, and asks nothing', () => {
    const text = formatDeadLetterMessage(THE_WAVE, { timezone: TZ });
    expect(text).not.toMatch(/[*_`#]/);
    expect(text).not.toContain('?');
  });

  it('names other kinds of lost work without burying the main one', () => {
    const text = formatDeadLetterMessage(
      [
        ...THE_WAVE.slice(0, 3),
        death('00000000-0000-4000-8000-000000000098', '2026-09-14T19:00:00Z', '2026-09-14T19:06:00Z', {
          kind: 'mission-run',
          payload: {},
        }),
      ],
      { timezone: TZ },
    );
    expect(text.startsWith('Mail is not being read.')).toBe(true);
    expect(text).toContain('Also 1 run');
  });
});
