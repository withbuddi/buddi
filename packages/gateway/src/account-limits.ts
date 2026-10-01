/**
 * A model account a provider has rate-limited, and until when
 * (core.provider_account_limits; docs/providers.md, "Rate limits").
 *
 * The adapter knows what one refusal said; this keeps it, per account, so the
 * next call can be refused here instead of at the provider (a spent daily
 * quota does not come back for asking), and so Settings → Model accounts,
 * `buddi accounts list` and the MCP admin can say "Rate-limited until 14:20".
 * Kept in Postgres because the dashboard, the scheduler and a terminal's
 * `buddi ask` are not always the same process.
 */
import { ProviderError, type RateLimitInfo } from '@buddi/runtime';
import type { Pool } from 'pg';

/** The standing limit on one account, in the shape every surface reads. */
export interface AccountRateLimit {
  scope: 'day' | 'burst';
  /** When the limit lifts. */
  until: string;
  /** The quota's size when the provider said it. */
  limit: number | null;
  unit: 'requests' | 'tokens' | null;
  freeTier: boolean;
  provider: string | null;
  model: string | null;
}

type Queryable = Pick<Pool, 'query'>;

/**
 * The limit a failed call leaves on its account, or null when it leaves none.
 * Only a refusal that named a time counts: a bare 429 is a moment, not a state.
 */
export function limitFromError(error: unknown, now: number = Date.now()): AccountRateLimit | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as { status?: unknown; type?: unknown; retryAt?: unknown; limit?: RateLimitInfo | null };
  if (e.type === 'insufficient_quota') return null;
  const limit = e.limit ?? null;
  const retryAt = limit?.retryAt ?? (e.status === 429 && typeof e.retryAt === 'string' ? e.retryAt : null);
  if (retryAt === null) return null;
  const until = Date.parse(retryAt);
  if (!Number.isFinite(until) || until <= now || until > now + 8 * 86_400_000) return null;
  return {
    scope: limit?.scope ?? 'burst',
    until: new Date(until).toISOString(),
    limit: limit?.limit ?? null,
    unit: limit?.unit ?? null,
    freeTier: limit?.freeTier === true,
    provider: limit?.provider ?? null,
    model: limit?.model ?? null,
  };
}

const COLUMNS = `account_id as "accountId", scope, until, quota, unit, free_tier as "freeTier", provider, model`;

interface LimitRow { accountId: string; scope: 'day' | 'burst'; until: Date; quota: number | null; unit: 'requests' | 'tokens' | null; freeTier: boolean; provider: string | null; model: string | null }

function fromRow(row: LimitRow): AccountRateLimit {
  return { scope: row.scope, until: new Date(row.until).toISOString(), limit: row.quota, unit: row.unit, freeTier: row.freeTier, provider: row.provider, model: row.model };
}

/** Every limit still standing, by account; the lapsed ones are swept on the way. */
export async function loadLimits(pool: Queryable): Promise<Map<string, AccountRateLimit>> {
  await pool.query('delete from core.provider_account_limits where until <= now()');
  const { rows } = await pool.query<LimitRow>(`select ${COLUMNS} from core.provider_account_limits`);
  return new Map(rows.map((row) => [row.accountId, fromRow(row)]));
}

/** The limit standing on one account now, or null. */
export async function limitOn(pool: Queryable, accountId: string): Promise<AccountRateLimit | null> {
  const { rows } = await pool.query<LimitRow>(`select ${COLUMNS} from core.provider_account_limits where account_id = $1 and until > now()`, [accountId]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function recordLimit(pool: Queryable, accountId: string, limit: AccountRateLimit): Promise<void> {
  await pool.query(
    `insert into core.provider_account_limits (account_id, scope, until, quota, unit, free_tier, provider, model, recorded_at)
     select $1, $2, $3, $4, $5, $6, $7, $8, now() where exists (select 1 from core.provider_accounts where id = $1)
     on conflict (account_id) do update set scope = excluded.scope, until = excluded.until, quota = excluded.quota,
       unit = excluded.unit, free_tier = excluded.free_tier, provider = excluded.provider, model = excluded.model, recorded_at = now()`,
    [accountId, limit.scope, limit.until, limit.limit, limit.unit, limit.freeTier, limit.provider, limit.model],
  );
}

export async function clearLimit(pool: Queryable, accountId: string): Promise<void> {
  await pool.query('delete from core.provider_account_limits where account_id = $1', [accountId]);
}

/**
 * The refusal for a call to an account whose daily quota is spent: the same
 * shape the adapter throws, so the owner reads the same sentence and the
 * queue requeues at the same reset — and the provider is not asked again.
 */
export function dailyLimitError(limit: AccountRateLimit, now: number = Date.now()): ProviderError {
  return new ProviderError({
    status: 429,
    type: 'rate_limit_error',
    message: `daily quota spent; not calling the provider until ${limit.until}`,
    retryAt: limit.until,
    limit: {
      scope: 'day',
      retryAt: limit.until,
      waitMs: Math.max(Date.parse(limit.until) - now, 0),
      ...(limit.limit !== null ? { limit: limit.limit } : {}),
      ...(limit.unit !== null ? { unit: limit.unit } : {}),
      ...(limit.freeTier ? { freeTier: true } : {}),
      ...(limit.provider !== null ? { provider: limit.provider } : {}),
      ...(limit.model !== null ? { model: limit.model } : {}),
    },
  });
}
