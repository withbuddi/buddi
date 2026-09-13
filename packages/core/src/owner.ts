/**
 * Owner identity and surface pairing (ARCHITECTURE.md, "Owner and surface
 * authentication").
 *
 * There is exactly one installation owner. Surfaces establish *identity* — they
 * report the numeric ids a transport gave them — and authorization is decided
 * here, in core, never in the surface. A surface that forgets to call
 * `resolveOwnerForSurface` gets no owner id at all, which is the fail-closed
 * direction.
 *
 * Nothing here trusts a username, a display name, a forward header or chat
 * membership: pairing is by external *user* id, and an optional chat binding
 * pins the private chat the owner speaks from.
 */

/** The narrow slice of `pg.Pool` these helpers need — keeps them stub-testable. */
export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

/** The single installation owner's id. One owner, one row, one constant. */
export const OWNER_ID = 'owner';

export interface SurfaceIdentityRef {
  surface: string;
  externalUserId: string;
  externalChatId?: string | null;
}

export interface SurfaceIdentity {
  id: string;
  ownerId: string;
  surface: string;
  externalUserId: string;
  externalChatId: string | null;
}

export type OwnerResolution =
  | { ok: true; ownerId: string }
  | { ok: false; reason: 'unpaired' | 'chat-mismatch' };

/** Create the installation owner if missing; returns its id. Idempotent. */
export async function ensureOwner(
  pool: Queryable,
  displayName?: string,
): Promise<string> {
  const { rows } = await pool.query(
    `insert into core.owner (id, display_name)
     values ($1, $2)
     on conflict (id) do update
       set display_name = coalesce(excluded.display_name, core.owner.display_name)
     returning id`,
    [OWNER_ID, displayName ?? null],
  );
  const id = rows[0]?.id;
  if (id === undefined || id === null) throw new Error('ensureOwner: no owner row');
  return String(id);
}

/**
 * Pair a surface identity to the owner. Idempotent: re-pairing the same
 * (surface, user) updates the bound chat id rather than creating a second row.
 */
export async function pairSurfaceIdentity(
  pool: Queryable,
  ref: SurfaceIdentityRef,
): Promise<SurfaceIdentity> {
  await ensureOwner(pool);
  const { rows } = await pool.query(
    `insert into core.surface_identities (owner_id, surface, external_user_id, external_chat_id)
     values ($1, $2, $3, $4)
     on conflict (surface, external_user_id) do update
       set external_chat_id = coalesce(excluded.external_chat_id, core.surface_identities.external_chat_id)
     returning id, owner_id, surface, external_user_id, external_chat_id`,
    [OWNER_ID, ref.surface, ref.externalUserId, ref.externalChatId ?? null],
  );
  return toIdentity(rows[0]);
}

function toIdentity(row: any): SurfaceIdentity {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    surface: row.surface,
    externalUserId: String(row.external_user_id),
    externalChatId: row.external_chat_id === null ? null : String(row.external_chat_id),
  };
}

/** The paired identity for a (surface, user), if any. */
export async function getSurfaceIdentity(
  pool: Queryable,
  surface: string,
  externalUserId: string,
): Promise<SurfaceIdentity | undefined> {
  const { rows } = await pool.query(
    `select id, owner_id, surface, external_user_id, external_chat_id
       from core.surface_identities
      where surface = $1 and external_user_id = $2`,
    [surface, externalUserId],
  );
  return rows[0] ? toIdentity(rows[0]) : undefined;
}

/** Every identity paired for a surface. */
export async function listSurfaceIdentities(
  pool: Queryable,
  surface: string,
): Promise<SurfaceIdentity[]> {
  const { rows } = await pool.query(
    `select id, owner_id, surface, external_user_id, external_chat_id
       from core.surface_identities
      where surface = $1
      order by created_at asc`,
    [surface],
  );
  return rows.map(toIdentity);
}

/**
 * Authorization. An unpaired user id is `unpaired`; a paired user speaking from
 * a chat other than the one bound at pairing time is `chat-mismatch` (an account
 * takeover, a group the owner was added to, a forwarded conversation — all of
 * them refusals, none of them errors).
 */
export async function resolveOwnerForSurface(
  pool: Queryable,
  ref: SurfaceIdentityRef,
): Promise<OwnerResolution> {
  const identity = await getSurfaceIdentity(pool, ref.surface, ref.externalUserId);
  if (!identity) return { ok: false, reason: 'unpaired' };
  const chatId = ref.externalChatId ?? null;
  if (identity.externalChatId !== null && chatId !== null && identity.externalChatId !== chatId) {
    return { ok: false, reason: 'chat-mismatch' };
  }
  return { ok: true, ownerId: identity.ownerId };
}

/**
 * Record an update in the dedup ledger. Returns true the first time the update
 * is seen and false forever after — the caller processes only on true, and the
 * polling offset advances only after this has committed.
 */
export async function recordSurfaceUpdate(
  pool: Queryable,
  surface: string,
  updateId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `insert into core.surface_updates (surface, update_id)
     values ($1, $2)
     on conflict (surface, update_id) do nothing
     returning update_id`,
    [surface, updateId],
  );
  return rows.length > 0;
}

/** The persisted polling offset for a surface, if one was ever stored. */
export async function getSurfaceCursor(
  pool: Queryable,
  surface: string,
): Promise<string | undefined> {
  const { rows } = await pool.query(
    `select cursor from core.surface_cursors where surface = $1`,
    [surface],
  );
  const cursor = rows[0]?.cursor;
  return cursor === undefined || cursor === null ? undefined : String(cursor);
}

/** Store the polling offset. Only ever called after the update is persisted. */
export async function setSurfaceCursor(
  pool: Queryable,
  surface: string,
  cursor: string,
): Promise<void> {
  await pool.query(
    `insert into core.surface_cursors (surface, cursor, updated_at)
     values ($1, $2, now())
     on conflict (surface) do update
       set cursor = excluded.cursor, updated_at = now()`,
    [surface, cursor],
  );
}

/* ------------------------------------------------------------------ *
 * Active agent per chat (one bot, many agents)
 * ------------------------------------------------------------------ */

/**
 * Which agent a chat is currently talking to, or `null` when it has never
 * switched. `null` is not an error: the caller falls back to the catalog's
 * default agent, so an installation that never runs `/use` stores no row.
 */
export async function getActiveAgent(
  pool: Queryable,
  surface: string,
  externalChatId: string,
): Promise<string | null> {
  const { rows } = await pool.query(
    `select agent_id from core.surface_active_agent
      where surface = $1 and external_chat_id = $2`,
    [surface, externalChatId],
  );
  const agentId = rows[0]?.agent_id;
  return agentId === undefined || agentId === null ? null : String(agentId);
}

/**
 * Point a chat at an agent. The id is stored as given — validity is the agent
 * catalog's decision, made before this is called, never here.
 */
export async function setActiveAgent(
  pool: Queryable,
  surface: string,
  externalChatId: string,
  agentId: string,
): Promise<void> {
  await pool.query(
    `insert into core.surface_active_agent (surface, external_chat_id, agent_id, updated_at)
     values ($1, $2, $3, now())
     on conflict (surface, external_chat_id) do update
       set agent_id = excluded.agent_id, updated_at = now()`,
    [surface, externalChatId, agentId],
  );
}
