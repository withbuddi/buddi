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

/**
 * Domains where Gmail's local-part rules apply: dots are ignored, and
 * `googlemail.com` is the same mailbox as `gmail.com`.
 */
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The mailbox an address delivers to, with every form of the same mailbox
 * collapsed onto one key.
 *
 * This exists for exactly one question — "is this the owner?" — and it is the
 * question that decides whether buddi mails him his own reply. Case is already
 * handled by `normalizeAddress`; what is left is the two forms that reach the
 * same inbox while spelling it differently:
 *
 *  - **plus addressing** (`janedoe+bills@gmail.com`), which every major provider
 *    routes to `owner@example.com`, and which a correspondent may well have in
 *    their address book;
 *  - **Gmail's dots and its second domain** (`jane.doe@googlemail.com`), which
 *    Gmail itself treats as the same account.
 *
 * It deliberately narrows *only*. A key never becomes a recipient — it is
 * compared, and the address that travels is the one the original carried.
 */
export function mailboxKey(raw: string): string {
  const bare = normalizeAddress(raw);
  const at = bare.lastIndexOf('@');
  if (at <= 0) return bare;
  let local = bare.slice(0, at);
  const domain = bare.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) return `${local.replace(/\./g, '')}@gmail.com`;
  return `${local}@${domain}`;
}

/** True when two addresses reach the same mailbox. Empty matches nothing. */
export function isSameMailbox(a: string, b: string): boolean {
  const left = mailboxKey(a);
  return left !== '' && left === mailboxKey(b);
}

/**
 * Local parts that mean "nothing you send here will be read".
 *
 * Replying to one is not dangerous, it is useless — and on a reply-all it is
 * the tell that the message was a broadcast rather than a conversation. It is
 * reported, never enforced: the agent and the owner decide, this only makes
 * sure neither has to notice it on their own.
 */
const UNREPLYABLE =
  /^(no[.\-_]?reply|do[.\-_]?not[.\-_]?reply|mailer[.\-_]?daemon|postmaster|bounces?|notifications?|automated)([.\-_+].*)?$/;

/** True when the address looks like a machine that does not read its mail. */
export function looksUnreplyable(raw: string): boolean {
  const bare = normalizeAddress(raw);
  const at = bare.lastIndexOf('@');
  if (at <= 0) return false;
  return UNREPLYABLE.test(bare.slice(0, at));
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

/**
 * Who a reply goes to.
 *
 * ## The two shapes, and why they are the only two
 *
 * "Reply to everyone" is not one thing, so this names what it actually means
 * here rather than leaving it to be guessed:
 *
 *  - **`sender`** — the sender alone. The default, always, and what every
 *    reply was before this existed. Nothing an agent omits can widen it.
 *  - **`everyone`** — the audience the original had, minus the owner. The
 *    sender leads the `To` line, the rest of the original's `To` follows it
 *    there (they were addressed, so they stay addressed), and the original's
 *    `Cc` stays in `Cc` (they were copied, so they stay copied). That mapping
 *    is the honest one: it reproduces the original's own idea of who is in the
 *    conversation and who is watching it, instead of flattening both into one
 *    line the owner then has to read carefully.
 *
 * `alsoTo` / `alsoCc` are the third case that is not a shape: the owner wants
 * the sender plus one named colleague. They are appended after the audience is
 * built, under exactly the same rules.
 *
 * ## The rules that hold whatever is asked for
 *
 *  - **The owner is never a recipient.** Every address is compared by
 *    `mailboxKey`, so a plus-tag, a different case or Gmail's dots cannot slip
 *    his own address past the filter. This applies to `from` too: a reply to
 *    something he sent has nobody to reply to, and that is said out loud rather
 *    than turning into mail addressed to himself.
 *  - **Nothing is duplicated**, and an address that would appear in both lines
 *    stays in `To` — the stronger of the two.
 *  - **Order is the original's.** People read a recipient list as a sentence
 *    about who this concerns; re-sorting it loses that.
 *  - **A reply never carries a blind copy.** Not `bcc` from the original —
 *    which is not stored, was never visible, and must not be resurrected — and
 *    not a new one either. A widened reply is a visible act or it is nothing.
 */
export type ReplyAudience = 'sender' | 'everyone';

export interface ReplyRecipientsInput {
  /** The original's From. */
  from: string;
  /** The original's To, in its own order. */
  to: readonly string[];
  /** The original's Cc, in its own order. */
  cc?: readonly string[];
  /** Every address that reaches the owner. Never a recipient. */
  owner: readonly string[];
  /** Which shape. Absent means `sender`; only an explicit ask widens. */
  audience?: ReplyAudience | undefined;
  alsoTo?: readonly string[] | undefined;
  alsoCc?: readonly string[] | undefined;
}

export interface ReplyRecipients {
  to: string[];
  cc: string[];
  /** Always empty. A reply has no blind copies — see above. */
  bcc: never[];
  audience: ReplyAudience;
  /** The sender, as the reply addresses them. */
  sender: string;
  /** Everyone on the reply who is not the sender. Empty is the default shape. */
  beyondSender: string[];
  /**
   * Everyone who was on the *original* besides the sender and the owner — the
   * people a widened reply would reach — **whatever shape was asked for**.
   *
   * `beyondSender` describes the reply that was written; this describes the
   * choice that was available. They are the same list on `everyone` and they
   * differ on `sender`, which is the whole point: a sender-only draft of a
   * message that five people read is the moment the owner has a decision to
   * make, and nothing downstream can see that moment unless this is here.
   */
  othersOnOriginal: string[];
  /** The owner's own addresses that were on the original and were left off. */
  excludedOwn: string[];
  /** True when the sender looks like a machine that will not read a reply. */
  senderLooksUnreplyable: boolean;
}

export function replyRecipients(input: ReplyRecipientsInput): ReplyRecipients {
  const ownKeys = new Set(input.owner.map(mailboxKey).filter((k) => k !== ''));
  const isOwn = (address: string): boolean => ownKeys.has(mailboxKey(address));

  const excludedOwn: string[] = [];
  const seen = new Set<string>();
  const to: string[] = [];
  const cc: string[] = [];

  /** Add one address to a line, unless it is the owner's or already placed. */
  const add = (line: string[], raw: string): void => {
    const address = normalizeAddress(raw);
    if (address === '') return;
    const key = mailboxKey(address);
    if (isOwn(address)) {
      if (!excludedOwn.includes(address)) excludedOwn.push(address);
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    line.push(address);
  };

  const sender = normalizeAddress(input.from);
  add(to, sender);

  const audience: ReplyAudience = input.audience ?? 'sender';
  if (audience === 'everyone') {
    for (const address of input.to) add(to, address);
    for (const address of input.cc ?? []) add(cc, address);
  }
  for (const address of input.alsoTo ?? []) add(to, address);
  for (const address of input.alsoCc ?? []) add(cc, address);

  const senderKey = mailboxKey(sender);

  // Who the wide shape *would* reach, derived from the original alone so that
  // asking for the narrow one does not hide the choice. Same exclusions as a
  // recipient line — the owner is never counted, nothing is counted twice —
  // but computed on its own keys, because `seen` describes the reply.
  const otherKeys = new Set<string>([senderKey]);
  const othersOnOriginal: string[] = [];
  for (const raw of [...input.to, ...(input.cc ?? [])]) {
    const address = normalizeAddress(raw);
    if (address === '' || isOwn(address)) continue;
    const key = mailboxKey(address);
    if (otherKeys.has(key)) continue;
    otherKeys.add(key);
    othersOnOriginal.push(address);
  }

  return {
    to,
    cc,
    bcc: [],
    audience,
    sender,
    beyondSender: [...to, ...cc].filter((a) => mailboxKey(a) !== senderKey),
    othersOnOriginal,
    excludedOwn,
    senderLooksUnreplyable: looksUnreplyable(sender),
  };
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
  cc?: readonly string[];
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
    // Who else is on it. A message addressed to five people is a different
    // message from one addressed to the owner alone, and the agent cannot see
    // that unless it is put in front of it.
    `Cc: ${(input.cc ?? []).join(', ') || '(none)'}`,
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
