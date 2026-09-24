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
import type { BuddiHost } from '../host/types.js';

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
  /**
   * Which agent should speak about it: resolved by the plugin — normally with
   * `ctx.agentForRole` — or the wake mission's agent by default. A plugin that
   * writes an id of its own down is naming an agent the owner may have deleted
   * this morning; ask for the role instead and leave this undefined when
   * nobody holds it.
   */
  agentId?: string;
  /**
   * An `info` finding that wakes its agent **once**, when it is first raised,
   * instead of waiting for the digest.
   *
   * Some facts are good news with a short shelf life — a milestone crossed, a
   * target reached, a number nobody has been able to measure for a week. They
   * do not deserve an `urgent` (which repeats every 24 h and interrupts), but
   * hearing about them next Sunday is hearing about them too late. So the
   * first raise becomes a wake and everything after it behaves like any other
   * `info`: quiet for seven days, then the digest.
   *
   * Ignored on `urgent`, which already wakes. Unset — the normal case — is an
   * `info` that simply waits for the recap.
   */
  wake?: boolean;
  /** Structured evidence handed to that agent verbatim. */
  data?: unknown;
}

export interface SentinelContext {
  /** The host, bound to the plugin this sentinel belongs to. See `ToolContext.buddi`. */
  buddi?: BuddiHost;
  /** @deprecated Use `ctx.buddi.db`. */
  db: Pool;
  /**
   * The owner this installation belongs to.
   *
   * A sentinel that only reads its own rows never needs it. A sentinel that
   * calls something written for a *tool* does: `measureMetric` takes a
   * `ToolContext`, and a `ToolContext` has an owner. Core's goal watcher is
   * the first, and rather than let it invent the string, the tick passes down
   * the same id every other part of the process runs as.
   *
   * @deprecated Use `ctx.buddi.owner.id`.
   */
  ownerId: string;
  /** @deprecated Use `ctx.buddi.clock.now`. */
  now: () => Date;
  /**
   * The owner's timezone: a sentinel that needs a *day* renders it in this zone.
   *
   * @deprecated Use `ctx.buddi.owner.timezone`.
   */
  timezone: string;
  /**
   * The id of the agent that answers for a role — the first *runnable* agent
   * holding it in roster order — or `undefined` when nobody does.
   *
   * It is the only supported way for a sentinel to address a finding. Roles
   * are the owner's word (`roles: [credit]` in an agent's frontmatter) and
   * survive the agent being renamed, replaced or deleted; an id hard-coded in
   * a plugin does not. Held-back and unbound agents are left out: an agent
   * this installation cannot run would take the finding and say nothing.
   *
   * `undefined` is an answer, not a failure — leave `Finding.agentId` unset
   * and the wake mission's agent speaks, which is by construction an agent
   * that exists.
   *
   * @deprecated Use `ctx.buddi.owner.agentForRole`.
   */
  agentForRole(role: string): string | undefined;
}

/**
 * What a sentinel hands back when the facts it sees outnumber what it is
 * willing to raise in one tick.
 *
 * A cap on findings is not a statement that the facts past it stopped being
 * true — but `resolveMissing` can only go by what the run returned, so a bare
 * capped array makes core resolve the tail and then hear it again as news next
 * tick. So a sentinel that caps says both things: the findings it wants raised
 * now, and every key that is still true. Core raises the first and resolves
 * nothing in the second.
 */
export interface SentinelReport {
  /** The findings to raise this tick, already capped by the sentinel. */
  findings: Finding[];
  /**
   * Every key the sentinel still holds true, the raised ones included. Absent
   * means "the findings are the whole truth", which is the common case.
   */
  keys?: readonly string[];
}

export type SentinelResult = Finding[] | SentinelReport;

/** The findings of a result, whichever shape it came in. */
export function findingsOf(result: SentinelResult): Finding[] {
  return Array.isArray(result) ? result : result.findings;
}

/** Every key a result says is still true: the raised ones plus the capped tail. */
export function stillTrueKeys(result: SentinelResult): Set<string> {
  const keys = new Set<string>();
  for (const finding of findingsOf(result)) keys.add(finding.key);
  if (!Array.isArray(result)) for (const key of result.keys ?? []) keys.add(key);
  return keys;
}

export interface Sentinel {
  /** Namespaced and stable, e.g. 'finance.cashflow'. Keys the run ledger. */
  id: string;
  description: string;
  /** Period in **seconds**. The tick runs it when that much time has passed. */
  every: number;
  run(ctx: SentinelContext): Promise<SentinelResult>;
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
  /** True when the owner has this watcher switched off. It did not run. */
  disabled?: boolean;
  findings: number;
  /** Findings that woke the owner or went to the digest this tick. */
  fired: number;
  /** Findings that stopped being true this tick. */
  resolved: number;
  error?: string;
};
