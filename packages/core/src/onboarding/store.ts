/**
 * First run — the state machine and the owner's profile.
 *
 * The whole point of this module is that *code decides when the conversation
 * happens and records that it did*, and nothing more. There is no script here,
 * no question text and no ordering: the agent asks, the agent records, the
 * agent says when it is done.
 *
 * Two properties everything below is built for:
 *
 *  - **it starts once.** `beginOnboarding` is one conditional upsert, so two
 *    surfaces meeting a brand-new installation at the same moment produce one
 *    interview and one `started: false`. Neither surface reads-then-writes.
 *  - **it is idempotent.** Every accessor may be called again with the same
 *    argument and change nothing: a step already recorded is not recorded
 *    twice, a finished onboarding keeps its original `completed_at`, and the
 *    surface that finished it keeps the credit.
 *
 * Reading never writes: an installation that has never had the conversation
 * has no row at all, and `getOnboarding` answers with a synthetic `pending`
 * one rather than creating it.
 */
import { OWNER_ID, ensureOwner, type Queryable } from '../owner.js';
import type {
  Onboarding,
  OnboardingStart,
  OwnerProfile,
  OwnerProfilePatch,
} from './types.js';

/** Every column, in one place, so the row mapper and the SQL cannot drift. */
const COLUMNS = `owner_id, state, started_at, completed_at, surface, steps_done,
                 nudges_sent, last_nudge_at, unanswered, quiet_until, updated_at`;

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const at = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * `steps_done` as an array of strings, whatever the driver handed back.
 *
 * `pg` parses `jsonb` for us, but a stub database in a test may return the
 * text, and a column holding something that is not an array is data we did not
 * write. Both degrade to "no steps recorded" rather than throwing: a malformed
 * cell must never cost the owner the conversation.
 */
function steps(value: unknown): string[] {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toOnboarding(row: any): Onboarding {
  return {
    ownerId: String(row.owner_id),
    state: row.state,
    startedAt: date(row.started_at),
    completedAt: date(row.completed_at),
    surface: row.surface === null || row.surface === undefined ? null : String(row.surface),
    stepsDone: steps(row.steps_done),
    nudgesSent: Number(row.nudges_sent ?? 0),
    lastNudgeAt: date(row.last_nudge_at),
    unanswered: Number(row.unanswered ?? 0),
    quietUntil: date(row.quiet_until),
    updatedAt: date(row.updated_at),
  };
}

/** What an installation that has never been asked anything looks like. */
export function pendingOnboarding(ownerId: string = OWNER_ID): Onboarding {
  return {
    ownerId,
    state: 'pending',
    startedAt: null,
    completedAt: null,
    surface: null,
    stepsDone: [],
    nudgesSent: 0,
    lastNudgeAt: null,
    unanswered: 0,
    quietUntil: null,
    updatedAt: null,
  };
}

/**
 * The onboarding row. Never writes — a missing row *is* `pending`, and a
 * surface that only wants to know whether to say hello must not create state
 * by asking.
 */
export async function getOnboarding(pool: Queryable): Promise<Onboarding> {
  const { rows } = await pool.query(
    `select ${COLUMNS} from core.onboarding where owner_id = $1`,
    [OWNER_ID],
  );
  return rows[0] ? toOnboarding(rows[0]) : pendingOnboarding();
}

/**
 * Claim the first conversation for a surface.
 *
 * `do update … where state = 'pending'` is the whole concurrency story: the
 * update only fires while nobody has started, so exactly one caller gets a row
 * back and every later caller gets `started: false` with whatever the state
 * actually is. An installation that is already `done` is never restarted.
 */
export async function beginOnboarding(
  pool: Queryable,
  surface: string,
): Promise<OnboardingStart> {
  const { rows } = await pool.query(
    `insert into core.onboarding (owner_id, state, started_at, surface, updated_at)
     values ($1, 'in-progress', now(), $2, now())
     on conflict (owner_id) do update
       set state = 'in-progress',
           started_at = coalesce(core.onboarding.started_at, now()),
           surface = coalesce(core.onboarding.surface, excluded.surface),
           updated_at = now()
     where core.onboarding.state = 'pending'
     returning ${COLUMNS}`,
    [OWNER_ID, surface],
  );
  if (rows[0]) return { started: true, onboarding: toOnboarding(rows[0]) };
  return { started: false, onboarding: await getOnboarding(pool) };
}

/**
 * Record that one question got answered. Free-form and set-like: the same step
 * twice changes nothing, and the order is the order they were recorded in.
 */
export async function markStepDone(pool: Queryable, step: string): Promise<Onboarding> {
  const name = step.trim();
  if (name === '') return getOnboarding(pool);
  const { rows } = await pool.query(
    `insert into core.onboarding (owner_id, steps_done, updated_at)
     values ($1, to_jsonb(array[$2]::text[]), now())
     on conflict (owner_id) do update
       set steps_done = case
             when core.onboarding.steps_done @> to_jsonb(array[$2]::text[])
               then core.onboarding.steps_done
             else core.onboarding.steps_done || to_jsonb(array[$2]::text[])
           end,
           updated_at = now()
     returning ${COLUMNS}`,
    [OWNER_ID, name],
  );
  return rows[0] ? toOnboarding(rows[0]) : pendingOnboarding();
}

/**
 * The conversation finished. Idempotent, and the *first* surface to finish it
 * keeps the credit — a second call from the other surface changes nothing, so
 * whichever one the owner actually answered on is the one recorded.
 */
export async function completeOnboarding(
  pool: Queryable,
  surface: string,
): Promise<Onboarding> {
  const { rows } = await pool.query(
    `insert into core.onboarding (owner_id, state, started_at, completed_at, surface, updated_at)
     values ($1, 'done', now(), now(), $2, now())
     on conflict (owner_id) do update
       set state = 'done',
           completed_at = coalesce(core.onboarding.completed_at, now()),
           surface = coalesce(core.onboarding.surface, excluded.surface),
           updated_at = now()
     returning ${COLUMNS}`,
    [OWNER_ID, surface],
  );
  return rows[0] ? toOnboarding(rows[0]) : pendingOnboarding();
}

/**
 * The owner said no. A first-class outcome, not a failure: `skipped` closes the
 * machine exactly as `done` does, and nothing ever asks again.
 *
 * The reason is kept in the event log rather than in the row — it is one
 * sentence of history, not state anything reads — and a database with no event
 * table simply records the skip without it.
 */
export async function skipOnboarding(pool: Queryable, reason?: string): Promise<Onboarding> {
  const { rows } = await pool.query(
    `insert into core.onboarding (owner_id, state, started_at, completed_at, updated_at)
     values ($1, 'skipped', now(), now(), now())
     on conflict (owner_id) do update
       set state = 'skipped',
           completed_at = coalesce(core.onboarding.completed_at, now()),
           updated_at = now()
     returning ${COLUMNS}`,
    [OWNER_ID],
  );
  const note = (reason ?? '').trim();
  if (note !== '') {
    await pool
      .query(`insert into core.events (kind, payload) values ($1, $2::jsonb)`, [
        'onboarding.skipped',
        JSON.stringify({ reason: note }),
      ])
      .catch(() => undefined);
  }
  return rows[0] ? toOnboarding(rows[0]) : pendingOnboarding();
}

/**
 * Is the first conversation behind us? `skipped` counts: the owner declining it
 * is an answer, and re-offering something that was declined is the one thing a
 * first run must never do.
 */
export async function isOnboardingComplete(pool: Queryable): Promise<boolean> {
  const { state } = await getOnboarding(pool);
  return state === 'done' || state === 'skipped';
}

/* ------------------------------------------------------------------ *
 * The owner's profile
 * ------------------------------------------------------------------ */

function toProfile(row: any): OwnerProfile {
  const text = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    return trimmed === '' ? null : trimmed;
  };
  return {
    preferredName: text(row.preferred_name),
    timezone: text(row.timezone),
    language: text(row.language),
    about: text(row.about),
    displayName: text(row.display_name),
  };
}

/** What the agents know about how to address the owner. All of it may be null. */
export async function getOwnerProfile(pool: Queryable): Promise<OwnerProfile> {
  const { rows } = await pool.query(
    `select preferred_name, timezone, language, about, display_name
       from core.owner where id = $1`,
    [OWNER_ID],
  );
  return rows[0] ? toProfile(rows[0]) : EMPTY_PROFILE;
}

const EMPTY_PROFILE: OwnerProfile = { preferredName: null, timezone: null, language: null, about: null, displayName: null };

/**
 * Write the profile. Absent keys are left alone; an explicit `null` clears one.
 *
 * Nothing is validated here — an IANA zone is checked where the *instruction*
 * to write one comes from (the `owner.set_profile` tool), because core's job is
 * to store what the owner said, not to have an opinion about it.
 */
export async function setOwnerProfile(
  pool: Queryable,
  patch: OwnerProfilePatch,
): Promise<OwnerProfile> {
  await ensureOwner(pool);
  const value = (given: string | null | undefined): string | null | undefined => {
    if (given === undefined) return undefined;
    if (given === null) return null;
    const trimmed = given.trim();
    return trimmed === '' ? null : trimmed;
  };
  const preferredName = value(patch.preferredName);
  const timezone = value(patch.timezone);
  const language = value(patch.language);
  const about = value(patch.about);

  const { rows } = await pool.query(
    `update core.owner
        set preferred_name = case when $2::boolean then $3 else preferred_name end,
            timezone       = case when $4::boolean then $5 else timezone end,
            language       = case when $6::boolean then $7 else language end,
            about          = case when $8::boolean then $9 else about end
      where id = $1
      returning preferred_name, timezone, language, about, display_name`,
    [
      OWNER_ID,
      preferredName !== undefined,
      preferredName ?? null,
      timezone !== undefined,
      timezone ?? null,
      language !== undefined,
      language ?? null,
      about !== undefined,
      about ?? null,
    ],
  );
  return rows[0] ? toProfile(rows[0]) : EMPTY_PROFILE;
}
