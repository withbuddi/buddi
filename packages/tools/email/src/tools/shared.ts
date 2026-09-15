/**
 * Shared reads for the email tools. Every query is scoped to the configured
 * account: there is one owner and one mailbox, and a tool argument can never
 * widen that.
 */
import type { Pool } from 'pg';
import { z } from 'zod';
import { currentAccount } from '../config.js';
import type { AccountRecord } from '../ports.js';
import {
  DRAFT_COLUMNS,
  MESSAGE_COLUMNS,
  toDraft,
  toMessage,
  type DraftRecord,
  type MessageRecord,
} from '../rows.js';

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

export async function requireAccount(db: Pool): Promise<AccountRecord> {
  const account = await currentAccount(db);
  if (!account) {
    throw new Error(
      'no mail account is configured on this installation (set GMAIL_USER and restart)',
    );
  }
  return account;
}

export async function findMessage(db: Pool, id: string): Promise<MessageRecord | null> {
  const { rows } = await db.query(
    `select ${MESSAGE_COLUMNS} from email.messages where id = $1`,
    [id],
  );
  return rows[0] ? toMessage(rows[0]) : null;
}

export async function requireMessage(db: Pool, id: string): Promise<MessageRecord> {
  const message = await findMessage(db, id);
  if (!message) throw new Error(`unknown message: ${id}`);
  return message;
}

export async function findDraft(db: Pool, id: string): Promise<DraftRecord | null> {
  const { rows } = await db.query(`select ${DRAFT_COLUMNS} from email.drafts where id = $1`, [id]);
  return rows[0] ? toDraft(rows[0]) : null;
}

export async function requireDraft(db: Pool, id: string): Promise<DraftRecord> {
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
  db: Pool,
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
