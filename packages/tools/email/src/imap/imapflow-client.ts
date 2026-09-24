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
  ImapClient,
  ImapClientFactory,
  MailboxInfo,
  MailboxStatus,
  AccountRecord,
} from '../ports.js';
import { normalizeMessageId, parseReferences } from '../mail.js';
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

class ImapFlowClient implements ImapClient {
  #open: string | null = null;

  constructor(private readonly client: ImapFlowLike) {}

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
        headers: ['message-id', 'in-reply-to', 'references', 'list-id'],
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
      if (text) {
        // BODY.PEEK — reading never marks the message seen.
        const downloaded = await this.client.download(String(uid), text.part, { uid: true });
        const raw = await readAll(downloaded?.content ?? null, MAX_BODY_BYTES);
        bodyText = text.type === 'text/html' ? stripHtml(raw) : raw;
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
        from: addressList(envelope.from)[0] ?? '(unknown)',
        to: addressList(envelope.to),
        cc: addressList(envelope.cc),
        subject: String(envelope.subject ?? ''),
        date: envelope.date ? new Date(envelope.date as string) : null,
        // The server's own record of when the message arrived — sender-
        // controlled `date` is never used for thread ordering (threads.ts).
        internalDate: msg.internalDate ? new Date(msg.internalDate as string | Date) : null,
        bodyText,
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
  });
  await client.connect();
  return new ImapFlowClient(client);
};
