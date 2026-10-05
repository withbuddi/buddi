/**
 * The real IMAP adapter: `imapflow` behind the `ImapClient` port.
 *
 * Three properties are not negotiable here.
 *
 * 1. **Verified TLS.** `secure: true`, and `rejectUnauthorized` is never turned
 *    off. An app password is a bearer secret with full mailbox privileges;
 *    handing it to whoever answers on port 993 is the whole attack.
 * 2. **Peek, always.** Every body fetch goes through `download()`, which issues
 *    `BODY.PEEK[...]`, so reading mail never sets `\Seen`. "Read mail must not
 *    mutate flags" is a trust-model rule, not a preference.
 * 3. **No ambient credentials.** The client is constructed with the credentials
 *    it is given. It never reads `process.env`, and it never discovers a login.
 *
 * `imapflow` is imported dynamically so that nothing loads a socket library at
 * plugin-registration time, and so the fake path has no dependency at all.
 */
import type {
  AttachmentInfo,
  EmailAuth,
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
  AccountRecord,
} from '../ports.js';
import { authenticatedDomain, isBulkHeaders, normalizeMessageId, parseReferences, trustedAuthResults } from '../mail.js';
import { isPartId, safeFilename } from '../attachments/safety.js';

/** Only what this adapter uses. Keeps the port independent of imapflow's d.ts. */
interface ImapFlowLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string, opts?: { readOnly?: boolean }): Promise<Record<string, unknown>>;
  list(options?: Record<string, unknown>): Promise<Array<Record<string, any>>>;
  fetch(
    range: string | Record<string, unknown>,
    query: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): AsyncIterable<Record<string, any>>;
  download(
    range: string,
    part?: string,
    options?: Record<string, unknown>,
  ): Promise<{ content: AsyncIterable<Buffer> | null } | null>;
  capabilities?: Map<string, unknown>;
  messageFlagsAdd(range: string, flags: string[], options?: Record<string, unknown>): Promise<boolean>;
  messageFlagsRemove(range: string, flags: string[], options?: Record<string, unknown>): Promise<boolean>;
  messageMove(
    range: string,
    destination: string,
    options?: Record<string, unknown>,
  ): Promise<{ uidValidity?: bigint; uidMap?: Map<number, number> } | false | undefined>;
  search(query: Record<string, unknown>, options?: Record<string, unknown>): Promise<number[] | false | undefined>;
  /** What the session ENABLEd (CONDSTORE, QRESYNC, …). */
  enabled?: Set<string>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}

type ImapFlowCtor = new (options: Record<string, unknown>) => ImapFlowLike;

/** Hard cap on a downloaded text part, so one enormous mail cannot eat memory. */
export const MAX_BODY_BYTES = 512 * 1024;

function addressList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (entry as { address?: string }).address)
    .filter((a): a is string => typeof a === 'string' && a.trim() !== '');
}

/**
 * Walk a body structure for the first `text/plain` part, then `text/html`.
 * Returns the IMAP part path (`1.2`), or `'1'` for a single-part message.
 */
export function findTextPart(node: Record<string, any> | undefined): {
  part: string;
  type: string;
} | null {
  if (!node) return null;
  const search = (n: Record<string, any>, path: string): { part: string; type: string } | null => {
    const type = String(n.type ?? '').toLowerCase();
    const children: Record<string, any>[] = Array.isArray(n.childNodes) ? n.childNodes : [];
    if (children.length === 0) {
      if (type === 'text/plain' || type === 'text/html') {
        return { part: n.part ? String(n.part) : path, type };
      }
      return null;
    }
    for (const pass of ['text/plain', 'text/html']) {
      for (const [i, child] of children.entries()) {
        const found = search(child, path === '' ? String(i + 1) : `${path}.${i + 1}`);
        if (found && found.type === pass) return found;
      }
    }
    return null;
  };
  return search(node, '');
}

/**
 * The HTML part a message carries beside (or instead of) its text, by its
 * IMAP part path. The first `text/html` leaf that is not an attachment.
 */
export function findHtmlPart(node: Record<string, any> | undefined): string | null {
  if (!node) return null;
  const search = (n: Record<string, any>, path: string): string | null => {
    const type = String(n.type ?? '').toLowerCase();
    const children: Record<string, any>[] = Array.isArray(n.childNodes) ? n.childNodes : [];
    if (children.length === 0) {
      const attached = String(n.disposition ?? '').toLowerCase() === 'attachment';
      return type === 'text/html' && !attached ? (n.part ? String(n.part) : path === '' ? '1' : path) : null;
    }
    for (const [i, child] of children.entries()) {
      const found = search(child, path === '' ? String(i + 1) : `${path}.${i + 1}`);
      if (found) return found;
    }
    return null;
  };
  return search(node, '');
}

/** The display name on an envelope address list's first entry, or null. */
export function firstName(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const name = (value[0] as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 200) : null;
}

/** Attachment metadata from a body structure. Bytes are never downloaded. */
export function collectAttachments(node: Record<string, any> | undefined): AttachmentInfo[] {
  if (!node) return [];
  const out: AttachmentInfo[] = [];
  const walk = (n: Record<string, any>): void => {
    const children: Record<string, any>[] = Array.isArray(n.childNodes) ? n.childNodes : [];
    const disposition = String(n.disposition ?? '').toLowerCase();
    const type = String(n.type ?? '').toLowerCase();
    if (children.length === 0 && (disposition === 'attachment' || (n.dispositionParameters?.filename ?? n.parameters?.name))) {
      const part = n.part ? String(n.part) : '';
      out.push({
        // Normalised at the door: the name that is stored is the name the
        // refusal check will read, and a trailing space must not be able to
        // hide an extension from one of them (attachments/safety.ts).
        filename: safeFilename(
          (n.dispositionParameters?.filename as string | undefined) ??
            (n.parameters?.name as string | undefined) ??
            null,
        ),
        mime: type || 'application/octet-stream',
        sizeBytes: Number(n.size ?? 0),
        // The body part this file is, so a later fetch asks for it by name
        // rather than parsing the message again. `imapflow` fills `part` on
        // every node but the root of a single-part message, which carries no
        // attachment anyway. Anything that is not a part id is not stored as
        // one — the fetch re-reads the structure rather than trusting it.
        part: isPartId(part) ? part : null,
        // What a `cid:` picture in the HTML names this part by, without its brackets.
        ...(typeof n.id === 'string' && n.id.trim() !== '' ? { contentId: n.id.trim().replace(/^<|>$/g, '').slice(0, 200) } : {}),
      });
    }
    for (const child of children) walk(child);
  };
  walk(node);
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readAll(content: AsyncIterable<Buffer> | null, maxBytes: number): Promise<string> {
  if (!content) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of content) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= maxBytes) break;
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

class ImapFlowClient implements ImapWriter {
  #open: string | null = null;
  /** Whether the open mailbox was selected read-write (only the writes below ask for that). */
  #writable = false;

  /**
   * @param imapHost the account's IMAP host: whose receiving server's
   *   `Authentication-Results` is the only one believed (`trustedAuthResults`).
   */
  constructor(
    private readonly client: ImapFlowLike,
    private readonly imapHost: string = '',
  ) {}

  /**
   * Every folder, with what the server says each is for.
   *
   * `imapflow`'s LIST reply carries `specialUse` when the server offers
   * SPECIAL-USE and `flags` as a Set; both are handed over as they arrived and
   * `folders.ts` is what decides what they mean.
   */
  async listMailboxes(): Promise<MailboxInfo[]> {
    const listing = await this.client.list({
      statusQuery: { uidValidity: true, uidNext: true, messages: true },
    });
    return listing.map((box) => ({
      name: String(box.path ?? box.name ?? ''),
      specialUse: typeof box.specialUse === 'string' ? box.specialUse : null,
      flags: [...(box.flags instanceof Set ? box.flags : new Set<string>())].map(String),
      status: box.status && box.status.uidValidity !== undefined && box.status.uidNext !== undefined
        ? {
            uidValidity: Number(box.status.uidValidity),
            uidNext: Number(box.status.uidNext),
            exists: Number(box.status.messages ?? 0),
          }
        : undefined,
    })).filter((box) => box.name !== '');
  }

  async open(mailbox: string): Promise<MailboxStatus> {
    // Read-only: the source observes the mailbox, it never curates it.
    const box = await this.client.mailboxOpen(mailbox, { readOnly: true });
    this.#open = mailbox;
    this.#writable = false;
    return {
      uidValidity: Number(box.uidValidity as number | bigint),
      uidNext: Number(box.uidNext ?? 0),
      exists: Number(box.exists ?? 0),
      // imapflow ENABLEs CONDSTORE on connect when the server advertises it
      // and parses HIGHESTMODSEQ as a BigInt; absent (or NOMODSEQ) otherwise.
      highestModseq:
        box.highestModseq !== undefined && box.highestModseq !== null && !box.noModseq
          ? String(box.highestModseq)
          : null,
    };
  }

  /**
   * `UID FETCH <set> (UID FLAGS)`, optionally `(CHANGEDSINCE <modseq>)`.
   *
   * Nothing but flags is asked for — no envelope, no body structure, no
   * `BODY.PEEK` — so this is a few bytes per message and cannot mark one
   * seen. The uid list is sent as a compact set (`3:9,12,40:41`).
   */
  async fetchFlags(
    mailbox: string,
    uids: readonly number[],
    changedSince?: string | null,
  ): Promise<FlagState[]> {
    if (uids.length === 0) return [];
    if (this.#open !== mailbox) await this.open(mailbox);
    const out: FlagState[] = [];
    for await (const msg of this.client.fetch(
      uidSet(uids),
      { uid: true, flags: true },
      changedSince ? { uid: true, changedSince: BigInt(changedSince) } : { uid: true },
    )) {
      out.push({
        uid: Number(msg.uid),
        flags: [...(msg.flags instanceof Set ? msg.flags : new Set<string>())].map(String),
      });
    }
    return out;
  }

  async fetchBulk(mailbox: string, uids: readonly number[]): Promise<Map<number, boolean>> {
    const out = new Map<number, boolean>();
    if (uids.length === 0) return out;
    if (this.#open !== mailbox) await this.open(mailbox);
    for await (const msg of this.client.fetch(uidSet(uids), { uid: true, headers: ['list-unsubscribe', 'precedence'] }, { uid: true })) {
      out.set(Number(msg.uid), isBulkHeaders(parseHeaders(msg.headers)));
    }
    return out;
  }

  /**
   * Which held uids left the mailbox. On a session that ENABLEd QRESYNC and
   * given a modseq, `UID FETCH from:to (UID FLAGS) (CHANGEDSINCE m VANISHED)`
   * — imapflow adds VANISHED itself — and the server's `VANISHED (EARLIER)`
   * arrives as `expunge` events, collected here. Otherwise `UID SEARCH UID
   * from:to`: the uids still there. Neither reads a header or a body.
   */
  async departures(
    mailbox: string,
    range: { fromUid: number; toUid: number; changedSince?: string | null },
  ): Promise<{ vanished: number[] } | { present: number[] }> {
    if (this.#open !== mailbox) await this.open(mailbox);
    const span = `${range.fromUid}:${range.toUid}`;
    if (range.changedSince && this.client.enabled?.has('QRESYNC') && this.client.on && this.client.off) {
      const vanished: number[] = [];
      const listener = (payload: unknown): void => {
        const p = payload as { path?: string; uid?: number; vanished?: boolean } | undefined;
        if (p?.vanished && typeof p.uid === 'number' && (p.path === undefined || p.path === mailbox)) vanished.push(p.uid);
      };
      this.client.on('expunge', listener);
      try {
        for await (const _msg of this.client.fetch(span, { uid: true, flags: true }, { uid: true, changedSince: BigInt(range.changedSince) })) {
          // Flag changes are the flag re-sync's business; only VANISHED matters here.
        }
      } finally {
        this.client.off('expunge', listener);
      }
      return { vanished: vanished.filter((uid) => uid >= range.fromUid && uid <= range.toUid) };
    }
    const found = await this.client.search({ uid: span }, { uid: true });
    return { present: (found || []).map(Number) };
  }

  async fetchSince(mailbox: string, sinceUid: number, limit: number): Promise<FetchedMessage[]> {
    if (this.#open !== mailbox) await this.open(mailbox);
    const range = `${sinceUid + 1}:*`;
    const collected: Record<string, any>[] = [];
    for await (const msg of this.client.fetch(
      range,
      {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        internalDate: true,
        headers: ['message-id', 'in-reply-to', 'references', 'list-id', 'list-unsubscribe', 'precedence', 'authentication-results'],
      },
      { uid: true },
    )) {
      // The server is free to include the last message even when its uid is at
      // or below the range start (`*` semantics), so the cursor is re-checked.
      if (Number(msg.uid) <= sinceUid) continue;
      collected.push(msg);
      if (collected.length > limit * 4) break;
    }
    collected.sort((a, b) => Number(a.uid) - Number(b.uid));
    const selected = collected.slice(0, limit);

    const out: FetchedMessage[] = [];
    for (const msg of selected) {
      const uid = Number(msg.uid);
      const envelope = (msg.envelope ?? {}) as Record<string, any>;
      const headers = parseHeaders(msg.headers);
      const text = findTextPart(msg.bodyStructure as Record<string, any>);
      let bodyText = '';
      let bodyHtml: string | null = null;
      if (text) {
        // BODY.PEEK — reading never marks the message seen.
        const downloaded = await this.client.download(String(uid), text.part, { uid: true });
        const raw = await readAll(downloaded?.content ?? null, MAX_BODY_BYTES);
        bodyText = text.type === 'text/html' ? stripHtml(raw) : raw;
        if (text.type === 'text/html') bodyHtml = raw;
      }
      /*
       * The HTML part too, when there is one beside the text: what the Mail
       * page draws. Sanitised and capped at ingest (`html.ts`); a peek, like
       * every body read here.
       */
      const htmlPart = text?.type === 'text/html' ? null : findHtmlPart(msg.bodyStructure as Record<string, any>);
      if (htmlPart) {
        try {
          const downloaded = await this.client.download(String(uid), htmlPart, { uid: true });
          bodyHtml = await readAll(downloaded?.content ?? null, MAX_BODY_BYTES);
        } catch {
          // The text is already in hand; a part the server will not give is no reason to lose the message.
          bodyHtml = null;
        }
      }
      const attachments = collectAttachments(msg.bodyStructure as Record<string, any>);
      out.push({
        uid,
        messageId: normalizeMessageId(
          (envelope.messageId as string | undefined) ?? headers['message-id'],
        ),
        inReplyTo: normalizeMessageId(
          (envelope.inReplyTo as string | undefined) ?? headers['in-reply-to'],
        ),
        references: parseReferences(headers['references']),
        listId: headers['list-id'] ?? null,
        bulk: isBulkHeaders(headers),
        authDomain: authenticatedDomain(
          trustedAuthResults(allHeaders(msg.headers, 'authentication-results'), this.imapHost),
          addressList(envelope.from)[0] ?? '',
        ),
        from: addressList(envelope.from)[0] ?? '(unknown)',
        fromName: firstName(envelope.from),
        to: addressList(envelope.to),
        cc: addressList(envelope.cc),
        subject: String(envelope.subject ?? ''),
        date: envelope.date ? new Date(envelope.date as string) : null,
        // The server's own record of when the message arrived — sender-
        // controlled `date` is never used for thread ordering (threads.ts).
        internalDate: msg.internalDate ? new Date(msg.internalDate as string | Date) : null,
        bodyText,
        bodyHtml,
        hasAttachments: attachments.length > 0,
        attachments,
        flags: [...(msg.flags instanceof Set ? msg.flags : new Set<string>())].map(String),
      });
    }
    return out;
  }

  /**
   * The attachment listing of one message, from its body structure alone.
   *
   * `fetch` with `bodyStructure` downloads no body — it is the same metadata
   * ingest reads — so this is cheap, and it is the path for a message stored
   * before part ids were recorded.
   */
  async listAttachments(mailbox: string, uid: number): Promise<AttachmentInfo[] | null> {
    if (this.#open !== mailbox) await this.open(mailbox);
    for await (const msg of this.client.fetch(
      String(uid),
      { uid: true, bodyStructure: true },
      { uid: true },
    )) {
      if (Number(msg.uid) !== uid) continue;
      return collectAttachments(msg.bodyStructure as Record<string, any>);
    }
    return null;
  }

  /**
   * One attachment's bytes.
   *
   * `download()` issues `BODY.PEEK[<part>]` and decodes the transfer encoding,
   * so what comes back is the file — and reading it still never sets `\Seen`.
   * The cap is enforced **on the stream**: the declared size in a body
   * structure is the server's claim about a part, and a 25 MB ceiling that
   * trusts a claim is a ceiling somebody can walk through. Past it the
   * iteration stops, which drops the connection's read, and the call throws.
   */
  async downloadAttachment(
    mailbox: string,
    uid: number,
    part: string,
    maxBytes: number,
  ): Promise<Buffer | null> {
    if (this.#open !== mailbox) await this.open(mailbox);
    const downloaded = await this.client.download(String(uid), part, { uid: true });
    const content = downloaded?.content ?? null;
    if (!content) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of content) {
      total += chunk.length;
      if (total > maxBytes) {
        throw new Error(
          `attachment part ${part} of uid ${uid} is larger than the ${maxBytes}-byte cap`,
        );
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /* ---------------------------------------------------------------- *
   * The writes (`ImapWriter`). Reached only from `mailbox/actions.ts`.
   * ---------------------------------------------------------------- */

  /** SELECT read-write, once, for the writes below. Every read above stays EXAMINE. */
  async #openWritable(mailbox: string): Promise<void> {
    if (this.#open === mailbox && this.#writable) return;
    await this.client.mailboxOpen(mailbox, { readOnly: false });
    this.#open = mailbox;
    this.#writable = true;
  }

  async capabilities(): Promise<string[]> {
    return [...(this.client.capabilities?.keys() ?? [])].map((c) => String(c).toUpperCase());
  }

  async storeFlags(mailbox: string, uids: readonly number[], flags: readonly string[], op: 'add' | 'remove'): Promise<void> {
    if (uids.length === 0) return;
    await this.#openWritable(mailbox);
    const ok = op === 'add'
      ? await this.client.messageFlagsAdd(uidSet(uids), [...flags], { uid: true })
      : await this.client.messageFlagsRemove(uidSet(uids), [...flags], { uid: true });
    if (ok === false) throw new Error(`the server refused to change flags in ${mailbox}`);
  }

  /**
   * `UID MOVE`, and only that. `imapflow` falls back to COPY + `\Deleted` +
   * EXPUNGE on a server without MOVE, which can expunge more than was asked
   * for; so a server that does not say MOVE is refused before the call.
   */
  async move(mailbox: string, uids: readonly number[], destination: string): Promise<MoveResult> {
    if (uids.length === 0) return { uidValidity: null, uidMap: new Map() };
    if (!(await this.capabilities()).includes('MOVE')) {
      throw new Error('this mail server cannot move messages (no MOVE), and buddi never deletes to fake one');
    }
    await this.#openWritable(mailbox);
    const result = await this.client.messageMove(uidSet(uids), destination, { uid: true });
    if (!result) throw new Error(`the server refused to move messages from ${mailbox} to ${destination}`);
    return {
      uidValidity: result.uidValidity !== undefined ? Number(result.uidValidity) : null,
      uidMap: result.uidMap ?? new Map(),
    };
  }

  async findByMessageId(mailbox: string, messageId: string): Promise<number | null> {
    if (this.#open !== mailbox) await this.open(mailbox);
    const found = await this.client.search({ header: { 'message-id': messageId } }, { uid: true });
    if (!found || found.length === 0) return null;
    return Math.max(...found.map(Number));
  }

  async fetchLabels(mailbox: string, uids: readonly number[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    if (uids.length === 0) return out;
    if (this.#open !== mailbox) await this.open(mailbox);
    for await (const msg of this.client.fetch(uidSet(uids), { uid: true, labels: true }, { uid: true })) {
      out.set(Number(msg.uid), [...(msg.labels instanceof Set ? msg.labels : new Set<string>())].map(String));
    }
    return out;
  }

  async addLabels(mailbox: string, uids: readonly number[], labels: readonly string[]): Promise<void> {
    if (uids.length === 0 || labels.length === 0) return;
    await this.#openWritable(mailbox);
    const ok = await this.client.messageFlagsAdd(uidSet(uids), [...labels], { uid: true, useLabels: true });
    if (ok === false) throw new Error(`the server refused to restore labels in ${mailbox}`);
  }

  async storeLabels(mailbox: string, uids: readonly number[], labels: readonly string[], op: 'add' | 'remove'): Promise<void> {
    if (uids.length === 0 || labels.length === 0) return;
    await this.#openWritable(mailbox);
    const ok = op === 'add'
      ? await this.client.messageFlagsAdd(uidSet(uids), [...labels], { uid: true, useLabels: true })
      : await this.client.messageFlagsRemove(uidSet(uids), [...labels], { uid: true, useLabels: true });
    if (ok === false) throw new Error(`the server refused to change labels in ${mailbox}`);
  }

  async close(): Promise<void> {
    await this.client.logout().catch(() => {});
  }
}

/** Uids as an IMAP sequence set, runs collapsed: `[1,2,3,7]` → `1:3,7`. */
export function uidSet(uids: readonly number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0] as number;
  let prev = start;
  for (const uid of sorted.slice(1)) {
    if (uid === prev + 1) {
      prev = uid;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}:${prev}`);
    start = uid;
    prev = uid;
  }
  if (sorted.length > 0) parts.push(start === prev ? String(start) : `${start}:${prev}`);
  return parts.join(',');
}

/** `message-id: <x>\r\nreferences: …` as a lowercase-keyed map. */
export function parseHeaders(raw: unknown): Record<string, string> {
  if (!raw) return {};
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s/.test(line) && key) {
      out[key] = `${out[key]} ${line.trim()}`;
      continue;
    }
    const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    key = (match[1] as string).toLowerCase();
    out[key] = (match[2] as string).trim();
  }
  return out;
}

/** Every occurrence of one header, unfolded, in order from the top. */
export function allHeaders(raw: unknown, name: string): string[] {
  if (!raw) return [];
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const wanted = name.toLowerCase();
  const out: string[] = [];
  let inWanted = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s/.test(line)) {
      if (inWanted && out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
      continue;
    }
    const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    inWanted = match !== null && (match[1] as string).toLowerCase() === wanted;
    if (inWanted) out.push((match![2] as string).trim());
  }
  return out;
}

/**
 * The first occurrence of one header, unfolded — where `parseHeaders` keeps
 * the last. Not for `Authentication-Results`: the first one there is not
 * necessarily the owner's server's (`allHeaders` + `trustedAuthResults`).
 */
export function firstHeader(raw: unknown, name: string): string | null {
  if (!raw) return null;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const wanted = name.toLowerCase();
  let value: string | null = null;
  let inWanted = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s/.test(line)) {
      if (inWanted && value !== null) value = `${value} ${line.trim()}`;
      continue;
    }
    if (inWanted) return value;
    const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    inWanted = match !== null && (match[1] as string).toLowerCase() === wanted;
    if (inWanted) value = (match![2] as string).trim();
  }
  return value;
}

/** The factory the gateway installs in production. */
export const imapflowFactory: ImapClientFactory = async (
  account: AccountRecord,
  auth: EmailAuth,
) => {
  const mod = (await import('imapflow')) as unknown as { ImapFlow: ImapFlowCtor };
  const client = new mod.ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: auth.user, pass: auth.pass },
    // Verified TLS. Never relaxed — an app password is a full-mailbox bearer.
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    logger: false,
    // ENABLE QRESYNC where the server offers it, so the presence check can
    // ask for VANISHED uids instead of searching (inbox-poll.ts).
    qresync: true,
  });
  await client.connect();
  return new ImapFlowClient(client, account.imapHost);
};

/** What the IDLE connection uses of imapflow, beside `connect` and `logout`. */
interface ImapFlowIdleLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  mailboxOpen(path: string, opts?: { readOnly?: boolean }): Promise<unknown>;
  idle(): Promise<unknown>;
  status(path: string, query: Record<string, boolean>): Promise<{ uidNext?: number | bigint } | undefined>;
  capabilities: Map<string, unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * How long one IDLE runs before imapflow breaks and re-issues it. RFC 2177
 * lets a server drop an IDLE after 30 minutes and some do after 29; ten is
 * well inside that. (imapflow's 5-minute socket timeout also sends a NOOP
 * during a silent IDLE and re-arms it; this does not depend on that.)
 */
export const IDLE_RESTART_MS = 10 * 60_000;

/**
 * The IDLE factory the gateway installs: a connection of its own, INBOX
 * opened read-only (EXAMINE, so idling can never set a flag), IDLE started at
 * once and re-armed by imapflow after every interruption.
 */
export const imapflowIdleFactory: ImapIdleFactory = async (account, auth, onChange) => {
  const mod = (await import('imapflow')) as unknown as { ImapFlow: new (o: Record<string, unknown>) => ImapFlowIdleLike };
  const client = new mod.ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: auth.user, pass: auth.pass },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    logger: false,
    maxIdleTime: IDLE_RESTART_MS,
    autoIdleDelay: 1_000,
    // Never imapflow's NOOP loop: a server without IDLE is the poll's job.
    missingIdleCommand: 'NOOP',
  });
  let settle!: (outcome: { error?: unknown }) => void;
  const ended = new Promise<{ error?: unknown }>((resolve) => {
    settle = resolve;
  });
  let lastError: unknown;
  let closing = false;
  client.on('error', (err) => {
    lastError = err;
  });
  client.on('close', () => settle(closing ? {} : { error: lastError ?? new Error('IDLE connection closed by the server') }));
  const report = (change: IdleChange) => (payload: unknown): void => {
    const path = (payload as { path?: unknown } | undefined)?.path;
    if (typeof path === 'string' && path.toUpperCase() !== 'INBOX') return;
    onChange(change);
  };
  client.on('exists', report('exists'));
  client.on('expunge', report('expunge'));
  client.on('flags', report('flags'));

  try {
    await client.connect();
  } catch (err) {
    closing = true;
    client.close();
    throw err;
  }
  const session: ImapIdleSession = {
    ended,
    // STATUS on this connection: imapflow breaks the IDLE for the one
    // command and re-arms it afterwards. The selected mailbox (INBOX) is
    // never STATUSed (RFC 3501 advises against it) and is never Sent.
    async sentUidNext(folder: string) {
      if (folder.toUpperCase() === 'INBOX') return null;
      const status = await client.status(folder, { uidNext: true });
      return status?.uidNext !== undefined ? Number(status.uidNext) : null;
    },
    async close() {
      if (closing) return;
      closing = true;
      await client.logout().catch(() => {});
      client.close();
      settle({});
    },
  };
  if (!client.capabilities.has('IDLE') && !client.capabilities.has('IMAP4REV2')) {
    await session.close();
    return 'unsupported';
  }
  try {
    await client.mailboxOpen('INBOX', { readOnly: true });
  } catch (err) {
    await session.close();
    throw err;
  }
  // The first IDLE now rather than after the auto-idle delay; imapflow
  // re-arms it after every break (maxIdleTime, a socket-timeout NOOP).
  void client.idle().catch(() => {});
  return session;
};
