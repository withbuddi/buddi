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
 */
export const PROCESSING_VERSION = 1;

/** The categories triage may record. Unknown values are refused by zod. */
export const CATEGORIES = [
  'bill',
  'bank-notice',
  'payment-failed',
  'statement',
  'receipt',
  'personal',
  'promo',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const URGENCIES = ['urgent', 'normal', 'low'] as const;

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

/** The latest triage decision for a message, or null. */
export async function latestTriage(
  db: Pool,
  messageId: string,
): Promise<{ category: string; urgency: string; summary: string; actionNeeded: string | null } | null> {
  const { rows } = await db.query(
    `select category, urgency, summary, action_needed
       from email.triage
      where message_id = $1
      order by processing_version desc
      limit 1`,
    [messageId],
  );
  const row = rows[0];
  return row
    ? {
        category: row.category,
        urgency: row.urgency,
        summary: row.summary,
        actionNeeded: row.action_needed ?? null,
      }
    : null;
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
