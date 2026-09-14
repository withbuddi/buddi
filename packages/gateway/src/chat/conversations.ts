/**
 * Recent conversations, for `/resume`.
 *
 * A conversation id is a uuid nobody remembers, so the picker shows what the
 * owner actually recognizes: when it was, how long it ran, and the first thing
 * they said in it. Read-only — the session decides which one to continue.
 */
import type { Queryable } from '@buddi/core';

export interface ConversationLine {
  id: string;
  createdAt: Date | null;
  lastMessageAt: Date | null;
  messages: number;
  /** The opening user turn, one line, truncated. Empty when there is none. */
  preview: string;
}

export const PREVIEW_CHARS = 72;

/** The first text block of a stored message, whatever shape the driver returns. */
export function firstText(content: unknown): string {
  const value = typeof content === 'string' ? safeParse(content) : content;
  if (!Array.isArray(value)) return '';
  for (const block of value) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = String((block as { text?: unknown }).text ?? '').trim();
      if (text !== '') return text;
    }
  }
  return '';
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

/** One line, collapsed and cut to `PREVIEW_CHARS`. */
export function previewOf(content: unknown): string {
  const text = firstText(content).replace(/\s+/g, ' ').trim();
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS - 1)}…`;
}

/**
 * The agent's most recent conversations, newest first.
 *
 * Empty conversations are included: `buddi chat` creates one on start, and a
 * session the owner opened and closed without typing is still the one they may
 * mean by "the last one".
 */
export async function listRecentConversations(
  pool: Queryable,
  agentId: string,
  limit = 10,
): Promise<ConversationLine[]> {
  const { rows } = await pool.query(
    `select c.id,
            c.created_at,
            (select max(m.created_at) from core.messages m where m.conversation_id = c.id) as last_at,
            (select count(*) from core.messages m where m.conversation_id = c.id) as message_count,
            (select m.content from core.messages m
               where m.conversation_id = c.id and m.role = 'user'
               order by m.created_at asc, m.id asc
               limit 1) as first_user
       from core.conversations c
      where c.agent_id = $1
      order by c.created_at desc, c.id desc
      limit $2`,
    [agentId, Math.max(1, Math.trunc(limit))],
  );
  return rows.map((r) => ({
    id: String(r.id),
    createdAt: r.created_at ? new Date(r.created_at) : null,
    lastMessageAt: r.last_at ? new Date(r.last_at) : null,
    messages: Number(r.message_count ?? 0),
    preview: previewOf(r.first_user),
  }));
}
