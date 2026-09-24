/**
 * Row shapes and the mapping to them. Postgres hands `bigint` back as a string
 * (js numbers cannot hold the full range); UIDs and UIDVALIDITY are well inside
 * the safe integer range, so they are converted here, once, rather than being
 * compared as strings somewhere subtle.
 */
import { FOLDER_KINDS, type FolderKind } from './folders.js';
import type { AccountRecord, AttachmentInfo } from './ports.js';

export const ACCOUNT_COLUMNS =
  'id, address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name, ' +
  'aliases, display_name, enabled, added_via, folders_discovered_at, created_at';

export function toAccount(row: Record<string, any>): AccountRecord {
  return {
    id: String(row.id),
    address: row.address,
    imapHost: row.imap_host,
    imapPort: Number(row.imap_port),
    smtpHost: row.smtp_host,
    smtpPort: Number(row.smtp_port),
    authMode: row.auth_mode,
    secretName: row.secret_name,
    // `text[]` comes back as a real array; a row read before the column existed
    // reads as none, which is the same thing as "this account has no aliases".
    aliases: stringArray(row.aliases),
    displayName: row.display_name ?? null,
    enabled: row.enabled !== false,
    addedVia: row.added_via === 'page' ? 'page' : 'env',
    // Null until folder discovery has completed for this account — see
    // `folders_discovered_at` in migration 008 and `discoverFolders`.
    foldersDiscoveredAt: iso(row.folders_discovered_at),
    createdAt: iso(row.created_at),
  };
}

/**
 * One folder of one account: what it is, whether buddi polls it, and the
 * cursor into it. The table was called `mailboxes` until threads arrived
 * (migration 007); it is the same row with the two columns discovery needs.
 */
export interface FolderRecord {
  id: string;
  accountId: string;
  name: string;
  kind: FolderKind;
  /** True for the folders the poll walks: the inbox and Sent. */
  synced: boolean;
  uidValidity: number | null;
  lastUid: number;
  /**
   * The HIGHESTMODSEQ the last flag re-sync of this folder saw, as a decimal
   * string, or null when there is none to ask CHANGEDSINCE with (migration 015).
   */
  highestModseq: string | null;
}

export const FOLDER_COLUMNS =
  'id, account_id, name, kind, synced, uidvalidity, last_uid, highest_modseq';

export function toFolder(row: Record<string, any>): FolderRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    name: row.name,
    kind: (FOLDER_KINDS as readonly string[]).includes(row.kind) ? (row.kind as FolderKind) : 'other',
    synced: row.synced === true,
    uidValidity: row.uidvalidity === null ? null : Number(row.uidvalidity),
    lastUid: Number(row.last_uid),
    highestModseq:
      row.highest_modseq === null || row.highest_modseq === undefined ? null : String(row.highest_modseq),
  };
}

export interface MessageRecord {
  id: string;
  accountId: string;
  folderId: string;
  /** The conversation this message belongs to. Null only before the backfill. */
  threadId: string | null;
  /** `in` for mail that arrived, `out` for what the owner sent. */
  direction: MessageDirection;
  uidValidity: number;
  uid: number;
  messageId: string | null;
  threadKey: string | null;
  /** The List-Id header, normalized, or null. Null on rows ingested before it. */
  listId: string | null;
  from: string;
  to: string[];
  /** Who was copied. `[]` on rows ingested before the column existed. */
  cc: string[];
  subject: string;
  date: string | null;
  snippet: string;
  bodyText: string;
  hasAttachments: boolean;
  attachments: AttachmentInfo[];
  flags: string[];
  fetchedAt: string | null;
  /** When the body was purged under retention, or null while it is still kept. */
  bodyPurgedAt: string | null;
}

export const MESSAGE_DIRECTIONS = ['in', 'out'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_COLUMNS =
  'id, account_id, folder_id, thread_id, direction, uidvalidity, uid, message_id, thread_key, list_id, from_addr, ' +
  'to_addrs, cc, subject, date, snippet, body_text, has_attachments, attachments, flags, fetched_at, ' +
  'body_purged_at';

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function toMessage(row: Record<string, any>): MessageRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    folderId: String(row.folder_id),
    threadId: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
    direction: row.direction === 'out' ? 'out' : 'in',
    uidValidity: Number(row.uidvalidity),
    uid: Number(row.uid),
    messageId: row.message_id ?? null,
    threadKey: row.thread_key ?? null,
    listId: row.list_id ?? null,
    from: row.from_addr,
    to: stringArray(row.to_addrs),
    cc: stringArray(row.cc),
    subject: row.subject ?? '',
    date: iso(row.date),
    snippet: row.snippet ?? '',
    bodyText: row.body_text ?? '',
    hasAttachments: Boolean(row.has_attachments),
    attachments: Array.isArray(row.attachments) ? (row.attachments as AttachmentInfo[]) : [],
    flags: stringArray(row.flags),
    fetchedAt: iso(row.fetched_at),
    bodyPurgedAt: iso(row.body_purged_at),
  };
}

/**
 * Where a draft is in its life (docs/specs/email.md §8).
 *
 * `draft` is the agent's words, `edited` the owner's over them, and the three
 * after are ends: sent, said no to, or left alone long enough that nobody is
 * waiting on it any more. `draft` and `edited` together are what "live" means
 * everywhere below.
 */
export const DRAFT_STATUSES = ['draft', 'edited', 'sent', 'discarded', 'lapsed'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** The two statuses a draft can still be acted on from. */
export const LIVE_DRAFT_STATUSES: readonly DraftStatus[] = ['draft', 'edited'];

export function isLiveDraft(status: DraftStatus): boolean {
  return LIVE_DRAFT_STATUSES.includes(status);
}

export interface DraftRecord {
  id: string;
  /**
   * The account this draft leaves from. Null only on a draft written before
   * accounts were plural and whose account has since been removed; `email.send`
   * refuses such a draft rather than picking a mailbox for it.
   */
  accountId: string | null;
  inReplyTo: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  artifactId: string | null;
  createdByAgent: string;
  createdAt: string | null;
  /** Where this draft is in its life. `draft` on every row written before §8. */
  status: DraftStatus;
  /** When the body, the recipients or the status last moved. */
  updatedAt: string | null;
  discardedAt: string | null;
  lapsedAt: string | null;
  /**
   * Who wrote the words currently in it: `owner` once the owner has saved over
   * the agent's, null while they are still the agent's. It is what makes an
   * owner-edited draft something no agent may overwrite.
   */
  editedBy: string | null;
  /** The conversation this draft answers. Null for a `draft_new`. */
  threadId: string | null;
  sentActionId: string | null;
  sentAt: string | null;
  sentMessageId: string | null;
  sentResponse: string | null;
  sendError: string | null;
}

export const DRAFT_COLUMNS =
  'id, account_id, in_reply_to, thread_id, to_addrs, cc, bcc, subject, body_text, artifact_id, ' +
  'created_by_agent, created_at, status, updated_at, discarded_at, lapsed_at, edited_by, ' +
  'sent_action_id, sent_at, sent_message_id, sent_response, send_error';

export function toDraft(row: Record<string, any>): DraftRecord {
  return {
    id: String(row.id),
    accountId: row.account_id === null || row.account_id === undefined ? null : String(row.account_id),
    inReplyTo: row.in_reply_to === null || row.in_reply_to === undefined ? null : String(row.in_reply_to),
    to: stringArray(row.to_addrs),
    cc: stringArray(row.cc),
    bcc: stringArray(row.bcc),
    subject: row.subject ?? '',
    bodyText: row.body_text ?? '',
    artifactId: row.artifact_id === null || row.artifact_id === undefined ? null : String(row.artifact_id),
    createdByAgent: row.created_by_agent,
    createdAt: iso(row.created_at),
    status: (DRAFT_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as DraftStatus)
      : 'draft',
    updatedAt: iso(row.updated_at),
    discardedAt: iso(row.discarded_at),
    lapsedAt: iso(row.lapsed_at),
    editedBy: row.edited_by ?? null,
    threadId: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
    sentActionId: row.sent_action_id === null || row.sent_action_id === undefined ? null : String(row.sent_action_id),
    sentAt: iso(row.sent_at),
    sentMessageId: row.sent_message_id ?? null,
    sentResponse: row.sent_response ?? null,
    sendError: row.send_error ?? null,
  };
}

export interface TriageRecord {
  messageId: string;
  processingVersion: number;
  category: string;
  urgency: 'urgent' | 'normal' | 'low';
  summary: string;
  actionNeeded: string | null;
  decidedAt: string | null;
}

export function toTriage(row: Record<string, any>): TriageRecord {
  return {
    messageId: String(row.message_id),
    processingVersion: Number(row.processing_version),
    category: row.category,
    urgency: row.urgency,
    summary: row.summary,
    actionNeeded: row.action_needed ?? null,
    decidedAt: iso(row.decided_at),
  };
}
