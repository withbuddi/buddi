/**
 * Settings → Memory → People, and Home's birthday card (docs/memory.md,
 * "People"; docs/dashboard.md, Home).
 *
 *   GET  /api/memory/people                 → { people: PersonRow[], today }
 *   POST /api/memory/people                 { id?, name, relationship?, addressAs?, birthday?, anniversary?, notes?, reminders? } → { person, people }
 *   POST /api/memory/people/:id/forget      → { person, people }
 *   POST /api/memory/people/:id/restore     → { person, people }
 *   GET  /api/owner/birthday                → BirthdayGlance
 *
 * The owner writes People directly: no proposal, because the owner is the one
 * who decides. Every save brings the date missions in step at once
 * (`syncDateMissions`), so "Remind me of their dates" is the mission's own
 * switch, created off and turned on here.
 */
import { daysUntil, localDateString, ownerTimezone, setMissionEnabled, turning, type AgentCatalog, type DayMonth } from '@buddi/core';
import { PersonRefusal, forgetPerson, listPeople, restorePerson, upsertPerson, type PersonView } from '@buddi/tool-memory';
import type { Pool } from 'pg';
import { birthdayGlance, personMissionId, syncDateMissions } from '../missions/dates.js';

export interface PeopleDeps {
  pool: Pool;
  catalog: Pick<AgentCatalog, 'agentForRole'>;
  now: () => Date;
  log: (line: string) => void;
}

export interface PeopleReply {
  status: number;
  body: unknown;
}

/** A person as the page draws it: the next date said, and whether its reminders are on. */
export interface PersonRow extends PersonView {
  next: { what: 'birthday' | 'anniversary'; inDays: number; turning: number | null } | null;
  /** Null: no date, so nothing to remind of. */
  reminders: boolean | null;
}

export async function peopleRows(deps: Pick<PeopleDeps, 'pool' | 'now'>): Promise<{ people: PersonRow[]; today: string }> {
  const today = localDateString(deps.now(), ownerTimezone());
  let people: PersonView[] = [];
  try { people = await listPeople(deps.pool); }
  catch (err) { if ((err as { code?: string } | null)?.code !== '42P01') throw err; }
  const { rows: missions } = await deps.pool.query(
    `select id, enabled from core.missions where id like 'person-dates:%'`,
  );
  const enabled = new Map<string, boolean>(missions.map((m) => [String(m.id), Boolean(m.enabled)]));
  return {
    today,
    people: people.map((p) => {
      const dates = (['birthday', 'anniversary'] as const)
        .filter((what) => p[what] !== null)
        .map((what) => ({ what, date: p[what] as DayMonth, inDays: daysUntil(p[what] as DayMonth, today) }))
        .sort((a, b) => a.inDays - b.inDays);
      const soonest = dates[0];
      return {
        ...p,
        next: soonest ? { what: soonest.what, inDays: soonest.inDays, turning: turning(soonest.date, today) } : null,
        reminders: dates.length === 0 ? null : (enabled.get(personMissionId(p.id)) ?? false),
      };
    }),
  };
}

const dateOf = (value: unknown): DayMonth | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return { day: Number(v.day), month: Number(v.month), year: v.year === undefined || v.year === null || v.year === '' ? null : Number(v.year) };
};
const textOf = (value: unknown): string | null | undefined =>
  value === undefined ? undefined : value === null ? null : typeof value === 'string' ? value : String(value);

export async function peopleRoute(deps: PeopleDeps, method: string, path: string, body: Record<string, unknown>): Promise<PeopleReply | undefined> {
  if (method === 'GET' && path === '/api/owner/birthday') {
    return { status: 200, body: await birthdayGlance(deps.pool, deps.now()) };
  }
  if (method === 'GET' && path === '/api/memory/people') {
    return { status: 200, body: await peopleRows(deps) };
  }
  if (method !== 'POST') return undefined;
  const sync = async (): Promise<void> => {
    try { await syncDateMissions({ pool: deps.pool, catalog: deps.catalog, now: deps.now, log: deps.log }); }
    catch (err) { deps.log(`dates: ${err instanceof Error ? err.message : String(err)}`); }
  };

  if (path === '/api/memory/people') {
    const id = typeof body.id === 'string' && body.id !== '' ? body.id : undefined;
    try {
      const { person } = await upsertPerson(deps.pool, {
        ...(id ? { id } : {}),
        ...(body.name !== undefined ? { name: String(body.name) } : {}),
        ...(textOf(body.relationship) !== undefined ? { relationship: textOf(body.relationship)! } : {}),
        ...(textOf(body.addressAs) !== undefined ? { addressAs: textOf(body.addressAs)! } : {}),
        ...(textOf(body.notes) !== undefined ? { notes: textOf(body.notes)! } : {}),
        ...(dateOf(body.birthday) !== undefined ? { birthday: dateOf(body.birthday)! } : {}),
        ...(dateOf(body.anniversary) !== undefined ? { anniversary: dateOf(body.anniversary)! } : {}),
      }, { by: 'owner', now: deps.now() });
      await sync();
      // The switch on the sheet is the mission's own: it exists once a date does.
      if (typeof body.reminders === 'boolean' && (person.birthday || person.anniversary)) {
        await setMissionEnabled(deps.pool, personMissionId(person.id), body.reminders);
      }
      const rows = await peopleRows(deps);
      return { status: 200, body: { person: rows.people.find((p) => p.id === person.id) ?? person, people: rows.people } };
    } catch (err) {
      if (err instanceof PersonRefusal) return { status: 400, body: { error: err.message } };
      if ((err as { code?: string } | null)?.code === '23505') return { status: 409, body: { error: 'Someone with that name is already in People.' } };
      throw err;
    }
  }

  const one = /^\/api\/memory\/people\/([0-9a-f-]{36})\/(forget|restore)$/.exec(path);
  if (one) {
    const person = one[2] === 'forget' ? await forgetPerson(deps.pool, one[1]!, deps.now()) : await restorePerson(deps.pool, one[1]!);
    if (!person) return { status: 404, body: { error: one[2] === 'forget' ? 'That person is not in People.' : 'That person cannot come back: someone with the same name is in People now.' } };
    await sync();
    const rows = await peopleRows(deps);
    return { status: 200, body: { person, people: rows.people } };
  }
  return undefined;
}
