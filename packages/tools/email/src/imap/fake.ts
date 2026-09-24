/**
 * An in-process IMAP server, good enough to prove the source contract.
 *
 * It is the only IMAP the test suite ever talks to: no socket, no mailbox, no
 * credentials. It enforces the two properties the real one must have — peek
 * semantics (a fetch never mutates flags) and UIDVALIDITY as the generation
 * that makes stored UIDs meaningful — so a regression in either shows up as a
 * failing test rather than as silently-read mail.
 */
import type {
  AttachmentInfo,
  FetchedMessage,
  FlagState,
  ImapClient,
  ImapClientFactory,
  MailboxInfo,
  MailboxStatus,
} from '../ports.js';

export interface FakeMailbox {
  uidValidity: number;
  messages: FetchedMessage[];
  /** The SPECIAL-USE attribute this folder is listed with, e.g. `\\Sent`. */
  specialUse?: string | null;
  /**
   * Whether this mailbox does CONDSTORE (RFC 7162), the way Gmail does. When
   * it does, every add and every flag change bumps a mod-sequence, `open`
   * reports HIGHESTMODSEQ and `fetchFlags` honours `changedSince`; when it
   * does not, `open` reports none and the client has to fall back.
   */
  condstore?: boolean;
  /** The mailbox's current HIGHESTMODSEQ. Maintained by the server. */
  highestModseq?: number;
}

/**
 * The bytes this server will hand over for one body part, keyed
 * `<mailbox>/<uid>/<part>`. A message whose attachment has no entry here is a
 * message whose part the server does not have — which is the other half of
 * what `email.fetch_attachment` has to cope with.
 */
export type FakeParts = Map<string, Buffer>;

function partKey(mailbox: string, uid: number, part: string): string {
  return `${mailbox}/${uid}/${part}`;
}

export class FakeImapServer {
  readonly mailboxes = new Map<string, FakeMailbox>();
  /** Every fetch this server served, for assertions about the cap and cursor. */
  readonly fetches: Array<{ mailbox: string; sinceUid: number; limit: number; returned: number }> = [];
  opens = 0;
  closes = 0;
  /** How many times the folders were listed. Discovery happens once. */
  lists = 0;
  /** The body parts this server can hand over. See `putPart`. */
  readonly parts: FakeParts = new Map();
  /** Every part download served, for assertions about the cap and the peek. */
  readonly downloads: Array<{ mailbox: string; uid: number; part: string; maxBytes: number }> = [];
  /** Every FLAGS-only fetch served: which uids were asked for, since when, how many answered. */
  readonly flagFetches: Array<{
    mailbox: string;
    uids: number[];
    changedSince: string | null;
    returned: number;
  }> = [];
  /** Each message's mod-sequence, keyed `<mailbox>/<uid>`, for a CONDSTORE mailbox. */
  readonly modseqs = new Map<string, number>();

  constructor(seed: Record<string, FakeMailbox> = {}) {
    for (const [name, box] of Object.entries(seed)) this.mailboxes.set(name, box);
  }

  mailbox(name: string): FakeMailbox {
    let box = this.mailboxes.get(name);
    if (!box) {
      box = { uidValidity: 1, messages: [] };
      this.mailboxes.set(name, box);
    }
    return box;
  }

  /** Append a message, assigning the next uid. Returns the uid it got. */
  add(name: string, message: Omit<FetchedMessage, 'uid'> & { uid?: number }): number {
    const box = this.mailbox(name);
    const uid = message.uid ?? Math.max(0, ...box.messages.map((m) => m.uid)) + 1;
    box.messages.push({ ...message, uid });
    this.#touch(name, uid);
    return uid;
  }

  /**
   * What another mail client does: set this message's flags on the server.
   * Marking a message read on the phone is `setFlags(INBOX, uid, ['\\Seen'])`.
   */
  setFlags(name: string, uid: number, flags: string[]): void {
    const message = this.mailbox(name).messages.find((m) => m.uid === uid);
    if (!message) throw new Error(`fake imap: no uid ${uid} in ${name}`);
    message.flags = [...flags];
    this.#touch(name, uid);
  }

  /** Archive or delete elsewhere: the message is simply not in this mailbox any more. */
  remove(name: string, uid: number): void {
    const box = this.mailbox(name);
    box.messages = box.messages.filter((m) => m.uid !== uid);
    this.modseqs.delete(`${name}/${uid}`);
  }

  /** Bump the mailbox's mod-sequence and give it to this message, when the mailbox has one. */
  #touch(name: string, uid: number): void {
    const box = this.mailbox(name);
    if (!box.condstore) return;
    box.highestModseq = (box.highestModseq ?? 1) + 1;
    this.modseqs.set(`${name}/${uid}`, box.highestModseq);
  }

  /** Give one body part of one message its bytes. */
  putPart(mailbox: string, uid: number, part: string, bytes: Buffer): void {
    this.parts.set(partKey(mailbox, uid, part), bytes);
  }

  /**
   * What the server does when a mailbox is recreated upstream: a new
   * generation, and every uid the client stored is meaningless.
   */
  resetUidValidity(name: string, uidValidity: number): void {
    const box = this.mailbox(name);
    box.uidValidity = uidValidity;
  }

  /** What a LIST would return: every folder this server holds, in order. */
  listing(): MailboxInfo[] {
    return [...this.mailboxes.entries()].map(([name, box]) => ({
      name,
      specialUse: box.specialUse ?? null,
      flags: [],
      status: {
        uidValidity: box.uidValidity,
        uidNext: Math.max(0, ...box.messages.map((m) => m.uid)) + 1,
        exists: box.messages.length,
      },
    }));
  }

  client(): ImapClient {
    return new FakeImapClient(this);
  }

  factory(): ImapClientFactory {
    return async () => this.client();
  }
}

class FakeImapClient implements ImapClient {
  #closed = false;

  constructor(private readonly server: FakeImapServer) {}

  async listMailboxes(): Promise<MailboxInfo[]> {
    if (this.#closed) throw new Error('fake imap: client is closed');
    this.server.lists += 1;
    return this.server.listing();
  }

  async open(mailbox: string): Promise<MailboxStatus> {
    this.server.opens += 1;
    const box = this.server.mailbox(mailbox);
    return {
      uidValidity: box.uidValidity,
      uidNext: Math.max(0, ...box.messages.map((m) => m.uid)) + 1,
      exists: box.messages.length,
      highestModseq: box.condstore ? String(box.highestModseq ?? 1) : null,
    };
  }

  async fetchFlags(
    mailbox: string,
    uids: readonly number[],
    changedSince?: string | null,
  ): Promise<FlagState[]> {
    if (this.#closed) throw new Error('fake imap: client is closed');
    const box = this.server.mailbox(mailbox);
    const wanted = new Set(uids);
    // A server without CONDSTORE would refuse CHANGEDSINCE; the client must
    // never send it one, so the fake says so loudly rather than ignoring it.
    if (changedSince && !box.condstore) {
      throw new Error('fake imap: CHANGEDSINCE on a mailbox without CONDSTORE');
    }
    const since = changedSince ? Number(changedSince) : null;
    const out = box.messages
      .filter((m) => wanted.has(m.uid))
      .filter((m) => since === null || (this.server.modseqs.get(`${mailbox}/${m.uid}`) ?? 0) > since)
      .sort((a, b) => a.uid - b.uid)
      .map((m) => ({ uid: m.uid, flags: [...m.flags] }));
    this.server.flagFetches.push({
      mailbox,
      uids: [...uids],
      changedSince: changedSince ?? null,
      returned: out.length,
    });
    return out;
  }

  async fetchSince(mailbox: string, sinceUid: number, limit: number): Promise<FetchedMessage[]> {
    if (this.#closed) throw new Error('fake imap: client is closed');
    const box = this.server.mailbox(mailbox);
    const selected = box.messages
      .filter((m) => m.uid > sinceUid)
      .sort((a, b) => a.uid - b.uid)
      .slice(0, limit);
    this.server.fetches.push({ mailbox, sinceUid, limit, returned: selected.length });
    // Deep-ish copy: a caller that mutates what it got must not reach into the
    // server's own flags, which is exactly the peek property under test.
    return selected.map((m) => ({
      ...m,
      to: [...m.to],
      cc: [...m.cc],
      references: [...m.references],
      flags: [...m.flags],
      attachments: m.attachments.map((a) => ({ ...a })),
    }));
  }

  async listAttachments(mailbox: string, uid: number): Promise<AttachmentInfo[] | null> {
    if (this.#closed) throw new Error('fake imap: client is closed');
    const box = this.server.mailbox(mailbox);
    const message = box.messages.find((m) => m.uid === uid);
    // Not there at all is a different answer from "there, with no files".
    if (!message) return null;
    return message.attachments.map((a) => ({ ...a }));
  }

  async downloadAttachment(
    mailbox: string,
    uid: number,
    part: string,
    maxBytes: number,
  ): Promise<Buffer | null> {
    if (this.#closed) throw new Error('fake imap: client is closed');
    this.server.downloads.push({ mailbox, uid, part, maxBytes });
    const box = this.server.mailbox(mailbox);
    if (!box.messages.some((m) => m.uid === uid)) return null;
    const bytes = this.server.parts.get(partKey(mailbox, uid, part));
    if (!bytes) return null;
    // The real adapter enforces the cap on the stream rather than on a
    // declared size, so the fake refuses the same way: a test can seed a part
    // fatter than its own body structure claims and see the same error.
    if (bytes.length > maxBytes) {
      throw new Error(
        `attachment part ${part} of uid ${uid} is larger than the ${maxBytes}-byte cap`,
      );
    }
    return Buffer.from(bytes);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.server.closes += 1;
  }
}

/** A plausible message, so a test writes only the fields it cares about. */
export function fakeMessage(over: Partial<FetchedMessage> = {}): Omit<FetchedMessage, 'uid'> & {
  uid?: number;
} {
  const date = over.date !== undefined ? over.date : new Date('2026-09-13T09:00:00Z');
  return {
    messageId: '<m1@example.test>',
    inReplyTo: null,
    references: [],
    listId: null,
    from: 'sender@example.test',
    to: ['owner@example.test'],
    cc: [],
    subject: 'Hello',
    date,
    // Defaults to the same instant as `date` so a test that does not care
    // about the distinction gets consistent ordering either way; a test about
    // the distinction overrides one or the other explicitly.
    internalDate: date,
    bodyText: 'Body text.',
    hasAttachments: false,
    attachments: [],
    flags: [],
    ...over,
  };
}
