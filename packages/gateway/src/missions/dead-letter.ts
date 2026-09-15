/**
 * Telling the owner that work they were relying on did not happen.
 *
 * The mail agent's whole contract is that silence means "nothing worth your
 * attention". On the evening of 14 September a network blip killed twelve
 * triage runs; nothing anywhere in the installation surfaced a dead job, so the
 * silence stood, and the owner found out by noticing a client mail he had
 * expected to hear about. A dead job turns the default into a lie, and that is
 * the defect this module exists to close.
 *
 * ## What counts
 *
 * Not "a job errored" — errors are ordinary and the queue retries them. The
 * signal is a job of an **unattended kind** that has reached `failed`: it will
 * not be tried again, and nobody was watching. Whether it ran out of attempts
 * or died at once on a permanent error does not matter to the owner; in both
 * cases the work is not going to happen.
 *
 * ## One message, not twelve
 *
 * An outage kills jobs in a wave, and a wave must arrive as one message.
 *
 *  - Deaths are collected into an **incident**. A death joins the open incident
 *    while it lands within `DEAD_LETTER_INCIDENT_GAP_MS` of the last one; after
 *    that long a quiet, the next death is a new outage and deserves its own
 *    message.
 *  - The incident is reported once, `DEAD_LETTER_WINDOW_MS` after its *first*
 *    death — a fixed aggregation window, not a wait for quiet. Waiting for
 *    quiet would mean an outage that never clears is never reported, which is
 *    the failure mode we are here to fix; a fixed window bounds the delay and
 *    still folds the opening burst into one count.
 *  - After that, silence for the rest of the incident. The message says so, and
 *    says where the full extent is visible, because a second message about the
 *    same outage is exactly the noise that teaches an owner to stop reading
 *    (`private/skills/quiet-by-default.md`).
 *
 * The bookkeeping lives in `core.system_flags`, so a restart mid-incident does
 * not re-announce an outage the owner already heard about.
 */
import {
  appendEvent,
  getFlag,
  listDeadJobs,
  localDateTimeString,
  setFlag,
  UNATTENDED_JOB_KINDS,
  type Job,
} from '@buddi/core';
import type { Pool } from 'pg';
import { OwnerNotPairedError } from '../telegram/notify.js';

/** Where the watch keeps its place across restarts. */
export const DEAD_LETTER_FLAG = 'deadletter.watch';

/** How long the opening burst of an outage is folded before it is reported. */
export const DEAD_LETTER_WINDOW_MS = 15 * 60_000;

/** A quiet of this length ends an incident; the next death starts a new one. */
export const DEAD_LETTER_INCIDENT_GAP_MS = 6 * 60 * 60_000;

/**
 * On a first ever run, only deaths this recent are announced. Older ones are
 * history: an installation that upgrades should not be told about every job
 * that ever failed, and a day is long enough to catch last night's outage.
 */
export const DEAD_LETTER_FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60_000;

/** How many dead jobs one message is allowed to read before it stops counting. */
export const DEAD_LETTER_MAX_WAVE = 500;

/** The watch's durable place. */
export interface DeadLetterState {
  /** Deaths at or before this instant have already been folded in. */
  watermark: string;
  incident?: {
    firstDeathAt: string;
    lastDeathAt: string;
    reported: boolean;
  };
}

export interface DeadLetterTickResult {
  /** Deaths folded into an incident this pass. */
  collected: number;
  /** The message that was delivered, when one was. */
  reported?: string;
  /** Why nothing was delivered, when there was something to say. */
  skipped?: string;
}

/** What the owner is told a kind of dead work means, in their own terms. */
interface WorkDescription {
  /** Groups jobs that are the same kind of loss. */
  key: string;
  /** First line: what is not happening. */
  headline: string;
  /** What the individual pieces of work are, plural. */
  noun: string;
  /** What did not happen to them. */
  outcome: string;
}

function agentIdOf(job: Job): string | undefined {
  const payload = job.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const id = (payload as Record<string, unknown>).agentId;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
}

/**
 * Plain words for a dead job. No job ids, no kinds, no tool names: the owner
 * cares that mail went unread, not that a row reached state `failed`.
 */
export function describeWork(job: Job): WorkDescription {
  const agentId = agentIdOf(job);
  if (agentId === 'mail-triage') {
    return {
      key: 'mail',
      headline: 'Mail is not being read.',
      noun: 'emails',
      outcome: 'were never looked at',
    };
  }
  if (agentId !== undefined) {
    return {
      key: `agent:${agentId}`,
      headline: `Work you rely on ${agentId} for is not running.`,
      noun: 'runs',
      outcome: 'never finished',
    };
  }
  return {
    key: `kind:${job.kind}`,
    headline: 'Scheduled work did not run.',
    noun: 'runs',
    outcome: 'never finished',
  };
}

/** The first line of a job's error, which is the part that identifies it. */
function errorLine(job: Job): string {
  const raw = (job.lastError ?? '').split('\n')[0]?.trim() ?? '';
  return raw === '' ? 'no reason was recorded' : raw;
}

/** The error most of the wave shares. A wave usually has exactly one cause. */
function commonError(jobs: readonly Job[]): { text: string; shared: boolean } {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const line = errorLine(job);
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [line, n] of counts) {
    if (n > bestCount) {
      best = line;
      bestCount = n;
    }
  }
  return { text: best, shared: counts.size === 1 };
}

/** `2026-09-14 13:21 EDT`, and just `13:34` for the end of the same day. */
function window(jobs: readonly Job[], timezone: string): string {
  const times = jobs.map((j) => j.createdAt.getTime()).sort((a, b) => a - b);
  const from = new Date(times[0] as number);
  const to = new Date(times[times.length - 1] as number);
  const fromText = localDateTimeString(from, timezone);
  if (from.getTime() === to.getTime()) return `at ${fromText}`;
  const toText = localDateTimeString(to, timezone);
  const sameDay = fromText.slice(0, 10) === toText.slice(0, 10);
  return `between ${fromText} and ${sameDay ? toText.slice(11, 16) : toText}`;
}

/**
 * The message itself. Plain text, no markdown — it arrives as a notification —
 * and it leads with what is not happening rather than with a count of rows.
 */
export function formatDeadLetterMessage(
  jobs: readonly Job[],
  opts: { timezone: string },
): string {
  if (jobs.length === 0) throw new Error('formatDeadLetterMessage: nothing to report');

  const groups = new Map<string, { description: WorkDescription; jobs: Job[] }>();
  for (const job of jobs) {
    const description = describeWork(job);
    const group = groups.get(description.key);
    if (group) group.jobs.push(job);
    else groups.set(description.key, { description, jobs: [job] });
  }
  const ordered = [...groups.values()].sort((a, b) => b.jobs.length - a.jobs.length);
  const lead = ordered[0] as { description: WorkDescription; jobs: Job[] };
  const error = commonError(jobs);

  const lines: string[] = [lead.description.headline];

  const count = (n: number, noun: string): string => `${n} ${n === 1 ? noun.replace(/s$/, '') : noun}`;
  const cause = error.shared
    ? `every attempt failed the same way: ${error.text}`
    : `most of them failed the same way: ${error.text}`;
  lines.push(
    `${count(lead.jobs.length, lead.description.noun)} ${window(lead.jobs, opts.timezone)} ` +
      `${lead.description.outcome}, and nothing is still trying — ${cause}.`,
  );

  for (const group of ordered.slice(1, 3)) {
    lines.push(
      `Also ${count(group.jobs.length, group.description.noun)} ${window(group.jobs, opts.timezone)}: ` +
        `${group.description.headline.toLowerCase()}`,
    );
  }

  lines.push('Nothing more will be sent about this outage.');
  lines.push('To see what was lost: buddi jobs --state failed');
  lines.push('To run it all again: buddi jobs retry --all');
  return lines.join('\n');
}

export interface DeadLetterWatchDeps {
  pool: Pool;
  /** How the owner is reached. The same path a mission report takes. */
  deliver: (text: string) => Promise<string>;
  now: () => Date;
  timezone: string;
  /** Kinds that count as unattended. Defaults to core's list. */
  kinds?: readonly string[];
  log?: (line: string) => void;
}

function readState(value: unknown): DeadLetterState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.watermark !== 'string' || Number.isNaN(Date.parse(v.watermark))) return null;
  const incident =
    typeof v.incident === 'object' && v.incident !== null
      ? (v.incident as Record<string, unknown>)
      : null;
  return {
    watermark: v.watermark,
    ...(incident &&
    typeof incident.firstDeathAt === 'string' &&
    typeof incident.lastDeathAt === 'string'
      ? {
          incident: {
            firstDeathAt: incident.firstDeathAt,
            lastDeathAt: incident.lastDeathAt,
            reported: incident.reported === true,
          },
        }
      : {}),
  };
}

/**
 * One pass of the watch. Safe to call on a timer; it holds nothing between
 * calls and never throws for a delivery problem.
 */
export function createDeadLetterWatch(
  deps: DeadLetterWatchDeps,
): () => Promise<DeadLetterTickResult> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const kinds = deps.kinds ?? UNATTENDED_JOB_KINDS;

  return async function tick(): Promise<DeadLetterTickResult> {
    const now = deps.now();
    const stored = readState(await getFlag(deps.pool, DEAD_LETTER_FLAG));
    const state: DeadLetterState = stored ?? {
      watermark: new Date(now.getTime() - DEAD_LETTER_FIRST_RUN_LOOKBACK_MS).toISOString(),
    };

    const deaths = await listDeadJobs(deps.pool, {
      kinds,
      after: new Date(state.watermark),
      until: now,
      limit: DEAD_LETTER_MAX_WAVE,
    });

    let incident = state.incident;
    if (deaths.length > 0) {
      const first = deaths[0]?.updatedAt as Date;
      const last = deaths[deaths.length - 1]?.updatedAt as Date;
      const continues =
        incident !== undefined &&
        first.getTime() - Date.parse(incident.lastDeathAt) <= DEAD_LETTER_INCIDENT_GAP_MS;
      incident = continues
        ? { ...(incident as NonNullable<typeof incident>), lastDeathAt: last.toISOString() }
        : { firstDeathAt: first.toISOString(), lastDeathAt: last.toISOString(), reported: false };
      state.watermark = last.toISOString();
    }

    // A reported incident that has been quiet long enough is over. Forgetting
    // it is what lets the next outage be announced instead of swallowed.
    if (
      incident?.reported === true &&
      now.getTime() - Date.parse(incident.lastDeathAt) > DEAD_LETTER_INCIDENT_GAP_MS
    ) {
      incident = undefined;
    }

    const due =
      incident !== undefined &&
      !incident.reported &&
      now.getTime() - Date.parse(incident.firstDeathAt) >= DEAD_LETTER_WINDOW_MS;

    // Persist before delivering: if the send fails, the deaths are still
    // accounted for and the next pass retries the one message, rather than
    // rediscovering the same wave and sending two.
    state.incident = incident;
    await setFlag(deps.pool, DEAD_LETTER_FLAG, state);

    if (!due || incident === undefined) return { collected: deaths.length };

    const wave = await listDeadJobs(deps.pool, {
      kinds,
      after: new Date(Date.parse(incident.firstDeathAt) - 1),
      until: now,
      limit: DEAD_LETTER_MAX_WAVE,
    });
    if (wave.length === 0) return { collected: deaths.length };

    const text = formatDeadLetterMessage(wave, { timezone: deps.timezone });
    let delivered = true;
    try {
      await deps.deliver(text);
    } catch (err) {
      if (err instanceof OwnerNotPairedError) {
        // Nowhere to send. Do not keep trying every minute for ever: the count
        // is still in `buddi doctor`, which is the surface an unpaired
        // installation has.
        delivered = false;
        log(`dead-letter: ${wave.length} job(s) died and there is no paired chat to tell`);
      } else {
        log(
          `dead-letter: could not deliver the report: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return { collected: deaths.length, skipped: 'delivery failed' };
      }
    }

    state.incident = { ...incident, reported: true };
    await setFlag(deps.pool, DEAD_LETTER_FLAG, state);
    await appendEvent(deps.pool, 'queue.dead_letter_reported', {
      jobs: wave.length,
      kinds: [...new Set(wave.map((j) => j.kind))],
      from: incident.firstDeathAt,
      to: incident.lastDeathAt,
      delivered,
    });

    return delivered
      ? { collected: deaths.length, reported: text }
      : { collected: deaths.length, skipped: 'no paired chat' };
  };
}
