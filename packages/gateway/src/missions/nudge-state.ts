/**
 * The arc's state, read from and written to the onboarding row.
 *
 * `core.onboarding` belongs to the first-run interview (migration 013), and the
 * arc reads it through the interview's own accessor rather than a second view
 * of the same table. The four columns the *budget* owns — `nudges_sent`,
 * `last_nudge_at`, `unanswered`, `quiet_until` — are written here, because the
 * interview has no reason to know what a nudge is.
 *
 * Two things this file refuses to do:
 *
 *  - **It never creates the row.** `getOnboarding` hands back a synthetic
 *    `pending` row when there is none, and `startedAt === null` is what tells
 *    the two apart. A missing row means the arc has nowhere to count, and an
 *    arc that cannot count must not speak — so it reads as "no record" and the
 *    window stays shut.
 *  - **It never turns an unmigrated installation into an error.** A table that
 *    is not there yet reads as "no record" too. The cost of a missing migration
 *    must not be a mission run that throws every morning.
 */
import { getOnboarding, OWNER_ID, type Onboarding, type Queryable } from '@buddi/core';
import { currentPreferences, rememberPreference } from '@buddi/tool-memory';
import { ENGAGEMENT_KEY, parseEngagement, type Engagement } from './nudge-policy.js';

/** Postgres codes that mean "this installation has not migrated that yet". */
const ABSENT_CODES = new Set(['42P01', '3F000', '42703']);

function isAbsent(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ABSENT_CODES.has(code);
}

/**
 * The owner's onboarding row, or null when there is none.
 *
 * Null covers both "the interview has never run here" and "the table is not
 * migrated yet". They are the same fact to the arc: there is no place to keep a
 * count, so there is nothing to spend.
 */
export async function readArcState(pool: Queryable): Promise<Onboarding | null> {
  try {
    const onboarding = await getOnboarding(pool);
    // `pendingOnboarding()` — the stand-in for a row that does not exist. The
    // real row's `started_at` is NOT NULL.
    return onboarding.startedAt === null ? null : onboarding;
  } catch (err) {
    if (isAbsent(err)) return null;
    throw err;
  }
}

/**
 * One proactive message reached the owner.
 *
 * Three writes in one statement because they are one fact: the arc spent a
 * message, it spent it now, and nobody has answered it yet. `unanswered` goes
 * *up* on delivery and back to zero the moment the owner says anything — see
 * `noteOwnerActivity`.
 */
export async function recordNudgeDelivered(pool: Queryable, now: Date): Promise<void> {
  try {
    await pool.query(
      `update core.onboarding
          set nudges_sent = nudges_sent + 1,
              last_nudge_at = $2,
              unanswered = unanswered + 1,
              updated_at = $2
        where owner_id = $1`,
      [OWNER_ID, now],
    );
  } catch (err) {
    if (!isAbsent(err)) throw err;
  }
}

/**
 * The owner said something, on any surface. That is the only evidence the arc
 * is being read, so it is the only thing that clears the counter — and it must
 * never cost the owner their answer, hence the swallowed absence.
 */
export async function noteOwnerActivity(pool: Queryable, now: Date): Promise<void> {
  try {
    await pool.query(
      `update core.onboarding
          set unanswered = 0, updated_at = $2
        where owner_id = $1 and unanswered <> 0`,
      [OWNER_ID, now],
    );
  } catch (err) {
    if (!isAbsent(err)) throw err;
  }
}

/** `/quiet` and `/quiet off`. `null` clears it. False when there is no row. */
export async function setQuietUntil(
  pool: Queryable,
  until: Date | null,
  now: Date,
): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `update core.onboarding
          set quiet_until = $2, updated_at = $3
        where owner_id = $1
        returning owner_id`,
      [OWNER_ID, until, now],
    );
    return rows.length > 0;
  } catch (err) {
    if (isAbsent(err)) return false;
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * The engagement preference
 * ------------------------------------------------------------------ */

/**
 * `engagement` is an ordinary stated preference — the owner sets it by saying
 * so, and the memory tools store and version it like any other. It is read
 * here rather than re-implemented, so the arc sees the same value the agent
 * wrote when the owner said "stop suggesting things".
 */
export async function readEngagement(pool: Queryable): Promise<Engagement | undefined> {
  try {
    const preferences = await currentPreferences(pool, ['shared']);
    return parseEngagement(preferences.find((p) => p.key === ENGAGEMENT_KEY)?.value);
  } catch (err) {
    if (isAbsent(err)) return undefined;
    throw err;
  }
}

/** Write it as the owner's own stated preference, shared across every agent. */
export async function writeEngagement(
  pool: Queryable,
  value: Engagement,
  now: () => Date,
  timezone: string,
): Promise<void> {
  await rememberPreference.execute(
    { key: ENGAGEMENT_KEY, value, scope: 'shared' },
    { db: pool as never, ownerId: OWNER_ID, now, timezone },
  );
}
