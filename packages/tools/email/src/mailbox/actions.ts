/**
 * Changing the owner's mailbox: mark, archive, move, trash — and undo.
 *
 * Until this file the plugin only ever read the server (`ports.ts`: every
 * fetch is a peek). These are the writes, and every way into them is either a
 * gated tool the owner approved, a page button the owner pressed, or a rule
 * the owner set applying itself on arrival. Four things hold for all of them:
 *
 *  - **Nothing is deleted.** The most a write does to a message is move it.
 *    Trash is the server's `\Trash` folder (RFC 6154), never EXPUNGE and
 *    never `\Deleted`; a server without MOVE (RFC 6851) is refused rather
 *    than emulated with COPY + delete, and no folder is created implicitly.
 *  - **Every change is on the trail** (`email.mailbox_actions`, migration
 *    017): which messages, where each was and where it went, its flags and
 *    Gmail labels before, and who asked. That before is what `undo` restores.
 *  - **buddi's own rows follow the message.** A moved message's row takes its
 *    new folder, UIDVALIDITY and uid (COPYUID, RFC 4315), so the unread count,
 *    the Mail page and triage see the mailbox as it now is — and the next poll
 *    neither re-ingests a message moved back into the inbox (its quad already
 *    exists) nor reverts a flag (the server agrees with the row).
 *  - **One account per change.** The approval names the mailbox; a selection
 *    that spans two is two calls.
 *
 * Gmail is told apart by its `X-GM-EXT-1` capability. There, archive is a
 * MOVE from INBOX to All Mail (`\All`) — which takes the Inbox label off and
 * leaves every other label — a label is a folder for `move`, and Trash drops
 * labels, so a trash records them (`X-GM-LABELS`) and an undo puts them back.
 * Anywhere else, archive is a MOVE to the folder the server marks `\Archive`,
 * and a server with none is refused with a sentence.
 */
import type { DbArea } from '@buddi/core/plugin';
import { ToolRefusal } from '@buddi/core/plugin';
import { mailboxAuth } from '../credentials.js';
import { leafOf } from '../folders.js';
import { clearLoginFailure, isAuthFailure, recordLoginFailure } from '../logins.js';
import type { EnvLike } from '../config.js';
import {
  isImapWriter,
  type AccountRecord,
  type ImapClientFactory,
  type ImapWriter,
  type MailboxInfo,
} from '../ports.js';
import { INBOX } from '../config.js';

type Db = Pick<DbArea, 'query'>;

/** The most messages one call may change. One approval, one card, 500 rows. */
export const MAX_PER_CALL = 500;

/** How many messages an approval card names before "and N more". */
export const SAMPLE_SIZE = 5;

export const MAILBOX_ACTION_KINDS = ['mark-read', 'mark-unread', 'archive', 'move', 'trash'] as const;
export type MailboxActionKind = (typeof MAILBOX_ACTION_KINDS)[number];

/**
 * Who made a change. `policy` is a rule applying itself on arrival — the
 * owner's own or a learned one he kept; `policy_id` says which, and the policy
 * row says where it came from.
 */
export type ActionOrigin = 'agent' | 'owner' | 'policy';

export const SEEN = '\\Seen';
const GMAIL_CAPABILITY = 'X-GM-EXT-1';

/** One message as a change needs it: where it is, and enough to name it. */
export interface Target {
  id: string;
  accountId: string;
  folderId: string;
  folder: string;
  uidValidity: number;
  uid: number;
  messageId: string | null;
  subject: string;
  from: string;
  flags: string[];
}

/** One message's entry on the trail: before and after. */
export interface TrailItem {
  id: string;
  subject: string;
  from: string;
  messageId: string | null;
  fromFolder: string;
  fromUidValidity: number;
  fromUid: number;
  toFolder?: string;
  toUidValidity?: number;
  toUid?: number | null;
  prevFlags?: string[];
  prevLabels?: string[];
}

export interface ActionRecord {
  id: string;
  accountId: string;
  kind: MailboxActionKind | 'undo';
  destination: string | null;
  criteria: string | null;
  origin: ActionOrigin;
  actor: string;
  policyId: string | null;
  runId: string | null;
  actionId: string | null;
  messageIds: string[];
  items: TrailItem[];
  changed: number;
  note: string | null;
  reverts: string | null;
  undoneAt: string | null;
  undoneBy: string | null;
  createdAt: string | null;
}

export const ACTION_COLUMNS =
  'id, account_id, kind, destination, criteria, origin, actor, policy_id, run_id, action_id, message_ids, ' +
  'items, changed, note, reverts, undone_at, undone_by, created_at';

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function toAction(row: Record<string, any>): ActionRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    kind: row.kind,
    destination: row.destination ?? null,
    criteria: row.criteria ?? null,
    origin: row.origin,
    actor: row.actor ?? '',
    policyId: row.policy_id ? String(row.policy_id) : null,
    runId: row.run_id ?? null,
    actionId: row.action_id ? String(row.action_id) : null,
    messageIds: Array.isArray(row.message_ids) ? row.message_ids.map(String) : [],
    items: Array.isArray(row.items) ? row.items : [],
    changed: Number(row.changed ?? 0),
    note: row.note ?? null,
    reverts: row.reverts ? String(row.reverts) : null,
    undoneAt: iso(row.undone_at),
    undoneBy: row.undone_by ? String(row.undone_by) : null,
    createdAt: iso(row.created_at),
  };
}

/** A refusal whose message is the sentence the owner and the agent read. */
export class MailboxRefusal extends ToolRefusal {}

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Mark as read", "Archive", … — the verb a card and a trail row lead with. */
export function verbOf(kind: MailboxActionKind | 'undo', destination?: string | null): string {
  switch (kind) {
    case 'mark-read':
      return 'Mark as read';
    case 'mark-unread':
      return 'Mark as unread';
    case 'archive':
      return 'Archive';
    case 'move':
      return `Move to ${destination ?? 'a folder'}`;
    case 'trash':
      return 'Move to Trash';
    case 'undo':
      return 'Undo';
  }
}

/** The sample lines a card shows: sender — subject. */
export function sampleLines(targets: readonly Pick<Target, 'from' | 'subject'>[]): string[] {
  const lines = targets.slice(0, SAMPLE_SIZE).map((t) => `- ${t.from || '(unknown sender)'} — ${t.subject || '(no subject)'}`);
  if (targets.length > SAMPLE_SIZE) lines.push(`…and ${targets.length - SAMPLE_SIZE} more.`);
  return lines;
}

/* ------------------------------------------------------------------ *
 * Reading what a change is about
 * ------------------------------------------------------------------ */

/** The rows for these ids, with their folder names, in the order asked. */
export async function loadTargets(db: Db, ids: readonly string[]): Promise<Target[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query(
    `select m.id, m.account_id, m.folder_id, f.name as folder, m.uidvalidity, m.uid, m.message_id,
            m.subject, m.from_addr, m.flags
       from email.messages m join email.folders f on f.id = m.folder_id
      where m.id = any($1::uuid[])`,
    [ids],
  );
  const byId = new Map(rows.map((r: Record<string, any>) => [String(r.id), r]));
  const out: Target[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    out.push({
      id,
      accountId: String(r.account_id),
      folderId: String(r.folder_id),
      folder: r.folder,
      uidValidity: Number(r.uidvalidity),
      uid: Number(r.uid),
      messageId: r.message_id ?? null,
      subject: r.subject ?? '',
      from: r.from_addr ?? '',
      flags: Array.isArray(r.flags) ? r.flags : [],
    });
  }
  return out;
}

/**
 * The targets of one call, checked: every id known, at most `MAX_PER_CALL`,
 * all in one mailbox the owner has. Refusals are sentences.
 */
export async function requireTargets(
  db: Db,
  ids: readonly string[],
  accounts: readonly AccountRecord[],
): Promise<{ account: AccountRecord; targets: Target[] }> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new MailboxRefusal('No messages were named. Use email.select_messages to find them first.');
  if (unique.length > MAX_PER_CALL) {
    throw new MailboxRefusal(`That is ${unique.length} messages; one change covers at most ${MAX_PER_CALL}. Split it.`);
  }
  const targets = await loadTargets(db, unique);
  const missing = unique.length - targets.length;
  if (missing > 0) {
    throw new MailboxRefusal(`${plural(missing, 'of those ids is', 'of those ids are')} not a message buddi has. Select them again.`);
  }
  const accountIds = [...new Set(targets.map((t) => t.accountId))];
  if (accountIds.length > 1) {
    throw new MailboxRefusal('Those messages are in more than one mailbox. One change covers one mailbox; make one call per mailbox.');
  }
  const account = accounts.find((a) => a.id === accountIds[0]);
  if (!account) throw new MailboxRefusal('Those messages are in a mailbox that is turned off or no longer here.');
  return { account, targets };
}

/* ------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------ */

export interface WriterOptions {
  connect: ImapClientFactory;
  env?: EnvLike;
}

/**
 * Open a writing connection to one mailbox, run `work`, and close it.
 *
 * A login the provider refuses is written on the account row, as the poll
 * writes it, so the settings row says "Password needed".
 */
export async function withWriter<T>(
  ctx: { buddi?: import('@buddi/core/plugin').BuddiHost | undefined },
  account: AccountRecord,
  opts: WriterOptions,
  work: (client: ImapWriter) => Promise<T>,
): Promise<T> {
  const db = ctx.buddi!.db;
  const auth = await mailboxAuth(ctx, account, opts.env);
  if (!auth.ok) throw new MailboxRefusal(`${account.address} cannot be opened: ${auth.problem.message}`);
  let client;
  try {
    client = await opts.connect(account, auth.value);
  } catch (err) {
    if (isAuthFailure(err)) {
      await recordLoginFailure(db, account.id, err, ctx.buddi!.clock.now()).catch(() => {});
      throw new MailboxRefusal(`${account.address} refused its stored password. Set a new one under Settings → Email.`);
    }
    throw err;
  }
  try {
    await clearLoginFailure(db, account.id);
    if (!isImapWriter(client)) {
      throw new MailboxRefusal(`The connection to ${account.address} can only read mail here, so nothing was changed.`);
    }
    return await work(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** What a server is, for the decisions below. */
export interface ServerFacts {
  gmail: boolean;
  move: boolean;
  listing: MailboxInfo[];
}

export async function serverFacts(client: ImapWriter): Promise<ServerFacts> {
  const caps = await client.capabilities();
  const listing = await client.listMailboxes();
  return { gmail: caps.includes(GMAIL_CAPABILITY), move: caps.includes('MOVE'), listing };
}

function single<T>(list: T[]): T | undefined {
  return list.length === 1 ? list[0] : undefined;
}

function attributesOf(info: MailboxInfo): string[] {
  return [info.specialUse ?? '', ...info.flags].map((f) => f.trim().toLowerCase()).filter((f) => f !== '');
}

function specialFolder(listing: readonly MailboxInfo[], use: string): string | null {
  const wanted = use.toLowerCase();
  return listing.find((info) => attributesOf(info).includes(wanted))?.name ?? null;
}

/** Folders a message can be moved into: selectable, and not the Gmail namespace root. */
function selectable(listing: readonly MailboxInfo[]): MailboxInfo[] {
  return listing.filter((info) => !attributesOf(info).includes('\\noselect') && !attributesOf(info).includes('\\nonexistent'));
}

/** "INBOX, Archive, Receipts, …" — the list a refusal names. */
export function folderList(listing: readonly MailboxInfo[]): string {
  const names = selectable(listing).map((info) => info.name);
  return names.length > 0 ? names.join(', ') : '(none listed)';
}

/**
 * Where a kind of change sends messages on this server, or a refusal.
 *
 * Nothing is created: a folder that does not exist is refused, naming the
 * ones that do.
 */
export function destinationFor(
  facts: ServerFacts,
  kind: MailboxActionKind,
  account: string,
  folder?: string,
): string | null {
  if (kind === 'mark-read' || kind === 'mark-unread') return null;
  if (!facts.move) {
    throw new MailboxRefusal(
      `${account}'s server cannot move messages (it does not offer IMAP MOVE), and buddi never copies and deletes to fake it. Nothing was changed.`,
    );
  }
  if (kind === 'archive') {
    const found = facts.gmail ? specialFolder(facts.listing, '\\All') : specialFolder(facts.listing, '\\Archive');
    if (!found) {
      throw new MailboxRefusal(
        facts.gmail
          ? `${account} lists no All Mail folder, so there is nowhere to archive to. Nothing was changed.`
          : `${account} has no Archive folder (its server marks none), so buddi cannot archive there. Move them to a folder by name instead — its folders are: ${folderList(facts.listing)}.`,
      );
    }
    return found;
  }
  if (kind === 'trash') {
    const found = specialFolder(facts.listing, '\\Trash');
    if (!found) {
      throw new MailboxRefusal(
        `${account} has no Trash folder (its server marks none), and buddi never deletes mail outright. Nothing was changed.`,
      );
    }
    return found;
  }
  // move
  const wanted = (folder ?? '').trim();
  if (wanted === '') throw new MailboxRefusal('Name the folder to move them to.');
  const candidates = selectable(facts.listing);
  const found =
    candidates.find((c) => c.name === wanted) ??
    single(candidates.filter((c) => c.name.toLowerCase() === wanted.toLowerCase())) ??
    single(candidates.filter((c) => leafOf(c.name) === wanted.toLowerCase()));
  if (found) {
    /*
     * Trash and Junk are emptied by the provider. A move there is a trash in
     * all but name, and `email.move` may be remembered where `email.trash`
     * never is — so it is refused here, and the owner is asked every time.
     */
    const attributes = attributesOf(found);
    if (attributes.includes('\\trash') || attributes.includes('\\junk')) {
      throw new MailboxRefusal(
        `${found.name} is ${attributes.includes('\\trash') ? 'the Trash' : 'the Junk folder'}, which your provider empties on its own. Use email.trash for that; it asks every time.`,
      );
    }
    return found.name;
  }
  throw new MailboxRefusal(
    `${account} has no ${facts.gmail ? 'folder or label' : 'folder'} called "${wanted}", and buddi creates none. Its ${facts.gmail ? 'folders and labels' : 'folders'} are: ${folderList(facts.listing)}.`,
  );
}

/* ------------------------------------------------------------------ *
 * Keeping buddi's rows in step
 * ------------------------------------------------------------------ */

/** The folder row for a server name, created (unsynced, kind other) if new. Never changes an existing one. */
async function folderRow(db: Db, accountId: string, name: string): Promise<string> {
  const { rows } = await db.query(
    `insert into email.folders (account_id, name, kind, synced) values ($1, $2, 'other', false)
     on conflict (account_id, name) do update set name = email.folders.name
     returning id`,
    [accountId, name],
  );
  return String(rows[0]!.id);
}

let unknownCounter = 0;
/**
 * A placeholder uid for a message whose new uid the server did not report and
 * a Message-ID search could not find: negative, so it can never be a real uid,
 * and unique. Its UIDVALIDITY is 0, which is what tells the next change (or
 * undo) to find it by Message-ID first.
 */
function placeholderUid(): number {
  unknownCounter = (unknownCounter + 1) % 1000;
  return -(Date.now() * 1000 + unknownCounter);
}

/** Point a row at where its message is now. Falls back to "uid unknown" if the poll got there first. */
async function relocateRow(
  db: Db,
  target: Pick<Target, 'id' | 'accountId'>,
  folderId: string,
  uidValidity: number | null,
  uid: number | null,
): Promise<void> {
  if (uidValidity !== null && uid !== null) {
    const result = await db.query(
      `update email.messages set folder_id = $2, uidvalidity = $3, uid = $4
        where id = $1
          and not exists (select 1 from email.messages o
                           where o.account_id = $5 and o.folder_id = $2 and o.uidvalidity = $3 and o.uid = $4)`,
      [target.id, folderId, uidValidity, uid, target.accountId],
    );
    if ((result.rowCount ?? 0) > 0) return;
  }
  await db.query(`update email.messages set folder_id = $2, uidvalidity = 0, uid = $3 where id = $1`, [
    target.id,
    folderId,
    placeholderUid(),
  ]);
}

async function setSeenLocally(db: Db, ids: readonly string[], seen: boolean): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    seen
      ? `update email.messages set flags = flags || '["\\\\Seen"]'::jsonb
          where id = any($1::uuid[]) and not (flags @> '["\\\\Seen"]'::jsonb)`
      : `update email.messages set flags = flags - '\\Seen' where id = any($1::uuid[])`,
    [ids],
  );
}

/* ------------------------------------------------------------------ *
 * Doing it
 * ------------------------------------------------------------------ */

export interface Provenance {
  origin: ActionOrigin;
  actor: string;
  policyId?: string | null;
  runId?: string | null;
  actionId?: string | null;
  criteria?: string | null;
}

export interface ActionOutcome {
  /** The trail row, or null when nothing was there to change. */
  action: ActionRecord | null;
  changed: number;
  skipped: number;
  note: string;
}

/**
 * Find where each target is now, on the server: its folder's generation must
 * match, and a row whose uid is unknown (UIDVALIDITY 0) is looked up by
 * Message-ID. Returns the uid per target, or null for one that is not there.
 */
async function locate(client: ImapWriter, folder: string, targets: readonly Target[]): Promise<Map<string, { uid: number; flags: string[] }>> {
  const status = await client.open(folder);
  const uids = new Map<string, number>();
  for (const t of targets) {
    if (t.uidValidity === status.uidValidity && t.uid > 0) {
      uids.set(t.id, t.uid);
    } else if (t.messageId) {
      const found = await client.findByMessageId(folder, t.messageId);
      if (found !== null) uids.set(t.id, found);
    }
  }
  const out = new Map<string, { uid: number; flags: string[] }>();
  if (uids.size === 0) return out;
  const states = await client.fetchFlags(folder, [...uids.values()]);
  const flagsOf = new Map(states.map((s) => [s.uid, s.flags]));
  for (const [id, uid] of uids) {
    const flags = flagsOf.get(uid);
    if (flags) out.set(id, { uid, flags });
  }
  return out;
}

function byFolder(targets: readonly Target[]): Map<string, Target[]> {
  const groups = new Map<string, Target[]>();
  for (const t of targets) {
    const list = groups.get(t.folder) ?? [];
    list.push(t);
    groups.set(t.folder, list);
  }
  return groups;
}

/** Where the moved messages landed: COPYUID first, a Message-ID search for the rest. */
async function landed(
  client: ImapWriter,
  destination: string,
  moved: ReadonlyArray<{ target: Target; uid: number }>,
  result: { uidValidity: number | null; uidMap: Map<number, number> },
): Promise<{ uidValidity: number | null; uids: Map<string, number | null> }> {
  const uids = new Map<string, number | null>();
  const unknown: Array<{ target: Target; uid: number }> = [];
  for (const m of moved) {
    const to = result.uidMap.get(m.uid);
    if (to !== undefined) uids.set(m.target.id, to);
    else unknown.push(m);
  }
  let uidValidity = result.uidValidity;
  if (unknown.length > 0 || uidValidity === null) {
    const status = await client.open(destination);
    uidValidity = uidValidity ?? status.uidValidity;
    for (const m of unknown) {
      uids.set(m.target.id, m.target.messageId ? await client.findByMessageId(destination, m.target.messageId) : null);
    }
  }
  return { uidValidity, uids };
}

async function recordAction(
  db: Db,
  input: {
    accountId: string;
    kind: MailboxActionKind | 'undo';
    destination: string | null;
    provenance: Provenance;
    messageIds: string[];
    items: TrailItem[];
    changed: number;
    note: string | null;
    reverts?: string | null;
    now: Date;
  },
): Promise<ActionRecord> {
  const p = input.provenance;
  const { rows } = await db.query(
    `insert into email.mailbox_actions
       (account_id, kind, destination, criteria, origin, actor, policy_id, run_id, action_id, message_ids,
        items, changed, note, reverts, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11::jsonb, $12, $13, $14, $15)
     returning ${ACTION_COLUMNS}`,
    [
      input.accountId,
      input.kind,
      input.destination,
      p.criteria ?? null,
      p.origin,
      p.actor,
      p.policyId ?? null,
      p.runId ?? null,
      p.actionId ?? null,
      input.messageIds,
      JSON.stringify(input.items),
      input.changed,
      input.note,
      input.reverts ?? null,
      input.now,
    ],
  );
  return toAction(rows[0]!);
}

/**
 * Carry out one change on one account's server, keep the rows in step, and
 * write it on the trail.
 *
 * Messages no longer where buddi last saw them are skipped, never guessed at,
 * and the note says how many. Nothing is recorded when nothing changed.
 */
export async function performAction(
  db: Db,
  client: ImapWriter,
  input: {
    account: AccountRecord;
    kind: MailboxActionKind;
    targets: Target[];
    folder?: string;
    provenance: Provenance;
    now: Date;
    /** Already learned this connection, so a describe+execute pair does not list twice. */
    facts?: ServerFacts;
  },
): Promise<ActionOutcome> {
  const { account, kind, targets } = input;
  const facts = input.facts ?? (await serverFacts(client));
  const destination = destinationFor(facts, kind, account.address, input.folder);
  const items: TrailItem[] = [];
  const reasons = new Map<string, number>();
  const skip = (why: string, n = 1): void => {
    if (n > 0) reasons.set(why, (reasons.get(why) ?? 0) + n);
  };

  // Whatever the server already did stays on the trail even if a later
  // folder fails (a dropped connection, a lookup): the change is recorded as
  // partial, with the error, and the error is thrown on.
  try {
    for (const [folder, group] of byFolder(targets)) {
      const here = await locate(client, folder, group);
      skip(`no longer in ${folder}`, group.length - here.size);
      const present = group.filter((t) => here.has(t.id));
      if (present.length === 0) continue;

      if (kind === 'mark-read' || kind === 'mark-unread') {
        const seen = kind === 'mark-read';
        const change = present.filter((t) => here.get(t.id)!.flags.includes(SEEN) !== seen);
        skip(seen ? 'already read' : 'already unread', present.length - change.length);
        if (change.length === 0) continue;
        await client.storeFlags(folder, change.map((t) => here.get(t.id)!.uid), [SEEN], seen ? 'add' : 'remove');
        for (const t of change) {
          const at = here.get(t.id)!;
          items.push({
            id: t.id, subject: t.subject, from: t.from, messageId: t.messageId,
            fromFolder: folder, fromUidValidity: t.uidValidity > 0 ? t.uidValidity : 0, fromUid: at.uid,
            prevFlags: at.flags,
          });
        }
        await setSeenLocally(db, change.map((t) => t.id), seen);
        continue;
      }

      // A move of some kind. Already there is not a change.
      let movable = present.filter((t) => folder !== destination);
      skip(kind === 'trash' ? 'already in Trash' : `already in ${destination}`, present.length - movable.length);
      if (kind === 'archive' && facts.gmail && folder !== INBOX) {
        skip('not in the inbox', movable.length);
        movable = [];
      }
      if (movable.length === 0) continue;

      const source = await client.open(folder);
      const labels = facts.gmail && kind === 'trash'
        ? await client.fetchLabels(folder, movable.map((t) => here.get(t.id)!.uid))
        : new Map<number, string[]>();
      const moved = movable.map((t) => ({ target: t, uid: here.get(t.id)!.uid }));
      const result = await client.move(folder, moved.map((m) => m.uid), destination!);
      // The server has moved them: on the trail now, refined below. Should the
      // landing lookup fail, each row still follows to the destination with its
      // uid unknown (found by Message-ID next time), so undo can find it.
      const pushed = moved.map((m) => {
        const item: TrailItem = {
          id: m.target.id, subject: m.target.subject, from: m.target.from, messageId: m.target.messageId,
          fromFolder: folder, fromUidValidity: source.uidValidity, fromUid: m.uid,
          toFolder: destination!, toUidValidity: 0, toUid: null,
          prevFlags: here.get(m.target.id)!.flags,
          ...(labels.has(m.uid) ? { prevLabels: labels.get(m.uid) } : {}),
        };
        items.push(item);
        return item;
      });
      const destId = await folderRow(db, account.id, destination!);
      let where: Awaited<ReturnType<typeof landed>>;
      try {
        where = await landed(client, destination!, moved, result);
      } catch (err) {
        for (const m of moved) await relocateRow(db, m.target, destId, null, null);
        throw err;
      }
      for (const [i, m] of moved.entries()) {
        const newUid = where.uids.get(m.target.id) ?? null;
        await relocateRow(db, m.target, destId, newUid === null ? null : where.uidValidity, newUid);
        pushed[i]!.toUidValidity = where.uidValidity ?? 0;
        pushed[i]!.toUid = newUid;
      }
    }
  } catch (err) {
    if (items.length > 0) {
      const why = err instanceof Error ? err.message : String(err);
      const skippedNote = [...reasons.entries()].map(([r, n]) => `${n} ${r}`).join(', ');
      await recordAction(db, {
        accountId: account.id,
        kind,
        destination,
        provenance: input.provenance,
        messageIds: items.map((i) => i.id),
        items,
        changed: items.length,
        note: `Partial: stopped by an error after ${plural(items.length, 'message')}: ${why}.${skippedNote ? ` Skipped ${skippedNote}.` : ''}`,
        now: input.now,
      }).catch(() => {});
    }
    throw err;
  }

  const skipped = [...reasons.values()].reduce((a, b) => a + b, 0);
  const skippedNote = [...reasons.entries()].map(([why, n]) => `${n} ${why}`).join(', ');
  const done = `${verbOf(kind, destination)}: ${plural(items.length, 'message')} in ${account.address}`;
  const note = items.length === 0
    ? `Nothing changed in ${account.address}${skippedNote ? ` (${skippedNote})` : ''}.`
    : `${done}.${skippedNote ? ` Skipped ${skippedNote}.` : ''}${kind === 'trash' ? ' They are in Trash, not deleted; undo puts them back while they are still there.' : ' Undo puts them back.'}`;
  if (items.length === 0) return { action: null, changed: 0, skipped, note };
  const action = await recordAction(db, {
    accountId: account.id,
    kind,
    destination,
    provenance: input.provenance,
    messageIds: items.map((i) => i.id),
    items,
    changed: items.length,
    note: skippedNote ? `Skipped ${skippedNote}.` : null,
    now: input.now,
  });
  return { action, changed: items.length, skipped, note };
}

/* ------------------------------------------------------------------ *
 * Undo
 * ------------------------------------------------------------------ */

export async function findAction(db: Db, id: string): Promise<ActionRecord | null> {
  const { rows } = await db.query(`select ${ACTION_COLUMNS} from email.mailbox_actions where id = $1::uuid`, [id]);
  return rows[0] ? toAction(rows[0]) : null;
}

/** The newest change that can still be undone, in these accounts. */
export async function lastUndoable(db: Db, accountIds: readonly string[]): Promise<ActionRecord | null> {
  const { rows } = await db.query(
    `select ${ACTION_COLUMNS} from email.mailbox_actions
      where account_id = any($1::uuid[]) and kind <> 'undo' and undone_at is null
      order by created_at desc, seq desc limit 1`,
    [accountIds],
  );
  return rows[0] ? toAction(rows[0]) : null;
}

/** Why a change cannot be undone, or null when it can. */
export function undoRefusal(action: ActionRecord): string | null {
  if (action.kind === 'undo') return 'That was itself an undo; buddi does not undo an undo. Make the change again instead.';
  if (action.undoneAt) return `That change was already undone (${action.undoneAt}).`;
  return null;
}

/** The sentence an undo's approval and the Recent changes row say. */
export function describeUndo(action: ActionRecord, account: string): string {
  const n = plural(action.changed, 'message');
  switch (action.kind) {
    case 'mark-read':
      return `Undo "${verbOf(action.kind)}" on ${n} in ${account}: they become unread again.`;
    case 'mark-unread':
      return `Undo "${verbOf(action.kind)}" on ${n} in ${account}: they become read again.`;
    case 'trash':
      return `Undo "${verbOf(action.kind)}" on ${n} in ${account}: they move back from Trash to where they were (any already emptied from Trash cannot come back).`;
    default:
      return `Undo "${verbOf(action.kind, action.destination)}" on ${n} in ${account}: they move back to where they were.`;
  }
}

/**
 * Put one change back, as far as the mailbox still allows, and record the
 * undo as a change of its own.
 *
 * Each message is acted on where buddi's row says it is now — the row
 * followed it — and only if the server still has it there: a message emptied
 * from Trash, or moved again in another client, is skipped and counted.
 */
export async function undoAction(
  db: Db,
  client: ImapWriter,
  input: { account: AccountRecord; action: ActionRecord; provenance: Provenance; now: Date },
): Promise<ActionOutcome> {
  const { account, action } = input;
  const refusal = undoRefusal(action);
  if (refusal) throw new MailboxRefusal(refusal);
  const facts = await serverFacts(client);
  const current = await loadTargets(db, action.items.map((i) => i.id));
  const itemOf = new Map(action.items.map((i) => [i.id, i]));
  const items: TrailItem[] = [];
  let skipped = action.items.length - current.length;

  for (const [folder, group] of byFolder(current)) {
    const here = await locate(client, folder, group);
    skipped += group.length - here.size;
    const present = group.filter((t) => here.has(t.id));
    if (present.length === 0) continue;

    if (action.kind === 'mark-read' || action.kind === 'mark-unread') {
      const restoreSeen = present.filter((t) => (itemOf.get(t.id)!.prevFlags ?? []).includes(SEEN));
      const restoreUnseen = present.filter((t) => !(itemOf.get(t.id)!.prevFlags ?? []).includes(SEEN));
      if (restoreSeen.length > 0) {
        await client.storeFlags(folder, restoreSeen.map((t) => here.get(t.id)!.uid), [SEEN], 'add');
        await setSeenLocally(db, restoreSeen.map((t) => t.id), true);
      }
      if (restoreUnseen.length > 0) {
        await client.storeFlags(folder, restoreUnseen.map((t) => here.get(t.id)!.uid), [SEEN], 'remove');
        await setSeenLocally(db, restoreUnseen.map((t) => t.id), false);
      }
      for (const t of present) {
        items.push({
          id: t.id, subject: t.subject, from: t.from, messageId: t.messageId,
          fromFolder: folder, fromUidValidity: t.uidValidity, fromUid: here.get(t.id)!.uid,
          prevFlags: here.get(t.id)!.flags,
        });
      }
      continue;
    }

    // Moves: back to each message's own original folder.
    const back = new Map<string, Target[]>();
    for (const t of present) {
      const original = itemOf.get(t.id)!.fromFolder;
      if (original === folder) {
        skipped += 1;
        continue;
      }
      const list = back.get(original) ?? [];
      list.push(t);
      back.set(original, list);
    }
    for (const [original, list] of back) {
      if (!facts.listing.some((f) => f.name === original)) {
        skipped += list.length;
        continue;
      }
      const source = await client.open(folder);
      const moved = list.map((t) => ({ target: t, uid: here.get(t.id)!.uid }));
      const result = await client.move(folder, moved.map((m) => m.uid), original);
      const where = await landed(client, original, moved, result);
      const destId = await folderRow(db, account.id, original);
      for (const m of moved) {
        const newUid = where.uids.get(m.target.id) ?? null;
        await relocateRow(db, m.target, destId, newUid === null ? null : where.uidValidity, newUid);
        items.push({
          id: m.target.id, subject: m.target.subject, from: m.target.from, messageId: m.target.messageId,
          fromFolder: folder, fromUidValidity: source.uidValidity, fromUid: m.uid,
          toFolder: original, toUidValidity: where.uidValidity ?? 0, toUid: newUid,
        });
      }
      // Gmail drops a message's labels in Trash: give back the ones it had.
      if (facts.gmail) {
        const byLabels = new Map<string, number[]>();
        for (const m of moved) {
          const prev = itemOf.get(m.target.id)!.prevLabels ?? [];
          const uid = where.uids.get(m.target.id);
          if (prev.length === 0 || uid === null || uid === undefined) continue;
          const key = JSON.stringify([...prev].sort());
          byLabels.set(key, [...(byLabels.get(key) ?? []), uid]);
        }
        for (const [key, uids] of byLabels) await client.addLabels(original, uids, JSON.parse(key) as string[]);
      }
    }
  }

  const note = items.length === 0
    ? `Nothing could be put back in ${account.address}${skipped > 0 ? ` (${plural(skipped, 'message')} no longer where the change left ${skipped === 1 ? 'it' : 'them'})` : ''}.`
    : `Undid "${verbOf(action.kind, action.destination)}" on ${plural(items.length, 'message')} in ${account.address}.${skipped > 0 ? ` ${plural(skipped, 'message')} could not be put back: no longer where the change left ${skipped === 1 ? 'it' : 'them'}.` : ''}`;
  if (items.length === 0) return { action: null, changed: 0, skipped, note };
  const undo = await recordAction(db, {
    accountId: account.id,
    kind: 'undo',
    destination: null,
    provenance: input.provenance,
    messageIds: items.map((i) => i.id),
    items,
    changed: items.length,
    note: skipped > 0 ? `${plural(skipped, 'message')} could not be put back.` : null,
    reverts: action.id,
    now: input.now,
  });
  await db.query(`update email.mailbox_actions set undone_at = $2, undone_by = $3 where id = $1`, [
    action.id,
    input.now,
    undo.id,
  ]);
  return { action: undo, changed: items.length, skipped, note };
}

/** The newest changes, for the Mail page's Recent changes. */
export async function recentActions(db: Db, accountIds: readonly string[], limit = 20): Promise<ActionRecord[]> {
  const { rows } = await db.query(
    `select ${ACTION_COLUMNS} from email.mailbox_actions
      where account_id = any($1::uuid[])
      order by created_at desc, seq desc limit $2`,
    [accountIds, limit],
  );
  return rows.map(toAction);
}
