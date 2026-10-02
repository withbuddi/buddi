/**
 * The one rule for "needs you" (docs/notifications.md, "Needs you").
 *
 * Needs you holds only what the owner can act on. For a notification that is:
 * an approval or a question, which always ask; or any other message that
 * carries an `action` — a step to take or a question to answer. Everything
 * else (a mission's report, an agent's plain `owner.notify`, a reminder that
 * fired, the recap, a learned line) is information: it is delivered on the
 * owner's channel as ever and kept in Notifications → Recent, but it never
 * sits in Needs you and never counts on a badge. A link alone is a place to
 * read more, not an ask.
 *
 * An actionable row is open until the owner deals with it: opened (seen),
 * marked Done (seen), or acted on. One stored because its kind is off was
 * never routed to the owner and is not open.
 *
 * Every surface that counts or lists what needs the owner — Home's list and
 * counts, the rail's badge, the lock screen — goes through these two, or the
 * SQL twin below, so they cannot disagree.
 */
import type { Queryable } from '../owner.js';
import { NOTIFICATION_COLUMNS, toNotification } from './store.js';
import type { OwnerNotification } from './types.js';

type Row = Pick<OwnerNotification, 'kind' | 'action'>;
type OpenRow = Row & Pick<OwnerNotification, 'state' | 'seenAt' | 'actedAt'>;

/** True when the message asks the owner for something: an approval, a question, or an explicit action. */
export function needsOwner(row: Row): boolean {
  if (row.kind === 'approval' || row.kind === 'question') return true;
  return typeof row.action === 'string' && row.action.trim() !== '';
}

/** Actionable and not dealt with yet: what Home lists and the badges count. */
export function openForOwner(row: OpenRow): boolean {
  return needsOwner(row) && row.actedAt === null && row.seenAt === null && row.state !== 'stored';
}

/** `openForOwner` in SQL, over `core.owner_notifications`. */
export const OPEN_FOR_OWNER_SQL =
  `(kind in ('approval', 'question') or coalesce(btrim(action), '') <> '')` +
  ` and acted_at is null and seen_at is null and state <> 'stored'`;

/**
 * Open actionable messages other than approvals and questions, which every
 * surface counts from their own records (the pending actions, the held
 * questions) rather than from the message that told the owner about them.
 * From the last week, like the lock screen always counted.
 */
export async function countOpenAsks(db: Queryable, now: Date = new Date()): Promise<number> {
  const { rows } = await db.query(
    `select count(*)::int as n from core.owner_notifications where ${OPEN_ASKS_WHERE}`,
    [weekBefore(now)],
  );
  return Number(rows[0]?.n ?? 0);
}

/** The rows `countOpenAsks` counts, newest first: what Home lists under Needs you. */
export async function listOpenAsks(db: Queryable, now: Date = new Date()): Promise<OwnerNotification[]> {
  const { rows } = await db.query(
    `select ${NOTIFICATION_COLUMNS} from core.owner_notifications
      where ${OPEN_ASKS_WHERE} order by created_at desc, id limit ${OPEN_ASKS_MAX}`,
    [weekBefore(now)],
  );
  return rows.map(toNotification);
}

/** More than any owner should have open; the count is not capped, the list is. */
const OPEN_ASKS_MAX = 100;
const OPEN_ASKS_WHERE = `${OPEN_FOR_OWNER_SQL} and kind not in ('approval', 'question') and created_at > $1`;
const weekBefore = (now: Date): Date => new Date(now.getTime() - 7 * 86_400_000);
