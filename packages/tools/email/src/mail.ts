/**
 * Pure mail helpers. No IO, no database — all of this is testable on its own,
 * and every rule that decides identity or presentation lives here rather than
 * being reimplemented in two adapters.
 */
import type { AttachmentInfo, FetchedMessage } from './ports.js';

/** How much of the body the list view carries. */
export const SNIPPET_CHARS = 220;

/** Lowercased bare address: `Jane Doe <Jane@Example.COM>` -> `jane@example.com`. */
export function normalizeAddress(raw: string): string {
  const trimmed = raw.trim();
  const angled = /<([^>]+)>/.exec(trimmed);
  const bare = (angled?.[1] ?? trimmed).trim();
  return bare.replace(/^"|"$/g, '').toLowerCase();
}

export function normalizeAddresses(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const address = normalizeAddress(item);
    if (address === '' || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

/** A `<...>` Message-ID, normalized to its bracketed form. Null when absent. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const match = /<([^>]+)>/.exec(value);
  const inner = (match?.[1] ?? value).trim();
  return inner === '' ? null : `<${inner}>`;
}

/** Every `<...>` in a References header, in order. */
export function parseReferences(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [...raw.matchAll(/<[^>]+>/g)].map((m) => m[0]);
}

/**
 * A stable key for the conversation this message belongs to.
 *
 * The root of the References chain when there is one (that is what threads a
 * reply to its original), else In-Reply-To, else the message's own id. A
 * Message-ID is evidence about the logical message, never the mailbox key —
 * which is why this is a separate, nullable column and not an identity.
 */
export function threadKeyFor(input: {
  messageId: string | null;
  inReplyTo: string | null;
  references: readonly string[];
}): string | null {
  const root = input.references[0];
  if (root) return root;
  if (input.inReplyTo) return input.inReplyTo;
  return input.messageId;
}

/** One-line preview: whitespace collapsed, hard-capped. */
export function snippetOf(bodyText: string, chars: number = SNIPPET_CHARS): string {
  const flat = bodyText.replace(/\s+/g, ' ').trim();
  return flat.length <= chars ? flat : `${flat.slice(0, chars - 1)}…`;
}

/** `Re: ` prefixed once, however many the original already carried. */
export function replySubject(subject: string): string {
  const stripped = subject.replace(/^(\s*re\s*:\s*)+/i, '').trim();
  return stripped === '' ? 'Re:' : `Re: ${stripped}`;
}

/** True when the mailbox has not marked the message `\Seen`. */
export function isUnread(flags: readonly string[]): boolean {
  return !flags.some((f) => f.toLowerCase() === '\\seen');
}

/**
 * The structured summary a triage run is started with.
 *
 * Deliberately not the raw message: the prompt says what the fields *are*, and
 * the body is truncated. Mail is hostile input — it is quoted as evidence for
 * the agent to classify, never as instructions, and the persona is what holds
 * that line.
 */
export function triagePrompt(input: {
  messageId: string;
  from: string;
  to: readonly string[];
  subject: string;
  date: string | null;
  hasAttachments: boolean;
  attachments: readonly AttachmentInfo[];
  bodyText: string;
  bodyChars?: number;
}): string {
  const cap = input.bodyChars ?? 4000;
  const body = input.bodyText.length > cap
    ? `${input.bodyText.slice(0, cap)}\n[… truncated, read the full message with email.read]`
    : input.bodyText;
  const attachments = input.attachments.length
    ? input.attachments
        .map((a) => `${a.filename ?? '(unnamed)'} (${a.mime}, ${a.sizeBytes} bytes)`)
        .join(', ')
    : input.hasAttachments
      ? 'yes (not listed)'
      : 'none';
  return [
    'A new message arrived in the inbox. Triage it.',
    '',
    `Message id (for the tools): ${input.messageId}`,
    `From: ${input.from}`,
    `To: ${input.to.join(', ') || '(none)'}`,
    `Subject: ${input.subject || '(no subject)'}`,
    `Date: ${input.date ?? '(unknown)'}`,
    `Attachments: ${attachments}`,
    '',
    'Body:',
    body.trim() === '' ? '(empty)' : body,
  ].join('\n');
}

/** A message as ingest stores it, derived once from what the port returned. */
export interface IngestedMessage extends FetchedMessage {
  threadKey: string | null;
  snippet: string;
}

export function prepareForIngest(message: FetchedMessage): IngestedMessage {
  return {
    ...message,
    from: normalizeAddress(message.from),
    to: normalizeAddresses(message.to),
    cc: normalizeAddresses(message.cc),
    messageId: normalizeMessageId(message.messageId),
    inReplyTo: normalizeMessageId(message.inReplyTo),
    threadKey: threadKeyFor({
      messageId: normalizeMessageId(message.messageId),
      inReplyTo: normalizeMessageId(message.inReplyTo),
      references: message.references,
    }),
    snippet: snippetOf(message.bodyText),
  };
}
