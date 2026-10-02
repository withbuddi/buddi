/**
 * Sentinels — deterministic watchers. No model, no prompt, no judgement.
 *
 * A sentinel is the second half of the "sources originate work" contract
 * (docs/architecture.md, "Sentinels"): a plugin ships code that runs
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
  /** A short label for logs and the fallback owner line. Prefer `ownerLine` for what the owner reads. */
  title: string;
  /**
   * The **agent brief**: what the agent that picks the finding up — a wake,
   * or the owner pressing "Ask" — should check and do. Written for a model
   * ("read the draft with email.read_draft and tell the owner what it says").
   * Never shown to the owner on any surface (host API 1.23).
   */
  detail: string;
  /**
   * The **owner's line** (host API 1.23): plain and short, what happened and
   * why it matters — "Your Checking balance hasn't been updated since 14 Sep,
   * so the cash forecast starts from a guess." It is the only text the
   * dashboard, Telegram, the recap and Home show. Unset falls back to `title`,
   * never to the brief.
   */
  ownerLine?: string;
  /**
   * What sort of fact this is within its watcher (1.23), e.g. `stale-balance`.
   * Open findings of the same watcher and kind are drawn as one row. Unset is
   * the watcher's one kind, ''.
   */
  kind?: string;
  /**
   * What the finding is about (1.23): an account, a sender. `id` is stable and
   * is what "Stop telling me this" silences; `label` names the row inside a
   * group. Plain words, no untrusted markup beyond what `ownerLine` may carry.
   */
  subject?: { id: string; label: string };
  /**
   * How a group of this kind reads (1.23). `{count}` is replaced by the number
   * of findings: `{ title: '{count} balances not updated in 2+ weeks' }`.
   * Unset: the first finding's line "and N more like it".
   */
  group?: { title: string; ownerLine?: string };
  /**
   * What the owner can do about it (1.23), the first one primary. See
   * `FindingAction`. Every row also gets Not now and Stop telling me this
   * from core, so neither is declared here.
   */
  actions?: FindingAction[];
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
  /**
   * How the agent's line reaches the owner, when a wake is not news for now.
   *
   * A wake's report goes out as `now` by default. `urgency: 'today'` holds it
   * for the end of the owner's day instead — for a nudge that matters but not
   * this minute ("you have not told me your weight this week"). `dedupeKey`
   * is the notification's "this thing, again"; it defaults to
   * `finding:<key>`. Never raises an urgency: there is no `now` here.
   */
  notify?: { urgency?: 'today'; dedupeKey?: string };
  /**
   * How long this same fact stays quiet after it spoke, when the default is
   * too eager: 24 hours for `urgent`, seven days for `info`. A weekly goal off
   * track is news once a week, not every morning. Only ever lengthens the
   * wait in practice; the first raise still speaks at once.
   */
  cooldownMs?: number;
  /** Structured evidence handed to that agent verbatim. */
  data?: unknown;
}

/**
 * One thing the owner can do about a finding, from the row (host API 1.23).
 *
 *  - `open`: one of this plugin's pages (`page`, optionally an `item` in it),
 *    or core's Files library (`place: 'files'`).
 *  - `run`: one of this plugin's tools, run as the owner. A gated tool raises
 *    its approval card exactly as from the plugin's own page; nothing here
 *    gets around the gate. `confirm` asks first; `tone: 'danger'` for a
 *    discard.
 *  - `fill`: a one-field form — the entered value goes into
 *    `args[field.name]` and the tool runs as with `run`. Findings of a group
 *    whose `fill` names the same tool share one quick form, a field each;
 *    `groupLabel` is the button then ("Update them").
 *  - `ask`: asks the agent that answers for the finding, handing it the brief.
 *    The label defaults to "Ask <agent>".
 *  - `dismiss`: "Not needed" — quiet until the fact itself changes.
 */
export type FindingAction =
  | { kind: 'open'; label: string; page?: string; item?: string; place?: 'files' }
  | { kind: 'run'; label: string; tool: string; args?: Record<string, unknown>; confirm?: string; tone?: 'danger' }
  | {
      kind: 'fill';
      label: string;
      groupLabel?: string;
      /** The quick form's title, e.g. "Update balances". */
      title?: string;
      tool: string;
      args?: Record<string, unknown>;
      field: { name: string; label: string; type: 'number' | 'text' | 'date'; value?: string | number | null; hint?: string };
    }
  | { kind: 'ask'; label?: string }
  | { kind: 'dismiss'; label: string };

export interface SentinelContext {
  /** The host, bound to the plugin this sentinel belongs to. See `ToolContext.buddi`. */
  buddi?: BuddiHost;
}

/** What core runs a sentinel with: the host's facts beside it. Core's own, like `CoreToolContext`. */
export interface CoreSentinelContext extends SentinelContext {
  /** The pool: `buddi.db`. */
  db: Pool;
  /**
   * The owner this installation belongs to.
   *
   * A sentinel that only reads its own rows never needs it. A sentinel that
   * calls something written for a *tool* does: `measureMetric` takes a
   * `ToolContext`, and a `ToolContext` has an owner. Core's goal watcher is
   * the first, and rather than let it invent the string, the tick passes down
   * the same id every other part of the process runs as.
   */
  ownerId: string;
  /** The clock: `buddi.clock.now`. */
  now: () => Date;
  /**
   * The owner's timezone: a sentinel that needs a *day* renders it in this zone.
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
  /**
   * Gather this watcher's wakes for the same agent into one run (host API
   * 1.20). A watcher that can raise several urgent facts at once — five cards
   * all due this week — would otherwise wake its agent five times in a row.
   * The first wake waits `windowSeconds` for company, each one that follows
   * pushes the run back by the window again, and none waits longer than
   * `maxWaitSeconds`: the agent then reads every finding in one run. Unset is
   * one run per wake, at once. Ignored by an older buddi, which wakes at once.
   */
  coalesce?: { windowSeconds: number; maxWaitSeconds: number };
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
  /** "Not now": quiet until then. Null with `snoozedAt` set is quiet until the fact changes. */
  snoozedUntil: Date | null;
  /** The owner's line, or null when the watcher gave none (the title stands in). */
  ownerLine: string | null;
  kind: string;
  subject: { id: string; label: string } | null;
  group: { title: string; ownerLine?: string } | null;
  actions: FindingAction[];
  agentId: string | null;
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
  snoozed_until?: Date | null;
  owner_line?: string | null;
  kind?: string | null;
  subject?: unknown;
  group_spec?: unknown;
  actions?: unknown;
  agent_id?: string | null;
};

export const SENTINEL_FINDING_COLUMNS =
  'key, sentinel_id, severity, title, detail, data, first_seen_at, last_seen_at, cooldown_until, delivered_at, resolved_at, snoozed_at, snoozed_until, owner_line, kind, subject, group_spec, actions, agent_id';

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
    snoozedUntil: row.snoozed_until ?? null,
    ownerLine: typeof row.owner_line === 'string' && row.owner_line.trim() !== '' ? row.owner_line : null,
    kind: row.kind ?? '',
    subject: subjectOf(row.subject),
    group: groupOf(row.group_spec),
    actions: actionsOf(row.actions),
    agentId: row.agent_id ?? null,
  };
}

/** Is a finding quiet by the owner's snooze at `now`? */
export function isSnoozed(f: { snoozedAt: Date | null; snoozedUntil: Date | null }, now: Date): boolean {
  if (f.snoozedAt === null) return false;
  return f.snoozedUntil === null || f.snoozedUntil.getTime() > now.getTime();
}

/** What the owner reads for a finding: its line, else its title — never the brief. */
export function ownerLineOf(f: { ownerLine?: string | null; title: string }): string {
  const line = typeof f.ownerLine === 'string' ? f.ownerLine.trim() : '';
  return line !== '' ? line : f.title;
}

const MAX_TEXT = 400;

function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t.slice(0, max);
}

/** A subject as stored, or null for anything else. */
export function subjectOf(value: unknown): { id: string; label: string } | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as { id?: unknown; label?: unknown };
  const id = text(v.id, 200);
  const label = text(v.label, 200);
  return id !== null && label !== null ? { id, label } : null;
}

/** A group spec as stored, or null. */
export function groupOf(value: unknown): { title: string; ownerLine?: string } | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as { title?: unknown; ownerLine?: unknown };
  const title = text(v.title);
  if (title === null) return null;
  const ownerLine = text(v.ownerLine);
  return ownerLine === null ? { title } : { title, ownerLine };
}

/** The most actions one finding keeps; a row has room for a few, not a menu of twenty. */
export const MAX_FINDING_ACTIONS = 5;

/**
 * A finding's actions, checked: anything of a shape core does not know is
 * dropped rather than trusted, so a plugin built against a newer host, or one
 * that wrote nonsense, leaves the row with fewer buttons and nothing broken.
 */
export function actionsOf(value: unknown): FindingAction[] {
  if (!Array.isArray(value)) return [];
  const out: FindingAction[] = [];
  for (const raw of value) {
    if (out.length >= MAX_FINDING_ACTIONS) break;
    if (raw === null || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const label = text(a.label, 40);
    const args = a.args !== null && typeof a.args === 'object' && !Array.isArray(a.args) ? (a.args as Record<string, unknown>) : undefined;
    switch (a.kind) {
      case 'open': {
        if (label === null) continue;
        const page = text(a.page, 80);
        const item = text(a.item, 200);
        if (a.place === 'files') out.push({ kind: 'open', label, place: 'files' });
        else if (page !== null) out.push({ kind: 'open', label, page, ...(item !== null ? { item } : {}) });
        break;
      }
      case 'run': {
        const tool = text(a.tool, 120);
        if (label === null || tool === null) continue;
        const confirm = text(a.confirm, 300);
        out.push({ kind: 'run', label, tool, ...(args ? { args } : {}), ...(confirm !== null ? { confirm } : {}), ...(a.tone === 'danger' ? { tone: 'danger' as const } : {}) });
        break;
      }
      case 'fill': {
        const tool = text(a.tool, 120);
        const f = a.field !== null && typeof a.field === 'object' ? (a.field as Record<string, unknown>) : null;
        const name = f ? text(f.name, 60) : null;
        const fieldLabel = f ? text(f.label, 120) : null;
        const type = f && (f.type === 'number' || f.type === 'text' || f.type === 'date') ? f.type : null;
        if (label === null || tool === null || f === null || name === null || fieldLabel === null || type === null) continue;
        const value = typeof f.value === 'number' && Number.isFinite(f.value) ? f.value : text(f.value, 200);
        const hint = text(f.hint, 200);
        const groupLabel = text(a.groupLabel, 40);
        const title = text(a.title, 80);
        out.push({
          kind: 'fill',
          label,
          ...(groupLabel !== null ? { groupLabel } : {}),
          ...(title !== null ? { title } : {}),
          tool,
          ...(args ? { args } : {}),
          field: { name, label: fieldLabel, type, ...(value !== null ? { value } : {}), ...(hint !== null ? { hint } : {}) },
        });
        break;
      }
      case 'ask': {
        out.push(label === null ? { kind: 'ask' } : { kind: 'ask', label });
        break;
      }
      case 'dismiss': {
        if (label === null) continue;
        out.push({ kind: 'dismiss', label });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export type DigestItem = {
  id: string;
  findingKey: string;
  severity: Severity;
  title: string;
  detail: string;
  /** The owner's line when the watcher gave one. */
  ownerLine: string | null;
  createdAt: Date;
  consumedAt: Date | null;
};

export type DigestItemRow = {
  id: string;
  finding_key: string;
  severity: Severity;
  title: string;
  detail: string;
  owner_line?: string | null;
  created_at: Date;
  consumed_at: Date | null;
};

export const DIGEST_ITEM_COLUMNS =
  'id, finding_key, severity, title, detail, owner_line, created_at, consumed_at';

export function toDigestItem(row: DigestItemRow): DigestItem {
  return {
    id: String(row.id),
    findingKey: row.finding_key,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    ownerLine: typeof row.owner_line === 'string' && row.owner_line.trim() !== '' ? row.owner_line : null,
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
