/**
 * The weekly learning digest against a throwaway database (learning §5,
 * acceptance 5): counts and names from the week, the open count with a link,
 * "not measured yet" when no plugin counts its rules, one Telegram message
 * through the real `notifyOwner` with a stubbed Telegram API, nothing sent on
 * a quiet week, the latest kept for Home, and the schedule as a mission.
 */
import {
  createPool,
  createProposal,
  discardProposal,
  getMission,
  keepProposal,
  pairSurfaceIdentity,
  runMigrations,
  type Mission,
  type Occurrence,
  type PluginManifest,
  type ProposalKind,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { manifest as memoryManifest } from '@buddi/tool-memory';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEARNING_DIGEST_ID,
  digestSummary,
  digestText,
  ensureDigestMission,
  latestDigest,
  parseDigestCron,
  readDigestSchedule,
  runLearningDigest,
  setDigestSchedule,
} from './learning-digest.js';
import { notifyOwner } from '../telegram/notify.js';
import { withLearningDigest } from '../serve.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_learning_digest_test_${process.pid}`;
const NOW = new Date('2026-09-27T20:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const LINK = 'https://buddi.example.ts.net/#/settings/proposals';

suite('learning digest (postgres)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [memoryManifest]);
    await pairSurfaceIdentity(pool, { surface: 'telegram', externalUserId: '42', externalChatId: '4242' });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate core.proposals, core.events, memory.notes');
    await pool.query(`delete from core.missions where id = $1`, [LEARNING_DIGEST_ID]);
  });

  const propose = async (kind: ProposalKind, payload: Record<string, unknown>, at: Date) => {
    const made = await createProposal(pool, {
      kind,
      agent: 'advisor',
      payload,
      provenance: { agent: 'advisor', conversation: null, runId: null, turn: null, sources: [] },
      now: at,
    });
    if (!made.ok) throw new Error(made.message);
    return made.proposal;
  };

  const note = (content: string, at: Date) =>
    pool.query(`insert into memory.notes (content, kind, created_by_agent, created_at) values ($1, 'fact', 'advisor', $2)`, [content, at]);

  /** A week with something in it: notes, a skill and a rule kept, one old keep, one open, one discarded. */
  const busyWeek = async (): Promise<void> => {
    for (const [i, text] of ['Pays rent on the 1st', 'Prefers short answers', 'Card closes on the 12th', 'Allergic to cats'].entries()) {
      await note(text, new Date(NOW.getTime() - (i + 1) * 60_000));
    }
    await note('Old fact', new Date(NOW.getTime() - 9 * DAY));
    const skill = await propose('skill', { name: 'Check a bank balance', when: 'w', body: 'b', why: 'y' }, new Date(NOW.getTime() - 2 * DAY));
    await keepProposal(pool, { id: skill.id, now: new Date(NOW.getTime() - DAY) });
    const rule = await propose('policy', { plugin: 'mailer', matcher: { from: 'x' }, action: 'ignore', verdicts: [], why: 'y' }, new Date(NOW.getTime() - 2 * DAY));
    await keepProposal(pool, { id: rule.id, now: new Date(NOW.getTime() - DAY) });
    const old = await propose('skill', { name: 'Old skill', when: 'w', body: 'b', why: 'y' }, new Date(NOW.getTime() - 20 * DAY));
    await keepProposal(pool, { id: old.id, now: new Date(NOW.getTime() - 10 * DAY) });
    await propose('change', { part: 'instructions', before: null, proposed: 'Be terse.', why: 'y' }, new Date(NOW.getTime() - DAY));
    const no = await propose('skill', { name: 'Discarded one', when: 'w', body: 'b', why: 'y' }, new Date(NOW.getTime() - DAY));
    await discardProposal(pool, { id: no.id, now: NOW });
  };

  it('acceptance 5: arrives on Telegram as one message in plain words, with the link', async () => {
    await busyWeek();
    const sendMessage = vi.fn(async () => ({ message_id: 1 }));
    const result = await runLearningDigest({
      pool,
      now: NOW,
      manifests: [],
      proposalsUrl: LINK,
      deliver: (text) => notifyOwner(text, { pool, api: { sendMessage } as never }),
    });

    expect(result.delivered).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0] as unknown as [string, string];
    expect(chatId).toBe('4242');
    expect(text).toContain('Remembered 4 things.');
    expect(text).not.toContain('Pays rent');
    expect(text).toContain('Kept 1 skill: Check a bank balance.');
    expect(text).toContain('Quieted 1 sender.');
    expect(text).not.toContain('mailer: ignore');
    expect(text).not.toContain('Old skill');
    expect(text).toContain(`1 suggestion waits for you: ${LINK}`);
    // No installed plugin counts its rules here: no line, never a made-up number.
    expect(text).not.toMatch(/handled|stepped in|not measured/);
    expect(text.replace(LINK, '')).not.toMatch(/[*_`#]/);

    const latest = await latestDigest(pool);
    expect(latest).toMatchObject({ delivered: true, open: 1, skills: { count: 1 }, rules: { count: 1, actions: { ignore: 1 }, plugins: { mailer: 1 } }, memory: { count: 4 } });
    expect(latest?.summary.map((l) => l.text)).toEqual(['Remembered 4 things', 'Quieted 1 sender', 'Kept 1 skill: Check a bank balance', '1 suggestion waits for you']);
  });

  it('counts what a plugin says its kept rules did, per plugin', async () => {
    await busyWeek();
    const counting = {
      name: 'mailer',
      policies: { apply: async () => ({ ok: true, note: '' }), applied: async () => 7 },
    } as unknown as PluginManifest;
    const deliver = vi.fn(async (_text: string) => undefined);
    const result = await runLearningDigest({ pool, now: NOW, manifests: [counting], proposalsUrl: LINK, deliver });
    expect(result.digest.stopped).toEqual({ total: 7, byPlugin: { mailer: 7 } });
    expect(deliver.mock.calls[0]?.[0]).toContain('Your rules stepped in 7 times.');
  });

  it('sends nothing on a week with nothing learned and nothing open, and still records it for Home', async () => {
    await note('Too old', new Date(NOW.getTime() - 8 * DAY));
    const deliver = vi.fn(async (_text: string) => undefined);
    const result = await runLearningDigest({ pool, now: NOW, manifests: [], proposalsUrl: LINK, deliver });
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: false, skipped: 'nothing learned and nothing waiting' });
    expect(await latestDigest(pool)).toMatchObject({ delivered: false, open: 0, memory: { count: 0 } });
  });

  it('runs as the learning-digest mission on Sunday 20:00 by default, and the owner can move it', async () => {
    await ensureDigestMission(pool, 'America/New_York');
    expect(await getMission(pool, LEARNING_DIGEST_ID)).toMatchObject({ agentId: 'buddi', enabled: true });
    const schedule = await readDigestSchedule(pool, new Date('2026-09-23T12:00:00Z'), 'America/New_York');
    expect(schedule).toMatchObject({ day: 0, hour: 20, timezone: 'America/New_York', next: '2026-09-28T00:00:00.000Z' });

    await setDigestSchedule(pool, { day: 5, hour: 9 }, 'America/New_York');
    // A restart keeps the owner's choice.
    await ensureDigestMission(pool, 'America/New_York');
    expect(await readDigestSchedule(pool, new Date('2026-09-23T12:00:00Z'), 'America/New_York')).toMatchObject({ day: 5, hour: 9 });
    await expect(setDigestSchedule(pool, { day: 7, hour: 9 }, 'America/New_York')).rejects.toThrow(RangeError);
    await expect(setDigestSchedule(pool, { day: 1, hour: 24 }, 'America/New_York')).rejects.toThrow(RangeError);
  });

  it('answers the digest mission itself and hands every other mission to the executor', async () => {
    const execute = vi.fn(async () => ({ conversationId: 'c', text: 'agent', delivered: true, decision: 'report' as const }));
    const deliver = vi.fn(async (_text: string) => undefined);
    await propose('skill', { name: 'Open one', when: 'w', body: 'b', why: 'y' }, NOW);
    const run = withLearningDigest(execute, { pool, now: () => NOW, manifests: () => [], proposalsUrl: LINK, deliver });
    const occurrence = {} as Occurrence;
    const digest = await run(occurrence, { id: LEARNING_DIGEST_ID } as Mission);
    expect(execute).not.toHaveBeenCalled();
    expect(digest).toMatchObject({ conversationId: '', delivered: true, decision: 'report' });
    expect(deliver).toHaveBeenCalledTimes(1);
    await run(occurrence, { id: 'friday-recap' } as Mission);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('digest text and cron', () => {
  it('reads back the cron it writes, and the recap-style names', () => {
    expect(parseDigestCron('0 20 * * 0')).toEqual({ day: 0, hour: 20 });
    expect(parseDigestCron('0 20 * * SUN')).toEqual({ day: 0, hour: 20 });
    expect(parseDigestCron('*/5 * * * *')).toBeNull();
  });

  it('leaves out every kind with nothing in it, rather than saying "nothing"', () => {
    const empty = { count: 0, names: [] };
    const text = digestText(
      { at: '', since: '', memory: empty, skills: empty, rules: empty, changes: { count: 1, names: ["advisor's tools"] }, open: 0, stopped: { total: 0, byPlugin: { mailer: 0 } } },
      LINK,
    );
    expect(text).toBe('What buddi learned this week.\nChanged how your agents work once.');
    expect(digestText({ at: '', since: '', memory: empty, skills: empty, rules: empty, changes: empty, open: 0, stopped: null }, LINK))
      .toBe('What buddi learned this week.\nNothing new this week.');
  });

  it('says the week for humans: counts with one place to look, never raw rule names or a cut note', () => {
    const lines = digestSummary({
      at: '', since: '',
      memory: { count: 18, names: ['Loose ends from the 2026-09-27 weekly consolidation, for Fr…', 'Recurring charges billed to …'] },
      skills: { count: 2, names: ['Open a project', 'Start Cour des Comptes locally'] },
      rules: { count: 26, names: ['email: ignore', 'email: ignore', 'email: ignore'], actions: { ignore: 20, archive: 6 }, plugins: { email: 26 } },
      changes: { count: 0, names: [] },
      open: 0,
      stopped: { total: 436, byPlugin: { email: 436 } },
    });
    expect(lines).toEqual([
      { key: 'memory', text: 'Remembered 18 things', link: { label: 'See memory', route: '#/settings/memory' } },
      { key: 'rules', text: 'Quieted 26 senders', link: { label: 'See rules', route: '#/settings/proposals?plugin=email' } },
      { key: 'skills', text: 'Kept 2 skills: Open a project and Start Cour des Comptes locally' },
      { key: 'handled', text: 'Your rules handled 436 emails' },
    ]);
    const said = JSON.stringify(lines);
    expect(said).not.toContain('email: ignore');
    expect(said).not.toContain('…');
    expect(said).not.toMatch(/Nothing was waiting|Proposes|Stopped doing/);
  });

  it('calls rules that do more than quiet "new rules", and names the skills it could not list as "more"', () => {
    const empty = { count: 0, names: [] };
    const lines = digestSummary({
      at: '', since: '', memory: empty, changes: empty, open: 3, stopped: null,
      skills: { count: 5, names: ['A', 'B', 'C'] },
      rules: { count: 2, names: [], actions: { ignore: 1, notify: 1 }, plugins: { email: 1, finance: 1 } },
    });
    expect(lines.map((l) => l.text)).toEqual(['Kept 2 new rules', 'Kept 5 skills: A, B, C and 2 more', '3 suggestions wait for you']);
    expect(lines[0]?.link?.route).toBe('#/settings/proposals');
  });
});
