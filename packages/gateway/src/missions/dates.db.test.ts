/**
 * Dates buddi acts on, against real Postgres and a fake clock (docs/memory.md,
 * "Dates buddi acts on"): the owner's birthday greeting is made on by default when a birthday
 * is set, fires first thing on the day in the owner's zone and on no other day,
 * sends one note that Home then draws; a person with a date gets a reminder
 * mission, off until the owner turns it on, that speaks a week before and on
 * the day only. A throwaway database, dropped at the end.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  createPool,
  getActiveSchedule,
  getMission,
  loadAgentCatalog,
  nextAfter,
  parseCron,
  setMissionEnabled,
  setOwnerProfile,
  type CoreToolContext,
  type Occurrence,
} from '@buddi/core';
import { runMigrations, testDatabaseUrl } from '@buddi/core/testing';
import { manifest as memoryManifest, upsertPerson, forgetPerson } from '@buddi/tool-memory';
import type { CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import { createMissionExecutor } from './execute.js';
import { ownerDeliver } from '../owner-notify.js';
import {
  OWNER_BIRTHDAY_MISSION,
  birthdayGlance,
  createDatesPrepare,
  personMissionId,
  syncDateMissions,
} from './dates.js';
import { peopleRoute } from '../web/people.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const DB = `buddi_dates_${process.pid}`;
const DESK = 'mission-agent';

/** One mission.report, then done: what an unattended run is supposed to do. */
function reporting(text: string, link?: string, calls: { n: number } = { n: 0 }): RuntimeProvider {
  let turn = 0;
  return {
    async complete(): Promise<CompletionResponse> {
      calls.n += 1;
      turn += 1;
      if (turn === 1) {
        return { content: [{ type: 'tool_use', id: 'r1', name: 'mission.report', input: { urgency: 'normal', text, ...(link ? { link } : {}) } }], stopReason: 'tool_use', usage: { input: 1, output: 1 }, model: 'test' };
      }
      return { content: [{ type: 'text', text: 'sent' }], stopReason: 'end_turn', usage: { input: 1, output: 1 }, model: 'test' };
    },
  };
}

suite('dates buddi acts on (postgres, fake clock)', () => {
  let admin: Pool;
  let pool: Pool;
  let clock = new Date('2026-09-30T10:00:00Z');
  const now = (): Date => clock;
  const registry = new ToolRegistry();
  registry.register(memoryManifest);
  const catalog = loadAgentCatalog({ dir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'mission-agents'), registry, env: {} });
  const deskCatalog = { agentForRole: (role: string) => (role === 'front-desk' ? { ok: true as const, agent: catalog.get(DESK)! } : catalog.agentForRole(role)) };
  const sync = () => syncDateMissions({ pool, catalog: deskCatalog, now });

  const execute = (provider: RuntimeProvider, imageReady = false) => {
    const ctx: CoreToolContext = { db: pool, ownerId: 'owner', now, timezone: 'Europe/Paris' };
    return createMissionExecutor({
      pool, registry, catalog, provider, ctx, env: {}, now, log: () => {}, requireDelivery: false,
      deliver: ownerDeliver(pool, { now, timezone: 'Europe/Paris' }),
      prepare: createDatesPrepare({
        pool, now,
        team: () => [
          { id: DESK, name: 'Buddi', handle: 'buddi', tools: [], isFrontDesk: true },
          { id: 'art', name: 'Illustrator', handle: 'art', tools: ['image.generate'] },
        ],
        imageReady: async () => imageReady,
      }),
    });
  };
  const occurrenceAt = (missionId: string, at: Date): Occurrence => ({
    id: `occ-${missionId}-${at.toISOString()}`, missionId, scheduleRevision: 1, scheduledAt: at, state: 'claimed',
    claimedAt: at, finishedAt: null, runConversationId: null, error: null, payload: null,
  });

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [memoryManifest]);
    await setOwnerProfile(pool, { preferredName: 'Amen', timezone: 'Europe/Paris' });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${DB}`);
      await admin.end();
    }
  });

  it('makes no greeting without a birthday, and one, switched on, once there is one', async () => {
    await sync();
    expect(await getMission(pool, OWNER_BIRTHDAY_MISSION)).toBeNull();
    await setOwnerProfile(pool, { birthday: { day: 2, month: 10, year: 1990 } });
    expect((await sync()).created).toEqual([OWNER_BIRTHDAY_MISSION]);
    const mission = await getMission(pool, OWNER_BIRTHDAY_MISSION);
    expect(mission).toMatchObject({ name: 'Your birthday', agentId: DESK, enabled: true });
    expect(await getActiveSchedule(pool, OWNER_BIRTHDAY_MISSION)).toMatchObject({ cron: '0 8 2 10 *', timezone: 'Europe/Paris', timezoneExplicit: false });
    // The owner's switch is theirs: a second sync does not turn it back on.
    await setMissionEnabled(pool, OWNER_BIRTHDAY_MISSION, false);
    await sync();
    expect((await getMission(pool, OWNER_BIRTHDAY_MISSION))!.enabled).toBe(false);
    await setMissionEnabled(pool, OWNER_BIRTHDAY_MISSION, true);
  });

  it('fires first thing on the day in the owner’s zone, and Home draws the note and the picture', async () => {
    // The schedule's next instant after the end of September: 08:00 Paris on 2 October (06:00 UTC).
    const spec = (await getActiveSchedule(pool, OWNER_BIRTHDAY_MISSION))!;
    const at = nextAfter(parseCron(spec.cron), new Date('2026-09-30T10:00:00Z'), spec.timezone)!;
    expect(at.toISOString()).toBe('2026-10-02T06:00:00.000Z');
    clock = new Date(at.getTime() + 30_000);
    const made = [occurrenceAt(OWNER_BIRTHDAY_MISSION, at)];
    expect((await birthdayGlance(pool, clock))).toMatchObject({ today: true, name: 'Amen', age: 36, note: null });

    const file = '33333333-3333-4333-8333-333333333333';
    const result = await execute(reporting('Happy birthday, Amen! Thirty-six looks good on you.', `#/files/${file}`), true)(made[0]!, (await getMission(pool, OWNER_BIRTHDAY_MISSION))!);
    expect(result).toMatchObject({ decision: 'report', delivered: true });
    const glance = await birthdayGlance(pool, clock);
    expect(glance).toMatchObject({ today: true, note: 'Happy birthday, Amen! Thirty-six looks good on you.', from: DESK, image: file });
    const { rows } = await pool.query(`select dedupe_key from core.owner_notifications where dedupe_key like 'owner-birthday:%'`);
    expect(rows.map((r) => r.dedupe_key)).toEqual(['owner-birthday:2026-10-02']);
  });

  it('asks the Illustrator only when the image plugin can draw', async () => {
    const prepare = createDatesPrepare({ pool, now, team: () => [{ id: 'art', name: 'Illustrator', handle: 'art', tools: ['image.generate'] }], imageReady: async () => false });
    const mission = (await getMission(pool, OWNER_BIRTHDAY_MISSION))!;
    expect((await prepare(mission))!.appendix).toContain('No picture this time');
    const drawing = createDatesPrepare({ pool, now, team: () => [{ id: 'art', name: 'Illustrator', handle: 'art', tools: ['image.generate'] }], imageReady: async () => true });
    expect((await drawing(mission))!.appendix).toContain('@art (Illustrator) can draw');
  });

  it('never runs on another day: no model call, silent', async () => {
    clock = new Date('2026-10-03T06:00:00Z');
    const calls = { n: 0 };
    const result = await execute(reporting('should not be sent', undefined, calls))(occurrenceAt(OWNER_BIRTHDAY_MISSION, clock), (await getMission(pool, OWNER_BIRTHDAY_MISSION))!);
    expect(result).toMatchObject({ decision: 'silent', delivered: false });
    expect(calls.n).toBe(0);
    expect((await birthdayGlance(pool, clock)).today).toBe(false);
  });

  it('gives a person with a date a reminder mission, off until turned on, speaking a week before and on the day', async () => {
    clock = new Date('2026-09-30T10:00:00Z');
    const { person } = await upsertPerson(pool, { name: 'Ben', relationship: 'brother', birthday: { day: 9, month: 10, year: 1991 } }, { by: 'owner', now: clock });
    await upsertPerson(pool, { name: 'Claire', relationship: 'accountant' }, { by: 'owner', now: clock });
    await sync();
    const id = personMissionId(person.id);
    expect(await getMission(pool, id)).toMatchObject({ name: "Ben's birthday", enabled: false, agentId: DESK });
    expect(await getActiveSchedule(pool, id)).toMatchObject({ cron: '0 9 2,9 10 *' });
    // The page's switch turns it on.
    const saved = await peopleRoute({ pool, catalog: deskCatalog, now, log: () => {} }, 'POST', '/api/memory/people', { id: person.id, reminders: true });
    expect(saved!.body).toMatchObject({ person: { name: 'Ben', reminders: true, next: { what: 'birthday', inDays: 9, turning: 35 } } });
    expect((await getMission(pool, id))!.enabled).toBe(true);
    // Claire has no date: nothing to remind of.
    const listed = await peopleRoute({ pool, catalog: deskCatalog, now, log: () => {} }, 'GET', '/api/memory/people', {});
    expect((listed!.body as { people: Array<{ name: string; reminders: boolean | null }> }).people.map((p) => [p.name, p.reminders])).toEqual([['Ben', true], ['Claire', null]]);

    const prepare = createDatesPrepare({ pool, now, team: () => [], imageReady: async () => false });
    const mission = (await getMission(pool, id))!;
    clock = new Date('2026-10-02T07:00:00Z');
    expect(await prepare(mission)).toMatchObject({ appendix: "Ben is the owner's brother.\n- Ben's birthday (9 October, turning 35): in 7 days.", dedupeKey: `person-date:${person.id}:birthday:2026-10-02` });
    clock = new Date('2026-10-05T07:00:00Z');
    expect(await prepare(mission)).toMatchObject({ skip: expect.stringContaining('no date') });
    clock = new Date('2026-10-09T07:00:00Z');
    expect((await prepare(mission))!.appendix).toContain('today');

    // Forgetting the person takes the mission with them.
    await forgetPerson(pool, person.id, clock);
    expect((await sync()).removed).toEqual([id]);
    expect(await getMission(pool, id)).toBeNull();
  });

  it('removes the greeting when the birthday is cleared', async () => {
    await setOwnerProfile(pool, { birthday: null });
    expect((await sync()).removed).toEqual([OWNER_BIRTHDAY_MISSION]);
  });
});
