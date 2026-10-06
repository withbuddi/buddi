/**
 * The canvas's tabs, per conversation (docs/dashboard.md, "Canvas").
 *
 * What the owner put away and when each tab was last looked at, so the strip
 * comes back the same — same tabs, same order — after a reload or on another
 * device. Kept in `core.web_settings` under `canvas-tabs:<conversationId>`:
 * one small value per conversation, owned here, replaced whole on each write.
 */
import { CANVAS_TABS_PREFIX, readWebSetting, type Queryable } from '@buddi/core';

/**
 * The `core.web_settings` key for one conversation. Deleting a conversation
 * deletes it too (core's `forgetConversationSettings`).
 */
export function canvasTabsKey(conversationId: string): string {
  return `${CANVAS_TABS_PREFIX}${conversationId}`;
}

/** How many ids either half keeps; a long conversation drops its oldest. */
export const CANVAS_TABS_LIMIT = 200;

export interface CanvasTabsState {
  /** Tab stamps the owner closed (the call id of the version that was on screen). */
  closed: string[];
  /** When each tab was last looked at, epoch ms, by tab id. The strip's order. */
  touched: Record<string, number>;
}

const ID = /^[\w:./-]{1,200}$/;

/** A body checked into the stored shape, or the reason it is not one. */
export function parseCanvasTabs(body: unknown): { ok: true; value: CanvasTabsState } | { ok: false; error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be an object' };
  const record = body as Record<string, unknown>;
  const closed = record['closed'] ?? [];
  const touched = record['touched'] ?? {};
  if (!Array.isArray(closed) || !closed.every((id) => typeof id === 'string' && ID.test(id))) {
    return { ok: false, error: '`closed` must be an array of tab ids' };
  }
  if (touched === null || typeof touched !== 'object' || Array.isArray(touched)) {
    return { ok: false, error: '`touched` must be an object' };
  }
  const entries = Object.entries(touched as Record<string, unknown>);
  if (!entries.every(([id, at]) => ID.test(id) && typeof at === 'number' && Number.isFinite(at) && at >= 0)) {
    return { ok: false, error: '`touched` must map tab ids to times' };
  }
  return {
    ok: true,
    value: {
      closed: [...new Set(closed as string[])].slice(-CANVAS_TABS_LIMIT),
      touched: Object.fromEntries((entries as Array<[string, number]>).sort((a, b) => a[1] - b[1]).slice(-CANVAS_TABS_LIMIT)),
    },
  };
}

/**
 * The stored state, or an empty one: nothing stored is nothing closed. Null
 * when there is no such conversation.
 */
export async function readCanvasTabs(db: Queryable, conversationId: string): Promise<CanvasTabsState | null> {
  const { rows } = await db.query('select 1 from core.conversations where id = $1::uuid', [conversationId]);
  if (rows.length === 0) return null;
  const stored = await readWebSetting<unknown>(db, canvasTabsKey(conversationId));
  const parsed = parseCanvasTabs(stored ?? {});
  return parsed.ok ? parsed.value : { closed: [], touched: {} };
}

/**
 * Replace the conversation's state with an already-parsed one. False, and
 * nothing written, when there is no such conversation.
 */
export async function writeCanvasTabs(db: Queryable, conversationId: string, state: CanvasTabsState): Promise<boolean> {
  const { rows } = await db.query(
    `insert into core.web_settings (key, value, updated_at)
     select $1, $2::jsonb, now() where exists (select 1 from core.conversations where id = $3::uuid)
     on conflict (key) do update set value = excluded.value, updated_at = now()
     returning key`,
    [canvasTabsKey(conversationId), JSON.stringify(state), conversationId],
  );
  return rows.length > 0;
}
