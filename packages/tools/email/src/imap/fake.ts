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
  FetchedMessage,
  ImapClient,
  ImapClientFactory,
  MailboxStatus,
} from '../ports.js';

export interface FakeMailbox {
  uidValidity: number;
  messages: FetchedMessage[];
}

export class FakeImapServer {
  readonly mailboxes = new Map<string, FakeMailbox>();
  /** Every fetch this server served, for assertions about the cap and cursor. */
  readonly fetches: Array<{ mailbox: string; sinceUid: number; limit: number; returned: number }> = [];
  opens = 0;
  closes = 0;

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
    return uid;
  }

  /**
   * What the server does when a mailbox is recreated upstream: a new
   * generation, and every uid the client stored is meaningless.
   */
  resetUidValidity(name: string, uidValidity: number): void {
    const box = this.mailbox(name);
    box.uidValidity = uidValidity;
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

  async open(mailbox: string): Promise<MailboxStatus> {
    this.server.opens += 1;
    const box = this.server.mailbox(mailbox);
    return {
      uidValidity: box.uidValidity,
      uidNext: Math.max(0, ...box.messages.map((m) => m.uid)) + 1,
      exists: box.messages.length,
    };
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

  async close(): Promise<void> {
    this.#closed = true;
    this.server.closes += 1;
  }
}

/** A plausible message, so a test writes only the fields it cares about. */
export function fakeMessage(over: Partial<FetchedMessage> = {}): Omit<FetchedMessage, 'uid'> & {
  uid?: number;
} {
  return {
    messageId: '<m1@example.test>',
    inReplyTo: null,
    references: [],
    listId: null,
    from: 'sender@example.test',
    to: ['owner@example.test'],
    cc: [],
    subject: 'Hello',
    date: new Date('2026-09-13T09:00:00Z'),
    bodyText: 'Body text.',
    hasAttachments: false,
    attachments: [],
    flags: [],
    ...over,
  };
}
