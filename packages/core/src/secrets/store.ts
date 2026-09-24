/**
 * The owner's secrets as rows, and their values in the vault
 * (docs/specs/owner-secrets.md §2, §7).
 *
 * Names, bindings and uses live in `core.secrets`, `core.secret_bindings` and
 * `core.secret_uses`; a value lives only in the vault, under
 * `owner-secret:<id>`. Nothing here returns a value: the one read of one is in
 * `use.ts`, on its way into a destination's `deliver`.
 *
 * These are the owner's writes. They take no identity because the callers
 * that reach them decide that: the host's `secrets` area lets only the owner's
 * own call through and only for its plugin's kinds, and the Settings page
 * (owner-secrets §6) will be `ownerOnly` tools of core's.
 */
import type { Pool, PoolClient } from 'pg';
import type { SecretBinding, SecretListing, SecretUseOutcome } from '../host/types.js';
import type { Queryable } from '../owner.js';
import { ownerSecretVaultName, type Vault } from '../vault/types.js';
import { isAccountKind, isSecretKind, isSecretRule } from './destinations.js';

/** A secret's row. */
export interface SecretRow {
  id: string;
  name: string;
  totp: boolean;
}

/** A binding's row. */
export interface SecretBindingRow extends SecretBinding {
  id: string;
  secretId: string;
  firstApprovedAt: Date | null;
}

/** A name the owner reads on a card and in Settings: one line, not empty, not huge. */
export function assertOwnerSecretName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('A secret needs a name.');
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('A secret needs a name.');
  if (trimmed.length > 120) throw new Error('A secret name is at most 120 characters.');
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error('A secret name is one line of text.');
  return trimmed;
}

/** Check bindings before anything is written. Targets must be plain JSON. */
export function assertBindings(bindings: unknown): SecretBinding[] {
  if (!Array.isArray(bindings)) throw new Error('Bindings are a list.');
  return bindings.map((binding, index) => {
    const b = binding as Partial<SecretBinding> | null;
    if (b === null || typeof b !== 'object') throw new Error(`Binding ${index + 1} is not a binding.`);
    if (!isSecretKind(b.kind)) throw new Error(`Binding ${index + 1} names no destination kind.`);
    if (!isSecretRule(b.rule)) throw new Error(`Binding ${index + 1} has no rule (every-time, first-time or pre-approved).`);
    if (b.target === undefined) throw new Error(`Binding ${index + 1} has no target.`);
    let json: string;
    try {
      json = JSON.stringify(b.target);
    } catch {
      throw new Error(`Binding ${index + 1}'s target is not plain data.`);
    }
    return { kind: b.kind, target: JSON.parse(json) as unknown, rule: b.rule };
  });
}

function toSecret(row: Record<string, unknown>): SecretRow {
  return { id: String(row.id), name: String(row.name), totp: row.totp === true };
}

function toBinding(row: Record<string, unknown>): SecretBindingRow {
  return {
    id: String(row.id),
    secretId: String(row.secret_id),
    kind: String(row.kind),
    target: row.target,
    rule: row.rule as SecretBinding['rule'],
    firstApprovedAt: row.first_approved_at instanceof Date
      ? row.first_approved_at
      : row.first_approved_at === null || row.first_approved_at === undefined
        ? null
        : new Date(String(row.first_approved_at)),
  };
}

export async function findSecret(db: Queryable, name: string): Promise<SecretRow | null> {
  const { rows } = await db.query(`select id, name, totp from core.secrets where name = $1`, [name]);
  return rows[0] ? toSecret(rows[0]) : null;
}

export async function secretBindings(db: Queryable, secretId: string): Promise<SecretBindingRow[]> {
  const { rows } = await db.query(
    `select id, secret_id, kind, target, rule, first_approved_at from core.secret_bindings
      where secret_id = $1 order by created_at, id`,
    [secretId],
  );
  return rows.map(toBinding);
}

async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (rollback) {
      broken = rollback instanceof Error ? rollback : new Error(String(rollback));
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

async function writeBindings(db: Queryable, secretId: string, bindings: readonly SecretBinding[]): Promise<void> {
  for (const binding of bindings) {
    await db.query(
      `insert into core.secret_bindings (secret_id, kind, target, rule)
       values ($1, $2, $3::jsonb, $4)
       on conflict (secret_id, kind, target) do update set rule = excluded.rule`,
      [secretId, binding.kind, JSON.stringify(binding.target), binding.rule],
    );
  }
}

/**
 * Store a secret, or replace the value of the one with that name, with these
 * bindings added (a binding already there keeps its first approval unless its
 * rule changes). The value goes to the vault inside the transaction that
 * writes the row, so a vault that refuses leaves no row behind.
 */
export async function putOwnerSecret(
  pool: Pool,
  vault: Vault,
  input: { name: string; value: string; bindings: readonly SecretBinding[]; totp?: boolean },
): Promise<SecretRow> {
  const name = assertOwnerSecretName(input.name);
  const bindings = assertBindings(input.bindings);
  if (typeof input.value !== 'string' || input.value.trim() === '') throw new Error('A secret needs a value.');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `insert into core.secrets (name, totp) values ($1, $2)
       on conflict (name) do update set updated_at = now()
       returning id, name, totp`,
      [name, input.totp === true],
    );
    const secret = toSecret(rows[0]);
    await writeBindings(client, secret.id, bindings);
    await vault.set(ownerSecretVaultName(secret.id), input.value);
    return secret;
  });
}

/** Rename. False when there is no such secret; throws when the new name is taken. */
export async function renameOwnerSecret(db: Queryable, name: string, to: string): Promise<boolean> {
  const next = assertOwnerSecretName(to);
  const taken = await findSecret(db, next);
  if (taken !== null && taken.name !== name) throw new Error(`There is already a secret named "${next}".`);
  const { rows } = await db.query(
    `update core.secrets set name = $2, updated_at = now() where name = $1 returning id`,
    [name, next],
  );
  return rows.length > 0;
}

/** Replace a secret's bindings with these. False when there is no such secret. */
export async function rebindOwnerSecret(
  pool: Pool,
  name: string,
  bindings: readonly SecretBinding[],
): Promise<boolean> {
  const checked = assertBindings(bindings);
  return inTransaction(pool, async (client) => {
    const secret = await findSecret(client, name);
    if (secret === null) return false;
    // A binding that stays exactly as it was keeps its first approval; one that
    // is gone or changed rule is dropped and, if changed, written afresh.
    const kept: string[] = [];
    for (const binding of checked) {
      const { rows } = await client.query(
        `select id from core.secret_bindings
          where secret_id = $1 and kind = $2 and target = $3::jsonb and rule = $4`,
        [secret.id, binding.kind, JSON.stringify(binding.target), binding.rule],
      );
      if (rows[0]) kept.push(String(rows[0].id));
    }
    await client.query(
      `delete from core.secret_bindings where secret_id = $1 and not (id = any($2::uuid[]))`,
      [secret.id, kept],
    );
    await writeBindings(client, secret.id, checked);
    await client.query(`update core.secrets set updated_at = now() where id = $1`, [secret.id]);
    return true;
  });
}

/** Delete a secret: its rows, then its value. False when there was none. */
export async function deleteOwnerSecret(db: Queryable, vault: Vault, name: string): Promise<boolean> {
  const { rows } = await db.query(`delete from core.secrets where name = $1 returning id`, [name]);
  if (!rows[0]) return false;
  await vault.delete(ownerSecretVaultName(String(rows[0].id))).catch(() => false);
  return true;
}

/**
 * Secrets with their bindings and last use. `kinds`, when given, keeps only
 * the secrets with a binding of one of those kinds and only those bindings.
 */
export async function listOwnerSecrets(
  db: Queryable,
  opts: { kindPrefix?: string } = {},
): Promise<SecretListing[]> {
  const { rows } = await db.query(
    `select s.id, s.name, s.totp,
            coalesce(json_agg(json_build_object(
              'kind', b.kind, 'target', b.target, 'rule', b.rule,
              'firstApprovedAt', b.first_approved_at) order by b.created_at)
              filter (where b.id is not null), '[]') as bindings,
            (select json_build_object('at', u.at, 'kind', u.kind, 'target', u.target,
                                      'agentId', u.agent_id, 'outcome', u.outcome)
               from core.secret_uses u where u.secret_id = s.id
              order by u.at desc limit 1) as last_use
       from core.secrets s
       left join core.secret_bindings b
         on b.secret_id = s.id and ($1::text is null or starts_with(b.kind, $1))
      group by s.id
     having $1::text is null or count(b.id) > 0
      order by s.name`,
    [opts.kindPrefix ?? null],
  );
  return rows.map((row: Record<string, any>) => ({
    name: String(row.name),
    totp: row.totp === true,
    bindings: (row.bindings as Array<Record<string, unknown>>).map((b) => ({
      kind: String(b.kind),
      target: b.target,
      rule: b.rule as SecretBinding['rule'],
      firstApprovedAt: b.firstApprovedAt === null || b.firstApprovedAt === undefined ? null : String(b.firstApprovedAt),
      heldByPlugin: isAccountKind(String(b.kind)),
    })),
    lastUse: row.last_use === null || row.last_use === undefined
      ? null
      : {
          at: String(row.last_use.at),
          kind: String(row.last_use.kind),
          target: row.last_use.target,
          agentId: row.last_use.agentId ?? null,
          outcome: row.last_use.outcome as SecretUseOutcome,
        },
  }));
}

/** What `adoptVaultEntry` did. */
export type AdoptOutcome = 'adopted' | 'already' | 'nothing';

/**
 * Move a secret a plugin kept under its own vault name into an owner secret
 * (owner-secrets §7, "Migrating what plugins hold today"). Idempotent: run at
 * every start, it adopts once and then finds the owner secret already there.
 * The old entry is deleted only after the new value reads back the same.
 *
 * `fallback` is the value when the vault has no old entry — the day-1 `.env`
 * copy — which is adopted the same way; `.env` itself is the owner's file and
 * is not touched.
 */
export async function adoptVaultEntry(
  pool: Pool,
  vault: Vault,
  input: { from: string; name: string; bindings: readonly SecretBinding[]; fallback?: string | undefined },
): Promise<AdoptOutcome> {
  const existing = await findSecret(pool, input.name);
  if (existing !== null && (await vault.get(ownerSecretVaultName(existing.id))) !== null) {
    await writeBindings(pool, existing.id, assertBindings(input.bindings));
    await vault.delete(input.from).catch(() => false);
    return 'already';
  }
  const inVault = await vault.get(input.from);
  const value = inVault ?? (input.fallback?.trim() ? input.fallback : null);
  if (value === null) return 'nothing';
  const secret = await putOwnerSecret(pool, vault, { name: input.name, value, bindings: input.bindings });
  const back = await vault.get(ownerSecretVaultName(secret.id));
  if (back !== value) {
    throw new Error(`the owner secret "${input.name}" did not read back after moving ${input.from}; the old entry was kept`);
  }
  if (inVault !== null) await vault.delete(input.from);
  return 'adopted';
}
