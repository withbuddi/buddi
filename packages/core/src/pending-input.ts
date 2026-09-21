/**
 * What the owner said while an agent was working, until the run can take it.
 *
 * The table is the queue (migration 032). Everything here is one statement
 * against it, so the two surfaces that queue input — and the recovery that
 * runs at startup — cannot disagree about what a state means:
 *
 *   pending → leased → delivered     the run took it, and it is in a turn
 *   pending → promoted               no run took it; it became a turn of its own
 *   leased  → pending                the step it was leased for never happened
 *
 * Nothing here writes `core.messages`. Where the words end up in the
 * transcript is the runtime's business at its safe point, and the gateway's
 * when a run ends holding something — both of them mark the row afterwards,
 * through `markDelivered` and `promotePendingInput`.
 */
import type { Queryable } from './owner.js';

/** One thing the owner said mid-run, as the queue holds it. */
export interface PendingInputRow {
  id: string;
  conversationId: string;
  runId: string | null;
  text: string;
  /** When the owner said it. Never rewritten. */
  receivedAt: Date;
  state: 'pending' | 'leased' | 'delivered' | 'promoted';
}

function toRow(raw: any): PendingInputRow {
  return {
    id: String(raw.id),
    conversationId: String(raw.conversation_id),
    runId: raw.run_id === null || raw.run_id === undefined ? null : String(raw.run_id),
    text: String(raw.text),
    receivedAt: new Date(raw.received_at),
    state: raw.state,
  };
}

/** Queue one line, before anybody has been told it was accepted. */
export async function queuePendingInput(
  pool: Queryable,
  input: { conversationId: string; runId?: string | null; text: string; now?: Date },
): Promise<PendingInputRow> {
  const { rows } = await pool.query(
    `insert into core.pending_input (conversation_id, run_id, text, received_at)
     values ($1::uuid, $2::uuid, $3, coalesce($4::timestamptz, now()))
     returning id, conversation_id, run_id, text, received_at, state`,
    [input.conversationId, input.runId ?? null, input.text, input.now ?? null],
  );
  return toRow(rows[0]);
}

/**
 * Take everything waiting in this conversation under lease.
 *
 * Leased is not delivered: the caller has undertaken to show it to a model
 * and to say afterwards whether that happened. A crash between the two leaves
 * the row visible as `leased`, which recovery treats exactly like `pending` —
 * the one safe reading, because a line the model never saw is a line the
 * owner is still waiting on.
 */
export async function leasePendingInput(
  pool: Queryable,
  conversationId: string,
  runId?: string | null,
): Promise<PendingInputRow[]> {
  const { rows } = await pool.query(
    `update core.pending_input p
        set state = 'leased', run_id = coalesce($2::uuid, p.run_id)
      where p.id in (
              select id from core.pending_input
               where conversation_id = $1::uuid and state = 'pending'
               order by received_at asc, id asc
                 for update
            )
      returning id, conversation_id, run_id, text, received_at, state`,
    [conversationId, runId ?? null],
  );
  return rows.map(toRow).sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id.localeCompare(b.id));
}

/** The model was shown them, and `messageId` is the turn that carries them. */
export async function markDelivered(
  pool: Queryable,
  ids: readonly string[],
  messageId?: string | null,
): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `update core.pending_input
        set state = 'delivered', delivered_at = now(), message_id = coalesce($2::uuid, message_id)
      where id = any($1::uuid[])`,
    [[...ids], messageId ?? null],
  );
}

/** The step never happened. Back into the queue, in their own order. */
export async function releaseLease(pool: Queryable, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `update core.pending_input set state = 'pending' where id = any($1::uuid[]) and state = 'leased'`,
    [[...ids]],
  );
}

/** Everything still waiting in this conversation, leased or not, oldest first. */
export async function waitingPendingInput(
  pool: Queryable,
  conversationId: string,
): Promise<PendingInputRow[]> {
  const { rows } = await pool.query(
    `select id, conversation_id, run_id, text, received_at, state
       from core.pending_input
      where conversation_id = $1::uuid and state in ('pending', 'leased')
      order by received_at asc, id asc`,
    [conversationId],
  );
  return rows.map(toRow);
}

/** Every conversation with something still waiting in it. */
export async function conversationsWithPendingInput(pool: Queryable): Promise<string[]> {
  const { rows } = await pool.query(
    `select distinct conversation_id from core.pending_input where state in ('pending', 'leased')`,
  );
  return rows.map((r) => String(r.conversation_id));
}

/**
 * Nobody took them: they become one turn of the owner's own.
 *
 * In one transaction, because the two halves are one fact. The canonical row
 * is *new* — the pending rows are never rewritten into messages, and their
 * `received_at` stays what it was — and it is written with the time it became
 * a turn, so the history a run replays ends with the turn it is answering
 * rather than with something from the middle of the last one.
 *
 * Returns null when nothing was waiting, or when the transaction did not
 * land. A caller that gets null must not claim the turn is already stored.
 */
export async function promotePendingInput(
  pool: Queryable & { connect?: () => Promise<any> },
  conversationId: string,
  options: { join?: (texts: readonly string[]) => string } = {},
): Promise<{ messageId: string; text: string; ids: string[] } | null> {
  const join = options.join ?? ((texts) => texts.join('\n\n'));
  const client = pool.connect ? await pool.connect() : null;
  const run = client ?? pool;
  try {
    await run.query('begin');
    const { rows: waiting } = await run.query(
      `select id, text from core.pending_input
        where conversation_id = $1::uuid and state in ('pending', 'leased')
        order by received_at asc, id asc
          for update`,
      [conversationId],
    );
    if (waiting.length === 0) {
      await run.query('rollback');
      return null;
    }
    const text = join(waiting.map((r: any) => String(r.text)));
    const { rows: written } = await run.query(
      `insert into core.messages (conversation_id, role, content)
       values ($1::uuid, 'user', $2::jsonb) returning id`,
      [conversationId, JSON.stringify([{ type: 'text', text }])],
    );
    const messageId = String(written[0].id);
    const ids = waiting.map((r: any) => String(r.id));
    await run.query(
      `update core.pending_input set state = 'promoted', message_id = $2::uuid where id = any($1::uuid[])`,
      [ids, messageId],
    );
    await run.query('commit');
    return { messageId, text, ids };
  } catch (err) {
    await run.query('rollback').catch(() => {});
    throw err;
  } finally {
    client?.release?.();
  }
}
