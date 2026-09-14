/**
 * Row shapes and the mapping to them. Postgres hands `bigint` back as a string
 * (js numbers cannot hold the full range); UIDs and UIDVALIDITY are well inside
 * the safe integer range, so they are converted here, once, rather than being
 * compared as strings somewhere subtle.
 */
import type { AccountRecord, AttachmentInfo } from './ports.js';

export const ACCOUNT_COLUMNS =
  'id, address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name';

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
  };
}

export interface MailboxRecord {
  id: string;
  accountId: string;
  name: string;
  uidValidity: number | null;
  lastUid: number;
}

export const MAILBOX_COLUMNS = 'id, account_id, name, uidvalidity, last_uid';

export function toMailbox(row: Record<string, any>): MailboxRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    name: row.name,
    uidValidity: row.uidvalidity === null ? null : Number(row.uidvalidity),
    lastUid: Number(row.last_uid),
  };
}

export interface MessageRecord {
  id: string;
  accountId: string;
  mailboxId: string;
  uidValidity: number;
  uid: number;
  messageId: string | null;
  threadKey: string | null;
  from: string;
  to: string[];
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

export const MESSAGE_COLUMNS =
  'id, account_id, mailbox_id, uidvalidity, uid, message_id, thread_key, from_addr, ' +
  'to_addrs, subject, date, snippet, body_text, has_attachments, attachments, flags, fetched_at, ' +
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
    mailboxId: String(row.mailbox_id),
    uidValidity: Number(row.uidvalidity),
    uid: Number(row.uid),
    messageId: row.message_id ?? null,
    threadKey: row.thread_key ?? null,
    from: row.from_addr,
    to: stringArray(row.to_addrs),
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

export interface DraftRecord {
  id: string;
  inReplyTo: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  artifactId: string | null;
  createdByAgent: string;
  createdAt: string | null;
  sentActionId: string | null;
  sentAt: string | null;
  sentMessageId: string | null;
  sentResponse: string | null;
  sendError: string | null;
}

export const DRAFT_COLUMNS =
  'id, in_reply_to, to_addrs, cc, bcc, subject, body_text, artifact_id, created_by_agent, ' +
  'created_at, sent_action_id, sent_at, sent_message_id, sent_response, send_error';

export function toDraft(row: Record<string, any>): DraftRecord {
  return {
    id: String(row.id),
    inReplyTo: row.in_reply_to === null || row.in_reply_to === undefined ? null : String(row.in_reply_to),
    to: stringArray(row.to_addrs),
    cc: stringArray(row.cc),
    bcc: stringArray(row.bcc),
    subject: row.subject ?? '',
    bodyText: row.body_text ?? '',
    artifactId: row.artifact_id === null || row.artifact_id === undefined ? null : String(row.artifact_id),
    createdByAgent: row.created_by_agent,
    createdAt: iso(row.created_at),
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
