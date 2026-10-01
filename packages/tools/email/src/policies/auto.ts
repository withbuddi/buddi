/**
 * Rules that keep themselves (docs/email.md §5, "What keeps itself").
 *
 * The owner asked for this in so many words: dozens of cards, each one a
 * newsletter he would never read, is buddi making work rather than saving it.
 * So a learned rule skips the card and is kept at once — written through the
 * same apply as a kept card, recorded on `core.proposals` as kept by `auto`,
 * listed under Learned on the Mail page with Undo — when, and only when:
 *
 *  - **It only quiets.** The action is `ignore`; an on-arrival action, if it
 *    carries one, is `archive` or `mark-read`. Never `move`, never trash,
 *    never `notify`, `draft`, `hand-to-agent` or `wake`. A rule that keeps
 *    itself never writes an on-arrival action at all today.
 *  - **The owner never wrote to the sender**, from any mailbox. The veto that
 *    stops a proposal stops this harder: a person who gets answers is never
 *    silenced without asking.
 *  - **And one of two reasons holds:**
 *     - `bulk`: the sender's mail says it is sent to many — a message from
 *       them carried `List-Unsubscribe`, `Precedence: bulk|list|junk` or a
 *       `List-Id`, or the address is a no-reply one.
 *     - `track-record`: the owner has kept five rules of this kind (and
 *       discarded none since); core counts it from his own decisions only
 *       (`proposals.trackRecord`).
 *
 * The headers are the sender's own words. That is acceptable here because
 * they can only ever push towards silence for a sender the owner has never
 * written to and whose last three messages were already judged promo or low —
 * a forged `List-Unsubscribe` makes a newsletter look like a newsletter.
 *
 * Once a day at most, the owner hears what kept itself: one line, collapsed
 * under a per-day key, nothing when nothing did (`tellOwnerLearned`).
 */
import type { BuddiHost, DbArea, Proposal, ProposePolicyInput, ToolContext } from '@buddi/core/plugin';
import { localDateString } from '@buddi/core/plugin';
import { isNoReplyAddress, normalizeAddress } from '../mail.js';
import type { PolicyAction, PolicyParams } from './gate.js';
import { learnedKind, ruleOf, writeLearnedRule } from './learned.js';
import { policyForSender, revokePolicy, toPolicy, POLICY_COLUMNS } from './store.js';

type Db = Pick<DbArea, 'query'>;

/** Why a rule kept itself. */
export type AutoReason = 'bulk' | 'track-record';

/** The actions that only quiet a sender. */
export const QUIET_ACTIONS: readonly PolicyAction[] = ['ignore'];

/** The on-arrival actions a rule that keeps itself may carry. */
export const QUIET_ARRIVALS = ['archive', 'mark-read'] as const;

/**
 * May this rule keep itself, and why. Pure: the facts are read by the caller.
 * Null is the answer far more often than not, and then it is a card.
 */
export function mayKeepItself(input: {
  scope: string;
  action: string;
  params?: PolicyParams;
  ownerHasWritten: boolean;
  bulk: boolean;
  trusted: boolean;
}): AutoReason | null {
  if (input.ownerHasWritten) return null;
  if (input.scope !== 'sender') return null;
  if (!QUIET_ACTIONS.includes(input.action as PolicyAction)) return null;
  const arrival = input.params?.onArrival;
  if (arrival && !(QUIET_ARRIVALS as readonly string[]).includes(arrival.kind)) return null;
  if (input.bulk) return 'bulk';
  if (input.trusted) return 'track-record';
  return null;
}

/**
 * Is this sender's mail sent to many, in this account? A no-reply address, or
 * any message from them that carried `List-Unsubscribe` / `Precedence: bulk`
 * (`bulk`) or a `List-Id`.
 */
export async function isBulkSender(db: Db, accountId: string, address: string): Promise<boolean> {
  const matcher = normalizeAddress(address);
  if (matcher === '' || !accountId) return false;
  if (isNoReplyAddress(matcher)) return true;
  const { rows } = await db.query<{ bulk: boolean }>(
    `select exists (
       select 1 from email.messages m
        where m.account_id = $2::uuid and m.direction = 'in'
          and email.address_of(m.from_addr) = $1
          and (m.bulk or m.list_id is not null)
     ) as bulk`,
    [matcher, accountId],
  );
  return rows[0]?.bulk === true;
}

/**
 * Has the owner ever sent mail to this address, from **any** mailbox? Stricter
 * than the per-account veto on proposals: a rule that keeps itself does not
 * get the benefit of a history split across accounts.
 */
export async function ownerHasWrittenAnywhere(db: Db, address: string): Promise<boolean> {
  const matcher = normalizeAddress(address);
  if (matcher === '') return true;
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from email.messages m
      where m.direction = 'out'
        and (
          exists (select 1 from jsonb_array_elements_text(m.to_addrs) as a(addr) where email.address_of(a.addr) = $1)
          or exists (select 1 from jsonb_array_elements_text(m.cc) as a(addr) where email.address_of(a.addr) = $1)
        )`,
    [matcher],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** What `keepLearnedItself` needs from the host. */
export type AutoHost = Pick<BuddiHost, 'db' | 'owner'> & { proposals: NonNullable<BuddiHost['proposals']> };

/**
 * Propose the rule and keep it in one transaction: the card (never
 * announced), the rule through the same apply as a kept card, and the card
 * marked kept by `auto`. Returns the kept card, or null when the owner
 * discarded the same rule in the last 90 days (then nothing happens at all)
 * or the rule could not be written (then the caller proposes it as a card).
 */
export async function keepLearnedItself(
  host: AutoHost,
  ask: Omit<ProposePolicyInput, 'plugin'>,
  reason: AutoReason,
  now: Date,
  run: Pick<ToolContext, 'agentId' | 'conversationId' | 'toolUseId' | 'provenance'> | null,
): Promise<Proposal | null> {
  try {
    return await host.db.transaction(async (tx) => {
      const result = await host.proposals.proposePolicy(run, ask, tx, { announce: false });
      const card = result.ok ? result.proposal : result.reason === 'already-open' ? result.existing : null;
      if (!card) return null;
      return keepCardItself(host, tx, card, reason, now);
    });
  } catch (err) {
    if (err instanceof NotKept) return null;
    throw err;
  }
}

class NotKept extends Error {}

/** Write the rule an open card describes and mark the card kept by `auto`, inside `tx`. Throws `NotKept` to roll back. */
async function keepCardItself(host: AutoHost, tx: Db, card: Proposal, reason: AutoReason, now: Date): Promise<Proposal> {
  const written = await writeLearnedRule(tx, card, now, { keptBy: 'auto', autoReason: reason });
  if (!written.ok) throw new NotKept(written.note);
  const kept = await host.proposals.keepItself(card.id, tx);
  if (!kept) throw new NotKept('the card was decided meanwhile');
  return kept;
}

/**
 * The one-time sweep, run on every start and idempotent: every open email
 * card that qualifies as bulk today is kept the same way, so the pile that
 * was waiting before this build disappears into Learned. Only the `bulk`
 * reason: the track record decides new rules, not ones already waiting.
 * A sender with a live rule of any kind is left alone — that rule is the
 * owner's. Returns how many were kept.
 */
export async function sweepOpenBulkCards(host: AutoHost, now: Date): Promise<number> {
  const open = await host.proposals.listOpen();
  let kept = 0;
  for (const card of open) {
    const rule = ruleOf(card.payload);
    if (!rule.ok || !rule.accountId) continue;
    const ownerHasWritten = await ownerHasWrittenAnywhere(host.db, rule.matcher);
    const bulk = rule.scope === 'sender' ? await isBulkSender(host.db, rule.accountId, rule.matcher) : false;
    const reason = mayKeepItself({ scope: rule.scope, action: rule.action, params: rule.params, ownerHasWritten, bulk, trusted: false });
    if (reason !== 'bulk') continue;
    if (await policyForSender(host.db, rule.matcher, rule.accountId)) continue;
    try {
      await host.db.transaction((tx) => keepCardItself(host, tx, card, reason, now));
      kept += 1;
    } catch (err) {
      if (!(err instanceof NotKept)) throw err;
    }
  }
  return kept;
}

/** The kind an old card is, when it carries none (cards from before kinds). */
export function kindOfCard(card: Pick<Proposal, 'payload'>): string {
  if (typeof card.payload.kind === 'string' && card.payload.kind) return card.payload.kind;
  const params = (card.payload.params ?? {}) as PolicyParams;
  return learnedKind(String(card.payload.action ?? ''), params.category);
}

/* ------------------------------------------------------------------ *
 * The owner hears about it once a day
 * ------------------------------------------------------------------ */

/** The Mail page, where Learned lists them. */
export const LEARNED_ROUTE = '#/p/email/mail';

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "buddi learned 7 rules: quieted 5 newsletters and 2 senders — review". */
export function learnedLine(counts: { bulk: number; trackRecord: number }): string | null {
  const total = counts.bulk + counts.trackRecord;
  if (total === 0) return null;
  const parts = [
    counts.bulk > 0 ? plural(counts.bulk, 'newsletter') : null,
    counts.trackRecord > 0 ? plural(counts.trackRecord, 'sender') : null,
  ].filter((p): p is string => p !== null);
  return `buddi learned ${plural(total, 'rule')}: quieted ${parts.join(' and ')} — review`;
}

/** Where the open "buddi learned" line is kept (`email.settings`): see `tellOwnerLearned`. */
export const LEARNED_LINE_KEY = 'learned_line';

/** The line being written: its notification, its dedupe key, and the local day it was opened. */
interface LearnedLineState {
  lineId: string;
  key: string;
  opened: string;
}

async function readLineState(db: Db): Promise<LearnedLineState | null> {
  const { rows } = await db.query<{ value: unknown }>(`select value from email.settings where key = $1`, [LEARNED_LINE_KEY]);
  const v = rows[0]?.value as Partial<LearnedLineState> | undefined;
  if (!v || typeof v.lineId !== 'string' || typeof v.key !== 'string' || typeof v.opened !== 'string') return null;
  return v as LearnedLineState;
}

async function writeLineState(db: Db, state: LearnedLineState, now: Date): Promise<void> {
  await db.query(
    `insert into email.settings (key, value, updated_at) values ($1, $2::jsonb, $3)
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [LEARNED_LINE_KEY, JSON.stringify(state), now],
  );
}

/** Rules that kept themselves on a line (`line`), or not told yet (null), by reason; undone ones left out. */
async function keptOn(db: Db, line: string | null): Promise<{ bulk: number; trackRecord: number; ids: string[] }> {
  const { rows } = await db.query<{ id: string; auto_reason: string | null; revoked: boolean }>(
    `select id, auto_reason, revoked_at is not null as revoked
       from email.policies
      where kept_by = 'auto' and learned_line is not distinct from $1`,
    [line],
  );
  const live = rows.filter((r) => !r.revoked);
  return {
    bulk: live.filter((r) => r.auto_reason === 'bulk').length,
    trackRecord: live.filter((r) => r.auto_reason !== 'bulk').length,
    ids: rows.map((r) => String(r.id)),
  };
}

async function markTold(db: Db, ids: readonly string[], line: string): Promise<void> {
  if (ids.length === 0) return;
  await db.query(`update email.policies set learned_line = $2 where id = any($1::uuid[])`, [ids, line]);
}

/**
 * Tell the owner what kept itself, in one line waiting for the end-of-day
 * message (`today`). The line is updated while it waits, never repeated: a
 * rule kept after that day's message went out opens the next line, which the
 * next day's rules fold into, so a date never gets a second line. Each rule
 * is told on exactly one line (`policies.learned_line`). A line still waiting
 * after two days is left as it is and a fresh one opened. Nothing is sent
 * when nothing new kept itself. Never throws: the rules stand either way.
 */
export async function tellOwnerLearned(host: Pick<BuddiHost, 'db' | 'owner'>, now: Date): Promise<string | null> {
  const notify = host.owner.notify;
  if (!notify) return null;
  try {
    const timezone = host.owner.timezone || 'UTC';
    const today = localDateString(now, timezone);
    const yesterday = localDateString(new Date(now.getTime() - 86_400_000), timezone);
    const fresh = await keptOn(host.db, null);
    if (fresh.bulk + fresh.trackRecord === 0) return null;
    const say = async (key: string, counts: { bulk: number; trackRecord: number }): Promise<{ id: string; title: string } | null> => {
      const title = learnedLine(counts);
      if (!title) return null;
      const { id } = await notify({
        urgency: 'today',
        title,
        text: 'Each is under Learned on the Mail page, with Undo.',
        link: { route: LEARNED_ROUTE },
        dedupeKey: key,
      });
      return { id, title };
    };

    const state = await readLineState(host.db);
    if (state && state.opened >= yesterday) {
      // The open line, with what is new. The same id back means it was still
      // waiting, and now says more.
      const told = await keptOn(host.db, state.lineId);
      const said = await say(state.key, { bulk: told.bulk + fresh.bulk, trackRecord: told.trackRecord + fresh.trackRecord });
      if (said && said.id === state.lineId) {
        await markTold(host.db, fresh.ids, state.lineId);
        return said.title;
      }
      // It had gone out: this is the next line, and it says only what is new.
      const next = await say(state.key, fresh);
      if (!next) return null;
      await markTold(host.db, fresh.ids, next.id);
      await writeLineState(host.db, { lineId: next.id, key: state.key, opened: today }, now);
      return next.title;
    }

    const key = `learned:${today}`;
    const said = await say(key, fresh);
    if (!said) return null;
    await markTold(host.db, fresh.ids, said.id);
    await writeLineState(host.db, { lineId: said.id, key, opened: today }, now);
    return said.title;
  } catch (err) {
    console.error(`email: could not tell the owner what it learned: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * The Learned list, and its Undo
 * ------------------------------------------------------------------ */

/** One rule that kept itself, as the Mail page lists it. */
export interface LearnedRule {
  id: string;
  accountId: string | null;
  matcher: string;
  action: string;
  params: PolicyParams;
  autoReason: string | null;
  keptAt: string | null;
  revokedAt: string | null;
  proposalId: string | null;
  /** Mailbox changes it made on arrival that can still be put back. */
  arrivalChanges: string[];
}

/** The rules that kept themselves, newest first, undone ones included (they say so). */
export async function learnedRules(db: Db, limit = 50): Promise<LearnedRule[]> {
  const { rows } = await db.query(
    `select ${POLICY_COLUMNS},
            coalesce((select array_agg(a.id::text order by a.created_at desc)
                        from email.mailbox_actions a
                       where a.policy_id = p.id and a.kind <> 'undo' and a.undone_at is null), '{}') as arrival_changes
       from email.policies p
      where p.kept_by = 'auto'
      order by p.kept_at desc nulls last, p.id desc
      limit $1`,
    [limit],
  );
  return rows.map((row: Record<string, any>) => {
    const policy = toPolicy(row);
    return {
      id: policy.id,
      accountId: policy.accountId,
      matcher: policy.matcher,
      action: policy.action,
      params: policy.params,
      autoReason: policy.autoReason ?? null,
      keptAt: policy.keptAt ?? null,
      revokedAt: policy.revokedAt,
      proposalId: policy.proposalId ?? null,
      arrivalChanges: Array.isArray(row.arrival_changes) ? row.arrival_changes.map(String) : [],
    };
  });
}

/**
 * Undo a rule that kept itself: revoke it, and turn its card into the
 * owner's discard — so the same rule is not learned again for 90 days and the
 * kind's track record starts over. Returns the rule as it is now, or null.
 */
export async function undoLearnedRule(
  host: Pick<BuddiHost, 'db'> & { proposals: NonNullable<BuddiHost['proposals']> },
  id: string,
  now: Date,
): Promise<LearnedRule | null> {
  const rules = await learnedRules(host.db, 500);
  const rule = rules.find((r) => r.id === id);
  if (!rule) return null;
  await host.db.transaction(async (tx) => {
    await revokePolicy(tx, id, now);
    if (rule.proposalId) await host.proposals.takeBack(rule.proposalId, { reason: 'undone by the owner', within: tx });
  });
  return { ...rule, revokedAt: rule.revokedAt ?? now.toISOString() };
}
