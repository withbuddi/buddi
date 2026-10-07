/**
 * The dashboard's side of an agent's `secret.request` card
 * (docs/owner-secrets.md §6, "Saved from a conversation"; surfaces/secret-request.ts).
 *
 *   POST /api/secrets                   save a set for one site, in one call; with
 *                                       `questionId` it answers that card too
 *   POST /api/secrets/request/decline   "I'll sign in myself", or the card cancelled
 *
 * The values cross one boundary — this route's body — into core's ownerOnly
 * `secrets.put_set`, which writes them to the vault. They are never in a chat
 * message, an event, a question's answer or a log line: what the agent hears
 * is the names and whether the form was filled.
 *
 * Save and fill is the owner's approval of the fill: it records one
 * `secrets.use_set` action for the set, approved by that press, then fills the
 * fields the agent named through `secret.fill` as the agent — which now goes
 * through without a card, because the set's first use is approved.
 */
import type { Pool } from 'pg';
import {
  createAction,
  decideApproval,
  describeSecretSetUse,
  executeApproved,
  getQuestion,
  OWNER_AGENT_ID,
  SECRETS_SET_TOOL,
  SECRETS_TOOL_VERSION,
  VAULT_LOCKED_SAVE,
  type CoreToolContext,
  type Question,
  type SecretRequestCard,
  type SecretSetApproval,
  type ToolRegistry,
} from '@buddi/core';
import type { BrowserController } from '@buddi/tool-browser';
import {
  normalizeSite,
  outcomeStamp,
  outcomeTurnText,
  requestOrigins,
  secretNameFor,
  type SecretRequestFieldOutcome,
  type SecretRequestOutcome,
} from '../surfaces/secret-request.js';
import { WEB_SURFACE, WEB_WORKER } from './write.js';
import type { RouteReply } from './secrets.js';

export interface SecretRequestRouteDeps {
  pool: Pool;
  registry: ToolRegistry;
  ctx: Omit<CoreToolContext, 'db'>;
  now: () => Date;
  browser?: Partial<Pick<BrowserController, 'handOver'>> | undefined;
  /** The agent carries on with the outcome; the thread shows `stamp`. */
  carryOn?: ((input: { conversationId: string; agentId: string; text: string; stamp: string }) => Promise<string | null>) | undefined;
  log?: ((line: string) => void) | undefined;
}

const reply = (status: number, body: unknown): RouteReply => ({ status, body });

/** The field kinds a card's row may be. */
const KINDS = new Set(['username', 'password', 'totp', 'other']);

/** One field as the page posts it: the label it showed, the kind, the value typed. */
interface PostedField { label: string; kind: 'username' | 'password' | 'totp' | 'other'; value: string }

function postedFields(raw: unknown): PostedField[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'Send the fields to save: [{ label, kind, value }].';
  if (raw.length > 12) return 'At most 12 fields at once.';
  const out: PostedField[] = [];
  for (const item of raw) {
    const { label, kind, value } = (item ?? {}) as Record<string, unknown>;
    if (typeof label !== 'string' || label.trim() === '' || label.length > 60) return 'Each field needs a label of up to 60 characters.';
    if (typeof kind !== 'string' || !KINDS.has(kind)) return 'Each field\'s kind is username, password, totp or other.';
    if (typeof value !== 'string') return `"${label.trim()}" needs a value.`;
    // An empty row is a row the owner left blank: skipped, not an error.
    if (value.trim() === '') continue;
    if (value.length > 16_384) return `"${label.trim()}" is too long.`;
    out.push({ label: label.trim().replace(/\s+/g, ' '), kind: kind as PostedField['kind'], value });
  }
  if (out.length === 0) return 'Type at least one value.';
  return out;
}

/** Names already taken, so a new one gets " 2" rather than overwriting an old secret. */
async function uniqueNames(pool: Pick<Pool, 'query'>, wanted: readonly string[]): Promise<string[]> {
  const { rows } = await pool.query(`select lower(name) as name from core.secrets`);
  const taken = new Set(rows.map((row: { name: string }) => row.name));
  return wanted.map((name) => {
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${name} ${n}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/** The card this question is, when it is an open `secret.request`. */
function openRequest(question: Question | null, now: Date): { question: Question; card: SecretRequestCard } | string {
  if (!question) return 'That card is gone.';
  if (question.answeredAt || Date.parse(question.expiresAt) <= now.getTime()) return 'That card is no longer waiting.';
  if (question.request?.kind !== 'secret.request') return 'That card is not a sign-in card.';
  return { question, card: question.request };
}

/** Claim the card so a second press (another tab, a double tap) saves nothing twice. */
async function claim(pool: Pick<Pool, 'query'>, id: string, now: Date): Promise<boolean> {
  const { rows } = await pool.query(
    `update core.questions set answered_at = $2, answered_via = $3 where id = $1 and answered_at is null and expires_at > $2 returning id`,
    [id, now, WEB_SURFACE],
  );
  return rows.length > 0;
}

/** Put the card back when the save it claimed for did not happen (a locked vault). */
async function unclaim(pool: Pick<Pool, 'query'>, id: string): Promise<void> {
  await pool.query(`update core.questions set answered_at = null, answered_via = null where id = $1`, [id]);
}

/** Record what came of the card on its row: the outcome, names only. */
async function settle(pool: Pick<Pool, 'query'>, id: string, outcome: SecretRequestOutcome): Promise<void> {
  await pool.query(`update core.questions set answer = $2 where id = $1`, [id, JSON.stringify(outcome)]);
}

/** The ids of each saved secret's `browser.field` bindings — the page, the site, `*.` the site — by name. */
async function fieldBindings(pool: Pick<Pool, 'query'>, names: readonly string[]): Promise<Map<string, string[]>> {
  const { rows } = await pool.query(
    `select s.name, b.id::text as id from core.secrets s join core.secret_bindings b on b.secret_id = s.id
      where s.name = any($1::text[]) and b.kind = 'browser.field' order by b.created_at, b.id`,
    [names],
  );
  const out = new Map<string, string[]>();
  for (const row of rows as Array<{ name: string; id: string }>) out.set(row.name, [...(out.get(row.name) ?? []), row.id]);
  return out;
}

/**
 * `POST /api/secrets` — a set of secrets for one site, saved in one call.
 *
 * `{ site, fields: [{ label, kind, value }] }` saves them, named after the site
 * and each label ("Wikipedia password"), bound as `browser.field` to the site
 * and every host under it, asking the first time. With `questionId` the site
 * and the places come from that card, and `then` says what follows:
 * `fill` (Save and fill) or `save` (Save only, and the owner gets the page).
 */
export async function saveSecretSet(deps: SecretRequestRouteDeps, body: unknown): Promise<RouteReply> {
  if (typeof body !== 'object' || body === null) return reply(400, { error: 'Send `{ site, fields }`.' });
  const input = body as Record<string, unknown>;
  const fields = postedFields(input.fields);
  if (typeof fields === 'string') return reply(400, { error: fields });
  const now = deps.now();
  const questionId = typeof input.questionId === 'string' ? input.questionId : undefined;
  const then = input.then === 'fill' ? 'fill' : 'save';

  let site: string | undefined;
  let origins: string[];
  let request: { question: Question; card: SecretRequestCard } | undefined;
  if (questionId !== undefined) {
    if (!/^[0-9a-f-]{36}$/i.test(questionId)) return reply(400, { error: 'questionId is a card id.' });
    const open = openRequest(await getQuestion(deps.pool, questionId), now);
    if (typeof open === 'string') return reply(409, { error: open });
    request = open;
    site = open.card.site;
    origins = open.card.origins;
  } else {
    site = normalizeSite(typeof input.site === 'string' ? input.site : undefined);
    if (!site) return reply(400, { error: 'Name the site, like wikipedia.org.' });
    origins = requestOrigins(site, undefined);
  }

  const names = await uniqueNames(deps.pool, fields.map((field) => secretNameFor(site!, field.label)));
  const bindings = origins.map((origin) => ({ kind: 'browser.field', target: origin, rule: 'first-time' as const }));
  if (request && !(await claim(deps.pool, request.question.id, now))) return reply(409, { error: 'That card is no longer waiting.' });

  const saved = await deps.registry.invoke('secrets.put_set', {
    site,
    ...(request ? { conversationId: request.question.conversationId } : {}),
    items: fields.map((field, index) => ({ name: names[index]!, value: field.value, totp: field.kind === 'totp', bindings })),
  }, { ...deps.ctx, agentId: OWNER_AGENT_ID, db: deps.pool, now: deps.now } as CoreToolContext);
  if (!saved.ok) {
    if (request) await unclaim(deps.pool, request.question.id).catch(() => undefined);
    if (saved.message === VAULT_LOCKED_SAVE) {
      return reply(409, { error: VAULT_LOCKED_SAVE, locked: true });
    }
    return reply(400, { error: saved.message });
  }
  const savedNames = (saved.output as { names: string[] }).names;
  if (!request) return reply(200, { saved: savedNames, site });

  const { question, card } = request;
  let filled = false;
  const report: SecretRequestFieldOutcome[] = [];
  if (then === 'fill') {
    filled = await approveAndFill(deps, { question, card, fields, names: savedNames }, report);
  } else {
    await deps.browser?.handOver?.({ conversationId: question.conversationId, agentId: question.agentId }).catch(() => false);
  }
  const outcome: SecretRequestOutcome = { saved: savedNames, filled, ...(report.length > 0 ? { fields: report } : {}) };
  await settle(deps.pool, question.id, outcome).catch(() => undefined);
  const stamp = outcomeStamp(outcome, card.site, fields.map((field) => field.label));
  await deps.carryOn?.({
    conversationId: question.conversationId,
    agentId: question.agentId,
    text: outcomeTurnText(outcome, { filling: then === 'fill' }),
    stamp,
  }).catch((err: unknown) => deps.log?.(`secrets: carrying on after the sign-in card failed: ${err instanceof Error ? err.message : String(err)}`));
  return reply(200, { saved: savedNames, filled, stamp });
}

/**
 * Save and fill, after the save: one approval for the set (the press is the
 * owner's yes), then each field the agent named filled through `secret.fill`
 * as that agent. A field that looked like a card number, a CVV, an SSN or a
 * one-time code is left out of both: it asks on its own first use.
 */
async function approveAndFill(
  deps: SecretRequestRouteDeps,
  input: { question: Question; card: SecretRequestCard; fields: readonly PostedField[]; names: readonly string[] },
  report: SecretRequestFieldOutcome[] = [],
): Promise<boolean> {
  const { question, card } = input;
  const plan = input.fields.map((field, index) => {
    const asked = card.fields.find((candidate) => candidate.label.toLowerCase() === field.label.toLowerCase());
    return { name: input.names[index]!, label: field.label, page: asked?.name ?? asked?.label, ref: asked?.ref, warned: Boolean(asked?.warning) };
  }).filter((item) => !item.warned);
  if (plan.length === 0) return false;
  const bindings = await fieldBindings(deps.pool, plan.map((item) => item.name));
  const items: SecretSetApproval['items'] = plan.flatMap((item) => {
    const [bindingId, ...alsoBindingIds] = bindings.get(item.name) ?? [];
    return bindingId ? [{ bindingId, ...(alsoBindingIds.length > 0 ? { alsoBindingIds } : {}), secret: item.name, kind: 'browser.field', field: item.label.slice(0, 80) }] : [];
  });
  if (items.length === 0) return false;
  const args: SecretSetApproval = { site: card.site, plugin: 'browser', items };
  const described = describeSecretSetUse(args);
  const now = deps.now();
  const action = await createAction(deps.pool, {
    tool: SECRETS_SET_TOOL,
    toolVersion: SECRETS_TOOL_VERSION,
    agentId: question.agentId,
    conversationId: question.conversationId,
    canonicalArgs: args,
    envelope: described.envelope,
    preview: described.preview,
    tier: 'gated',
    now,
  });
  const decided = await decideApproval(deps.pool, { actionId: action.id, decision: 'approved', by: deps.ctx.ownerId, via: WEB_SURFACE, now, registry: deps.registry });
  if (!decided.ok) {
    deps.log?.(`secrets: the set's approval could not be recorded: ${decided.message}`);
    return false;
  }
  const executed = await executeApproved(deps.pool, {
    actionId: action.id,
    registry: deps.registry,
    ctx: { ...deps.ctx, db: deps.pool, now: deps.now } as CoreToolContext,
    worker: WEB_WORKER,
    now,
  });
  if (!executed.ok) {
    deps.log?.(`secrets: the set's approval did not go through: ${executed.message}`);
    return false;
  }
  // Approved for the set. Each field is filled by its label on the latest page (refs move once a fill
  // redraws the page), its ref the fallback; one the agent named neither for is the agent's to fill.
  const fillable = plan.filter((item) => item.page || item.ref);
  for (const item of plan) report.push({ name: item.name, label: item.page ?? item.label, ...(item.ref ? { ref: item.ref } : {}), filled: false });
  if (fillable.length === 0) return false;
  let all = fillable.length === plan.length;
  for (const item of fillable) {
    const result = await deps.registry.invoke('secret.fill', { name: item.name, ...(item.page ? { label: item.page } : {}), ...(item.ref ? { ref: item.ref } : {}) }, {
      ...deps.ctx,
      agentId: question.agentId,
      conversationId: question.conversationId,
      db: deps.pool,
      now: deps.now,
    } as CoreToolContext);
    const output = result.ok ? result.output as { filled?: unknown; ref?: unknown } | null : null;
    if (!result.ok || output?.filled !== true) {
      all = false;
      deps.log?.(`secrets: filling "${item.name}" after Save and fill did not go through${result.ok ? '' : `: ${result.message}`}`);
      continue;
    }
    const done = report.find((entry) => entry.name === item.name);
    if (done) {
      done.filled = true;
      if (typeof output.ref === 'string') done.ref = output.ref;
    }
  }
  return all;
}

/**
 * `POST /api/secrets/request/decline` — `{ questionId, reason }`: "I'll sign in
 * myself" hands the page to the owner the way Take over does; `cancelled`
 * just closes the card. The agent hears `{ declined: reason }`.
 */
export async function declineSecretRequest(deps: SecretRequestRouteDeps, body: unknown): Promise<RouteReply> {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const questionId = typeof input.questionId === 'string' ? input.questionId : '';
  if (!/^[0-9a-f-]{36}$/i.test(questionId)) return reply(400, { error: 'questionId is a card id.' });
  const reason = input.reason === 'cancelled' ? 'cancelled' : 'sign-in-myself';
  const now = deps.now();
  const open = openRequest(await getQuestion(deps.pool, questionId), now);
  if (typeof open === 'string') return reply(409, { error: open });
  if (!(await claim(deps.pool, questionId, now))) return reply(409, { error: 'That card is no longer waiting.' });
  const { question, card } = open;
  if (reason === 'sign-in-myself') {
    await deps.browser?.handOver?.({ conversationId: question.conversationId, agentId: question.agentId }).catch(() => false);
  }
  const outcome: SecretRequestOutcome = { declined: reason };
  await settle(deps.pool, questionId, outcome).catch(() => undefined);
  const stamp = outcomeStamp(outcome, card.site, []);
  await deps.carryOn?.({ conversationId: question.conversationId, agentId: question.agentId, text: outcomeTurnText(outcome), stamp })
    .catch((err: unknown) => deps.log?.(`secrets: carrying on after the sign-in card failed: ${err instanceof Error ? err.message : String(err)}`));
  return reply(200, { declined: reason, stamp });
}
