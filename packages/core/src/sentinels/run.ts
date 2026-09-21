/**
 * The sentinel tick.
 *
 * Three rules make this safe to run every thirty seconds forever:
 *
 *  1. **Dedup is by key, not by run.** A finding the sentinel returns again is
 *     the same fact: `last_seen_at` moves and nothing else happens.
 *  2. **Firing is rate limited by severity.** `urgent` wakes the owner once,
 *     then stays quiet for 24h; `info` lands in the weekly digest once, then
 *     stays quiet for 7 days. Silence is the default, not an optimization.
 *  3. **A sentinel that throws cannot stop the others.** The error is recorded
 *     in `core.sentinel_runs.last_error` and the tick continues; the findings
 *     of a failed run are ignored entirely (a half-list is not evidence that
 *     anything resolved).
 */
import type { Pool } from 'pg';
import { appendEvent } from '../events.js';
import type { PluginManifest } from '../tools.js';
import {
  INFO_COOLDOWN_MS,
  SENTINEL_FINDING_COLUMNS,
  SENTINEL_WAKE_MISSION_ID,
  URGENT_COOLDOWN_MS,
  toSentinelFinding,
  type Finding,
  type Sentinel,
  type SentinelFinding,
  type SentinelFindingRow,
  type SentinelOutcome,
} from './types.js';

/** Every sentinel the installed plugins ship, in manifest order. */
export function collectSentinels(manifests: PluginManifest[]): Sentinel[] {
  const seen = new Set<string>();
  const all: Sentinel[] = [];
  for (const manifest of manifests) {
    for (const sentinel of manifest.sentinels ?? []) {
      if (seen.has(sentinel.id)) {
        throw new Error(`sentinel id collision: ${sentinel.id} (plugin ${manifest.name})`);
      }
      seen.add(sentinel.id);
      all.push(sentinel);
    }
  }
  return all;
}

/** Open (unresolved) findings for one sentinel. */
export async function openFindings(pool: Pool, sentinelId: string): Promise<SentinelFinding[]> {
  const { rows } = await pool.query<SentinelFindingRow>(
    `select ${SENTINEL_FINDING_COLUMNS} from core.sentinel_findings
     where sentinel_id = $1 and resolved_at is null
     order by first_seen_at, key`,
    [sentinelId],
  );
  return rows.map(toSentinelFinding);
}

/** One finding by key, or null. */
export async function getFinding(pool: Pool, key: string): Promise<SentinelFinding | null> {
  const { rows } = await pool.query<SentinelFindingRow>(
    `select ${SENTINEL_FINDING_COLUMNS} from core.sentinel_findings where key = $1`,
    [key],
  );
  return rows.length > 0 ? toSentinelFinding(rows[0] as SentinelFindingRow) : null;
}

/**
 * Stamp a finding as having reached the owner. Called by whoever delivers —
 * core never sends anything itself.
 */
export async function markFindingDelivered(
  pool: Pool,
  key: string,
  at: Date,
): Promise<void> {
  await pool.query(
    `update core.sentinel_findings set delivered_at = $2 where key = $1`,
    [key, at.toISOString()],
  );
}

type RunLedgerRow = { sentinel_id: string; last_run_at: Date; last_error: string | null };

/** Run every due sentinel once. Never throws for a sentinel's own failure. */
export async function runSentinels(
  pool: Pool,
  manifests: PluginManifest[],
  now: Date,
  timezone: string,
  /**
   * Who answers for a role, from the host's live roster. Omitted — a test, or
   * a host with no catalog — every role is unheld, which is a valid answer:
   * findings name no agent and fall to the wake mission's agent.
   */
  agentForRole: (role: string) => string | undefined = () => undefined,
): Promise<SentinelOutcome[]> {
  const sentinels = collectSentinels(manifests);
  if (sentinels.length === 0) return [];

  const { rows: ledger } = await pool.query<RunLedgerRow>(
    `select sentinel_id, last_run_at, last_error from core.sentinel_runs`,
  );
  const lastRun = new Map(ledger.map((r) => [r.sentinel_id, r.last_run_at]));

  const outcomes: SentinelOutcome[] = [];
  for (const sentinel of sentinels) {
    const previous = lastRun.get(sentinel.id);
    const dueAt = previous ? previous.getTime() + sentinel.every * 1000 : 0;
    if (previous && now.getTime() < dueAt) {
      outcomes.push({ sentinelId: sentinel.id, ran: false, findings: 0, fired: 0, resolved: 0 });
      continue;
    }
    outcomes.push(await runOne(pool, sentinel, now, timezone, agentForRole));
  }
  return outcomes;
}

async function runOne(
  pool: Pool,
  sentinel: Sentinel,
  now: Date,
  timezone: string,
  agentForRole: (role: string) => string | undefined,
): Promise<SentinelOutcome> {
  let findings: Finding[];
  try {
    findings = await sentinel.run({ db: pool, now: () => now, timezone, agentForRole });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordRun(pool, sentinel.id, now, message);
    await appendEvent(pool, 'sentinel.ran', {
      sentinelId: sentinel.id,
      findings: 0,
      error: message,
    });
    return { sentinelId: sentinel.id, ran: true, findings: 0, fired: 0, resolved: 0, error: message };
  }

  let fired = 0;
  const seen = new Set<string>();
  for (const finding of findings) {
    if (!finding.key || finding.key.trim() === '') {
      throw new Error(`sentinel ${sentinel.id} returned a finding with no key`);
    }
    if (seen.has(finding.key)) continue; // one fact, one row, whatever the sentinel repeats
    seen.add(finding.key);
    if (await upsertAndMaybeFire(pool, sentinel.id, finding, now)) fired += 1;
  }

  const resolved = await resolveMissing(pool, sentinel.id, seen, now);
  await recordRun(pool, sentinel.id, now, null);
  await appendEvent(pool, 'sentinel.ran', {
    sentinelId: sentinel.id,
    findings: seen.size,
    fired,
    resolved,
  });
  return { sentinelId: sentinel.id, ran: true, findings: seen.size, fired, resolved };
}

async function recordRun(
  pool: Pool,
  sentinelId: string,
  now: Date,
  error: string | null,
): Promise<void> {
  await pool.query(
    `insert into core.sentinel_runs (sentinel_id, last_run_at, last_error)
     values ($1, $2, $3)
     on conflict (sentinel_id) do update
       set last_run_at = excluded.last_run_at, last_error = excluded.last_error`,
    [sentinelId, now.toISOString(), error],
  );
}

/**
 * Write the finding and decide whether it speaks.
 *
 * It speaks when it is new, when it had resolved and came back, or when its
 * cooldown has run out. Otherwise the row is touched and the owner hears
 * nothing.
 */
async function upsertAndMaybeFire(
  pool: Pool,
  sentinelId: string,
  finding: Finding,
  now: Date,
): Promise<boolean> {
  const existing = await getFinding(pool, finding.key);
  const isNew = existing === null;
  const cooldownPassed =
    existing !== null &&
    (existing.cooldownUntil === null || existing.cooldownUntil.getTime() <= now.getTime());
  // A snoozed finding is touched and never fires: the owner has heard it.
  const shouldFire = (isNew || cooldownPassed) && existing?.snoozedAt == null;

  await pool.query(
    `insert into core.sentinel_findings
       (key, sentinel_id, severity, title, detail, data, first_seen_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)
     on conflict (key) do update
       set sentinel_id = excluded.sentinel_id,
           severity = excluded.severity,
           title = excluded.title,
           detail = excluded.detail,
           data = excluded.data,
           last_seen_at = excluded.last_seen_at,
           resolved_at = null`,
    [
      finding.key,
      sentinelId,
      finding.severity,
      finding.title,
      finding.detail,
      JSON.stringify(finding.data ?? null),
      now.toISOString(),
    ],
  );

  if (!shouldFire) return false;

  const delivery =
    finding.severity === 'urgent'
      ? await enqueueWake(pool, sentinelId, finding, now)
      : await noteInDigest(pool, finding);

  if (!delivery.ok) {
    // Nowhere to put it yet (the wake mission is not registered). Leave the
    // cooldown clear so it fires on the tick after `buddi missions add-defaults`.
    await appendEvent(pool, 'sentinel.finding', {
      sentinelId,
      key: finding.key,
      severity: finding.severity,
      title: finding.title,
      fired: false,
      reason: delivery.reason,
    });
    return false;
  }

  const cooldownMs = finding.severity === 'urgent' ? URGENT_COOLDOWN_MS : INFO_COOLDOWN_MS;
  await pool.query(
    `update core.sentinel_findings set cooldown_until = $2 where key = $1`,
    [finding.key, new Date(now.getTime() + cooldownMs).toISOString()],
  );

  await appendEvent(pool, 'sentinel.finding', {
    sentinelId,
    key: finding.key,
    severity: finding.severity,
    title: finding.title,
    fired: true,
    ...(delivery.occurrenceId ? { occurrenceId: delivery.occurrenceId } : {}),
    ...(delivery.digestItemId ? { digestItemId: delivery.digestItemId } : {}),
  });
  return true;
}

type Delivery =
  | { ok: true; occurrenceId?: string; digestItemId?: string }
  | { ok: false; reason: string };

/**
 * An urgent finding becomes a pending occurrence of the wake mission, carrying
 * the finding as the occurrence payload. Two findings in the same second get
 * distinct instants: the unique key is (mission, revision, scheduled_at), and
 * two facts are two runs.
 */
async function enqueueWake(
  pool: Pool,
  sentinelId: string,
  finding: Finding,
  now: Date,
): Promise<Delivery> {
  const mission = await pool.query(`select id from core.missions where id = $1`, [
    SENTINEL_WAKE_MISSION_ID,
  ]);
  if (mission.rowCount === 0) {
    return { ok: false, reason: `mission "${SENTINEL_WAKE_MISSION_ID}" is not registered` };
  }

  const payload = {
    finding: {
      key: finding.key,
      sentinelId,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      agentId: finding.agentId ?? null,
      data: finding.data ?? null,
    },
  };

  for (let offset = 0; offset < 60; offset++) {
    const at = new Date(now.getTime() + offset);
    const { rows } = await pool.query<{ id: string }>(
      `insert into core.occurrences
         (mission_id, schedule_revision, scheduled_at, state, payload)
       values ($1, 0, $2, 'pending', $3::jsonb)
       on conflict (mission_id, schedule_revision, scheduled_at) do nothing
       returning id`,
      [SENTINEL_WAKE_MISSION_ID, at.toISOString(), JSON.stringify(payload)],
    );
    if (rows[0]) return { ok: true, occurrenceId: String(rows[0].id) };
  }
  return { ok: false, reason: 'could not allocate a wake occurrence instant' };
}

/** An info finding waits for the weekly recap. One unconsumed item per key. */
async function noteInDigest(pool: Pool, finding: Finding): Promise<Delivery> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.digest_items (finding_key, severity, title, detail)
     values ($1, $2, $3, $4)
     on conflict (finding_key) where consumed_at is null do nothing
     returning id`,
    [finding.key, finding.severity, finding.title, finding.detail],
  );
  // Already waiting in the digest: that is the dedup working, not a failure.
  return { ok: true, ...(rows[0] ? { digestItemId: String(rows[0].id) } : {}) };
}

/**
 * A fact the sentinel no longer reports has stopped being true. Resolution
 * clears the cooldown on purpose: if it comes back, the owner hears about it.
 */
async function resolveMissing(
  pool: Pool,
  sentinelId: string,
  seen: Set<string>,
  now: Date,
): Promise<number> {
  const open = await openFindings(pool, sentinelId);
  let resolved = 0;
  for (const finding of open) {
    if (seen.has(finding.key)) continue;
    await pool.query(
      `update core.sentinel_findings
       set resolved_at = $2, cooldown_until = null, snoozed_at = null
       where key = $1 and resolved_at is null`,
      [finding.key, now.toISOString()],
    );
    await appendEvent(pool, 'sentinel.resolved', {
      sentinelId,
      key: finding.key,
      severity: finding.severity,
      title: finding.title,
    });
    resolved += 1;
  }
  return resolved;
}

/**
 * The owner's one verb on a finding: snooze it, or take the snooze back. Only
 * an open finding can be snoozed; a resolved one is already quiet. Returns the
 * finding as it now stands, or null when the key names nothing open.
 */
export async function snoozeFinding(pool: Pool, key: string, snoozed: boolean, now = new Date()): Promise<SentinelFinding | null> {
  const { rows } = await pool.query<SentinelFindingRow>(
    `update core.sentinel_findings set snoozed_at = $2
      where key = $1 and resolved_at is null
      returning ${SENTINEL_FINDING_COLUMNS}`,
    [key, snoozed ? now.toISOString() : null],
  );
  if (rows.length === 0) return null;
  await appendEvent(pool, snoozed ? 'sentinel.snoozed' : 'sentinel.unsnoozed', { key });
  return toSentinelFinding(rows[0] as SentinelFindingRow);
}
