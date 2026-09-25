/**
 * The weekly learning digest (docs/learning.md §5).
 *
 * Once a week, one message on Telegram and a card on Home: what buddi learned
 * (memory notes added, skills, rules and changes kept: counts and up to three
 * names each), what it proposes (the open count, with a link to Settings →
 * Proposals), and what it stopped doing (how many times a plugin's gate acted
 * on a rule the owner kept, from the plugins that record it; "not measured
 * yet" when none does, never a number made up here).
 *
 * It rides the mission scheduler as the `learning-digest` mission, so the
 * owner's day and hour are an ordinary schedule revision, a missed Sunday
 * coalesces into one, and the occurrence shows in the mission's history. The
 * run itself is not an agent run: it is counts, and a model call would only
 * add a way to get them wrong. The mission's executor is `runLearningDigest`.
 *
 * Quiet by default: with nothing learned and nothing open there is nothing to
 * act on, so the Telegram message is skipped. The Home card is written either
 * way (as a `learning.digest` event) and shows the latest until the next.
 */
import {
  getActiveSchedule,
  getMission,
  nextAfter,
  readLearningWeek,
  setSchedule,
  upsertMission,
  type KeptTally,
  type PluginManifest,
  type ProposalKind,
} from '@buddi/core';
import type { Pool } from 'pg';

export const LEARNING_DIGEST_ID = 'learning-digest';
/** Not an agent: the mission row needs a name for who runs it, and this one is buddi's own. */
export const LEARNING_DIGEST_RUNNER = 'buddi';
export const LEARNING_DIGEST_EVENT = 'learning.digest';

/** Sunday 20:00, in the installation's zone. */
export const DEFAULT_DIGEST_DAY = 0;
export const DEFAULT_DIGEST_HOUR = 20;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** The cron for a day (0 = Sunday) and an hour, on the hour. */
export function digestCron(day: number, hour: number): string {
  return `0 ${hour} * * ${day}`;
}

/** The day and hour a digest cron says, or null for a cron this page did not write. */
export function parseDigestCron(cron: string): { day: number; hour: number } | null {
  const m = /^0 (\d{1,2}) \* \* (\d|SUN|MON|TUE|WED|THU|FRI|SAT)$/i.exec(cron.trim());
  if (!m) return null;
  const names = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const raw = m[2]!.toUpperCase();
  const day = /^\d$/.test(raw) ? Number(raw) % 7 : names.indexOf(raw);
  const hour = Number(m[1]);
  return hour <= 23 ? { day, hour } : null;
}

const MISSION = {
  id: LEARNING_DIGEST_ID,
  name: 'Weekly learning digest',
  agentId: LEARNING_DIGEST_RUNNER,
  prompt:
    'Built by buddi itself, with no model call: what was learned this week, what is proposed, and what learned ' +
    'rules stopped the agents doing. Its day and hour are set on Settings → Proposals.',
  alwaysDeliver: false,
};

/**
 * The mission exists, with a schedule. An owner's chosen day and hour are an
 * active schedule already and are left alone; only a missing one is created.
 */
export async function ensureDigestMission(pool: Pool, timezone: string): Promise<void> {
  const existing = await getMission(pool, LEARNING_DIGEST_ID);
  if (!existing) await upsertMission(pool, MISSION);
  if (!(await getActiveSchedule(pool, LEARNING_DIGEST_ID))) {
    await setSchedule(pool, LEARNING_DIGEST_ID, {
      cron: digestCron(DEFAULT_DIGEST_DAY, DEFAULT_DIGEST_HOUR),
      timezone,
      misfirePolicy: 'coalesce',
    });
  }
}

export interface DigestSchedule {
  day: number;
  hour: number;
  timezone: string;
  /** The next instant it runs, ISO. Null when the mission is off or missing. */
  next: string | null;
}

export async function readDigestSchedule(pool: Pool, now: Date, timezone: string): Promise<DigestSchedule> {
  const [mission, spec] = await Promise.all([getMission(pool, LEARNING_DIGEST_ID), getActiveSchedule(pool, LEARNING_DIGEST_ID)]);
  const parsed = spec ? parseDigestCron(spec.cron) : null;
  return {
    day: parsed?.day ?? DEFAULT_DIGEST_DAY,
    hour: parsed?.hour ?? DEFAULT_DIGEST_HOUR,
    timezone: spec?.timezone ?? timezone,
    next: spec && mission?.enabled ? (nextAfter(spec.cron, now, spec.timezone)?.toISOString() ?? null) : null,
  };
}

/** The owner's day and hour: a new schedule revision, in the installation's zone. */
export async function setDigestSchedule(
  pool: Pool,
  input: { day: number; hour: number },
  timezone: string,
): Promise<void> {
  if (!Number.isInteger(input.day) || input.day < 0 || input.day > 6) throw new RangeError('The day is 0 (Sunday) to 6 (Saturday).');
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) throw new RangeError('The hour is 0 to 23.');
  await ensureDigestMission(pool, timezone);
  const spec = await getActiveSchedule(pool, LEARNING_DIGEST_ID);
  const cron = digestCron(input.day, input.hour);
  if (spec && spec.cron === cron && spec.timezone === timezone) return;
  await setSchedule(pool, LEARNING_DIGEST_ID, { cron, timezone, misfirePolicy: 'coalesce' });
}

/* ------------------------------------------------------------------ *
 * The digest
 * ------------------------------------------------------------------ */

export interface LearningDigest {
  /** When it was made, and the start of the week it covers. ISO. */
  at: string;
  since: string;
  memory: KeptTally;
  skills: KeptTally;
  rules: KeptTally;
  changes: KeptTally;
  /** Proposals waiting for the owner now. */
  open: number;
  /**
   * How many times a plugin acted on a kept learned rule this week, per
   * plugin. Null when no installed plugin records it.
   */
  stopped: { total: number; byPlugin: Record<string, number> } | null;
}

/** True when there is nothing to tell: nothing learned and nothing waiting. */
export function quietDigest(d: LearningDigest): boolean {
  return d.memory.count + d.skills.count + d.rules.count + d.changes.count === 0 && d.open === 0;
}

/** Memory notes added since, and not deleted: count and the first three, newest first. */
async function memoryWeek(pool: Pool, since: Date): Promise<KeptTally> {
  try {
    const { rows } = await pool.query(
      `select content, count(*) over ()::int as n from memory.notes
        where created_at >= $1 and deleted_at is null
        order by created_at desc, seq desc limit 3`,
      [since],
    );
    const names = rows.map((r: Record<string, unknown>) => clip(String(r.content ?? ''), 60));
    return { count: Number(rows[0]?.n ?? 0), names };
  } catch {
    // No memory plugin installed here: nothing was remembered through it.
    return { count: 0, names: [] };
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export async function composeDigest(
  pool: Pool,
  input: { now: Date; manifests: readonly PluginManifest[] },
): Promise<LearningDigest> {
  const since = new Date(input.now.getTime() - WEEK_MS);
  const [week, memory] = await Promise.all([readLearningWeek(pool, { since }), memoryWeek(pool, since)]);
  let stopped: LearningDigest['stopped'] = null;
  for (const manifest of input.manifests) {
    const counter = manifest.policies?.applied;
    if (!counter) continue;
    try {
      const n = await counter.call(manifest.policies, { db: pool, now: input.now }, since);
      stopped ??= { total: 0, byPlugin: {} };
      stopped.byPlugin[manifest.name] = n;
      stopped.total += n;
    } catch {
      // A plugin that cannot count this week is not counted; the others still are.
    }
  }
  const kept = (kind: ProposalKind): KeptTally => week.kept[kind];
  return {
    at: input.now.toISOString(),
    since: since.toISOString(),
    memory,
    skills: kept('skill'),
    rules: kept('policy'),
    changes: kept('change'),
    open: week.open,
    stopped,
  };
}

function tallyPhrase(t: KeptTally, one: string, many: string): string | null {
  if (t.count === 0) return null;
  const names = t.names.length > 0 ? ` (${t.names.join('; ')}${t.count > t.names.length ? '; …' : ''})` : '';
  return `${t.count} ${t.count === 1 ? one : many}${names}`;
}

/**
 * The digest as one plain-text message: no markdown, since Telegram shows the
 * characters, and no question, since nobody answers a digest.
 */
export function digestText(d: LearningDigest, proposalsUrl: string): string {
  const learned = [
    tallyPhrase(d.memory, 'memory note', 'memory notes'),
    tallyPhrase(d.skills, 'skill kept', 'skills kept'),
    tallyPhrase(d.rules, 'rule kept', 'rules kept'),
    tallyPhrase(d.changes, 'change to an agent kept', 'changes to agents kept'),
  ].filter((p): p is string => p !== null);
  const lines = ['What buddi learned this week.'];
  lines.push(learned.length > 0 ? `Learned: ${learned.join(', ')}.` : 'Learned: nothing new.');
  lines.push(
    d.open > 0
      ? `Proposes: ${d.open} ${d.open === 1 ? 'proposal waits' : 'proposals wait'} for you to keep or discard: ${proposalsUrl}`
      : 'Proposes: nothing is waiting for you.',
  );
  if (d.stopped === null) {
    lines.push('Stopped doing: not measured yet.');
  } else {
    const by = Object.entries(d.stopped.byPlugin)
      .filter(([, n]) => n > 0)
      .map(([plugin, n]) => `${plugin} ${n}`);
    lines.push(
      d.stopped.total > 0
        ? `Stopped doing: rules you kept acted ${d.stopped.total} ${d.stopped.total === 1 ? 'time' : 'times'} (${by.join(', ')}).`
        : 'Stopped doing: no rule you kept acted this week.',
    );
  }
  return lines.join('\n');
}

export interface DigestRunResult {
  digest: LearningDigest;
  text: string;
  delivered: boolean;
  /** Why the message was not sent, when it was not. */
  skipped?: string;
}

/**
 * Compose the week, record it for Home, and send it to Telegram unless there
 * is nothing to say. A failed send is reported, not thrown: the Home card is
 * the digest's record and is already written.
 */
export async function runLearningDigest(deps: {
  pool: Pool;
  now: Date;
  manifests: readonly PluginManifest[];
  proposalsUrl: string;
  deliver: (text: string) => Promise<unknown>;
}): Promise<DigestRunResult> {
  const digest = await composeDigest(deps.pool, { now: deps.now, manifests: deps.manifests });
  const text = digestText(digest, deps.proposalsUrl);
  let delivered = false;
  let skipped: string | undefined;
  if (quietDigest(digest)) {
    skipped = 'nothing learned and nothing waiting';
  } else {
    try {
      await deps.deliver(text);
      delivered = true;
    } catch (err) {
      skipped = `not sent: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  await deps.pool.query(`insert into core.events (kind, payload, created_at) values ($1, $2::jsonb, $3)`, [
    LEARNING_DIGEST_EVENT,
    JSON.stringify({ ...digest, delivered, ...(skipped ? { skipped } : {}) }),
    deps.now,
  ]);
  return { digest, text, delivered, ...(skipped ? { skipped } : {}) };
}

/** The latest digest, for the Home card, or null before the first one. */
export async function latestDigest(pool: Pool): Promise<(LearningDigest & { delivered: boolean }) | null> {
  const { rows } = await pool.query(
    `select payload from core.events where kind = $1 order by created_at desc, id desc limit 1`,
    [LEARNING_DIGEST_EVENT],
  );
  const payload = rows[0]?.payload as (LearningDigest & { delivered?: boolean }) | undefined;
  return payload ? { ...payload, delivered: payload.delivered === true } : null;
}
