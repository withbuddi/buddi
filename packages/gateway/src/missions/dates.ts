/**
 * Dates buddi acts on (docs/memory.md, "Dates buddi acts on").
 *
 * Two kinds of mission, both on the front desk and both kept in step with
 * what the owner wrote, by `syncDateMissions` (at start, every few minutes,
 * and at once after Settings saves a date):
 *
 *  - `owner-birthday` — the owner's birthday greeting. On by default; first
 *    thing (08:00) in the owner's zone on the day. A short note from the team,
 *    with a picture from an Illustrator when the image plugin has an account.
 *    The note reaches Telegram and sits on Home all day.
 *  - `person-dates:<id>` — one per person with a birthday or an anniversary.
 *    Off until the owner turns it on (Settings → Memory → People or Missions).
 *    A week before and on the day (09:00): a reminder with an offer to find
 *    something.
 *
 * The schedule is a superset of the real days (`yearlyCron`); the `prepare`
 * here says which runs are real and skips the rest before any model is called.
 */
import {
  dayMonthText,
  daysUntil,
  getActiveSchedule,
  getMission,
  getOwnerProfile,
  isOnDay,
  listMissions,
  localDateString,
  ownerTimezone,
  setSchedule,
  turning,
  upsertMission,
  yearlyCron,
  daysBefore,
  type AgentCatalog,
  type DayMonth,
  type Mission,
} from '@buddi/core';
import { getPerson, listPeople, type PersonView } from '@buddi/tool-memory';
import type { Pool } from 'pg';
import type { PreparedRun, PrepareRun } from './execute.js';

export const OWNER_BIRTHDAY_MISSION = 'owner-birthday';
export const PERSON_DATES_PREFIX = 'person-dates:';
/** First thing in the owner's day. */
export const BIRTHDAY_HOUR = 8;
export const REMINDER_HOUR = 9;
/** How long before a person's date the first reminder comes. */
export const REMIND_DAYS_BEFORE = 7;
export const FRONT_DESK_ROLE = 'front-desk';

export const personMissionId = (personId: string): string => `${PERSON_DATES_PREFIX}${personId}`;
export const personOfMission = (missionId: string): string | null =>
  missionId.startsWith(PERSON_DATES_PREFIX) ? missionId.slice(PERSON_DATES_PREFIX.length) : null;

export const OWNER_BIRTHDAY_PROMPT =
  "Today is the owner's birthday. Greet them first thing, from the whole team: one short, warm note (two to four sentences) " +
  'in your own voice, using what you know about them and their year (their profile, memory, people), never a generic card. ' +
  'If the material below says a teammate can draw, ask them for one picture first, as described there. Then send the note with ' +
  'mission.report (urgency normal). No questions back, no list, nothing to approve.';

export function personPrompt(name: string): string {
  return `A date of ${name}'s is coming up or is today: the material below says which. Tell the owner in one or two sentences, ` +
    'warmly and concretely (who, what, when, how old or how many years when known), using what you know about them ' +
    '(memory.people has their notes). Offer one action with mission.report: "Find something" — a gift or a plan that fits them. ' +
    'On the day itself, also offer to draft a message to them. Send it with mission.report (urgency normal).';
}

/** "Marion's birthday", "Marion's anniversary", "Marion's dates". */
export function personMissionName(p: Pick<PersonView, 'name' | 'birthday' | 'anniversary'>): string {
  const what = p.birthday && p.anniversary ? 'dates' : p.birthday ? 'birthday' : 'anniversary';
  return `${p.name}${p.name.endsWith('s') ? "'" : "'s"} ${what}`;
}

/** The days a person's mission fires on: a week before and the day, for each date. */
export function personCron(p: Pick<PersonView, 'birthday' | 'anniversary'>, year: number): string | null {
  const days: Array<{ day: number; month: number }> = [];
  for (const date of [p.birthday, p.anniversary]) {
    if (!date) continue;
    days.push({ day: date.day, month: date.month });
    // The week before, in this year and the next (a date in early January has its week before in December).
    for (const y of [year, year + 1]) days.push(daysBefore(date, REMIND_DAYS_BEFORE, y));
  }
  return yearlyCron(days, REMINDER_HOUR);
}

export interface DatesDeps {
  pool: Pool;
  catalog: Pick<AgentCatalog, 'agentForRole'>;
  now: () => Date;
  log?: (line: string) => void;
}

/** Set a schedule only when the cron or the zone differs from the active one. */
async function scheduleIf(pool: Pool, missionId: string, cron: string, timezone: string): Promise<void> {
  const active = await getActiveSchedule(pool, missionId);
  if (active && active.cron === cron && active.timezone === timezone) return;
  await setSchedule(pool, missionId, { cron, timezone, timezoneExplicit: false, misfirePolicy: 'skip-after-deadline', deadlineMinutes: 12 * 60 });
}

async function dropMission(pool: Pool, missionId: string): Promise<void> {
  await pool.query(`delete from core.missions where id = $1`, [missionId]);
}

/**
 * Bring the date missions in line with the profile and People. Idempotent:
 * a mission is created once, its switch is the owner's from then on, and its
 * schedule is replaced only when the date or the zone changed. Returns what it
 * changed, for the log.
 */
export async function syncDateMissions(deps: DatesDeps): Promise<{ created: string[]; removed: string[] }> {
  const created: string[] = [];
  const removed: string[] = [];
  const desk = deps.catalog.agentForRole(FRONT_DESK_ROLE);
  if (!desk.ok) return { created, removed };
  const agentId = desk.agent.id;
  const zone = ownerTimezone();
  const year = Number(localDateString(deps.now(), zone).slice(0, 4));

  // The owner's birthday: on by default, the owner's switch kept after that.
  const profile = await getOwnerProfile(deps.pool);
  const existing = await getMission(deps.pool, OWNER_BIRTHDAY_MISSION);
  if (profile.birthday) {
    if (!existing) created.push(OWNER_BIRTHDAY_MISSION);
    await upsertMission(deps.pool, {
      id: OWNER_BIRTHDAY_MISSION,
      name: 'Your birthday',
      agentId,
      prompt: OWNER_BIRTHDAY_PROMPT,
      enabled: existing ? existing.enabled : true,
      alwaysDeliver: false,
    });
    await scheduleIf(deps.pool, OWNER_BIRTHDAY_MISSION, yearlyCron([profile.birthday], BIRTHDAY_HOUR)!, zone);
  } else if (existing) {
    await dropMission(deps.pool, OWNER_BIRTHDAY_MISSION);
    removed.push(OWNER_BIRTHDAY_MISSION);
  }

  // People with a date: off until the owner turns them on.
  let people: PersonView[] = [];
  try { people = await listPeople(deps.pool); } catch { people = []; }
  const wanted = new Set<string>();
  for (const p of people) {
    const cron = personCron(p, year);
    if (!cron) continue;
    const id = personMissionId(p.id);
    wanted.add(id);
    const mission = await getMission(deps.pool, id);
    if (!mission) created.push(id);
    await upsertMission(deps.pool, {
      id,
      name: personMissionName(p),
      agentId,
      prompt: personPrompt(p.name),
      enabled: mission ? mission.enabled : false,
      alwaysDeliver: false,
    });
    await scheduleIf(deps.pool, id, cron, zone);
  }
  for (const mission of await listMissions(deps.pool)) {
    if (mission.id.startsWith(PERSON_DATES_PREFIX) && !wanted.has(mission.id)) {
      await dropMission(deps.pool, mission.id);
      removed.push(mission.id);
    }
  }
  if (created.length + removed.length > 0) {
    deps.log?.(`dates: ${created.length > 0 ? `added ${created.join(', ')}` : ''}${created.length > 0 && removed.length > 0 ? '; ' : ''}${removed.length > 0 ? `removed ${removed.join(', ')}` : ''}`);
  }
  return { created, removed };
}

/**
 * The running process's sync, registered by `serve`, so a write anywhere (the
 * owner's profile tool, a dashboard save) moves the schedules at once rather
 * than at the next sweep. Nothing registered (a test, the CLI): a no-op.
 */
let registered: (() => Promise<unknown>) | null = null;
export function onDatesChanged(sync: (() => Promise<unknown>) | null): void {
  registered = sync;
}
export async function datesChanged(): Promise<void> {
  if (!registered) return;
  try { await registered(); } catch { /* The sweep tries again in a few minutes. */ }
}

/** Is a person's reminder on? Null when the person has no date (no mission). */
export async function personRemindersOn(pool: Pool, personId: string): Promise<boolean | null> {
  const mission = await getMission(pool, personMissionId(personId));
  return mission ? mission.enabled : null;
}

/* ------------------------------------------------------------------ *
 * Before each run: is it one of its days, and what to say
 * ------------------------------------------------------------------ */

export interface DatesPrepareDeps {
  pool: Pool;
  now: () => Date;
  /** The team, for the note's signature: names of the agents the owner sees. */
  team: () => Array<{ id: string; name: string; handle: string; tools: readonly string[]; isFrontDesk?: boolean }>;
  /** Whether the image plugin has an account to draw with. */
  imageReady: () => Promise<boolean>;
}

/** What is due for one person today: on the day, or a week before, per date. */
export function dueFor(p: Pick<PersonView, 'birthday' | 'anniversary'>, today: string): Array<{ what: 'birthday' | 'anniversary'; date: DayMonth; inDays: number }> {
  const due: Array<{ what: 'birthday' | 'anniversary'; date: DayMonth; inDays: number }> = [];
  for (const what of ['birthday', 'anniversary'] as const) {
    const date = p[what];
    if (!date) continue;
    const inDays = daysUntil(date, today);
    if (inDays === 0 || inDays === REMIND_DAYS_BEFORE) due.push({ what, date, inDays });
  }
  return due;
}

export function createDatesPrepare(deps: DatesPrepareDeps): PrepareRun {
  return async (mission: Mission): Promise<PreparedRun | null> => {
    const today = localDateString(deps.now(), ownerTimezone());

    if (mission.id === OWNER_BIRTHDAY_MISSION) {
      const profile = await getOwnerProfile(deps.pool);
      if (!profile.birthday || !isOnDay(profile.birthday, today)) return { appendix: '', skip: 'not the owner’s birthday today' };
      const age = turning(profile.birthday, today);
      const team = deps.team();
      const lines = [
        `The owner: ${profile.preferredName ?? profile.fullName ?? 'the owner'}${age !== null ? `, turning ${age} today` : ''} (birthday ${dayMonthText(profile.birthday, false)}).`,
        team.length > 0 ? `Sign it from the team: ${team.map((a) => a.name).join(', ')}.` : '',
      ];
      const artist = team.find((a) => a.tools.includes('image.generate') && !a.isFrontDesk);
      if (artist && (await deps.imageReady().catch(() => false))) {
        lines.push(
          `@${artist.handle} (${artist.name}) can draw. Before the note, ask them with agent.delegate for ONE small, joyful square picture ` +
            'celebrating the owner\'s birthday (no text in it, no real person), using what you know of what they love. ' +
            'Put the library id it hands back in mission.report as link "#/files/<id>". If it cannot draw today, send the note alone.',
        );
      } else {
        lines.push('No picture this time: send the note alone.');
      }
      return { appendix: lines.filter((l) => l !== '').join('\n'), dedupeKey: `${OWNER_BIRTHDAY_MISSION}:${today}` };
    }

    const personId = personOfMission(mission.id);
    if (personId) {
      const p = await getPerson(deps.pool, personId).catch(() => null);
      if (!p) return { appendix: '', skip: 'the person is no longer in People' };
      const due = dueFor(p, today);
      if (due.length === 0) return { appendix: '', skip: `no date of ${p.name}'s today or in a week` };
      const lines = due.map((d) => {
        const age = turning(d.date, today);
        const years = age === null ? '' : d.what === 'birthday' ? `, turning ${age}` : `, ${age} years`;
        return `- ${p.name}'s ${d.what} (${dayMonthText(d.date, false)}${years}): ${d.inDays === 0 ? 'today' : `in ${d.inDays} days`}.`;
      });
      const who = [p.relationship ? `${p.name} is the owner's ${p.relationship}` : p.name, p.addressAs && p.addressAs !== p.name ? `the owner calls them "${p.addressAs}"` : '']
        .filter((x) => x !== '').join('; ');
      return { appendix: `${who}.\n${lines.join('\n')}`, dedupeKey: `person-date:${p.id}:${due.map((d) => d.what).join('+')}:${today}` };
    }
    return null;
  };
}

/* ------------------------------------------------------------------ *
 * Home on the owner's birthday
 * ------------------------------------------------------------------ */

export interface BirthdayGlance {
  /** Today is the owner's birthday, in their zone. */
  today: boolean;
  /** The owner's local date, `YYYY-MM-DD`: what closing the card is keyed on. */
  date: string;
  name: string | null;
  age: number | null;
  /** The team's note, once the greeting went out today. */
  note: string | null;
  /** The front desk that sent it. */
  from: string | null;
  /** The Illustrator's picture (a Files id), when there is one. */
  image: string | null;
}

/** What Home draws on the owner's birthday: the greeting's note and picture, read from today's message. */
export async function birthdayGlance(pool: Pool, now: Date): Promise<BirthdayGlance> {
  const profile = await getOwnerProfile(pool);
  const today = localDateString(now, ownerTimezone());
  const on = profile.birthday ? isOnDay(profile.birthday, today) : false;
  const glance: BirthdayGlance = {
    today: on, date: today, name: profile.preferredName ?? profile.fullName ?? profile.displayName ?? null,
    age: on && profile.birthday ? turning(profile.birthday, today) : null, note: null, from: null, image: null,
  };
  if (!on) return glance;
  const { rows } = await pool.query(
    `select title, text, link, agent_id from core.owner_notifications where dedupe_key = $1 order by created_at desc limit 1`,
    [`${OWNER_BIRTHDAY_MISSION}:${today}`],
  );
  const row = rows[0];
  if (row) {
    glance.note = [row.title, row.text].filter((t: unknown) => typeof t === 'string' && t.trim() !== '').join('\n\n') || null;
    glance.from = row.agent_id ?? null;
    const file = typeof row.link === 'string' ? /^#\/files\/([0-9a-f-]{36})/i.exec(row.link) : null;
    glance.image = file ? file[1]! : null;
  }
  return glance;
}

