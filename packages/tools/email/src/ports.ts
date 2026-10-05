/**
 * The transport ports.
 *
 * Transport is separate from authentication (docs/architecture.md, "Email adapter"):
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
  /** The part's Content-ID without brackets: what a `cid:` picture in the HTML names. */
  contentId?: string | null;
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
  /**
   * The message carried `List-Unsubscribe`, or `Precedence: bulk | list |
   * junk`: mail sent to many. Stored as `messages.bulk`; the learning reads it
   * when deciding whether a rule that only quiets a sender may keep itself
   * (docs/email.md §5). Absent is false.
   */
  bulk?: boolean;
  /**
   * The From domain when the mailbox's own receiving server vouched for it in
   * an `Authentication-Results` header bearing its authserv-id
   * (`trustedAuthResults`, `authenticatedDomain`), else null or
   * absent. Stored as `messages.auth_domain`; the suspicious-sender watcher
   * reads it.
   */
  authDomain?: string | null;
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
  /**
   * The HTML part as downloaded (capped, unsanitised) when the message has
   * one; sanitised at ingest into `messages.body_html` (`html.ts`). Absent or
   * null for a text-only message.
   */
  bodyHtml?: string | null;
  /** The display name on the From header, when the sender gave one. */
  fromName?: string | null;
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
 * Reading mail must not mutate it (docs/architecture.md, "Trust model"): every fetch
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
  /**
   * Which of the messages buddi holds in `[fromUid, toUid]` have left this
   * mailbox (archived, moved or deleted in another app). Optional: a client
   * without it simply never notices.
   *
   * With `changedSince` (an earlier HIGHESTMODSEQ) on a server that ENABLEd
   * QRESYNC (RFC 7162), the answer is the server's own VANISHED (EARLIER)
   * list: `{ vanished }`. Otherwise one bounded `UID SEARCH UID from:to`
   * answers which uids are still there: `{ present }`. Uids only, never a
   * header or a body, so it cannot set `\Seen`.
   */
  departures?(
    mailbox: string,
    range: { fromUid: number; toUid: number; changedSince?: string | null },
  ): Promise<{ vanished: number[] } | { present: number[] }>;
  /** The server's CAPABILITY list, upper-cased. Optional on a reader; a writer has it. */
  capabilities?(): Promise<string[]>;
  /** `UID SEARCH HEADER Message-ID <id>`. Optional on a reader; a writer has it. */
  findByMessageId?(mailbox: string, messageId: string): Promise<number | null>;
  /** Gmail only: `UID FETCH <uids> (X-GM-LABELS)`. Optional on a reader; a writer has it. */
  fetchLabels?(mailbox: string, uids: readonly number[]): Promise<Map<number, string[]>>;
  /**
   * `UID FETCH <uids> (BODY.PEEK[HEADER.FIELDS (LIST-UNSUBSCRIBE PRECEDENCE)])`:
   * whether each message says it is sent to many (`isBulkHeaders`). Two header
   * lines, peeked, so it cannot set `\Seen`. A uid missing from the answer is
   * not in the mailbox. Optional: without it, older mail is never re-read.
   */
  fetchBulk?(mailbox: string, uids: readonly number[]): Promise<Map<number, boolean>>;
  close(): Promise<void>;
}

/**
 * Where a moved message landed: the destination's UIDVALIDITY and the new uid
 * of each source uid, as the server reported them (COPYUID, RFC 4315). A uid
 * missing from the map is one the server did not report — the caller finds it
 * by Message-ID, or records that it does not know.
 */
export interface MoveResult {
  uidValidity: number | null;
  uidMap: Map<number, number>;
}

/**
 * The write half, kept apart from `ImapClient` on purpose.
 *
 * Reading is a peek and stays one: nothing in the poll, the read tools or the
 * attachment fetch can reach a method below. Only the mailbox actions
 * (`mailbox/actions.ts`) — every one of them gated or a rule the owner set —
 * ask a client whether it is a writer, and a client that is not one is a
 * refusal, not a fallback. There is deliberately no expunge and no delete:
 * the most a writer can do to a message is move it, and Trash is a folder.
 */
export interface ImapWriter extends ImapClient {
  /** The server's CAPABILITY list, upper-cased: `MOVE`, `UIDPLUS`, `X-GM-EXT-1`, … */
  capabilities(): Promise<string[]>;
  /** `UID STORE <uids> +FLAGS` / `-FLAGS`, on the mailbox opened read-write. */
  storeFlags(mailbox: string, uids: readonly number[], flags: readonly string[], op: 'add' | 'remove'): Promise<void>;
  /** `UID MOVE <uids> <destination>` (RFC 6851). Never COPY + EXPUNGE. */
  move(mailbox: string, uids: readonly number[], destination: string): Promise<MoveResult>;
  /** `UID SEARCH HEADER Message-ID <id>`: the uid of one message in a mailbox, or null. */
  findByMessageId(mailbox: string, messageId: string): Promise<number | null>;
  /** Gmail only: `UID FETCH <uids> (X-GM-LABELS)`. */
  fetchLabels(mailbox: string, uids: readonly number[]): Promise<Map<number, string[]>>;
  /** Gmail only: `UID STORE <uids> +X-GM-LABELS (…)`. */
  addLabels(mailbox: string, uids: readonly number[], labels: readonly string[]): Promise<void>;
  /**
   * Gmail only: `UID STORE <uids> ±X-GM-LABELS (…)`. Taking `\Inbox` off is
   * how a message leaves the inbox with every other label kept; putting it
   * back is how it returns.
   */
  storeLabels(mailbox: string, uids: readonly number[], labels: readonly string[], op: 'add' | 'remove'): Promise<void>;
}

/** Whether a client can write. Duck-typed, so a test's stub stays a reader. */
export function isImapWriter(client: ImapClient): client is ImapWriter {
  const c = client as Partial<ImapWriter>;
  return typeof c.capabilities === 'function' && typeof c.move === 'function' &&
    typeof c.storeFlags === 'function' && typeof c.findByMessageId === 'function';
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
 * defects still throw (docs/architecture.md, "Runtime provider port").
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
  /**
   * 'page' is one the owner added in Settings. 'env' is a row the old
   * `GMAIL_USER` seed left behind and the gateway has not yet adopted (its
   * password was not readable); nothing seeds one any more.
   */
  addedVia: 'env' | 'page';
  /**
   * When folder discovery last completed: every folder the plan named was
   * persisted, the Sent folder included. Null means it has not completed — a
   * new account, one whose Sent row failed to insert, or a server with no Sent
   * folder at all — and the next poll lists the mailbox again.
   */
  foldersDiscoveredAt: string | null;
  createdAt: string | null;
  /**
   * When the server last refused this mailbox's stored password at login, and
   * what it said; null since the last login that worked (migration 017). What
   * makes the Email settings row say "Password needed" when the secret itself
   * was delivered fine.
   */
  loginFailedAt?: string | null;
  loginError?: string | null;
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

/**
 * What an idling INBOX connection reports: a message arrived (`EXISTS`), one
 * left (`EXPUNGE`, moved or deleted in another app), or a message's flags
 * changed (`FETCH … FLAGS`). The watcher only needs to know *that* something
 * changed; the poll reads what.
 */
export type IdleChange = 'exists' | 'expunge' | 'flags';

/**
 * One IDLE connection on INBOX, its own socket: never the poll's reader and
 * never the write port's, so a mailbox action cannot break it.
 */
export interface ImapIdleSession {
  /**
   * Settles once, when the connection is gone: `{}` after `close()`, the
   * error when the server or the network dropped it. Never rejects.
   */
  readonly ended: Promise<{ error?: unknown }>;
  /**
   * A folder's UIDNEXT — the Sent folder's — asked over this same connection
   * (`STATUS <folder> (UIDNEXT)`; the IDLE is broken for that one command
   * and re-armed). How mail the owner sends from another app is noticed
   * while IDLE is live without a second connection. Null when the server
   * would not say.
   */
  sentUidNext?(folder: string): Promise<number | null>;
  /** Log out and release the socket. Idempotent. */
  close(): Promise<void>;
}

/**
 * Open an IDLE connection on INBOX and report every change to `onChange`.
 * Resolves `'unsupported'` (connection already closed) when the server does
 * not advertise IDLE; rejects when the login or the connection fails.
 */
export type ImapIdleFactory = (
  account: AccountRecord,
  auth: EmailAuth,
  onChange: (change: IdleChange) => void,
) => Promise<ImapIdleSession | 'unsupported'>;
