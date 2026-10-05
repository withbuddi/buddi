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
  IdleChange,
  ImapClientFactory,
  ImapIdleFactory,
  ImapIdleSession,
  ImapWriter,
  MailboxInfo,
  MailboxStatus,
  MoveResult,
} from '../ports.js';

/** A message as this server holds it: what the port hands over, and Gmail's labels. */
type HeldMessage = FetchedMessage & { labels?: string[] };

export interface FakeMailbox {
  uidValidity: number;
  messages: HeldMessage[];
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
  /** The highest uid ever assigned here: a uid is never reused, even after a move out. */
  uidNextFloor?: number;
  /**
   * Whether this mailbox answers QRESYNC (RFC 7162): with `condstore` too, a
   * message leaving it bumps the mod-sequence and is remembered, so
   * `departures` with `changedSince` answers VANISHED instead of a search.
   */
  qresync?: boolean;
}

/**
 * Gmail's labels after a MOVE. Into Trash: none (Gmail drops them). Out of a
 * label folder: that label goes. Into a label folder: that label comes. INBOX
 * and All Mail are not labels here; `\\Inbox` membership is the folder itself.
 */
function gmailLabelsAfterMove(labels: string[], source: string, destination: string, server: FakeImapServer): string[] {
  const special = (name: string): boolean => name === 'INBOX' || Boolean(server.mailboxes.get(name)?.specialUse);
  if (server.mailboxes.get(destination)?.specialUse === '\\Trash') return [];
  const out = labels.filter((l) => l !== source);
  if (!special(destination) && !out.includes(destination)) out.push(destination);
  return out;
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
  /** Every bulk-headers fetch served (`fetchBulk`): which uids were asked for. */
  readonly bulkFetches: Array<{ mailbox: string; uids: number[] }> = [];
  /** Each message's mod-sequence, keyed `<mailbox>/<uid>`, for a CONDSTORE mailbox. */
  readonly modseqs = new Map<string, number>();
  /**
   * What CAPABILITY answers. A plain server by default (MOVE and UIDPLUS, as
   * Dovecot, Fastmail and iCloud have); `gmail()` adds `X-GM-EXT-1`. A test
   * about a server without MOVE or UIDPLUS takes them out.
   */
  capabilities: string[] = ['IMAP4REV1', 'MOVE', 'UIDPLUS'];
  /**
   * Every write this server accepted, in order. There is no `expunge` and no
   * `\\Deleted` here because the client never sends one — a test asserting
   * that reads this log.
   */
  readonly writes: Array<
    | { op: 'store'; mailbox: string; uids: number[]; flags: string[]; how: 'add' | 'remove' }
    | { op: 'move'; mailbox: string; uids: number[]; destination: string }
    | { op: 'labels'; mailbox: string; uids: number[]; labels: string[] }
    | { op: 'store-labels'; mailbox: string; uids: number[]; labels: string[]; how: 'add' | 'remove' }
  > = [];
  /** Every presence question served: how it was answered (`vanished` or `search`) and over which range. */
  readonly departureChecks: Array<{ mailbox: string; via: 'vanished' | 'search'; fromUid: number; toUid: number }> = [];
  /** Uids that left a QRESYNC mailbox, with the mod-sequence they left at. */
  readonly vanishedLog: Array<{ mailbox: string; uid: number; modseq: number }> = [];
  /** Every HTML part served (`fetchHtml`), for the reading pane's fetch-once. */
  readonly htmlFetches: Array<{ mailbox: string; uid: number; maxBytes: number }> = [];
  /** How long `fetchHtml` takes to answer, for the pane's bounded wait. */
  htmlDelayMs = 0;
  /** How many times an IDLE session asked for Sent's UIDNEXT. */
  sentChecks = 0;

  /**
   * IDLE (RFC 2177): sessions open on this server, every IDLE login it
   * accepted or refused, and the switches a test flips. A server without
   * `IDLE` in `capabilities` answers the IDLE factory with 'unsupported'.
   */
  readonly idlers = new Set<FakeIdleSession>();
  idleConnects = 0;
  /** When set, an IDLE login is refused the way a provider refuses a revoked app password. */
  refuseIdleLogin = false;
  /** When set, an IDLE connect fails like a network that is down (not a refusal). */
  idleUnreachable = false;

  constructor(seed: Record<string, FakeMailbox> = {}) {
    for (const [name, box] of Object.entries(seed)) this.mailboxes.set(name, box);
  }

  /**
   * A Gmail-shaped server: `X-GM-EXT-1`, INBOX, All Mail (`\\All`), Trash
   * (`\\Trash`), Sent, and whatever labels a test adds as folders. Moving a
   * message to Trash drops its labels, as Gmail does.
   */
  static gmail(labels: string[] = []): FakeImapServer {
    const server = new FakeImapServer({
      INBOX: { uidValidity: 1, messages: [] },
      '[Gmail]/All Mail': { uidValidity: 11, messages: [], specialUse: '\\All' },
      '[Gmail]/Sent Mail': { uidValidity: 12, messages: [], specialUse: '\\Sent' },
      '[Gmail]/Trash': { uidValidity: 13, messages: [], specialUse: '\\Trash' },
    });
    labels.forEach((label, i) => server.mailboxes.set(label, { uidValidity: 20 + i, messages: [] }));
    server.capabilities = ['IMAP4REV1', 'MOVE', 'UIDPLUS', 'X-GM-EXT-1'];
    return server;
  }

  /** Whether this server says it is Gmail. */
  get isGmail(): boolean {
    return this.capabilities.includes('X-GM-EXT-1');
  }

  /** The message at `<mailbox>/<uid>`, or undefined. */
  find(name: string, uid: number): HeldMessage | undefined {
    return this.mailboxes.get(name)?.messages.find((m) => m.uid === uid);
  }

  /** All Mail's alias uids for messages this fake keeps in another (label or inbox) folder. */
  readonly allMailAliases = new Map<number, { mailbox: string; uid: number }>();

  /** An All Mail uid for a message held outside All Mail, Trash and Spam, or null. */
  allMailAlias(messageId: string): number | null {
    for (const [name, box] of this.mailboxes) {
      if (box.specialUse === '\\Trash' || box.specialUse === '\\Junk' || box.specialUse === '\\All') continue;
      const m = box.messages.find((x) => x.messageId === messageId);
      if (!m) continue;
      const uid = 1_000_000 + this.allMailAliases.size + 1;
      this.allMailAliases.set(uid, { mailbox: name, uid: m.uid });
      return uid;
    }
    return null;
  }

  /** Where a message with this Message-ID is now: every `{ mailbox, uid }` holding it. */
  whereIs(messageId: string): Array<{ mailbox: string; uid: number }> {
    const out: Array<{ mailbox: string; uid: number }> = [];
    for (const [name, box] of this.mailboxes) {
      for (const m of box.messages) if (m.messageId === messageId) out.push({ mailbox: name, uid: m.uid });
    }
    return out;
  }

  /** `UID MOVE`, as a server does it: the next uid in the destination, gone from the source. */
  moveMessages(source: string, uids: readonly number[], destination: string): MoveResult {
    if (!this.capabilities.includes('MOVE')) throw new Error('fake imap: MOVE is not supported here');
    if (!this.mailboxes.has(destination)) throw new Error(`fake imap: [TRYCREATE] no mailbox ${destination}`);
    const from = this.mailbox(source);
    const to = this.mailbox(destination);
    const uidMap = new Map<number, number>();
    for (const uid of [...uids].sort((a, b) => a - b)) {
      const message = from.messages.find((m) => m.uid === uid);
      if (!message) continue;
      const next = Math.max(0, ...to.messages.map((m) => m.uid), to.uidNextFloor ?? 0) + 1;
      to.uidNextFloor = next;
      const labels = this.isGmail ? gmailLabelsAfterMove(message.labels ?? [], source, destination, this) : message.labels;
      to.messages.push({ ...message, uid: next, ...(labels ? { labels } : {}) });
      from.messages = from.messages.filter((m) => m.uid !== uid);
      this.#vanish(source, uid);
      this.#touch(destination, next);
      uidMap.set(uid, next);
      this.#notify(source, 'expunge');
      this.#notify(destination, 'exists');
    }
    this.writes.push({ op: 'move', mailbox: source, uids: [...uids], destination });
    return {
      uidValidity: this.capabilities.includes('UIDPLUS') ? to.uidValidity : null,
      uidMap: this.capabilities.includes('UIDPLUS') ? uidMap : new Map(),
    };
  }

  /** `UID STORE ±FLAGS`. */
  storeFlags(name: string, uids: readonly number[], flags: readonly string[], how: 'add' | 'remove'): void {
    const box = this.mailbox(name);
    for (const m of box.messages) {
      if (!uids.includes(m.uid)) continue;
      const set = new Set(m.flags);
      for (const f of flags) how === 'add' ? set.add(f) : set.delete(f);
      m.flags = [...set];
      this.#touch(name, m.uid);
      this.#notify(name, 'flags');
    }
    this.writes.push({ op: 'store', mailbox: name, uids: [...uids], flags: [...flags], how });
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
  add(name: string, message: Omit<FetchedMessage, 'uid'> & { uid?: number; labels?: string[] }): number {
    const box = this.mailbox(name);
    const uid = message.uid ?? Math.max(0, ...box.messages.map((m) => m.uid), box.uidNextFloor ?? 0) + 1;
    box.uidNextFloor = Math.max(box.uidNextFloor ?? 0, uid);
    box.messages.push({ ...message, uid });
    this.#touch(name, uid);
    this.#notify(name, 'exists');
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
    this.#notify(name, 'flags');
  }

  /** Archive or delete elsewhere: the message is simply not in this mailbox any more. */
  remove(name: string, uid: number): void {
    const box = this.mailbox(name);
    box.messages = box.messages.filter((m) => m.uid !== uid);
    this.#vanish(name, uid);
    this.#notify(name, 'expunge');
  }

  /**
   * What another mail app does when it moves a message: gone from `source`,
   * in `destination` under the next uid there (labels as Gmail would leave
   * them). Returns the new uid.
   */
  moveElsewhere(source: string, uid: number, destination: string): number {
    const caps = this.capabilities;
    this.capabilities = caps.includes('MOVE') ? caps : [...caps, 'MOVE'];
    try {
      const result = this.moveMessages(source, [uid], destination);
      this.writes.pop();
      const to = result.uidMap.get(uid);
      if (to !== undefined) return to;
      return Math.max(...this.mailbox(destination).messages.map((m) => m.uid));
    } finally {
      this.capabilities = caps;
    }
  }

  /** A message left `name`: forget its modseq, and on a QRESYNC mailbox remember it vanished. */
  #vanish(name: string, uid: number): void {
    this.modseqs.delete(`${name}/${uid}`);
    const box = this.mailbox(name);
    if (box.condstore && box.qresync) {
      box.highestModseq = (box.highestModseq ?? 1) + 1;
      this.vanishedLog.push({ mailbox: name, uid, modseq: box.highestModseq });
    }
  }

  /**
   * Gmail's `UID STORE ±X-GM-LABELS`. `\\Inbox` is membership of INBOX,
   * not a stored label here: taking it off moves the message to the label
   * folder it was given last (else All Mail), putting it on brings it back to
   * INBOX. Taking off the label of the folder it sits in moves it the same
   * way. Other labels are just kept on the message.
   */
  storeLabels(name: string, uids: readonly number[], labels: readonly string[], how: 'add' | 'remove'): void {
    if (!this.isGmail) throw new Error('fake imap: X-GM-LABELS on a server that is not Gmail');
    const box = this.mailbox(name);
    const allMail = [...this.mailboxes.entries()].find(([, b]) => b.specialUse === '\\All')?.[0] ?? null;
    const isLabelFolder = (l: string): boolean => this.mailboxes.has(l) && !this.mailboxes.get(l)!.specialUse && l !== 'INBOX';
    for (const uid of [...uids]) {
      const message = box.messages.find((m) => m.uid === uid);
      if (!message) continue;
      const held = new Set((message.labels ?? []).filter((l) => l !== '\\Inbox'));
      let inbox = name === 'INBOX';
      for (const label of labels) {
        if (label === '\\Inbox') inbox = how === 'add';
        else if (how === 'add') held.add(label);
        else held.delete(label);
      }
      message.labels = [...held];
      let home: string | null = name;
      if (inbox) home = 'INBOX';
      else if (name === 'INBOX' || (isLabelFolder(name) && !held.has(name))) {
        // The label added last: the single copy here sits where the newest label puts it.
        home = [...held].reverse().find(isLabelFolder) ?? allMail;
      }
      if (home && home !== name) {
        const to = this.mailbox(home);
        const next = Math.max(0, ...to.messages.map((m) => m.uid), to.uidNextFloor ?? 0) + 1;
        to.uidNextFloor = next;
        to.messages.push({ ...message, uid: next });
        box.messages = box.messages.filter((m) => m.uid !== uid);
        this.#vanish(name, uid);
        this.#touch(home, next);
        this.#notify(name, 'expunge');
        this.#notify(home, 'exists');
      } else {
        this.#touch(name, uid);
      }
    }
    this.writes.push({ op: 'store-labels', mailbox: name, uids: [...uids], labels: [...labels], how });
  }

  /** Tell every session idling on this mailbox, as an untagged response would. */
  #notify(name: string, change: IdleChange): void {
    for (const session of this.idlers) session.push(name, change);
  }

  /** The network drops every IDLE connection: each session ends with an error. */
  dropIdle(): void {
    for (const session of [...this.idlers]) session.drop(new Error('fake imap: connection reset'));
  }

  /** The IDLE factory: a connection of its own on INBOX, as the real one opens. */
  idleFactory(): ImapIdleFactory {
    return async (_account, auth, onChange) => {
      this.idleConnects += 1;
      if (this.idleUnreachable) throw Object.assign(new Error('fake imap: connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      if (this.refuseIdleLogin || auth.pass === 'wrong') {
        throw Object.assign(new Error('Command failed'), {
          authenticationFailed: true,
          responseText: 'Invalid credentials (Failure)',
        });
      }
      if (!this.capabilities.includes('IDLE')) return 'unsupported';
      const session = new FakeIdleSession(this, 'INBOX', onChange);
      this.idlers.add(session);
      return session;
    };
  }

  /** @internal */
  forget(session: FakeIdleSession): void {
    this.idlers.delete(session);
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
        uidNext: Math.max(0, ...box.messages.map((m) => m.uid), box.uidNextFloor ?? 0) + 1,
        exists: box.messages.length,
      },
    }));
  }

  client(): ImapWriter {
    return new FakeImapClient(this);
  }

  factory(): ImapClientFactory {
    return async () => this.client();
  }
}

/** One IDLE connection on the fake server. */
class FakeIdleSession implements ImapIdleSession {
  readonly ended: Promise<{ error?: unknown }>;
  #settle!: (outcome: { error?: unknown }) => void;
  #done = false;

  constructor(
    private readonly server: FakeImapServer,
    private readonly mailbox: string,
    private readonly onChange: (change: IdleChange) => void,
  ) {
    this.ended = new Promise((resolve) => {
      this.#settle = resolve;
    });
  }

  push(mailbox: string, change: IdleChange): void {
    if (this.#done || mailbox !== this.mailbox) return;
    this.onChange(change);
  }

  /** `STATUS <Sent> (UIDNEXT)` over this connection, as the real session asks it. */
  async sentUidNext(folder: string): Promise<number | null> {
    if (this.#done) throw new Error('fake imap: IDLE connection is closed');
    if (!this.server.mailboxes.has(folder)) return null;
    this.server.sentChecks += 1;
    const box = this.server.mailbox(folder);
    return Math.max(0, ...box.messages.map((m) => m.uid), box.uidNextFloor ?? 0) + 1;
  }

  drop(error: unknown): void {
    if (this.#done) return;
    this.#done = true;
    this.server.forget(this);
    this.#settle({ error });
  }

  async close(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    this.server.forget(this);
    this.#settle({});
  }
}

class FakeImapClient implements ImapWriter {
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
      uidNext: Math.max(0, ...box.messages.map((m) => m.uid), box.uidNextFloor ?? 0) + 1,
      exists: box.messages.length,
      highestModseq: box.condstore ? String(box.highestModseq ?? 1) : null,
    };
  }

  async fetchBulk(mailbox: string, uids: readonly number[]): Promise<Map<number, boolean>> {
    if (this.#closed) throw new Error('fake imap: client is closed');
    const box = this.server.mailbox(mailbox);
    const wanted = new Set(uids);
    this.server.bulkFetches.push({ mailbox, uids: [...uids] });
    return new Map(box.messages.filter((m) => wanted.has(m.uid)).map((m) => [m.uid, m.bulk === true]));
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
    return selected.map(({ labels: _labels, ...m }) => ({
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

  async fetchHtml(mailbox: string, uid: number, maxBytes: number): Promise<string | null> {
    if (this.#closed) throw new Error('fake imap: client is closed');
    this.server.htmlFetches.push({ mailbox, uid, maxBytes });
    if (this.server.htmlDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.server.htmlDelayMs));
    const message = this.server.mailbox(mailbox).messages.find((m) => m.uid === uid);
    if (!message || !message.bodyHtml) return null;
    return message.bodyHtml.slice(0, maxBytes);
  }

  async capabilities(): Promise<string[]> {
    if (this.#closed) throw new Error('fake imap: client is closed');
    return this.server.capabilities.map((c) => c.toUpperCase());
  }

  async storeFlags(mailbox: string, uids: readonly number[], flags: readonly string[], op: 'add' | 'remove'): Promise<void> {
    if (this.#closed) throw new Error('fake imap: client is closed');
    this.server.storeFlags(mailbox, uids, flags, op);
  }

  async move(mailbox: string, uids: readonly number[], destination: string): Promise<MoveResult> {
    if (this.#closed) throw new Error('fake imap: client is closed');
    return this.server.moveMessages(mailbox, uids, destination);
  }

  async findByMessageId(mailbox: string, messageId: string): Promise<number | null> {
    if (this.#closed) throw new Error('fake imap: client is closed');
    const found = this.server.mailbox(mailbox).messages.find((m) => m.messageId === messageId);
    if (found) return found.uid;
    // Gmail's All Mail holds every message not in Trash or Spam, whichever
    // label folder this fake keeps its one copy in: answer with an alias uid.
    if (this.server.isGmail && this.server.mailboxes.get(mailbox)?.specialUse === '\\All') {
      return this.server.allMailAlias(messageId);
    }
    return null;
  }

  async fetchLabels(mailbox: string, uids: readonly number[]): Promise<Map<number, string[]>> {
    if (!this.server.isGmail) throw new Error('fake imap: X-GM-LABELS on a server that is not Gmail');
    const out = new Map<number, string[]>();
    for (const uid of uids) {
      const alias = this.server.allMailAliases.get(uid);
      if (alias && this.server.mailboxes.get(mailbox)?.specialUse === '\\All') {
        const m = this.server.find(alias.mailbox, alias.uid);
        if (m) out.set(uid, [...(m.labels ?? [])]);
      }
    }
    for (const m of this.server.mailbox(mailbox).messages) {
      if (uids.includes(m.uid)) out.set(m.uid, [...(m.labels ?? [])]);
    }
    return out;
  }

  async departures(
    mailbox: string,
    range: { fromUid: number; toUid: number; changedSince?: string | null },
  ): Promise<{ vanished: number[] } | { present: number[] }> {
    if (this.#closed) throw new Error('fake imap: client is closed');
    const box = this.server.mailbox(mailbox);
    const inRange = (uid: number): boolean => uid >= range.fromUid && uid <= range.toUid;
    if (range.changedSince && box.condstore && box.qresync) {
      const since = Number(range.changedSince);
      const vanished = this.server.vanishedLog
        .filter((v) => v.mailbox === mailbox && v.modseq > since && inRange(v.uid))
        .map((v) => v.uid);
      this.server.departureChecks.push({ mailbox, via: 'vanished', fromUid: range.fromUid, toUid: range.toUid });
      return { vanished };
    }
    this.server.departureChecks.push({ mailbox, via: 'search', fromUid: range.fromUid, toUid: range.toUid });
    return { present: box.messages.map((m) => m.uid).filter(inRange).sort((a, b) => a - b) };
  }

  async storeLabels(mailbox: string, uids: readonly number[], labels: readonly string[], op: 'add' | 'remove'): Promise<void> {
    if (this.#closed) throw new Error('fake imap: client is closed');
    this.server.storeLabels(mailbox, uids, labels, op);
  }

  async addLabels(mailbox: string, uids: readonly number[], labels: readonly string[]): Promise<void> {
    if (!this.server.isGmail) throw new Error('fake imap: X-GM-LABELS on a server that is not Gmail');
    for (const m of this.server.mailbox(mailbox).messages) {
      if (!uids.includes(m.uid)) continue;
      m.labels = [...new Set([...(m.labels ?? []), ...labels])].filter((l) => l !== '\\Inbox');
    }
    this.server.writes.push({ op: 'labels', mailbox, uids: [...uids], labels: [...labels] });
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
