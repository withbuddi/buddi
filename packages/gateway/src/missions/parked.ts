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
 *
 * The job is tied to its question before the card goes out, and an answer is
 * written onto the job in the same statement that wakes it: an answer that
 * lands while the worker is still suspending the job is kept there, and the
 * suspension wakes the job when it finds one (`wakeIf`).
 *
 * Take over is a wait of its own: the run parks again, on the page rather
 * than a card (`page:<conversation>`), until the owner gives the page back.
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
  /** Parked on the page the owner took over, until they give it back (no card of its own). */
  handback?: boolean;
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
    ...(p.handback === true ? { handback: true } : {}),
  };
}

/** The question id a run parked on a taken-over page waits under: the page, not a card. */
export function handbackQuestionId(conversationId: string): string {
  return `page:${conversationId}`;
}

/** A real question card's id (a run parked on a page has no card to close). */
export function isCardQuestion(questionId: string): boolean {
  return !questionId.startsWith('page:');
}

/** What the run is told when the owner took the page themselves and gave it back. */
export const GAVE_BACK_ANSWER = 'I took over the page myself and gave it back.';

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
export function neededYouLine(input: { missionName: string; question: string; waitedMs: number; handback?: boolean }): string {
  // A browser card is its title, a newline and a line of why: the title is what was asked.
  const title = (input.question.trim().split('\n')[0] ?? '').trim().replace(/\s+/g, ' ');
  const asked = /[.?!]$/.test(title) ? title : `${title}.`;
  if (input.handback) {
    return `${input.missionName} waited for you to give the page back and stopped: "${asked}" The page was not given back within ${waitWords(input.waitedMs)}, so it ended there. Run it again from Missions when you are done with it.`;
  }
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
    /** The queue job this run is: tied to the question before the card goes out. */
    jobId?: string;
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
  const parked: ParkedRun = { questionId: question.id, conversationId: input.conversationId, question: question.question, until: until.toISOString(), waitMs: input.waitMs };
  // Before anyone can see the card: an answer that comes back at once finds this job.
  if (input.jobId) await tieJob(deps.pool, input.jobId, parked);
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
  return parked;
}

/**
 * Park on the page the owner just took over: no card and no notification (the
 * owner is at the page already). The run waits until the page is given back
 * (`resumeParkedForPage`), or until the parking time runs out.
 */
export async function parkForHandback(
  deps: ParkDeps,
  input: { missionId: string; agentId: string; conversationId: string; question: string; waitMs: number; jobId?: string },
): Promise<ParkedRun> {
  const until = new Date(deps.now().getTime() + input.waitMs);
  const parked: ParkedRun = { questionId: handbackQuestionId(input.conversationId), conversationId: input.conversationId, question: input.question, until: until.toISOString(), waitMs: input.waitMs, handback: true };
  if (input.jobId) await tieJob(deps.pool, input.jobId, parked);
  await appendEvent(deps.pool, 'mission.parked', { missionId: input.missionId, agentId: input.agentId, questionId: parked.questionId, until: parked.until, handback: true }, input.conversationId);
  return parked;
}

/** Write what the run waits on onto its (still leased) job, with no answer yet. */
async function tieJob(pool: Pool, jobId: string, parked: ParkedRun): Promise<void> {
  await pool.query(
    `update core.jobs
        set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('parked', $2::jsonb, 'answer', null),
            updated_at = now()
      where id = $1::uuid and state = 'leased'`,
    [jobId, JSON.stringify(parked)],
  );
}

/**
 * Hand an answer to the job parked on `questionId`, in one statement: a job
 * already suspended is woken with it; a job still being suspended (its worker
 * has not landed the suspension yet) keeps it in its payload, and the
 * suspension wakes it (`wakeIf`). An answer already given is never replaced.
 * Returns the job's id, or null when no run waits on this question.
 */
async function answerParkedJob(pool: Pool, questionId: string, answer: ParkedAnswer): Promise<string | null> {
  const { rows } = await pool.query<{ id: string; state: string; kind: string; conversation_id: string | null }>(
    `update core.jobs
        set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('answer', $2::jsonb),
            state = case when state = 'suspended' then 'pending' else state end,
            suspended_reason = case when state = 'suspended' then null else suspended_reason end,
            run_after = case when state = 'suspended' then now() else run_after end,
            attempts = case when state = 'suspended' and attempts > 0 then attempts - 1 else attempts end,
            updated_at = now()
      where payload->'parked'->>'questionId' = $1
        and ((state = 'suspended' and suspended_reason = $3) or state = 'leased')
        and coalesce(payload->'answer'->>'questionId', '') <> $1
      returning id, state, kind, conversation_id`,
    [questionId, JSON.stringify(answer), `${PARKED_REASON_PREFIX}${questionId}`],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.state === 'pending') {
    await appendEvent(pool, 'job.resumed', { jobId: row.id, kind: row.kind, patched: ['answer'] }, row.conversation_id ?? undefined).catch(() => undefined);
  }
  return row.id;
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
  const answer: ParkedAnswer = { questionId: question.id, text: question.answer ?? answerText ?? '' };
  if (!(await answerParkedJob(pool, question.id, answer))) return false;
  // The face and Home stop saying "Asked you a question".
  await appendEvent(pool, QUESTION_CLEARED, { agentId: question.agentId }, question.conversationId).catch(() => undefined);
  return true;
}

/**
 * The owner gave back a page in this conversation. A mission run waiting on
 * it carries on: one parked on the page after Take over, or one still parked
 * on its card (the owner took the page from the Canvas rather than the card;
 * that card is closed). `true` when a run was woken.
 */
export async function resumeParkedForPage(pool: Pool, conversationId: string, now: Date): Promise<boolean> {
  const handback = handbackQuestionId(conversationId);
  if (await answerParkedJob(pool, handback, { questionId: handback, text: GAVE_BACK_ANSWER })) return true;
  const { rows } = await pool.query<{ question_id: string }>(
    `select payload->'parked'->>'questionId' as question_id
       from core.jobs
      where payload->'parked'->>'conversationId' = $1
        and ((state = 'suspended' and suspended_reason like $2) or state = 'leased')
        and coalesce(payload->'answer'->>'questionId', '') <> coalesce(payload->'parked'->>'questionId', '')
      order by updated_at desc limit 1`,
    [conversationId, `${PARKED_REASON_PREFIX}%`],
  );
  const questionId = rows[0]?.question_id;
  if (!questionId) return false;
  if (!(await answerParkedJob(pool, questionId, { questionId, text: GAVE_BACK_ANSWER }))) return false;
  if (isCardQuestion(questionId)) {
    const closed = await pool.query<{ agent_id: string }>(
      `update core.questions set answered_at = $2, answered_via = 'browser', answer = $3
        where id = $1::uuid and answered_at is null returning agent_id`,
      [questionId, now, GAVE_BACK_ANSWER],
    ).catch(() => ({ rows: [] as Array<{ agent_id: string }> }));
    if (closed.rows[0]) await appendEvent(pool, QUESTION_CLEARED, { agentId: closed.rows[0].agent_id }, conversationId).catch(() => undefined);
  }
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
    if (row.question_id && isCardQuestion(row.question_id)) await closeQuestion(pool, { id: row.question_id, via: 'timeout', now }).catch(() => false);
    const answer: ParkedAnswer = { questionId: row.question_id, timedOut: true };
    if (await resumeJob(pool, row.id, { payloadPatch: { answer } })) woken++;
  }
  return woken;
}
