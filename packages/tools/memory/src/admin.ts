/**
 * The owner's side of memory: everything, across every scope, and the means
 * to correct it.
 *
 * The tools give an agent a keyhole — shared plus its own scope. The owner
 * gets the room. Nothing here bypasses the rules the tools keep: a preference
 * change is still a new revision, a forgotten note is still a soft delete,
 * and a note keeps the provenance it was written with.
 */
import { SHARED, fromAgentScope, toAgentScope, toIso } from './tools/shared.js';

type Db = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };

export interface MemoryPreference {
  key: string;
  value: string;
  /** `'shared'` or an agent id. */
  scope: string;
  revision: number;
  updatedAt: string | null;
}

export interface MemoryNote {
  id: string;
  content: string;
  kind: string;
  scope: string;
  createdAt: string | null;
  expiresAt: string | null;
  createdByAgent: string | null;
  sourceConversationId: string | null;
}

/**
 * Every current preference and every live note, whatever the scope — or, with
 * `agent`, what that agent sees outside a room: the shared set plus its own.
 * The same two scopes the tools read, so an agent's sheet shows exactly what
 * the agent would recall. Filtered here rather than in the page because the
 * note list is capped, and one busy agent must not crowd another off it.
 */
export async function listMemory(
  db: Db,
  now: Date,
  opts: { agent?: string } = {},
): Promise<{ preferences: MemoryPreference[]; notes: MemoryNote[] }> {
  const agent = opts.agent?.trim() || null;
  const [{ rows: prefs }, { rows: notes }] = await Promise.all([
    db.query(
      `select key, value, agent_scope, revision, created_at
         from memory.preferences
        where superseded_at is null
          and ($1::text is null or agent_scope is null or agent_scope = $1)
        order by key asc, agent_scope nulls first`,
      [agent],
    ),
    db.query(
      `select id, content, kind, scope, created_at, expires_at, created_by_agent, source_conversation_id
         from memory.notes
        where deleted_at is null and (expires_at is null or expires_at > $1)
          and ($2::text is null or scope = any(array[$3, $2]::text[]))
        order by created_at desc, seq desc
        limit 500`,
      [now, agent, SHARED],
    ),
  ]);
  return {
    preferences: prefs.map((row) => ({
      key: String(row.key),
      value: String(row.value),
      scope: fromAgentScope(row.agent_scope),
      revision: Number(row.revision),
      updatedAt: toIso(row.created_at),
    })),
    notes: notes.map((row) => ({
      id: String(row.id),
      content: String(row.content),
      kind: String(row.kind),
      scope: String(row.scope),
      createdAt: toIso(row.created_at),
      expiresAt: toIso(row.expires_at),
      createdByAgent: row.created_by_agent ?? null,
      sourceConversationId: row.source_conversation_id ?? null,
    })),
  };
}

/** Set a preference the way the tool does: supersede, then a new revision. */
export async function setPreference(
  db: Db,
  input: { key: string; value: string; scope: string; now: Date },
): Promise<MemoryPreference> {
  const agentScope = toAgentScope(input.scope);
  const { rows: maxRows } = await db.query(
    `select coalesce(max(revision), 0)::int as max from memory.preferences
      where key = $1 and agent_scope is not distinct from $2`,
    [input.key, agentScope],
  );
  const revision = (maxRows[0]?.max ?? 0) + 1;
  await db.query(
    `update memory.preferences set superseded_at = $3
      where key = $1 and agent_scope is not distinct from $2 and superseded_at is null`,
    [input.key, agentScope, input.now],
  );
  await db.query(
    `insert into memory.preferences (key, value, revision, agent_scope, created_at)
     values ($1, $2, $3, $4, $5)`,
    [input.key, input.value, revision, agentScope, input.now],
  );
  return { key: input.key, value: input.value, scope: input.scope, revision, updatedAt: input.now.toISOString() };
}

/** Retire a preference: its current revision is superseded and nothing replaces it. */
export async function forgetPreference(db: Db, input: { key: string; scope: string; now: Date }): Promise<boolean> {
  const { rows } = await db.query(
    `update memory.preferences set superseded_at = $3
      where key = $1 and agent_scope is not distinct from $2 and superseded_at is null
      returning key`,
    [input.key, toAgentScope(input.scope), input.now],
  );
  return rows.length > 0;
}

/** Change what a note says, who sees it, or what kind it is. Provenance stays. */
export async function updateNote(
  db: Db,
  input: { id: string; content?: string; scope?: string; kind?: string; expiresAt?: Date | null },
): Promise<MemoryNote | null> {
  const { rows } = await db.query(
    `update memory.notes
        set content    = coalesce($2, content),
            scope      = coalesce($3, scope),
            kind       = coalesce($4, kind),
            expires_at = case when $5::boolean then $6 else expires_at end
      where id = $1 and deleted_at is null
      returning id, content, kind, scope, created_at, expires_at, created_by_agent, source_conversation_id`,
    [input.id, input.content ?? null, input.scope ?? null, input.kind ?? null, input.expiresAt !== undefined, input.expiresAt ?? null],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id), content: String(row.content), kind: String(row.kind), scope: String(row.scope),
    createdAt: toIso(row.created_at), expiresAt: toIso(row.expires_at),
    createdByAgent: row.created_by_agent ?? null, sourceConversationId: row.source_conversation_id ?? null,
  };
}

export async function forgetNote(db: Db, input: { id: string; now: Date }): Promise<boolean> {
  const { rows } = await db.query(
    `update memory.notes set deleted_at = $2 where id = $1 and deleted_at is null returning id`,
    [input.id, input.now],
  );
  return rows.length > 0;
}

export { SHARED as SHARED_SCOPE };
