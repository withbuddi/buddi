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

/** An attachment as ingest sees it. Bytes are not fetched in v1. */
export interface AttachmentInfo {
  filename: string | null;
  mime: string;
  sizeBytes: number;
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
  date: Date | null;
  bodyText: string;
  hasAttachments: boolean;
  attachments: AttachmentInfo[];
  /** IMAP flags, observed. A read never sets one — see `ImapClient`. */
  flags: string[];
}

export interface MailboxStatus {
  /** The generation the mailbox's UIDs belong to. A change invalidates them all. */
  uidValidity: number;
  uidNext: number;
  exists: number;
}

/**
 * Reading mail must not mutate it (ARCHITECTURE.md, "Trust model"): every fetch
 * in this port is a **peek**, so `\Seen` is never set by buddi looking at a
 * message. An implementation that cannot guarantee that is not an `ImapClient`.
 */
export interface ImapClient {
  /** Open a mailbox read-only and report its state. */
  open(mailbox: string): Promise<MailboxStatus>;
  /**
   * Messages with `uid > sinceUid`, oldest first, at most `limit` of them.
   * Peek semantics: flags are reported, never changed.
   */
  fetchSince(mailbox: string, sinceUid: number, limit: number): Promise<FetchedMessage[]>;
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
