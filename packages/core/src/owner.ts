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
import { randomInt } from 'node:crypto';

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
  /** A name the owner recognizes ("Amen's phone"). Never used for authorization. */
  label?: string | null;
  /** How this identity came to be paired. First pairing wins; see below. */
  pairedVia?: PairedVia | null;
}

/**
 * `env` — the startup allowlist (`TELEGRAM_OWNER_USER_ID`).
 * `code` — a one-time pairing code the owner minted.
 * `manual` — written directly, by a human with database access.
 */
export type PairedVia = 'env' | 'code' | 'manual';

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
  // `paired_via` records how an identity *first* arrived, so a restart that
  // re-runs the environment allowlist cannot rewrite a device that paired by
  // code into an `env` one. The label, being a name, is updatable.
  const { rows } = await pool.query(
    `insert into core.surface_identities (owner_id, surface, external_user_id, external_chat_id, label, paired_via)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (surface, external_user_id) do update
       set external_chat_id = coalesce(excluded.external_chat_id, core.surface_identities.external_chat_id),
           label = coalesce(excluded.label, core.surface_identities.label),
           paired_via = coalesce(core.surface_identities.paired_via, excluded.paired_via)
     returning id, owner_id, surface, external_user_id, external_chat_id`,
    [
      OWNER_ID,
      ref.surface,
      ref.externalUserId,
      ref.externalChatId ?? null,
      ref.label ?? null,
      ref.pairedVia ?? null,
    ],
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

/* ------------------------------------------------------------------ *
 * Pairing by one-time code (migration 007)
 * ------------------------------------------------------------------ */

/**
 * The alphabet a code is drawn from: upper case, with `I`, `O`, `0` and `1`
 * removed. The owner reads these off one screen and types them into another,
 * so the pairs that look alike are simply not in the set.
 */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Code length. 32^8 ≈ 1.1e12 — and a code lives ten minutes and is used once. */
export const PAIRING_CODE_LENGTH = 8;

/** Default time to live for a freshly minted code. */
export const PAIRING_TTL_MINUTES = 10;

/** A code as minted: what to show the owner, and when it stops working. */
export interface PairingCode {
  code: string;
  expiresAt: Date;
}

export interface CreatePairingCodeOptions {
  surface: string;
  ttlMinutes?: number;
}

/**
 * A cryptographically random code. `randomInt` is rejection-sampled by Node, so
 * every character is uniform — `Math.random` and `% length` are both wrong here
 * and the difference is not visible by looking at the output.
 */
export function generatePairingCode(length = PAIRING_CODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += PAIRING_ALPHABET[randomInt(0, PAIRING_ALPHABET.length)];
  }
  return out;
}

/**
 * How a code is read back: case is ignored and spaces and dashes are noise, so
 * `abcd-2345` and `ABCD 2345` are the same code. Nothing else is coerced — a
 * character outside the alphabet stays wrong rather than being guessed at.
 */
export function normalizePairingCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, '');
}

/** Mint a single-use code for a surface. Retries only on the (absurd) collision. */
export async function createPairingCode(
  pool: Queryable,
  opts: CreatePairingCodeOptions,
): Promise<PairingCode> {
  const ttl = Math.max(1, Math.floor(opts.ttlMinutes ?? PAIRING_TTL_MINUTES));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generatePairingCode();
    const { rows } = await pool.query(
      `insert into core.pairing_codes (code, surface, expires_at)
       values ($1, $2, now() + make_interval(mins => $3::int))
       on conflict (code) do nothing
       returning code, expires_at`,
      [code, opts.surface, ttl],
    );
    const row = rows[0];
    if (row) return { code: String(row.code), expiresAt: new Date(row.expires_at) };
  }
  throw new Error('createPairingCode: could not mint an unused code');
}

export interface ConsumePairingCodeRef extends SurfaceIdentityRef {
  code: string;
}

export type PairingResult =
  | { ok: true; identity: SurfaceIdentity }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' };

/**
 * Claim a code and pair the identity that presented it.
 *
 * The claim is one statement: `update … where used_at is null and expires_at >
 * now() returning`. Two devices racing the same code both run it, exactly one
 * row comes back, and the loser is told `used` — there is no read-then-write
 * window to lose. The *reason* for a failure is looked up afterwards, when the
 * decision has already been made and cannot be affected by what we find.
 */
export async function consumePairingCode(
  pool: Queryable,
  ref: ConsumePairingCodeRef,
): Promise<PairingResult> {
  const code = normalizePairingCode(ref.code);
  if (code === '') return { ok: false, reason: 'invalid' };

  const claimed = await pool.query(
    `update core.pairing_codes
        set used_at = now()
      where code = $1
        and surface = $2
        and used_at is null
        and expires_at > now()
      returning code`,
    [code, ref.surface],
  );
  if (claimed.rows.length === 0) {
    const { rows } = await pool.query(
      `select used_at, expires_at from core.pairing_codes where code = $1 and surface = $2`,
      [code, ref.surface],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: 'invalid' };
    if (row.used_at !== null && row.used_at !== undefined) return { ok: false, reason: 'used' };
    return { ok: false, reason: 'expired' };
  }

  const identity = await pairSurfaceIdentity(pool, {
    surface: ref.surface,
    externalUserId: ref.externalUserId,
    externalChatId: ref.externalChatId ?? null,
    label: ref.label ?? null,
    pairedVia: 'code',
  });
  // The audit trail: which device this code created. Cosmetic to pairing —
  // the code is already spent either way.
  await pool.query(
    `update core.pairing_codes set used_by_identity = $2::uuid where code = $1`,
    [code, identity.id],
  );
  return { ok: true, identity };
}

/**
 * "This device spoke just now." Deliberately not part of authorization: it is
 * written after a message is accepted and a failure to write it must never cost
 * the owner their answer.
 *
 * A label supplied here *fills in* a missing one and never replaces one that is
 * already stored: a device paired from the environment allowlist has no name,
 * and the first message it sends is where its name honestly comes from — but a
 * name the owner chose stays theirs, whatever the transport now calls them.
 */
export async function touchSurfaceIdentity(
  pool: Queryable,
  surface: string,
  externalUserId: string,
  opts: { label?: string | null } = {},
): Promise<void> {
  const label = (opts.label ?? '').trim() === '' ? null : (opts.label as string).trim();
  await pool.query(
    `update core.surface_identities
        set last_seen_at = now(),
            label = coalesce(label, $3)
      where surface = $1 and external_user_id = $2`,
    [surface, externalUserId, label],
  );
}

/** A paired device as the owner sees it, across every surface. */
export interface SurfaceIdentityDetail extends SurfaceIdentity {
  label: string | null;
  pairedAt: Date | null;
  lastSeenAt: Date | null;
  pairedVia: PairedVia | null;
}

/** Every paired identity on every surface, oldest first. */
export async function listSurfaceIdentitiesDetailed(
  pool: Queryable,
): Promise<SurfaceIdentityDetail[]> {
  const { rows } = await pool.query(
    `select id, owner_id, surface, external_user_id, external_chat_id,
            label, paired_at, last_seen_at, paired_via
       from core.surface_identities
      order by paired_at asc, created_at asc`,
  );
  return rows.map((row) => ({
    ...toIdentity(row),
    label: row.label === undefined || row.label === null ? null : String(row.label),
    pairedAt: row.paired_at ? new Date(row.paired_at) : null,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
    pairedVia: (row.paired_via ?? null) as PairedVia | null,
  }));
}

/** A uuid, and nothing that merely looks like one. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Unpair a device by identity id. `false` means "no such device" — a caller
 * that typed a wrong id gets a fact, not an exception, and an id that is not a
 * uuid never reaches the database.
 */
export async function unpairSurfaceIdentity(pool: Queryable, id: string): Promise<boolean> {
  const trimmed = id.trim();
  if (!UUID_RE.test(trimmed)) return false;
  const { rows } = await pool.query(
    `delete from core.surface_identities where id = $1::uuid returning id`,
    [trimmed],
  );
  return rows.length > 0;
}

/** The owner's display name, if one was ever stored. */
export async function getOwnerDisplayName(pool: Queryable): Promise<string | undefined> {
  const { rows } = await pool.query(`select display_name from core.owner where id = $1`, [
    OWNER_ID,
  ]);
  const name = rows[0]?.display_name;
  return name === undefined || name === null || String(name).trim() === ''
    ? undefined
    : String(name);
}
