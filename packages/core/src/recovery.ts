/**
 * Recovery mode — the state a restored installation wakes up in.
 *
 * A restore is not a start. The database that comes back holds queued jobs that
 * were queued for a world that has moved on, missions whose next occurrence is
 * in the past, approvals waiting on a decision nobody will give now, and
 * standing tool grants the owner gave to an installation that no longer exists.
 * If `buddi serve` simply started its loops, the first minute after a restore
 * would be spent acting on all of it at once.
 *
 * So a restore writes one row here, and the gateway reads it at startup: while
 * it is set, chat and the dashboard work and nothing else runs. The owner goes
 * through the checklist — put the secrets back, reinstall the plugins, drop or
 * keep the pending work and the grants — and `leaveRecovery` is the last step.
 *
 * `pending` is counts, never rows. What is in the tables is in the tables; what
 * this records is what the *archive* carried, so the checklist can say "eleven
 * queued jobs" even after the owner has dropped them.
 */
import type { Queryable } from './owner.js';

/** What the restored dump carried, counted once, at restore time. */
export interface RecoveryPending {
  /** Queue rows that are still claimable or leased. */
  jobs: number;
  /** Missions with an occurrence that has not finished. */
  missions: number;
  /** Approvals still waiting on the owner. */
  approvals: number;
  /** Telegram identities paired to a chat. */
  telegramChats: number;
  /** Standing tool permissions. */
  grants: number;
}

export interface RecoveryState {
  active: boolean;
  restoredAt: Date;
  archive: string;
  buddiVersion: string | null;
  pending: RecoveryPending;
  leftAt: Date | null;
}

export const EMPTY_PENDING: RecoveryPending = {
  jobs: 0,
  missions: 0,
  approvals: 0,
  telegramChats: 0,
  grants: 0,
};

export interface EnterRecoveryInput {
  archive: string;
  buddiVersion?: string | null | undefined;
  pending?: Partial<RecoveryPending> | undefined;
  now?: Date | undefined;
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** A `pending` cell as the checklist reads it, whatever the driver handed back. */
export function toPending(value: unknown): RecoveryPending {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...EMPTY_PENDING };
  const row = raw as Record<string, unknown>;
  return {
    jobs: count(row.jobs),
    missions: count(row.missions),
    approvals: count(row.approvals),
    telegramChats: count(row.telegramChats),
    grants: count(row.grants),
  };
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * Count what a just-restored database is holding.
 *
 * Run by the restorer after the load and before the gateway starts, so the
 * numbers describe the archive rather than whatever the owner did afterwards.
 * Each count is its own statement and its own `catch`: a plugin schema that did
 * not come back must not turn a checklist into a failed restore.
 */
export async function countPending(pool: Queryable): Promise<RecoveryPending> {
  const one = async (sql: string): Promise<number> => {
    try {
      const { rows } = await pool.query(sql);
      return count(rows[0]?.n);
    } catch {
      return 0;
    }
  };
  return {
    jobs: await one(
      `select count(*)::text as n from core.jobs where state in ('pending', 'leased', 'suspended')`,
    ),
    missions: await one(
      `select count(distinct mission_id)::text as n from core.occurrences
        where state in ('pending', 'claimed')`,
    ),
    approvals: await one(`select count(*)::text as n from core.approvals where state = 'pending'`),
    telegramChats: await one(
      `select count(*)::text as n from core.surface_identities
        where surface = 'telegram' and external_chat_id is not null`,
    ),
    grants: await one(`select count(*)::text as n from core.tool_permissions`),
  };
}

/**
 * Put the installation into recovery. Idempotent on the one row: a second
 * restore replaces what the first one recorded, including clearing `left_at`.
 */
export async function enterRecovery(
  pool: Queryable,
  input: EnterRecoveryInput,
): Promise<RecoveryState> {
  const pending: RecoveryPending = { ...EMPTY_PENDING, ...(input.pending ?? {}) };
  const { rows } = await pool.query(
    `insert into core.recovery (id, restored_at, archive, buddi_version, pending, left_at)
     values (true, $1, $2, $3, $4::jsonb, null)
     on conflict (id) do update
        set restored_at = excluded.restored_at,
            archive = excluded.archive,
            buddi_version = excluded.buddi_version,
            pending = excluded.pending,
            left_at = null
     returning restored_at, archive, buddi_version, pending, left_at`,
    [input.now ?? new Date(), input.archive, input.buddiVersion ?? null, JSON.stringify(pending)],
  );
  return row(rows[0]);
}

/**
 * The row, or null when this installation was never restored.
 *
 * A database whose migration has not run yet is also "never restored"; every
 * other failure is raised, so a caller cannot mistake a database it could not
 * read for an installation that is not in recovery.
 */
export async function readRecovery(pool: Queryable): Promise<RecoveryState | null> {
  try {
    const { rows } = await pool.query(
      `select restored_at, archive, buddi_version, pending, left_at from core.recovery where id`,
    );
    return rows[0] ? row(rows[0]) : null;
  } catch (err) {
    if (isMissingRelation(err)) return null;
    throw err;
  }
}

/**
 * Is this installation in recovery right now?
 *
 * A database that predates the migration is an installation that is simply not
 * in recovery, so a missing table answers `false`. Nothing else is swallowed:
 * a pool that has been ended, or a database that cannot be reached, used to
 * come back here as "not in recovery" — which hid the banner and the whole
 * checklist on exactly the installation they exist for. That belongs on the
 * wire as a failure, not as an answer.
 */
export async function inRecovery(pool: Queryable): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `select 1 as n from core.recovery where id and left_at is null`,
    );
    return rows.length > 0;
  } catch (err) {
    if (isMissingRelation(err)) return false;
    throw err;
  }
}

/** `undefined_table` or `invalid_schema_name`: this database has no recovery row yet. */
function isMissingRelation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '42P01' || code === '3F000';
}

/** Leave recovery. `false` when it was not in recovery to begin with. */
export async function leaveRecovery(pool: Queryable, now: Date = new Date()): Promise<boolean> {
  const { rows } = await pool.query(
    `update core.recovery set left_at = $1 where id and left_at is null returning left_at`,
    [now],
  );
  return rows.length > 0;
}

function row(raw: Record<string, unknown>): RecoveryState {
  const leftAt = raw.left_at === null || raw.left_at === undefined ? null : date(raw.left_at);
  return {
    active: leftAt === null,
    restoredAt: date(raw.restored_at),
    archive: String(raw.archive),
    buddiVersion: raw.buddi_version === null || raw.buddi_version === undefined ? null : String(raw.buddi_version),
    pending: toPending(raw.pending),
    leftAt,
  };
}
