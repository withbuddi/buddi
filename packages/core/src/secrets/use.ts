/**
 * One use of an owner secret (docs/specs/owner-secrets.md §2, §3).
 *
 * Core finds the binding, asks the destination to check the target, applies
 * the rule, reads the vault and calls `deliver`. The value exists here and in
 * that one `deliver` call; what the caller is answered is an outcome and a
 * use id, never the value. Every use is a row in `core.secret_uses`, refusals
 * included.
 *
 * The rule is the stricter of the binding's and the kind's `maxRule`:
 *
 *  - `pre-approved` delivers.
 *  - `first-time` delivers once the owner approved a first use under this
 *    binding (`first_approved_at`); until then it raises an approval and
 *    answers `pending` with its id.
 *  - `every-time` delivers only against an approved action for this binding
 *    and this target that no earlier use consumed; otherwise it raises one.
 *
 * The approval is an ordinary action on the existing path (`createAction`),
 * for core's own `secrets.use` tool (`approval.ts`): the owner sees a card,
 * decides it on any surface, and the executor runs the tool, which records the
 * grant. The value is delivered on the use asked after that, never from the
 * approval itself.
 */
import type { Pool } from 'pg';
import { createAction } from '../actions/store.js';
import type { BuddiHost, SecretUseResult } from '../host/types.js';
import { ownerSecretVaultName, type Vault } from '../vault/types.js';
import { isAccountKind, secretDestination, stricterRule } from './destinations.js';
import { findSecret, secretBindings, type SecretBindingRow } from './store.js';
import { describeSecretUse, SECRETS_TOOL, SECRETS_TOOL_VERSION } from './approval.js';
import { TOTP_STEP_SECONDS, currentTotp, totpCounter } from './totp.js';

export interface UseSecretDeps {
  pool: Pool;
  vault: Vault | undefined;
  /** The plugin asking. It may use only kinds it registered. */
  plugin: string;
  /** That plugin's host, handed to its destination. */
  buddi: BuddiHost;
  agentId?: string | undefined;
  conversationId?: string | undefined;
  now: () => Date;
  /**
   * Core's own destinations (the `http` area's `http.header`, the gateway's
   * `accounts.provider`) take the value into the code that asked for it — the
   * caller *is* the destination's delivery. Recorded exactly as a delivered
   * use; the registered destination's own `deliver` never runs. Not on the
   * host's `secrets` area, so no plugin can ask for this.
   */
  deliverInto?: (value: string, target: unknown, useId: string) => void | Promise<void>;
}

export interface UseSecretRequest {
  name: string;
  kind: string;
  target: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Plain JSON, or undefined when it is not. */
function plain(target: unknown): unknown {
  try {
    const json = JSON.stringify(target);
    return json === undefined ? undefined : JSON.parse(json);
  } catch {
    return undefined;
  }
}

export async function useOwnerSecret(deps: UseSecretDeps, req: UseSecretRequest): Promise<SecretUseResult> {
  const { pool, plugin } = deps;
  const target = plain(req.target);
  const conversationId = await existingConversation(pool, deps.conversationId);

  const record = async (row: {
    secretId: string | null;
    outcome: 'delivered' | 'held' | 'pending' | 'refused' | 'failed';
    actionId?: string | null;
    detail?: string | null;
  }): Promise<string> => {
    const { rows } = await pool.query(
      `insert into core.secret_uses
         (secret_id, secret_name, kind, target, plugin, agent_id, conversation_id, action_id, outcome, detail, at)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)
       returning id`,
      [
        row.secretId,
        req.name,
        req.kind,
        target === undefined ? null : JSON.stringify(target),
        plugin,
        deps.agentId ?? null,
        conversationId,
        row.actionId ?? null,
        row.outcome,
        row.detail ?? null,
        deps.now(),
      ],
    );
    return String(rows[0].id);
  };
  const refuse = async (secretId: string | null, reason: string): Promise<SecretUseResult> => {
    await record({ secretId, outcome: 'refused', detail: reason });
    return { refused: reason };
  };

  // The kind first: a plugin delivers only into destinations it registered.
  const destination = secretDestination(req.kind);
  if (destination === undefined) return refuse(null, `There is no secret destination ${req.kind}.`);
  if (destination.plugin !== plugin) {
    return refuse(null, `${req.kind} is ${destination.plugin}'s destination, not ${plugin}'s.`);
  }
  if (target === undefined) return refuse(null, 'The target is not plain data.');

  const secret = await findSecret(pool, req.name);
  if (secret === null) return refuse(null, `There is no secret named "${req.name}".`);
  // A TOTP secret delivers only its current code, into a browser field only
  // (owner-secrets §4) — a property of the secret, so it is checked before
  // any binding or card.
  if (secret.totp === true && req.kind !== 'browser.field') {
    return refuse(secret.id, `"${req.name}" is a TOTP secret; its code goes into a browser field only.`);
  }

  // The binding: one of this kind whose target the destination accepts. The
  // destination checks, never the caller.
  let binding: SecretBindingRow | undefined;
  for (const candidate of await secretBindings(pool, secret.id)) {
    if (candidate.kind !== req.kind) continue;
    let ok = false;
    try {
      ok = (await destination.checkTarget(target, candidate.target, deps.buddi)) === true;
    } catch {
      ok = false;
    }
    if (ok) {
      binding = candidate;
      break;
    }
  }
  if (binding === undefined) {
    return refuse(secret.id, `"${req.name}" is not bound to ${destination.describe(target)}.`);
  }

  const rule = stricterRule(binding.rule, destination.maxRule);
  let grantedBy: string | null = null;
  if (rule !== 'pre-approved') {
    const decided = await latestApproval(pool, binding.id, target, deps.now());
    if (rule === 'first-time' && binding.firstApprovedAt === null) {
      if (decided !== null && (decided.state === 'approved' || decided.state === 'succeeded')) {
        // Approved and not yet executed, or executed: the grant stands either way.
        await pool.query(
          `update core.secret_bindings set first_approved_at = coalesce(first_approved_at, $2) where id = $1`,
          [binding.id, deps.now()],
        );
      } else if (decided !== null && decided.state === 'pending') {
        return { pending: decided.id };
      } else {
        return ask();
      }
    }
    if (rule === 'every-time') {
      if (decided !== null && (decided.state === 'approved' || decided.state === 'succeeded') && !decided.consumed) {
        grantedBy = decided.id;
      } else if (decided !== null && decided.state === 'pending') {
        return { pending: decided.id };
      } else {
        return ask();
      }
    }
  }

  // Delivery.
  if (deps.vault === undefined) return refuse(secret.id, 'This installation has no vault, so no secret can be used.');
  let value: string | null;
  try {
    value = await deps.vault.get(ownerSecretVaultName(secret.id));
  } catch {
    return refuse(secret.id, 'The vault is locked; unlock this machine and try again.');
  }
  if (value === null) return refuse(secret.id, `"${req.name}" has no value stored; replace it in Settings.`);
  /*
   * A TOTP secret's value is the seed; what is delivered is the current code,
   * into a browser field only (owner-secrets §4). The owner turned TOTP on for
   * this secret explicitly, and every code generated is logged — the use row
   * carries the window it was minted for, never the code.
   */
  let delivered = value;
  let detail: string | null = null;
  if (secret.totp === true) {
    const at = deps.now();
    delivered = currentTotp(value, at);
    detail = `code generated for the window ending ${new Date(
      (totpCounter(at) + 1) * TOTP_STEP_SECONDS * 1000,
    ).toISOString()}`;
  }
  const useId = await record({
    secretId: secret.id,
    outcome: isAccountKind(req.kind) ? 'held' : 'delivered',
    actionId: grantedBy,
    ...(detail !== null ? { detail } : {}),
  });
  try {
    if (deps.deliverInto !== undefined) {
      await deps.deliverInto(delivered, target, useId);
    } else {
      await destination.deliver(delivered, target, { use: useId, buddi: deps.buddi });
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const detail = raw.split(value).join(`‹secret:${req.name}›`);
    await pool.query(`update core.secret_uses set outcome = 'failed', detail = $2 where id = $1`, [useId, detail]);
    return { refused: `${req.kind} could not take "${req.name}": ${detail}` };
  }
  return { done: true, use: useId };

  async function ask(): Promise<SecretUseResult> {
    const args = { bindingId: binding!.id, secret: req.name, kind: req.kind, target, plugin, rule: rule as 'every-time' | 'first-time' };
    const card = describeSecretUse(args);
    const action = await createAction(pool, {
      tool: SECRETS_TOOL,
      toolVersion: SECRETS_TOOL_VERSION,
      agentId: deps.agentId ?? plugin,
      conversationId,
      canonicalArgs: args,
      envelope: card.envelope,
      preview: card.preview,
      tier: 'gated',
      now: deps.now(),
    });
    await record({ secretId: secret!.id, outcome: 'pending', actionId: action.id });
    return { pending: action.id };
  }
}

/** The conversation, when it is a row: an action's and a use's reference to it must hold. */
async function existingConversation(pool: Pool, id: string | undefined): Promise<string | null> {
  if (id === undefined || !UUID.test(id)) return null;
  const { rows } = await pool.query(`select 1 from core.conversations where id = $1`, [id]);
  return rows.length > 0 ? id : null;
}

/** The newest approval asked for this binding and target, and whether a use consumed it. */
async function latestApproval(
  pool: Pool,
  bindingId: string,
  target: unknown,
  now: Date,
): Promise<{ id: string; state: string; consumed: boolean } | null> {
  // A card nobody decided before it expired is not pending any more, swept or not.
  const { rows } = await pool.query(
    `select a.id,
            case when ap.state = 'pending' and a.expires_at <= $4 then 'expired' else ap.state end as state,
            exists (select 1 from core.secret_uses u
                     where u.action_id = a.id and u.outcome in ('delivered', 'held', 'failed')) as consumed
       from core.actions a join core.approvals ap on ap.action_id = a.id
      where a.tool = $1 and a.canonical_args->>'bindingId' = $2
        and a.canonical_args->'target' = $3::jsonb
      order by a.created_at desc, a.id desc
      limit 1`,
    [SECRETS_TOOL, bindingId, JSON.stringify(target), now],
  );
  const row = rows[0] as { id: string; state: string; consumed: boolean } | undefined;
  return row === undefined ? null : { id: String(row.id), state: String(row.state), consumed: row.consumed === true };
}
