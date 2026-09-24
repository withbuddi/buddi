/**
 * Shared reads for the email tools. Every query is scoped to the accounts the
 * *owner* configured: a tool argument may narrow that to one of them, and it
 * can never widen it to a mailbox nobody added.
 */
import type { DbArea } from '@buddi/core/plugin';
import { z } from 'zod';
import { findAccount, listAccounts } from '../config.js';
import { normalizeAddress } from '../mail.js';
import type { AccountRecord } from '../ports.js';
import {
  DRAFT_COLUMNS,
  MESSAGE_COLUMNS,
  toDraft,
  toMessage,
  type DraftRecord,
  type MessageRecord,
} from '../rows.js';

/** `ctx.buddi.db`, a transaction's handle, or anything that answers a query as they do. */
type Db = Pick<DbArea, 'query'>;

/**
 * The triage policy version these tools write. Bump it when the categories or
 * the rules change: a re-triage then lands as a new row beside the old
 * decision, rather than quietly rewriting what was decided under the old policy.
 *
 * Version 2 is the taxonomy below. Version 1 was the money-only one, where
 * seven of eight categories named a kind of transaction and the urgency ladder
 * was defined entirely in money — so a client of many years writing to say she
 * was retiring had nowhere to land but `personal`/`low`, and the owner found it
 * himself, in Gmail, a day late.
 *
 * Rows written under version 1 are **left exactly as they are**. Re-triaging a
 * mailbox of history would cost one model call per message to restate verdicts
 * about mail the owner has already lived through, and the decisions are kept
 * for the record rather than to be acted on — nothing reads an old urgency to
 * decide whether to interrupt anyone. `processing_version` exists so the two
 * can coexist, and this is what it is for.
 */
export const PROCESSING_VERSION = 2;

/**
 * The categories triage may record.
 *
 * Founded on **what kind of thing this is to the owner**, not on whether money
 * is involved. The question each answers is "what would he have to deal with
 * here", and the five money categories are five of fourteen rather than seven
 * of eight — they earn their place, they no longer *are* the place.
 *
 * Ordered as they are reasoned about: people first, then obligations, then
 * safety, then money, then the noise.
 */
export const CATEGORIES = [
  // Someone is waiting on the owner. The single most common thing that used to
  // have nowhere to go but `personal`.
  'reply-needed',
  // A working relationship changes: a counterpart retires or moves on, a new
  // contact is named, an introduction, a reorganisation at a client.
  'relationship',
  // Something is offered to the owner personally: work, a client, a speaking
  // invitation, a proposal. Not marketing — marketing is `promo`.
  'opportunity',
  // A duty with a date and no money attached: a document to file, a form, a
  // renewal, an appointment, a legal or administrative notice.
  'obligation',
  // An account or security event: a sign-in, a password reset, a device added,
  // a breach notice, something claiming one of those.
  'security',
  // Money, still, and unchanged: these worked and they stay.
  'bill',
  'payment-failed',
  'bank-notice',
  'statement',
  'receipt',
  // A service the owner uses telling him something operational: a price
  // change, a plan ending, an outage, new terms. Not selling him anything.
  'service-notice',
  // A human writing to the owner with nothing waiting on him: news, thanks,
  // a note. `personal` is now what is left after `reply-needed` and
  // `relationship` have taken what they are owed.
  'personal',
  'promo',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * Categories written under an older policy version that the current taxonomy
 * no longer offers.
 *
 * Empty today, and deliberately so: every version-1 category survived into
 * version 2, so not one of the stored rows holds a value this build cannot
 * name. It is here because the next policy change may not be so lucky, and
 * `categoryLabel` must keep working the day it is not.
 */
export const LEGACY_CATEGORIES: readonly string[] = [];

/** Every category any stored row may hold, current or retired. */
export const KNOWN_CATEGORIES: readonly string[] = [...CATEGORIES, ...LEGACY_CATEGORIES];

/**
 * A human label for a stored category — including one this build has never
 * heard of.
 *
 * Reading a triage row must never be able to fail on its category. A row is
 * history: it was written under whatever policy was in force, and a view that
 * throws (or renders nothing) because a value left the enum turns a policy
 * change into a broken page. So an unknown value renders as itself.
 */
export function categoryLabel(value: string): string {
  const raw = (value ?? '').trim();
  if (raw === '') return 'uncategorised';
  return raw.replace(/-/g, ' ');
}

/** Whether a stored category is one this build's taxonomy still offers. */
export function isKnownCategory(value: string): boolean {
  return KNOWN_CATEGORIES.includes((value ?? '').trim());
}

/**
 * The urgency ladder. Three rungs, unchanged as *values* — which is why this
 * change needs no migration: `email.triage.urgency` carries a check constraint
 * naming exactly these three, and version 2 redefines what they mean rather
 * than adding a fourth.
 *
 * What changed is the definition. `urgent` used to mean "money is about to be
 * lost"; it now means "something is lost, missed or damaged if the owner does
 * not see this soon", and the loss may be a relationship, an opportunity, a
 * deadline or a standing. A person can be urgent now. The bar itself did not
 * move: a false alarm still costs more than a late one.
 */
export const URGENCIES = ['urgent', 'normal', 'low'] as const;

export type Urgency = (typeof URGENCIES)[number];

export const UUID = z.string().uuid('expected the id a tool gave you');

/** Default and hard cap for every listing. A tool argument cannot widen it. */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

export function boundedLimit(limit: number | undefined): number {
  return Math.min(Math.max(1, Math.trunc(limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
}

/** The `account` argument every read tool takes. Absent means all of them. */
export const ACCOUNT_ARG = z
  .string()
  .min(1)
  .describe(
    'Which mailbox to look in, by its address or the id a result gave you. Leave it out to look in every mailbox this installation has — that is the default, and usually the right one.',
  );

/**
 * The accounts one call may see, and how to name them back.
 *
 * This is what replaced "the configured account". A tool that says nothing gets
 * every enabled account; a tool that names one gets that one. Either way the
 * result is a *list* of ids to scope the SQL with and a map from id to record,
 * so every row that comes back can say which mailbox it is from — which is the
 * whole point of plural accounts: a subject line means something different
 * depending on which of the owner's addresses received it.
 */
export interface AccountScope {
  accounts: AccountRecord[];
  ids: string[];
  /** The record for an account id, for labelling rows. */
  byId: Map<string, AccountRecord>;
  /** The address of the one account in scope, when exactly one is. */
  only: AccountRecord | null;
}

function scopeOf(accounts: AccountRecord[]): AccountScope {
  return {
    accounts,
    ids: accounts.map((a) => a.id),
    byId: new Map(accounts.map((a) => [a.id, a])),
    only: accounts.length === 1 ? (accounts[0] as AccountRecord) : null,
  };
}

/** Nothing configured is a configuration fact with a fix, said in one line. */
const NONE_CONFIGURED =
  'no mail account is configured on this installation — add one under Settings → Email, or set GMAIL_USER and restart';

export async function accountScope(db: Db, ref?: string | undefined): Promise<AccountScope> {
  const named = ref?.trim();
  if (named) {
    const account = await findAccount(db, named);
    if (!account) {
      const known = await listAccounts(db);
      throw new Error(
        known.length === 0
          ? NONE_CONFIGURED
          : `no mail account here is ${named} (this installation has ${known.map((a) => a.address).join(', ')})`,
      );
    }
    return scopeOf([account]);
  }
  const accounts = await listAccounts(db);
  if (accounts.length === 0) throw new Error(NONE_CONFIGURED);
  return scopeOf(accounts);
}

/** Exactly one account — for a tool that has to send *from* somewhere. */
export async function requireOneAccount(db: Db, ref?: string | undefined): Promise<AccountRecord> {
  const scope = await accountScope(db, ref);
  if (scope.only) return scope.only;
  throw new Error(
    `this installation has ${scope.accounts.length} mail accounts (${scope.accounts
      .map((a) => a.address)
      .join(', ')}); say which one with \`account\``,
  );
}

/** The account a stored row belongs to. Never guessed, never defaulted. */
export async function accountOf(db: Db, accountId: string): Promise<AccountRecord> {
  const account = await findAccount(db, accountId, { enabledOnly: false });
  if (!account) throw new Error(`unknown mail account: ${accountId}`);
  return account;
}

/** Every address this account answers as: its own, and each of its aliases. */
export function ownAddresses(account: AccountRecord): string[] {
  return [account.address, ...account.aliases];
}

/**
 * The identities this account may send under: its address first, then aliases.
 *
 * The account's own address leads because it is the default and the only one
 * that is certainly the owner's to send as. The aliases follow in the order the
 * owner entered them on the settings page.
 *
 * ## Why nothing here looks at the original's To or Cc
 *
 * It used to: a reply left under whichever alias appeared in the original's
 * recipients. But `To` and `Cc` are written by the sender. Mail reaches a
 * mailbox through Bcc, through forwarding and through catch-all addresses, so
 * the headers do not say which identity the message was delivered to — they say
 * which one somebody typed. Anyone who knew the owner had a
 * `legal@` or `billing@` alias could put it on the `To` line of a message sent
 * somewhere else entirely and the proposed reply would go out under it.
 *
 * So the identity **defaults to the account's address**, and an alias is used
 * only when the owner chooses it: the send envelope carries these choices
 * (`fromChoices`) next to the `from` it will use, and the approval card is
 * where that choice is made. Delivery-envelope metadata (the SMTP RCPT TO,
 * `Delivered-To`, `X-Original-To`) would be trustworthy, but this build does
 * not capture it at ingest; until it does, the owner is the source of truth
 * and not the message.
 */
export function identityChoices(account: AccountRecord): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [account.address, ...account.aliases]) {
    const address = normalizeAddress(candidate);
    if (address === '' || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

/**
 * The identity a reply leaves under, before the owner has chosen anything: the
 * account's own address, always. See `identityChoices`.
 */
export function identityFor(account: AccountRecord): string {
  // Normalized exactly as `identityChoices` normalizes, so the default
  // identity is always one of the options the owner is offered. A stored
  // address that was never lowercased — a row inserted by hand — would
  // otherwise make the two disagree and take every send from that mailbox
  // down before it reached an approval card.
  return normalizeAddress(account.address);
}

export async function findMessage(db: Db, id: string): Promise<MessageRecord | null> {
  const { rows } = await db.query(
    `select ${MESSAGE_COLUMNS} from email.messages where id = $1`,
    [id],
  );
  return rows[0] ? toMessage(rows[0]) : null;
}

export async function requireMessage(db: Db, id: string): Promise<MessageRecord> {
  const message = await findMessage(db, id);
  if (!message) throw new Error(`unknown message: ${id}`);
  return message;
}

export async function findDraft(db: Db, id: string): Promise<DraftRecord | null> {
  const { rows } = await db.query(`select ${DRAFT_COLUMNS} from email.drafts where id = $1`, [id]);
  return rows[0] ? toDraft(rows[0]) : null;
}

export async function requireDraft(db: Db, id: string): Promise<DraftRecord> {
  const draft = await findDraft(db, id);
  if (!draft) throw new Error(`unknown draft: ${id}`);
  return draft;
}

/**
 * The latest triage decision for a message, or null.
 *
 * `processing_version desc` is what makes a re-triage under a new policy win
 * over the decision it replaced, without either row being destroyed.
 *
 * It never validates the stored category. A row written under an older policy
 * is history and must still read back: `categoryLabel` names whatever is there
 * and `policyVersion`/`currentPolicy` say which rules produced it, so a caller
 * that cares can tell an old verdict from a current one instead of discovering
 * it by rendering nothing.
 */
export async function latestTriage(
  db: Db,
  messageId: string,
): Promise<{
  category: string;
  categoryLabel: string;
  urgency: string;
  summary: string;
  actionNeeded: string | null;
  policyVersion: number;
  currentPolicy: boolean;
} | null> {
  const { rows } = await db.query(
    `select category, urgency, summary, action_needed, processing_version
       from email.triage
      where message_id = $1
      order by processing_version desc
      limit 1`,
    [messageId],
  );
  const row = rows[0];
  if (!row) return null;
  const version = Number(row.processing_version);
  return {
    category: row.category,
    categoryLabel: categoryLabel(row.category),
    urgency: row.urgency,
    summary: row.summary,
    actionNeeded: row.action_needed ?? null,
    policyVersion: version,
    currentPolicy: version === PROCESSING_VERSION,
  };
}

/**
 * Provenance, fail-closed. A tool that records something must know which agent
 * recorded it; guessing would put a draft in the wrong name.
 */
export function requireAgentId(agentId: string | undefined, tool: string): string {
  const id = agentId?.trim();
  if (!id) throw new Error(`${tool}: no agent id in the tool context; refusing to record`);
  return id;
}
