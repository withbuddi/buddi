/**
 * Owner API tokens: how a script or another program calls the HTTP API
 * without a browser (docs/api.md, "Authentication").
 *
 * A token is `buddi_` and 32 random bytes, base64url. It is shown once, when
 * it is made, and stored only as its SHA-256 (`core.api_tokens`); a request
 * presents it as `Authorization: Bearer <token>` and is looked up by that
 * digest. It acts as the owner, minus what `api-routes.ts` refuses a token —
 * deciding approvals, changing grants, installing code, access and secrets —
 * and it is never a way past an approval card: a gated tool it reaches waits
 * for the owner like any other.
 *
 * Revoking deletes the row, so the very next request carrying it is a 401
 * that counts against the address like any other wrong credential.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export const API_TOKEN_PREFIX = 'buddi_';
/** The shape a token has; anything else is refused before a query. */
export const API_TOKEN_PATTERN = /^buddi_[A-Za-z0-9_-]{43}$/;
/** Live tokens at once. A list longer than this is a leak waiting to happen, not a need. */
export const MAX_API_TOKENS = 20;
export const API_TOKEN_NAME_MAX = 60;
/** How often `last_used_at` is written for a token in steady use. */
const TOUCH_EVERY_MS = 60_000;

export type ApiTokenVia = 'dashboard' | 'cli';

export interface ApiTokenView {
  id: string;
  name: string;
  /** The token's last four characters. */
  hint: string;
  scope: 'owner';
  createdVia: ApiTokenVia;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A refusal with the status a route answers it with. */
export class ApiTokenRefusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiTokenRefusal';
  }
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A new token. Exported for tests; `createApiToken` is how one is made. */
export function newApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** The token in an `Authorization` header, when it is a Bearer one. */
export function bearerOf(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value ?? '');
  return match?.[1];
}

interface Row {
  id: string;
  name: string;
  hint: string;
  scope: string;
  created_via: string;
  created_at: Date;
  last_used_at: Date | null;
}

const COLUMNS = 'id, name, hint, scope, created_via, created_at, last_used_at';

function viewOf(row: Row): ApiTokenView {
  return {
    id: row.id,
    name: row.name,
    hint: row.hint,
    scope: 'owner',
    createdVia: row.created_via === 'cli' ? 'cli' : 'dashboard',
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  };
}

export function cleanTokenName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (name === '') throw new ApiTokenRefusal(400, 'Give the token a name: what will use it.');
  if (name.length > API_TOKEN_NAME_MAX) throw new ApiTokenRefusal(400, `A token’s name is at most ${API_TOKEN_NAME_MAX} characters.`);
  return name;
}

/** Make a token. The answer holds the token itself: the only time it exists outside the caller. */
export async function createApiToken(
  pool: Pool,
  input: { name: unknown; via: ApiTokenVia; now?: Date },
): Promise<{ token: string; apiToken: ApiTokenView }> {
  const name = cleanTokenName(input.name);
  const { rows: [count] } = await pool.query<{ n: string }>('select count(*)::text as n from core.api_tokens');
  if (Number(count?.n ?? 0) >= MAX_API_TOKENS) {
    throw new ApiTokenRefusal(409, `There are already ${MAX_API_TOKENS} tokens. Revoke one you no longer use first.`);
  }
  const token = newApiToken();
  const { rows: [row] } = await pool.query<Row>(
    `insert into core.api_tokens (id, name, token_hash, hint, created_via, created_at)
     values ($1, $2, $3, $4, $5, $6) returning ${COLUMNS}`,
    [randomUUID(), name, hashApiToken(token), token.slice(-4), input.via, input.now ?? new Date()],
  );
  return { token, apiToken: viewOf(row!) };
}

export async function listApiTokens(pool: Pool): Promise<ApiTokenView[]> {
  const { rows } = await pool.query<Row>(`select ${COLUMNS} from core.api_tokens order by created_at desc, id`);
  return rows.map(viewOf);
}

/** Revoke by id, or by the unique start of one (what a terminal types). True when one went. */
export async function revokeApiToken(pool: Pool, id: string): Promise<ApiTokenView | null> {
  const wanted = id.trim().toLowerCase();
  if (!/^[0-9a-f-]{4,36}$/.test(wanted)) return null;
  const { rows } = await pool.query<Row>(`select ${COLUMNS} from core.api_tokens where id::text like $1 || '%'`, [wanted]);
  if (rows.length !== 1) {
    if (rows.length > 1) throw new ApiTokenRefusal(409, `More than one token starts with ${id}: give more of the id.`);
    return null;
  }
  await pool.query('delete from core.api_tokens where id = $1', [rows[0]!.id]);
  return viewOf(rows[0]!);
}

/**
 * The token's row, when the token is live; null otherwise. A token of the
 * wrong shape is refused without a query. `last_used_at` is written at most
 * once a minute.
 */
export async function verifyApiToken(pool: Pool, token: string, now: Date = new Date()): Promise<ApiTokenView | null> {
  if (!API_TOKEN_PATTERN.test(token)) return null;
  const { rows: [row] } = await pool.query<Row>(`select ${COLUMNS} from core.api_tokens where token_hash = $1`, [hashApiToken(token)]);
  if (!row) return null;
  if (!row.last_used_at || now.getTime() - row.last_used_at.getTime() >= TOUCH_EVERY_MS) {
    await pool.query('update core.api_tokens set last_used_at = $2 where id = $1', [row.id, now]).catch(() => undefined);
    row.last_used_at = now;
  }
  return viewOf(row);
}

/** Settings → API tokens: list, make, revoke. Behind the dashboard session only. */
export async function apiTokensRoute(
  pool: Pool,
  req: { method: string; path: string; body: unknown; now: Date },
): Promise<{ status: number; body: unknown }> {
  try {
    if (req.path === '/api/api-tokens') {
      if (req.method === 'GET') return { status: 200, body: { tokens: await listApiTokens(pool) } };
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const made = await createApiToken(pool, { name: body.name, via: 'dashboard', now: req.now });
      return { status: 201, body: made };
    }
    const one = /^\/api\/api-tokens\/([0-9a-f-]{36})$/i.exec(req.path);
    if (one && req.method === 'DELETE') {
      return (await revokeApiToken(pool, one[1]!)) ? { status: 204, body: undefined } : { status: 404, body: { error: 'No token has that id. It may have been revoked already.' } };
    }
    return { status: 404, body: { error: 'no such endpoint' } };
  } catch (err) {
    if (err instanceof ApiTokenRefusal) return { status: err.status, body: { error: err.message } };
    throw err;
  }
}
