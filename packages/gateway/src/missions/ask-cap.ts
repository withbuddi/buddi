/**
 * How often an unattended mission may interrupt the owner with a question
 * (docs/browser.md, "Any mission may ask").
 *
 * Every unattended run may call `conversation.ask`, and a stuck watcher that
 * runs every five minutes would otherwise send a card and, an hour later, a
 * "needed you" line, run after run. So:
 *
 *   one open question per mission at a time: a run that asks while an earlier
 *   card of the same mission is still waiting is not parked again;
 *
 *   the same question again within a day, which nobody answered, is not
 *   asked again: it is logged, the run ends without a decision, and Home's
 *   Needs you holds one quiet line ("needed you") — no Telegram;
 *
 *   the timeout line is folded: a mission that timed out on the same question
 *   in the last day does not send a second one.
 *
 * Read from the event log and the question cards; the times are the
 * database's own, like the rows they are compared with.
 */
import { appendEvent, notifyOwner } from '@buddi/core';
import type { Pool } from 'pg';

/** How long a question nobody answered keeps a mission from asking it again. */
export const ASK_REPEAT_HOURS = 24;

/** Why a mission's question was not put to the owner. */
export type AskHeld = 'open' | 'repeat';

/** Whether this mission's question may go out now, or why not. */
export async function askHeldBack(pool: Pick<Pool, 'query'>, missionId: string, question: string): Promise<AskHeld | null> {
  const { rows } = await pool.query<{ open: boolean; repeat: boolean }>(
    `select
       coalesce(bool_or(q.answered_at is null and q.expires_at > now()), false) as open,
       coalesce(bool_or(
         e.created_at > now() - make_interval(hours => $3::int)
         and lower(btrim(q.question)) = lower(btrim($2))
         and (q.answered_at is null or q.answered_via = 'timeout')
       ), false) as repeat
       from core.events e
       join core.questions q on q.id::text = e.payload->>'questionId'
      where e.kind = 'mission.parked'
        and e.payload->>'missionId' = $1
        and e.created_at > now() - make_interval(hours => $3::int)`,
    [missionId, question, ASK_REPEAT_HOURS],
  );
  if (rows[0]?.open) return 'open';
  if (rows[0]?.repeat) return 'repeat';
  return null;
}

/** The same mission timed out on the same question within the last day: its "needed you" line was already sent. */
export async function timedOutRecently(pool: Pick<Pool, 'query'>, missionId: string, question: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1
       from core.events e
       left join core.questions q on q.id::text = e.payload->>'questionId'
      where e.kind = 'mission.needed_you'
        and e.payload->>'missionId' = $1
        and e.created_at > now() - make_interval(hours => $3::int)
        and lower(btrim(coalesce(e.payload->>'question', q.question, ''))) = lower(btrim($2))
      limit 1`,
    [missionId, question, ASK_REPEAT_HOURS],
  );
  return rows.length > 0;
}

/**
 * A question held back: one quiet line on Home's Needs you (stored, never
 * pushed), folded into the open one for this mission, and an event.
 */
export async function noteHeldAsk(
  pool: Pool,
  deps: { now: () => Date; timezone?: string; log: (line: string) => void },
  input: { missionId: string; missionName: string; agentId: string; conversationId: string; question: string; why: AskHeld },
): Promise<void> {
  const line = input.why === 'open'
    ? `It wanted to ask "${input.question.trim().slice(0, 200)}" while its earlier question is still waiting for you, so it did not interrupt you again.`
    : `It asked "${input.question.trim().slice(0, 200)}" again. Nobody answered that in the last day, so it did not interrupt you this time.`;
  deps.log(`mission ${input.missionId}: question held back (${input.why}): "${input.question.slice(0, 120)}"`);
  try {
    await notifyOwner(pool, { now: deps.now, ...(deps.timezone ? { timezone: deps.timezone } : {}), log: deps.log }, {
      kind: 'watcher',
      urgency: 'digest',
      title: `${input.missionName} needed you`,
      text: line,
      action: 'Answer it in the chat?',
      link: { route: `#/chat/${encodeURIComponent(input.agentId)}/${encodeURIComponent(input.conversationId)}` },
      agentId: input.agentId,
      dedupeKey: `mission-needed-you:${input.missionId}`,
    });
  } catch (err) {
    deps.log(`mission ${input.missionId}: could not note the held-back question: ${err instanceof Error ? err.message : String(err)}`);
  }
  await appendEvent(pool, 'mission.ask_held', { missionId: input.missionId, agentId: input.agentId, why: input.why }, input.conversationId);
}
