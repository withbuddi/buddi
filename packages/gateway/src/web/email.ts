/**
 * Settings → Email → Policies, over HTTP.
 *
 * Three routes and nothing clever: read the two lists, write or keep one rule,
 * take one back. The rules themselves live in the email plugin — this file
 * translates between the dashboard's JSON and that plugin's functions, and owes
 * the page one thing the tools do not: the *owner* is the one acting here, so
 * there is no approval card in the way. The gate on the tool exists because a
 * model proposed it; the owner tapping "Revoke" on their own settings page has
 * already said what they want.
 *
 * Every reply is shaped the same — `{ applied, proposed }` — so the page reloads
 * from whatever the last call returned instead of asking again.
 */
import type { Pool } from 'pg';
import {
  createPolicy,
  keepPolicy,
  policiesView,
  refusalFor,
  revokePolicy,
  PolicyRefusal,
  POLICY_ACTIONS,
  POLICY_SCOPES,
  type PolicyAction,
  type PolicyParams,
  type PolicyScope,
  type PolicyView,
} from '@buddi/tool-email';

export interface EmailPoliciesView {
  applied: PolicyView[];
  proposed: PolicyView[];
}

export interface RouteReply {
  status: number;
  body: unknown;
}

export async function readEmailPolicies(pool: Pool): Promise<RouteReply> {
  try {
    return { status: 200, body: await policiesView(pool) };
  } catch (err) {
    // The email plugin may not be installed, or its migrations may not have
    // run. That is not an error the owner can act on from this page, so it
    // reads as "no policies" rather than as a broken section.
    return {
      status: 200,
      body: { applied: [], proposed: [], unavailable: message(err) } satisfies Record<string, unknown>,
    };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isScope(value: unknown): value is PolicyScope {
  return typeof value === 'string' && (POLICY_SCOPES as readonly string[]).includes(value);
}

function isAction(value: unknown): value is PolicyAction {
  return typeof value === 'string' && (POLICY_ACTIONS as readonly string[]).includes(value);
}

/**
 * POST: keep a proposal, or write a new rule.
 *
 * "Keep" is the same route because it is the same act from the page's side —
 * the owner deciding this rule is on — and one route means one reload.
 */
export async function writeEmailPolicy(
  pool: Pool,
  body: unknown,
  now: Date,
): Promise<RouteReply> {
  const input = (body ?? {}) as Record<string, unknown>;

  if (typeof input.keep === 'string' && input.keep.trim() !== '') {
    const kept = await keepPolicy(pool, input.keep.trim());
    if (!kept) return { status: 404, body: { error: 'That policy is no longer there.' } };
    return { status: 200, body: await policiesView(pool) };
  }

  if (!isScope(input.scope)) {
    return { status: 400, body: { error: `\`scope\` must be one of ${POLICY_SCOPES.join(', ')}` } };
  }
  if (!isAction(input.action)) {
    return { status: 400, body: { error: `\`action\` must be one of ${POLICY_ACTIONS.join(', ')}` } };
  }
  const matcher = typeof input.matcher === 'string' ? input.matcher : '';
  const params: PolicyParams = {};
  if (typeof input.agentId === 'string' && input.agentId.trim()) params.agentId = input.agentId.trim();
  if (typeof input.instruction === 'string' && input.instruction.trim()) params.instruction = input.instruction.trim();
  if (typeof input.note === 'string' && input.note.trim()) params.note = input.note.trim();
  if (typeof input.label === 'string' && input.label.trim()) params.label = input.label.trim();
  if (input.action === 'ignore') {
    params.category = 'promo';
    params.urgency = 'low';
  }

  const refusal = refusalFor({ scope: input.scope, matcher, action: input.action, params });
  if (refusal) return { status: 400, body: { error: refusal } };

  try {
    await createPolicy(
      pool,
      { scope: input.scope, matcher, action: input.action, params, origin: 'owner' },
      now,
    );
  } catch (err) {
    if (err instanceof PolicyRefusal) return { status: 400, body: { error: err.message } };
    throw err;
  }
  return { status: 200, body: await policiesView(pool) };
}

/** DELETE: take one back. Revoking something already revoked is still 200. */
export async function deleteEmailPolicy(
  pool: Pool,
  id: string,
  now: Date,
): Promise<RouteReply> {
  const revoked = await revokePolicy(pool, id, now);
  if (!revoked) return { status: 404, body: { error: 'That policy is no longer there.' } };
  return { status: 200, body: await policiesView(pool) };
}
