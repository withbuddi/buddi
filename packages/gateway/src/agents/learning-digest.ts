/**
 * The weekly learning digest (docs/learning.md §5).
 *
 * Once a week, one message on Telegram and a card on Home, in the owner's
 * words (`digestSummary`): what buddi remembered, the rules and skills kept
 * (counts, with a place to look — never raw rule names), the suggestions
 * waiting, and how often kept rules stepped in, from the plugins that count it.
 * A kind with nothing in it is left out rather than said as "nothing".
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
  feedbackWeek,
  getActiveSchedule,
  getMission,
  nextAfter,
  readLearningWeek,
  setSchedule,
  upsertMission,
  type FeedbackWeek,
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
      timezoneExplicit: false,
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
  if (spec && spec.cron === cron && spec.timezone === timezone && !spec.timezoneExplicit) return;
  await setSchedule(pool, LEARNING_DIGEST_ID, { cron, timezone, timezoneExplicit: false, misfirePolicy: 'coalesce' });
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
  /**
   * The owner's standing reactions this week (Telegram 👍/👎), per agent, and
   * up to five 👎 notes ("what was off?"). Absent on digests written before
   * reactions were read.
   */
  feedback?: FeedbackWeek;
  /** The agents the reactions name, by id, as the owner knows them ("Ledger"). */
  agentNames?: Record<string, string>;
}

/** An agent as the digest names it: its display name, else its id. */
function agentName(d: Pick<LearningDigest, 'agentNames'>, id: string): string {
  return d.agentNames?.[id] ?? id;
}

/** True when there is nothing to tell: nothing learned and nothing waiting. */
export function quietDigest(d: LearningDigest): boolean {
  return d.memory.count + d.skills.count + d.rules.count + d.changes.count === 0 && d.open === 0
    && Object.keys(d.feedback?.byAgent ?? {}).length === 0;
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
  input: { now: Date; manifests: readonly PluginManifest[]; nameOf?: ((agentId: string) => string | undefined) | undefined },
): Promise<LearningDigest> {
  const since = new Date(input.now.getTime() - WEEK_MS);
  const [week, memory, feedback] = await Promise.all([
    readLearningWeek(pool, { since }),
    memoryWeek(pool, since),
    feedbackWeek(pool, { since }),
  ]);
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
  // Names as of this week, kept with the digest so Home reads them too.
  const agentNames: Record<string, string> = {};
  for (const id of new Set([...Object.keys(feedback.byAgent), ...feedback.notes.map((n) => n.agentId)])) {
    const name = input.nameOf?.(id);
    if (name) agentNames[id] = name;
  }
  return {
    at: input.now.toISOString(),
    since: since.toISOString(),
    memory,
    skills: kept('skill'),
    rules: kept('policy'),
    changes: kept('change'),
    open: week.open,
    stopped,
    feedback,
    ...(Object.keys(agentNames).length > 0 ? { agentNames } : {}),
  };
}

/** One line of the digest, in the owner's words, with at most one place to go. */
export interface DigestLine {
  /** Stable per kind: memory, rules, skills, changes, open, handled. */
  key: string;
  text: string;
  link?: { label: string; route: string };
}

/** Where the Home card's links go: dashboard routes, never a plugin's own page. */
export const DIGEST_ROUTES = {
  memory: '#/settings/memory',
  proposals: '#/settings/proposals',
} as const;

/** Actions that only make mail (or anything) quieter: "Quieted N senders". */
const QUIET_ACTIONS = new Set(['ignore', 'archive', 'mute']);

function counted(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "A, B and C", or "A, B and 4 more" when there were more than named. */
function namesList(names: readonly string[], count: number): string {
  const shown = names.map((n) => n.trim()).filter((n) => n !== '' && !n.endsWith('…'));
  if (shown.length === 0) return '';
  const more = count - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * The digest as a person would say it: one line per kind with a count and one
 * place to look, never a list of raw rule names or a note cut mid-sentence.
 * A kind with nothing in it has no line; "nothing was waiting" is not news.
 */
export function digestSummary(d: LearningDigest): DigestLine[] {
  const lines: DigestLine[] = [];
  if (d.memory.count > 0) {
    lines.push({ key: 'memory', text: `Remembered ${counted(d.memory.count, 'thing')}`, link: { label: 'See memory', route: DIGEST_ROUTES.memory } });
  }
  if (d.rules.count > 0) {
    const actions = d.rules.actions ?? {};
    const plugins = Object.keys(d.rules.plugins ?? {});
    const quiet = Object.keys(actions).length > 0 && Object.keys(actions).every((a) => QUIET_ACTIONS.has(a));
    const route = plugins.length === 1 ? `${DIGEST_ROUTES.proposals}?plugin=${encodeURIComponent(plugins[0]!)}` : DIGEST_ROUTES.proposals;
    lines.push({
      key: 'rules',
      text: quiet ? `Quieted ${counted(d.rules.count, 'sender')}` : `Kept ${counted(d.rules.count, 'new rule')}`,
      link: { label: 'See rules', route },
    });
  }
  if (d.skills.count > 0) {
    const names = namesList(d.skills.names, d.skills.count);
    lines.push({ key: 'skills', text: `Kept ${counted(d.skills.count, 'skill')}${names ? `: ${names}` : ''}` });
  }
  if (d.changes.count > 0) {
    lines.push({
      key: 'changes',
      text: `Changed how your agents work ${d.changes.count === 1 ? 'once' : `${d.changes.count} times`}`,
      link: { label: 'See what changed', route: DIGEST_ROUTES.proposals },
    });
  }
  if (d.open > 0) {
    lines.push({
      key: 'open',
      text: `${counted(d.open, 'suggestion')} ${d.open === 1 ? 'waits' : 'wait'} for you`,
      link: { label: 'Review', route: DIGEST_ROUTES.proposals },
    });
  }
  if (d.stopped && d.stopped.total > 0) {
    const acting = Object.entries(d.stopped.byPlugin).filter(([, n]) => n > 0).map(([plugin]) => plugin);
    const mailOnly = acting.length === 1 && acting[0] === 'email';
    lines.push({
      key: 'handled',
      text: mailOnly ? `Your rules handled ${counted(d.stopped.total, 'email')}` : `Your rules stepped in ${d.stopped.total === 1 ? 'once' : `${d.stopped.total} times`}`,
    });
  }
  return lines;
}

/**
 * The digest as one plain-text message: no markdown, since Telegram shows the
 * characters, and no question, since nobody answers a digest. The same lines
 * as the Home card, with the suggestions' link spelled out.
 */
export function digestText(d: LearningDigest, proposalsUrl: string): string {
  const lines = ['What buddi learned this week.'];
  const summary = digestSummary(d);
  if (summary.length === 0) lines.push('Nothing new this week.');
  for (const line of summary) lines.push(line.key === 'open' ? `${line.text}: ${proposalsUrl}` : `${line.text}.`);
  lines.push(...feedbackLines(d));
  return lines.join('\n');
}

/** "Your reactions: …" and the 👎 notes, or nothing when there were none. */
function feedbackLines(d: Pick<LearningDigest, 'feedback' | 'agentNames'>): string[] {
  const f = d.feedback;
  if (!f) return [];
  const agents = Object.entries(f.byAgent)
    .map(([agent, t]) => {
      const parts = [t.up > 0 ? `${t.up} 👍` : null, t.down > 0 ? `${t.down} 👎` : null, t.neutral > 0 ? `${t.neutral} other` : null]
        .filter((p): p is string => p !== null);
      return parts.length > 0 ? `${agentName(d, agent)} ${parts.join(' ')}` : null;
    })
    .filter((p): p is string => p !== null);
  if (agents.length === 0) return [];
  const lines = [`Your reactions: ${agents.join(', ')}.`];
  for (const n of f.notes) lines.push(`What was off (${agentName(d, n.agentId)}): ${clip(n.note, 140)}`);
  return lines;
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
  nameOf?: ((agentId: string) => string | undefined) | undefined;
}): Promise<DigestRunResult> {
  const digest = await composeDigest(deps.pool, { now: deps.now, manifests: deps.manifests, nameOf: deps.nameOf });
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
export async function latestDigest(pool: Pool): Promise<(LearningDigest & { delivered: boolean; summary: DigestLine[] }) | null> {
  const { rows } = await pool.query(
    `select payload from core.events where kind = $1 order by created_at desc, id desc limit 1`,
    [LEARNING_DIGEST_EVENT],
  );
  const payload = rows[0]?.payload as (LearningDigest & { delivered?: boolean }) | undefined;
  return payload ? { ...payload, delivered: payload.delivered === true, summary: digestSummary(payload) } : null;
}
