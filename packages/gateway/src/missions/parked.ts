/**
 * A mission run parked on the owner (docs/browser.md, "Missions").
 *
 * A mission that opted in (`browser: own`) looks at pages in buddi's own
 * browser while nobody is there. Four moments in that browser need a person —
 * Look? (a click that may not have landed), Keep going? (the task's steps or
 * hour are spent), Sign in, Human check — and on an interactive surface each
 * is a question card in the chat. In a mission there is no chat to hold it,
 * so the card becomes an owner notification with an action and the run parks:
 *
 *   the card       the same question card `conversation.ask` records
 *                  (`core.questions`), open for the parking time, in the
 *                  mission's own conversation;
 *   the reach      a `question` notification (always reaches, even in a
 *                  focus), drawn with the card's buttons on Telegram and
 *                  held on Home / Needs you as "Asked you a question";
 *   the run        a suspended job (`awaiting-owner:<question id>`), holding
 *                  no worker, no transaction and no model call.
 *
 * The answer, from any of those places, resumes the job in the same
 * conversation with the owner's words as its next turn. No answer within the
 * parking time (an hour by default, `missionWaitMinutes` in the browser's
 * settings) and the run ends as "needed you" with one report line — never
 * silently.
 */
import {
  askQuestion,
  appendEvent,
  closeQuestion,
  notifyOwner,
  questionKey,
  resumeJob,
  type Question,
  type QuestionOption,
} from '@buddi/core';
import type { Pool } from 'pg';
import { QUESTION_ASKED, QUESTION_CLEARED } from '../web/attention.js';

/** The suspended reason a parked mission job carries. */
export const PARKED_REASON_PREFIX = 'awaiting-owner:';

/** The parking time when the browser has no setting to read. */
export const DEFAULT_MISSION_WAIT_MS = 60 * 60_000;

/** What a parked job writes on itself, and reads back when it resumes. */
export interface ParkedRun {
  questionId: string;
  conversationId: string;
  question: string;
  /** When it stops waiting (ISO). */
  until: string;
  /** How long it waits, for the report line. */
  waitMs: number;
}

/** What the owner's answer, or the clock, merges into the payload. */
export interface ParkedAnswer {
  questionId: string;
  /** The option's label, or the owner's own words. */
  text?: string;
  /** Nobody answered within the parking time. */
  timedOut?: boolean;
}

export function parkedRunOf(value: unknown): ParkedRun | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.questionId !== 'string' || typeof p.conversationId !== 'string' || typeof p.until !== 'string') return null;
  return {
    questionId: p.questionId,
    conversationId: p.conversationId,
    question: typeof p.question === 'string' ? p.question : '',
    until: p.until,
    waitMs: typeof p.waitMs === 'number' && p.waitMs > 0 ? p.waitMs : DEFAULT_MISSION_WAIT_MS,
  };
}

export function parkedAnswerOf(value: unknown): ParkedAnswer | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.questionId !== 'string') return null;
  return {
    questionId: p.questionId,
    ...(typeof p.text === 'string' ? { text: p.text } : {}),
    ...(p.timedOut === true ? { timedOut: true } : {}),
  };
}

/** "an hour", "45 minutes": how long it waited, in the report line. */
export function waitWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? 'an hour' : `${hours} hours`;
  }
  return `${minutes} minutes`;
}

/** The one line a run that waited in vain delivers. */
export function neededYouLine(input: { missionName: string; question: string; waitedMs: number }): string {
  // A browser card is its title, a newline and a line of why: the title is what was asked.
  const title = (input.question.trim().split('\n')[0] ?? '').trim().replace(/\s+/g, ' ');
  const asked = /[.?!]$/.test(title) ? title : `${title}.`;
  return `${input.missionName} needed you and stopped: "${asked}" No answer came within ${waitWords(input.waitedMs)}, so it ended there. Run it again from Missions when you can take a look.`;
}

export interface ParkDeps {
  pool: Pool;
  now: () => Date;
  timezone?: string;
  log?: (line: string) => void;
}

/**
 * Put the card in front of the owner and say how the run waits. Returns what
 * the job writes on itself; the caller returns the suspension.
 */
export async function parkMissionRun(
  deps: ParkDeps,
  input: {
    missionId: string;
    missionName: string;
    agentId: string;
    conversationId: string;
    asked: { question: string; options: Array<Omit<QuestionOption, 'id'>>; allowOther: boolean };
    waitMs: number;
  },
): Promise<ParkedRun> {
  const now = deps.now();
  const until = new Date(now.getTime() + input.waitMs);
  // The owner may also say it in their own words ("take over", "skip it"): the browser reads answers loosely.
  const question = await askQuestion(deps.pool, {
    agentId: input.agentId,
    conversationId: input.conversationId,
    question: input.asked.question,
    options: input.asked.options,
    allowOther: true,
    now,
    ttlMs: input.waitMs,
  });
  // Home / Needs you and the agent's face: "Asked you a question", for the parking time rather than fifteen minutes.
  await appendEvent(
    deps.pool,
    QUESTION_ASKED,
    { agentId: input.agentId, questionId: question.id, missionId: input.missionId, until: until.toISOString() },
    input.conversationId,
  );
  try {
    await notifyOwner(deps.pool, { now: deps.now, ...(deps.timezone ? { timezone: deps.timezone } : {}), ...(deps.log ? { log: deps.log } : {}) }, {
      kind: 'question',
      urgency: 'now',
      title: `${input.missionName}: ${question.question}`,
      text: `It is running while you are away, in buddi's own browser, and needs you here. It waits ${waitWords(input.waitMs)}, then stops and tells you.`,
      action: question.question,
      link: { route: `#/chat/${encodeURIComponent(input.agentId)}/${encodeURIComponent(input.conversationId)}` },
      agentId: input.agentId,
      dedupeKey: questionKey(question.id),
    });
  } catch (err) {
    // The card is stored and Home shows it: a channel that failed costs the phone, never the run.
    deps.log?.(`mission ${input.missionId}: could not send the card as a notification: ${err instanceof Error ? err.message : String(err)}`);
  }
  await appendEvent(deps.pool, 'mission.parked', { missionId: input.missionId, agentId: input.agentId, questionId: question.id, until: until.toISOString() }, input.conversationId);
  return { questionId: question.id, conversationId: input.conversationId, question: question.question, until: until.toISOString(), waitMs: input.waitMs };
}

/** The suspended job a question parks, if one does. */
async function parkedJobOf(pool: Pool, questionId: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `select id from core.jobs where state = 'suspended' and suspended_reason = $1 limit 1`,
    [`${PARKED_REASON_PREFIX}${questionId}`],
  );
  return rows[0]?.id ?? null;
}

/**
 * The owner answered a question card. If a parked mission run is waiting on
 * it, wake that run with the answer and say so (`true`): the surface then
 * starts no turn of its own. `false` for every ordinary question.
 */
export async function resumeParkedForQuestion(
  pool: Pool,
  question: Pick<Question, 'id' | 'answer' | 'agentId' | 'conversationId'>,
  answerText?: string,
): Promise<boolean> {
  const jobId = await parkedJobOf(pool, question.id);
  if (!jobId) return false;
  const answer: ParkedAnswer = { questionId: question.id, text: question.answer ?? answerText ?? '' };
  const resumed = await resumeJob(pool, jobId, { payloadPatch: { answer } });
  if (resumed === null) return false;
  // The face and Home stop saying "Asked you a question".
  await appendEvent(pool, QUESTION_CLEARED, { agentId: question.agentId }, question.conversationId).catch(() => undefined);
  return true;
}

/**
 * The clock's half: every parked run whose time is up is closed and woken as
 * timed out; its handler delivers the "needed you" line. Safe to run from two
 * processes: the resume is guarded by the job's state.
 */
export async function expireParkedRuns(pool: Pool, now: Date): Promise<number> {
  const { rows } = await pool.query<{ id: string; question_id: string }>(
    `select id, payload->'parked'->>'questionId' as question_id
       from core.jobs
      where state = 'suspended'
        and suspended_reason like $1
        and payload->'parked'->>'until' is not null
        and (payload->'parked'->>'until')::timestamptz <= $2`,
    [`${PARKED_REASON_PREFIX}%`, now],
  );
  let woken = 0;
  for (const row of rows) {
    if (row.question_id) await closeQuestion(pool, { id: row.question_id, via: 'timeout', now }).catch(() => false);
    const answer: ParkedAnswer = { questionId: row.question_id, timedOut: true };
    if (await resumeJob(pool, row.id, { payloadPatch: { answer } })) woken++;
  }
  return woken;
}
