/**
 * The transport ports.
 *
 * Transport is separate from authentication (ARCHITECTURE.md, "Email adapter"):
 * IMAP and SMTP are the transport, `app-password` and `xoauth2` are auth modes
 * behind one interface, and swapping the auth mode never changes the transport.
 * Both ports exist so the whole plugin can be exercised against fakes — nothing
 * in the test suite opens a socket.
 *
 * Verified TLS is not an option here: both real adapters pin `secure: true` and
 * never disable certificate verification.
 */

/** One address as it travels: display name dropped, address lowercased. */
export type Address = string;

/**
 * An attachment as ingest sees it. The bytes are never fetched at ingest —
 * `email.fetch_attachment` pulls one on request (docs/email.md §10).
 */
export interface AttachmentInfo {
  filename: string | null;
  mime: string;
  sizeBytes: number;
  /**
   * The IMAP body part id (`2`, `1.3`) this attachment is, as the body
   * structure names it: what `downloadAttachment` fetches by.
   *
   * Optional, and it has to be. Rows ingested before this field existed hold
   * a listing with no part id, and the mail they describe is still on the
   * server — so a fetch of one of those re-reads the body structure
   * (`listAttachments`) rather than refusing. A row written today has it.
   */
  part?: string | null;
  /**
   * The artifact this attachment became, once somebody fetched it.
   *
   * Recorded on the message row so the second fetch of the same file is a
   * link rather than a download, and so the Mail page can say which
   * attachments are already in the library.
   */
  artifactId?: string | null;
}

/** One message, as the IMAP port hands it over. Headers + text body only. */
export interface FetchedMessage {
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /**
   * The List-Id header, as it arrived, or null when the message carried none.
   * The gate's `list-id` scope is matched against it: a newsletter changes its
   * From address far more readily than its list.
   */
  listId: string | null;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  /** The `Date` header, exactly as the sender wrote it. Never trusted for ordering. */
  date: Date | null;
  /**
   * IMAP INTERNALDATE: when the server itself received or created the
   * message. The sender cannot write it, which is why thread ordering is
   * built on this and not on `date` — see `threads.ts`. Null only for a fake
   * or a server that genuinely omits it; `fetched_at` is the fallback.
   */
  internalDate: Date | null;
  bodyText: string;
  hasAttachments: boolean;
  attachments: AttachmentInfo[];
  /** IMAP flags, observed. A read never sets one — see `ImapClient`. */
  flags: string[];
}

/**
 * One folder, as the server lists it.
 *
 * `specialUse` is the SPECIAL-USE attribute (RFC 6154) when the server offers
 * one — `\Sent`, `\Drafts`, `\Trash` — and it is the only trustworthy way to
 * find the Sent folder, because its *name* is whatever the owner's language
 * and provider made it. `flags` is everything else the LIST reply carried, so
 * a server that reports `\Sent` among the flags rather than as a special-use
 * attribute is still understood.
 */
export interface MailboxInfo {
  /** The IMAP path, as the server names it: `INBOX`, `[Gmail]/Sent Mail`. */
  name: string;
  specialUse: string | null;
  flags: string[];
  /**
   * The mailbox boundary observed by LIST/STATUS. Discovery persists this for
   * a newly found Sent folder before any SELECT can fail, so mail sent after
   * discovery is never mistaken for pre-existing history on a later poll.
   */
  status?: MailboxStatus;
}

export interface MailboxStatus {
  /** The generation the mailbox's UIDs belong to. A change invalidates them all. */
  uidValidity: number;
  uidNext: number;
  exists: number;
  /**
   * HIGHESTMODSEQ (RFC 7162), as a decimal string — a modseq is 63 bits and a
   * JavaScript number is not. Null or absent when the server does not do
   * CONDSTORE for this mailbox, which is what sends the flag re-sync down its
   * capped full-fetch path instead of asking only for what changed.
   */
  highestModseq?: string | null;
}

/** One message's flags as the server holds them now. No headers, no body. */
export interface FlagState {
  uid: number;
  flags: string[];
}

/**
 * Reading mail must not mutate it (ARCHITECTURE.md, "Trust model"): every fetch
 * in this port is a **peek**, so `\Seen` is never set by buddi looking at a
 * message. An implementation that cannot guarantee that is not an `ImapClient`.
 */
export interface ImapClient {
  /**
   * Every folder the account has, with whatever the server says each one is
   * for. A listing, not a selection: nothing is opened and nothing is read.
   */
  listMailboxes(): Promise<MailboxInfo[]>;
  /** Open a mailbox read-only and report its state. */
  open(mailbox: string): Promise<MailboxStatus>;
  /**
   * Messages with `uid > sinceUid`, oldest first, at most `limit` of them.
   * Peek semantics: flags are reported, never changed.
   */
  fetchSince(mailbox: string, sinceUid: number, limit: number): Promise<FetchedMessage[]>;
  /**
   * `UID FETCH <uids> (FLAGS)` — flags only, never a header or a body, so it
   * is cheap and it cannot set `\Seen`. With `changedSince` (a modseq from an
   * earlier `open`) the server answers only for the messages among `uids`
   * whose flags changed since then (`CHANGEDSINCE`); without it, for every one
   * of them still in the mailbox. A uid missing from the answer is a message
   * no longer there (or, with `changedSince`, one that did not change).
   */
  fetchFlags(mailbox: string, uids: readonly number[], changedSince?: string | null): Promise<FlagState[]>;
  /**
   * The attachment listing of one message, read from its body structure.
   *
   * For a row ingested before part ids were recorded: the listing is what says
   * which body part each file is. No body is downloaded. An empty array means
   * the message carries no attachments; `null` means the message is not there
   * — which is a different answer, and the one `email.fetch_attachment` turns
   * into "this message is no longer on the server".
   */
  listAttachments(mailbox: string, uid: number): Promise<AttachmentInfo[] | null>;
  /**
   * One attachment's bytes, peeked.
   *
   * `part` is the body part id from `AttachmentInfo`. `maxBytes` is a hard
   * ceiling: the stream is abandoned the moment it is exceeded and the call
   * throws, because a server is free to under-report a part's size in the body
   * structure and a cap that is only checked beforehand is not a cap. `null`
   * when the message or the part is not there.
   */
  downloadAttachment(
    mailbox: string,
    uid: number,
    part: string,
    maxBytes: number,
  ): Promise<Buffer | null>;
  close(): Promise<void>;
}

/** The exact bytes of intent for one send. Hashed into the action object. */
export interface SmtpEnvelope {
  from: Address;
  to: Address[];
  cc: Address[];
  /** Blind recipients are part of the envelope and are always shown in a preview. */
  bcc: Address[];
  subject: string;
  text: string;
  inReplyTo?: string | null;
  references?: string[];
}

export interface SmtpResult {
  /** The Message-ID the server assigned or accepted. */
  messageId: string;
  /** The raw SMTP response line — the receipt quoted back to the owner. */
  response: string;
  accepted: Address[];
  rejected: Address[];
}

export interface SmtpClient {
  send(envelope: SmtpEnvelope): Promise<SmtpResult>;
  close(): Promise<void>;
}

/**
 * Typed configuration problems. Expected failures are values; programming
 * defects still throw (ARCHITECTURE.md, "Runtime provider port").
 */
export type EmailProblem =
  | { code: 'not-configured'; message: string }
  | { code: 'secret-missing'; message: string }
  | { code: 'unsupported-auth-mode'; message: string };

export type Resolved<T> = { ok: true; value: T } | { ok: false; problem: EmailProblem };

export class EmailProblemError extends Error {
  override readonly name = 'EmailProblemError';
  constructor(readonly problem: EmailProblem) {
    super(`${problem.code}: ${problem.message}`);
  }
}

/** Credentials for one account, resolved by name. Never stored in the schema. */
export type EmailAuth = { mode: 'app-password'; user: string; pass: string };

export interface AccountRecord {
  id: string;
  address: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  authMode: 'app-password' | 'xoauth2';
  secretName: string;
  /**
   * The other addresses this account receives as. Identity, not routing: a
   * reply's From is the alias the original was addressed to when it is one of
   * these, and `address` otherwise.
   */
  aliases: string[];
  /** What the owner calls it. Null means the address is the name. */
  displayName: string | null;
  /** A disabled account keeps everything and is simply not polled or read. */
  enabled: boolean;
  /** 'env' is the GMAIL_USER seed; 'page' is one the owner added in Settings. */
  addedVia: 'env' | 'page';
  /**
   * When folder discovery last completed: every folder the plan named was
   * persisted, the Sent folder included. Null means it has not completed — a
   * new account, one whose Sent row failed to insert, or a server with no Sent
   * folder at all — and the next poll lists the mailbox again.
   */
  foldersDiscoveredAt: string | null;
  createdAt: string | null;
}

/** How a client is made for an account. Injected, so a test never dials out. */
export type ImapClientFactory = (
  account: AccountRecord,
  auth: EmailAuth,
) => Promise<ImapClient>;

export type SmtpClientFactory = (
  account: AccountRecord,
  auth: EmailAuth,
) => Promise<SmtpClient>;
