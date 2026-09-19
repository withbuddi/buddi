/**
 * Sentinels — deterministic watchers. No model, no prompt, no judgement.
 *
 * A sentinel is the second half of the "sources originate work" contract
 * (ARCHITECTURE.md, "Drop-in tools and skills"): a plugin ships code that runs
 * on a period, reads its own schema, and returns *findings*. What happens to a
 * finding — wake the owner now, note it for the weekly digest, or stay quiet
 * because it is the same fact as yesterday — is core's decision and lives in
 * `runSentinels`, so no plugin can decide to interrupt the owner.
 */
import type { Pool } from 'pg';

/** The mission enqueued for an `urgent` finding. Registered by the gateway. */
export const SENTINEL_WAKE_MISSION_ID = 'sentinel-wake';

/** How long the same urgent key stays quiet after it fires. */
export const URGENT_COOLDOWN_MS = 24 * 60 * 60_000;

/** How long the same info key stays quiet after it is noted. */
export const INFO_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

export type Severity = 'urgent' | 'info';

export interface Finding {
  /**
   * Stable dedup key — the same fact must produce the same key on every run,
   * and a *different* fact a different one. "the floor breaks on 2026-10-02"
   * is a key; "the floor breaks" with a moving date is not.
   */
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Which agent should speak about it. Defaults to the wake mission's agent. */
  agentId?: string;
  /** Structured evidence handed to that agent verbatim. */
  data?: unknown;
}

export interface SentinelContext {
  db: Pool;
  now: () => Date;
  /** The owner's timezone: a sentinel that needs a *day* renders it in this zone. */
  timezone: string;
}

export interface Sentinel {
  /** Namespaced and stable, e.g. 'finance.cashflow'. Keys the run ledger. */
  id: string;
  description: string;
  /** Period in **seconds**. The tick runs it when that much time has passed. */
  every: number;
  run(ctx: SentinelContext): Promise<Finding[]>;
}

export type SentinelFinding = {
  key: string;
  sentinelId: string;
  severity: Severity;
  title: string;
  detail: string;
  data: unknown;
  firstSeenAt: Date;
  lastSeenAt: Date;
  cooldownUntil: Date | null;
  deliveredAt: Date | null;
  resolvedAt: Date | null;
  /** Set by the owner: heard, living with it. Cleared when the fact resolves. */
  snoozedAt: Date | null;
};

export type SentinelFindingRow = {
  key: string;
  sentinel_id: string;
  severity: Severity;
  title: string;
  detail: string;
  data: unknown;
  first_seen_at: Date;
  last_seen_at: Date;
  cooldown_until: Date | null;
  delivered_at: Date | null;
  resolved_at: Date | null;
  snoozed_at: Date | null;
};

export const SENTINEL_FINDING_COLUMNS =
  'key, sentinel_id, severity, title, detail, data, first_seen_at, last_seen_at, cooldown_until, delivered_at, resolved_at, snoozed_at';

export function toSentinelFinding(row: SentinelFindingRow): SentinelFinding {
  return {
    key: row.key,
    sentinelId: row.sentinel_id,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    data: row.data,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    cooldownUntil: row.cooldown_until,
    deliveredAt: row.delivered_at,
    resolvedAt: row.resolved_at,
    snoozedAt: row.snoozed_at ?? null,
  };
}

export type DigestItem = {
  id: string;
  findingKey: string;
  severity: Severity;
  title: string;
  detail: string;
  createdAt: Date;
  consumedAt: Date | null;
};

export type DigestItemRow = {
  id: string;
  finding_key: string;
  severity: Severity;
  title: string;
  detail: string;
  created_at: Date;
  consumed_at: Date | null;
};

export const DIGEST_ITEM_COLUMNS =
  'id, finding_key, severity, title, detail, created_at, consumed_at';

export function toDigestItem(row: DigestItemRow): DigestItem {
  return {
    id: String(row.id),
    findingKey: row.finding_key,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  };
}

/** What one sentinel did in one tick. Returned so the caller can log it. */
export type SentinelOutcome = {
  sentinelId: string;
  /** False when the period had not elapsed: nothing ran, nothing changed. */
  ran: boolean;
  findings: number;
  /** Findings that woke the owner or went to the digest this tick. */
  fired: number;
  /** Findings that stopped being true this tick. */
  resolved: number;
  error?: string;
};
