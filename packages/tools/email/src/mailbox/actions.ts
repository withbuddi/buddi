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
  type MailboxStatus,
  type MoveResult,
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
  /** The poll found it gone from `folder` (moved or deleted in another app) and could not say where. */
  gone: boolean;
}

/**
 * Where one message stands on a trail row written intent-first: `planned`
 * (the command is about to go, or went without an answer), `done`, `unknown`
 * (a start after a crash could not find it either side), `dropped` (it never
 * happened; not kept on the row).
 */
export type ItemStatus = 'planned' | 'done' | 'unknown' | 'dropped';

/** A trail row's own state (migration 020). */
export type ActionState = 'pending' | 'done' | 'partial' | 'unknown';

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
  /** Absent on rows from before intent-first: those were written after the change, so it happened. */
  status?: ItemStatus;
  /** A flag change: the read mark it sets. What a reconcile checks the server against. */
  wantSeen?: boolean;
  /** Gmail: moved by X-GM-LABELS (label on, Inbox off) rather than a MOVE. */
  via?: 'labels';
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
  state: ActionState;
  /** Messages of this change an undo already put back (a partial undo leaves the rest). */
  revertedIds: string[];
}

export const ACTION_COLUMNS =
  'id, account_id, kind, destination, criteria, origin, actor, policy_id, run_id, action_id, message_ids, ' +
  'items, changed, note, reverts, undone_at, undone_by, created_at, state, reverted_ids';

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
    state: (['pending', 'done', 'partial', 'unknown'] as const).includes(row.state) ? row.state : 'done',
    revertedIds: Array.isArray(row.reverted_ids) ? row.reverted_ids.map(String) : [],
  };
}

/** A refusal whose message is the sentence the owner and the agent read. */
export class MailboxRefusal extends ToolRefusal {}

/** The mailbox could not be opened at all: no password, or the provider refused it. Nothing was tried. */
export class MailboxLoginRefusal extends MailboxRefusal {}

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
            m.subject, m.from_addr, m.flags, m.gone_at
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
      gone: r.gone_at !== null && r.gone_at !== undefined,
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
  if (!auth.ok) throw new MailboxLoginRefusal(`${account.address} cannot be opened: ${auth.problem.message}`);
  let client;
  try {
    client = await opts.connect(account, auth.value);
  } catch (err) {
    if (isAuthFailure(err)) {
      await recordLoginFailure(db, account.id, err, ctx.buddi!.clock.now()).catch(() => {});
      throw new MailboxLoginRefusal(`${account.address} refused its stored password. Set a new one under Settings → Email.`);
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

/**
 * The folder row for a server name, created (unsynced, kind other) if new.
 * Never changes an existing row's kind or cursor; records what the server
 * says the folder is for (`special_use`) when the caller knows it.
 */
export async function folderRow(db: Db, accountId: string, name: string, specialUse?: string | null): Promise<string> {
  const { rows } = await db.query(
    `insert into email.folders (account_id, name, kind, synced, special_use) values ($1, $2, 'other', false, $3)
     on conflict (account_id, name) do update set special_use = coalesce(excluded.special_use, email.folders.special_use)
     returning id`,
    [accountId, name, specialUse ?? null],
  );
  return String(rows[0]!.id);
}

/** The SPECIAL-USE attribute the listing gives a folder, or null. */
export function specialUseOf(listing: readonly MailboxInfo[], name: string): string | null {
  const info = listing.find((f) => f.name === name);
  if (!info) return null;
  const known = ['\\all', '\\archive', '\\trash', '\\junk', '\\sent', '\\drafts'];
  return attributesOf(info).find((a) => known.includes(a)) ?? null;
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

/**
 * Point a row at where its message is now: folder, UIDVALIDITY, uid — and,
 * on Gmail, its labels when they are known. The row is no longer "gone"
 * (buddi knows where it is), and a thread whose newest message this is keeps
 * its tie-break fields (`last_folder_id`, `last_uidvalidity`, `last_uid`)
 * pointing at the same place. Falls back to "uid unknown" if the poll got
 * there first.
 */
export async function relocateRow(
  db: Db,
  target: Pick<Target, 'id' | 'accountId'>,
  folderId: string,
  uidValidity: number | null,
  uid: number | null,
  labels?: readonly string[] | null,
): Promise<void> {
  const labelJson = labels === undefined ? null : JSON.stringify(labels ?? []);
  let where: { uidValidity: number; uid: number } | null = null;
  if (uidValidity !== null && uid !== null) {
    const result = await db.query(
      `update email.messages set folder_id = $2, uidvalidity = $3, uid = $4, gone_at = null,
              labels = case when $6::jsonb is null then labels else $6::jsonb end
        where id = $1
          and not exists (select 1 from email.messages o
                           where o.account_id = $5 and o.folder_id = $2 and o.uidvalidity = $3 and o.uid = $4)`,
      [target.id, folderId, uidValidity, uid, target.accountId, labelJson],
    );
    if ((result.rowCount ?? 0) > 0) where = { uidValidity, uid };
  }
  if (where === null) {
    where = { uidValidity: 0, uid: placeholderUid() };
    await db.query(
      `update email.messages set folder_id = $2, uidvalidity = 0, uid = $3, gone_at = null,
              labels = case when $4::jsonb is null then labels else $4::jsonb end
        where id = $1`,
      [target.id, folderId, where.uid, labelJson],
    );
  }
  await db.query(
    `update email.threads set last_folder_id = $2, last_uidvalidity = $3, last_uid = $4 where last_message_id = $1`,
    [target.id, folderId, where.uidValidity, where.uid],
  );
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
 * The trail, written before the server is touched
 * ------------------------------------------------------------------ */

/**
 * Trail rows of changes running in this process right now. A `pending` row
 * not in here was left by a process that stopped mid-change, and the next
 * poll reconciles it (`reconcileTrail`). One process per installation, so
 * this set is the whole truth about what is in flight.
 */
const inFlightTrail = new Set<string>();

/** The trail rows a change in this process is still writing. */
export function trailInFlight(): string[] {
  return [...inFlightTrail];
}

/** An item from before intent-first has no status: it was written after the change, so it happened. */
export function statusOf(item: TrailItem): ItemStatus {
  return item.status ?? 'done';
}

/**
 * The trail row, written before the first server command: `pending`, with
 * the messages it is about and no items yet. Each folder's items are added
 * as `planned` right before that folder's command and become `done` once the
 * server answered, so a crash anywhere leaves a row that says what may have
 * happened.
 */
async function beginTrail(
  db: Db,
  input: {
    accountId: string;
    kind: MailboxActionKind | 'undo';
    destination: string | null;
    provenance: Provenance;
    messageIds: string[];
    reverts?: string | null;
    now: Date;
  },
): Promise<string> {
  const p = input.provenance;
  const { rows } = await db.query(
    `insert into email.mailbox_actions
       (account_id, kind, destination, criteria, origin, actor, policy_id, run_id, action_id, message_ids,
        items, changed, note, reverts, created_at, state)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], '[]'::jsonb, 0, null, $11, $12, 'pending')
     returning id`,
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
      input.reverts ?? null,
      input.now,
    ],
  );
  const id = String(rows[0]!.id);
  inFlightTrail.add(id);
  return id;
}

/** The items as they stand, on the row. */
async function saveTrail(db: Db, id: string, items: readonly TrailItem[]): Promise<void> {
  const kept = items.filter((i) => statusOf(i) !== 'dropped');
  await db.query(
    `update email.mailbox_actions set items = $2::jsonb, changed = $3 where id = $1`,
    [id, JSON.stringify(kept), kept.filter((i) => statusOf(i) === 'done').length],
  );
}

/**
 * Close a trail row. Without an error: `done`, or deleted when nothing
 * changed. With one: `partial` when what was done is all known; still
 * `pending` when a command was sent and its answer never came (the next poll
 * asks the server); deleted when nothing reached the server.
 */
async function finishTrail(
  db: Db,
  id: string,
  items: readonly TrailItem[],
  outcome: { error?: unknown; skippedNote: string },
): Promise<ActionRecord | null> {
  inFlightTrail.delete(id);
  const kept = items.filter((i) => statusOf(i) !== 'dropped');
  const done = kept.filter((i) => statusOf(i) === 'done');
  const uncertain = kept.filter((i) => statusOf(i) === 'planned');
  const skipped = outcome.skippedNote ? ` Skipped ${outcome.skippedNote}.` : '';
  let state: ActionState;
  let note: string | null;
  if (outcome.error !== undefined) {
    const why = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    if (uncertain.length > 0) {
      state = 'pending';
      note = `Interrupted after ${plural(done.length, 'message')}: ${why}. ${plural(uncertain.length, 'more was', 'more were')} sent to the server without an answer; buddi checks ${uncertain.length === 1 ? 'it' : 'them'} on its next poll.${skipped}`;
    } else if (done.length > 0) {
      state = 'partial';
      note = `Partial: stopped by an error after ${plural(done.length, 'message')}: ${why}.${skipped}`;
    } else {
      await db.query(`delete from email.mailbox_actions where id = $1`, [id]);
      return null;
    }
  } else {
    if (done.length === 0) {
      await db.query(`delete from email.mailbox_actions where id = $1`, [id]);
      return null;
    }
    state = 'done';
    note = skipped ? skipped.trim() : null;
  }
  const { rows } = await db.query(
    `update email.mailbox_actions set state = $2, note = $3, items = $4::jsonb, message_ids = $5::uuid[], changed = $6
      where id = $1 returning ${ACTION_COLUMNS}`,
    [id, state, note, JSON.stringify(kept), kept.map((i) => i.id), done.length],
  );
  return rows[0] ? toAction(rows[0]) : null;
}

/**
 * After an undo (or its reconcile): the messages it put back join the
 * original's `reverted_ids`, and the original is stamped undone once the undo
 * finished without an error or nothing of it is left to put back. A partial
 * undo leaves it undoable, for the rest.
 */
async function markReverted(
  db: Db,
  original: ActionRecord,
  doneIds: readonly string[],
  finished: boolean,
  undoId: string | null,
  now: Date,
): Promise<void> {
  const reverted = new Set([...original.revertedIds, ...doneIds]);
  const remaining = original.items.filter((i) => statusOf(i) === 'done' && !reverted.has(i.id));
  const complete = (finished && undoId !== null) || remaining.length === 0;
  await db.query(
    `update email.mailbox_actions
        set reverted_ids = $2::uuid[],
            undone_at = case when $3 then $4 else undone_at end,
            undone_by = case when $3 then $5::uuid else undone_by end
      where id = $1`,
    [original.id, [...reverted], complete, now, undoId],
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

/** Gmail's own name for inbox membership, as X-GM-LABELS spells it. */
export const GMAIL_INBOX_LABEL = '\\Inbox';

/**
 * On Gmail, a folder that is a label the owner made: not INBOX and not one
 * of Gmail's own (All Mail, Trash, Spam, Sent, Drafts, Starred, Important).
 */
export function isUserLabel(facts: ServerFacts, name: string): boolean {
  if (!facts.gmail || name.toUpperCase() === INBOX) return false;
  const info = facts.listing.find((f) => f.name === name);
  if (!info) return false;
  return !attributesOf(info).some((a) => a.startsWith('\\') && a !== '\\hasnochildren' && a !== '\\haschildren');
}

/** Labels without Gmail's inbox marker, deduplicated, in a stable order. */
function plainLabels(labels: readonly string[] | undefined): string[] {
  return [...new Set((labels ?? []).filter((l) => l !== GMAIL_INBOX_LABEL))].sort();
}

function skippedWords(reasons: ReadonlyMap<string, number>): string {
  return [...reasons.entries()].map(([why, n]) => `${n} ${why}`).join(', ');
}

/**
 * Carry out one change on one account's server, keep the rows in step, and
 * write it on the trail — intent first: the row exists, `pending`, before the
 * first command, each folder's messages are on it as `planned` before that
 * folder's command and `done` after it, so a crash between the server change
 * and the record leaves a row the next poll reconciles (`reconcileTrail`).
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

  // A message the poll found gone from its folder has no place on the server
  // buddi knows: it was moved or deleted in another app.
  const live = targets.filter((t) => !t.gone);
  for (const t of targets) if (t.gone) skip('moved or deleted in another mail app');
  if (live.length === 0) {
    return { action: null, changed: 0, skipped: targets.length, note: `Nothing changed in ${account.address} (${skippedWords(reasons)}).` };
  }

  const trailId = await beginTrail(db, {
    accountId: account.id,
    kind,
    destination,
    provenance: input.provenance,
    messageIds: live.map((t) => t.id),
    now: input.now,
  });
  const save = (): Promise<void> => saveTrail(db, trailId, items);

  try {
    for (const [folder, group] of byFolder(live)) {
      const here = await locate(client, folder, group);
      skip(`no longer in ${folder}`, group.length - here.size);
      const present = group.filter((t) => here.has(t.id));
      if (present.length === 0) continue;

      if (kind === 'mark-read' || kind === 'mark-unread') {
        const seen = kind === 'mark-read';
        const change = present.filter((t) => here.get(t.id)!.flags.includes(SEEN) !== seen);
        skip(seen ? 'already read' : 'already unread', present.length - change.length);
        if (change.length === 0) continue;
        const planned = change.map((t): TrailItem => {
          const at = here.get(t.id)!;
          return {
            id: t.id, subject: t.subject, from: t.from, messageId: t.messageId,
            fromFolder: folder, fromUidValidity: t.uidValidity > 0 ? t.uidValidity : 0, fromUid: at.uid,
            prevFlags: at.flags, wantSeen: seen, status: 'planned',
          };
        });
        items.push(...planned);
        await save();
        await client.storeFlags(folder, change.map((t) => here.get(t.id)!.uid), [SEEN], seen ? 'add' : 'remove');
        for (const p of planned) p.status = 'done';
        await setSeenLocally(db, change.map((t) => t.id), seen);
        await save();
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

      /*
       * Gmail, from the inbox to a label: the label goes on and Inbox comes
       * off (X-GM-LABELS), so every other label stays exactly as it was.
       * Anywhere else a MOVE (from another label it swaps that label for the
       * new one, which is what moving between labels means).
       */
      const labelMove = kind === 'move' && facts.gmail && folder.toUpperCase() === INBOX && isUserLabel(facts, destination!);
      const source = await client.open(folder);
      const labels = facts.gmail && (kind === 'trash' || labelMove)
        ? await client.fetchLabels(folder, movable.map((t) => here.get(t.id)!.uid))
        : new Map<number, string[]>();
      const moved = movable.map((t) => ({ target: t, uid: here.get(t.id)!.uid }));
      const pushed = moved.map((m): TrailItem => ({
        id: m.target.id, subject: m.target.subject, from: m.target.from, messageId: m.target.messageId,
        fromFolder: folder, fromUidValidity: source.uidValidity, fromUid: m.uid,
        toFolder: destination!, toUidValidity: 0, toUid: null,
        prevFlags: here.get(m.target.id)!.flags,
        ...(labels.has(m.uid) ? { prevLabels: plainLabels(labels.get(m.uid)) } : {}),
        ...(labelMove ? { via: 'labels' as const } : {}),
        status: 'planned',
      }));
      items.push(...pushed);
      await save();

      let result: MoveResult;
      const uids = moved.map((m) => m.uid);
      if (labelMove) {
        await client.storeLabels(folder, uids, [destination!], 'add');
        await client.storeLabels(folder, uids, [GMAIL_INBOX_LABEL], 'remove');
        result = { uidValidity: null, uidMap: new Map() };
      } else {
        result = await client.move(folder, uids, destination!);
      }
      // The server has moved them: done, refined below. Should the landing
      // lookup fail, each row still follows to the destination with its uid
      // unknown (found by Message-ID next time), so undo can find it.
      for (const p of pushed) p.status = 'done';
      const labelsAfter = (m: { uid: number }): string[] | null | undefined =>
        labelMove ? plainLabels([...(labels.get(m.uid) ?? []), destination!]) : facts.gmail && kind === 'trash' ? [] : undefined;
      const destId = await folderRow(db, account.id, destination!, specialUseOf(facts.listing, destination!));
      let where: Awaited<ReturnType<typeof landed>>;
      try {
        where = await landed(client, destination!, moved, result);
      } catch (err) {
        for (const m of moved) await relocateRow(db, m.target, destId, null, null, labelsAfter(m));
        throw err;
      }
      for (const [i, m] of moved.entries()) {
        const newUid = where.uids.get(m.target.id) ?? null;
        await relocateRow(db, m.target, destId, newUid === null ? null : where.uidValidity, newUid, labelsAfter(m));
        pushed[i]!.toUidValidity = where.uidValidity ?? 0;
        pushed[i]!.toUid = newUid;
      }
      await save();
    }
  } catch (err) {
    await finishTrail(db, trailId, items, { error: err, skippedNote: skippedWords(reasons) }).catch(() => {});
    throw err;
  }

  const skipped = [...reasons.values()].reduce((a, b) => a + b, 0);
  const skippedNote = skippedWords(reasons);
  const action = await finishTrail(db, trailId, items, { skippedNote });
  const changed = action?.changed ?? 0;
  const done = `${verbOf(kind, destination)}: ${plural(changed, 'message')} in ${account.address}`;
  const note = changed === 0
    ? `Nothing changed in ${account.address}${skippedNote ? ` (${skippedNote})` : ''}.`
    : `${done}.${skippedNote ? ` Skipped ${skippedNote}.` : ''}${kind === 'trash' ? ' They are in Trash, not deleted; undo puts them back while they are still there.' : ' Undo puts them back.'}`;
  return { action, changed, skipped, note };
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
        and state <> 'pending' and changed > 0
      order by created_at desc, seq desc limit 1`,
    [accountIds],
  );
  return rows[0] ? toAction(rows[0]) : null;
}

/** The messages of a change an undo can still put back: done, and not put back already. */
export function undoableItems(action: ActionRecord): TrailItem[] {
  const reverted = new Set(action.revertedIds);
  return action.items.filter((i) => statusOf(i) === 'done' && !reverted.has(i.id));
}

/** Why a change cannot be undone, or null when it can. */
export function undoRefusal(action: ActionRecord): string | null {
  if (action.kind === 'undo') return 'That was itself an undo; buddi does not undo an undo. Make the change again instead.';
  if (action.undoneAt) return `That change was already undone (${action.undoneAt}).`;
  if (action.state === 'pending') {
    return 'buddi stopped while making that change, and has not yet checked with the server how far it got. It does on its next poll; undo it after that.';
  }
  if (undoableItems(action).length === 0) return 'Nothing of that change is left to put back.';
  return null;
}

/**
 * How many of a change's messages buddi has seen move since, in another mail
 * app: gone from the folder the change left them in, or now somewhere else.
 * An undo leaves those where the owner put them.
 */
export async function movedSince(db: Db, action: ActionRecord): Promise<number> {
  const items = undoableItems(action);
  if (items.length === 0) return 0;
  const { rows } = await db.query(
    `select m.id, f.name as folder, m.gone_at from email.messages m join email.folders f on f.id = m.folder_id
      where m.id = any($1::uuid[])`,
    [items.map((i) => i.id)],
  );
  const byId = new Map(rows.map((r: Record<string, any>) => [String(r.id), r]));
  let n = 0;
  for (const item of items) {
    const row = byId.get(item.id);
    if (!row) continue;
    if (row.gone_at !== null && row.gone_at !== undefined) n += 1;
    else if (item.toFolder && row.folder !== item.toFolder) n += 1;
  }
  return n;
}

/** The sentence an undo's approval and the Recent changes row say. */
export function describeUndo(action: ActionRecord, account: string, moved = 0): string {
  const left = undoableItems(action).length;
  const n = plural(left, 'message');
  const rest = action.revertedIds.length > 0 ? ' the rest of' : '';
  const since = moved > 0
    ? ` ${plural(moved, 'of them has', 'of them have')} since been moved in another mail app and will stay where ${moved === 1 ? 'it is' : 'they are'}.`
    : '';
  switch (action.kind) {
    case 'mark-read':
      return `Undo${rest} "${verbOf(action.kind)}" on ${n} in ${account}: they become unread again.${since}`;
    case 'mark-unread':
      return `Undo${rest} "${verbOf(action.kind)}" on ${n} in ${account}: they become read again.${since}`;
    case 'trash':
      return `Undo${rest} "${verbOf(action.kind)}" on ${n} in ${account}: they move back from Trash to where they were (any already emptied from Trash cannot come back).${since}`;
    default:
      return `Undo${rest} "${verbOf(action.kind, action.destination)}" on ${n} in ${account}: they move back to where they were.${since}`;
  }
}

/**
 * Put one change back, as far as the mailbox still allows, and record the
 * undo as a change of its own — intent first, like `performAction`.
 *
 * Each message is acted on where buddi's row says it is now — the row
 * followed it — and only if that is still where the change left it: one the
 * poll saw moved in another mail app is left where the owner put it, and one
 * emptied from Trash is skipped; the note says which. An undo stopped by an
 * error records what it put back, is marked partial, and leaves the change
 * undoable for the rest.
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
  const wanted = undoableItems(action);
  const current = await loadTargets(db, wanted.map((i) => i.id));
  const itemOf = new Map(wanted.map((i) => [i.id, i]));
  const items: TrailItem[] = [];
  const reasons = new Map<string, number>();
  const skip = (why: string, n = 1): void => {
    if (n > 0) reasons.set(why, (reasons.get(why) ?? 0) + n);
  };
  skip('no longer known to buddi', wanted.length - current.length);
  const isMove = action.kind !== 'mark-read' && action.kind !== 'mark-unread';
  const eligible = current.filter((t) => {
    const item = itemOf.get(t.id)!;
    if (t.gone || (isMove && item.toFolder && t.folder !== item.toFolder)) {
      skip('moved in another mail app since, so left where you put it');
      return false;
    }
    return true;
  });

  const summary = (changed: number): string => {
    const skipped = [...reasons.values()].reduce((a, b) => a + b, 0);
    const why = skippedWords(reasons);
    return changed === 0
      ? `Nothing could be put back in ${account.address}${skipped > 0 ? ` (${why})` : ''}.`
      : `Undid "${verbOf(action.kind, action.destination)}" on ${plural(changed, 'message')} in ${account.address}.${skipped > 0 ? ` ${plural(skipped, 'message')} could not be put back: ${why}.` : ''}`;
  };
  if (eligible.length === 0) {
    return { action: null, changed: 0, skipped: [...reasons.values()].reduce((a, b) => a + b, 0), note: summary(0) };
  }

  const trailId = await beginTrail(db, {
    accountId: account.id,
    kind: 'undo',
    destination: null,
    provenance: input.provenance,
    messageIds: eligible.map((t) => t.id),
    reverts: action.id,
    now: input.now,
  });
  const save = (): Promise<void> => saveTrail(db, trailId, items);
  const doneIds = (): string[] => items.filter((i) => statusOf(i) === 'done').map((i) => i.id);

  try {
    for (const [folder, group] of byFolder(eligible)) {
      const here = await locate(client, folder, group);
      skip('no longer where the change left it', group.length - here.size);
      const present = group.filter((t) => here.has(t.id));
      if (present.length === 0) continue;

      if (!isMove) {
        for (const seen of [true, false]) {
          const list = present.filter((t) => (itemOf.get(t.id)!.prevFlags ?? []).includes(SEEN) === seen);
          if (list.length === 0) continue;
          const planned = list.map((t): TrailItem => ({
            id: t.id, subject: t.subject, from: t.from, messageId: t.messageId,
            fromFolder: folder, fromUidValidity: t.uidValidity, fromUid: here.get(t.id)!.uid,
            prevFlags: here.get(t.id)!.flags, wantSeen: seen, status: 'planned',
          }));
          items.push(...planned);
          await save();
          await client.storeFlags(folder, list.map((t) => here.get(t.id)!.uid), [SEEN], seen ? 'add' : 'remove');
          for (const p of planned) p.status = 'done';
          await setSeenLocally(db, list.map((t) => t.id), seen);
          await save();
        }
        continue;
      }

      // Moves: back to each message's own original folder.
      const back = new Map<string, Target[]>();
      for (const t of present) {
        const original = itemOf.get(t.id)!.fromFolder;
        if (original === folder) {
          skip('already back where it was');
          continue;
        }
        const list = back.get(original) ?? [];
        list.push(t);
        back.set(original, list);
      }
      for (const [original, list] of back) {
        if (!facts.listing.some((f) => f.name === original)) {
          skip(`its old folder ${original} is gone`, list.length);
          continue;
        }
        const source = await client.open(folder);
        const viaLabels = list.filter((t) => facts.gmail && itemOf.get(t.id)!.via === 'labels' && original.toUpperCase() === INBOX);
        const viaMove = list.filter((t) => !viaLabels.includes(t));
        const destId = await folderRow(db, account.id, original, specialUseOf(facts.listing, original));

        if (viaMove.length > 0) {
          const moved = viaMove.map((t) => ({ target: t, uid: here.get(t.id)!.uid }));
          const pushed = moved.map((m): TrailItem => ({
            id: m.target.id, subject: m.target.subject, from: m.target.from, messageId: m.target.messageId,
            fromFolder: folder, fromUidValidity: source.uidValidity, fromUid: m.uid,
            toFolder: original, toUidValidity: 0, toUid: null, status: 'planned',
          }));
          items.push(...pushed);
          await save();
          const result = await client.move(folder, moved.map((m) => m.uid), original);
          for (const p of pushed) p.status = 'done';
          const where = await landed(client, original, moved, result);
          for (const [i, m] of moved.entries()) {
            const newUid = where.uids.get(m.target.id) ?? null;
            const prev = itemOf.get(m.target.id)!.prevLabels;
            await relocateRow(db, m.target, destId, newUid === null ? null : where.uidValidity, newUid, facts.gmail && prev ? plainLabels(prev) : undefined);
            pushed[i]!.toUidValidity = where.uidValidity ?? 0;
            pushed[i]!.toUid = newUid;
          }
          // Gmail drops a message's labels in Trash: give back the ones it had.
          if (facts.gmail) {
            const byLabels = new Map<string, number[]>();
            for (const m of moved) {
              const prev = plainLabels(itemOf.get(m.target.id)!.prevLabels);
              const uid = where.uids.get(m.target.id);
              if (prev.length === 0 || uid === null || uid === undefined) continue;
              const key = JSON.stringify(prev);
              byLabels.set(key, [...(byLabels.get(key) ?? []), uid]);
            }
            for (const [key, uids] of byLabels) await client.addLabels(original, uids, JSON.parse(key) as string[]);
          }
          await save();
        }

        if (viaLabels.length > 0) {
          await undoLabelMove(db, client, { folder, original, destId, source, list: viaLabels, here, itemOf, items, save });
        }
      }
    }
  } catch (err) {
    const undo = await finishTrail(db, trailId, items, { error: err, skippedNote: skippedWords(reasons) }).catch(() => null);
    await markReverted(db, action, doneIds(), false, undo?.id ?? null, input.now).catch(() => {});
    throw err;
  }

  const undo = await finishTrail(db, trailId, items, { skippedNote: skippedWords(reasons) });
  const changed = undo?.changed ?? 0;
  if (undo) await markReverted(db, action, doneIds(), true, undo.id, input.now);
  return { action: undo, changed, skipped: [...reasons.values()].reduce((a, b) => a + b, 0), note: summary(changed) };
}

/**
 * Undo a Gmail label move exactly: the labels the message had before come
 * back, any added since go, and Inbox goes back on — over X-GM-LABELS, so the
 * message never passes through a MOVE that would drop one. The label it was
 * moved to comes off last, from the inbox copy, so the message is never
 * without a home in between.
 */
async function undoLabelMove(
  db: Db,
  client: ImapWriter,
  input: {
    folder: string;
    original: string;
    destId: string;
    source: MailboxStatus;
    list: Target[];
    here: Map<string, { uid: number; flags: string[] }>;
    itemOf: Map<string, TrailItem>;
    items: TrailItem[];
    save: () => Promise<void>;
  },
): Promise<void> {
  const { folder, original, list, here, itemOf, items, save } = input;
  const uidOf = (t: Target): number => here.get(t.id)!.uid;
  const now = await client.fetchLabels(folder, list.map(uidOf));
  // One set of commands per distinct (before, now): usually all of them.
  const groups = new Map<string, { prev: string[]; current: string[]; targets: Target[] }>();
  for (const t of list) {
    const prev = plainLabels(itemOf.get(t.id)!.prevLabels);
    const current = plainLabels(now.get(uidOf(t)));
    const key = JSON.stringify([prev, current]);
    const g = groups.get(key) ?? { prev, current, targets: [] };
    g.targets.push(t);
    groups.set(key, g);
  }
  for (const { prev, current, targets } of groups.values()) {
    const pushed = targets.map((t): TrailItem => ({
      id: t.id, subject: t.subject, from: t.from, messageId: t.messageId,
      fromFolder: folder, fromUidValidity: input.source.uidValidity, fromUid: uidOf(t),
      toFolder: original, toUidValidity: 0, toUid: null, prevLabels: current, via: 'labels', status: 'planned',
    }));
    items.push(...pushed);
    await save();
    const uids = targets.map(uidOf);
    const add = prev.filter((l) => !current.includes(l));
    const remove = current.filter((l) => !prev.includes(l) && l !== folder);
    if (add.length > 0) await client.storeLabels(folder, uids, add, 'add');
    if (remove.length > 0) await client.storeLabels(folder, uids, remove, 'remove');
    await client.storeLabels(folder, uids, [GMAIL_INBOX_LABEL], 'add');
    for (const p of pushed) p.status = 'done';
    // Back in the inbox; now find each one there and take the moved-to label off.
    const status = await client.open(original);
    for (const [i, t] of targets.entries()) {
      const uid = t.messageId ? await client.findByMessageId(original, t.messageId) : null;
      if (uid !== null && !prev.includes(folder)) await client.storeLabels(original, [uid], [folder], 'remove');
      await relocateRow(db, t, input.destId, uid === null ? null : status.uidValidity, uid, prev);
      pushed[i]!.toUidValidity = uid === null ? 0 : status.uidValidity;
      pushed[i]!.toUid = uid;
    }
    await save();
  }
}

/* ------------------------------------------------------------------ *
 * After a crash: what the server says happened
 * ------------------------------------------------------------------ */

/**
 * Settle the `pending` trail rows a stopped process left for this account:
 * for each message planned and never confirmed, ask the server by Message-ID
 * where it is. Still where it was: it did not happen — the item goes. In
 * the destination: it happened — the row follows and the item is done.
 * Neither, or no Message-ID to ask with: unknown. The row becomes `done`, `partial`
 * (something did not happen) or `unknown`, or goes when nothing happened. An
 * interrupted undo puts what it did on its change's `reverted_ids`.
 */
export async function reconcileTrail(
  db: Db,
  client: ImapWriter,
  input: { account: AccountRecord; now: Date },
): Promise<{ settled: number }> {
  const { rows } = await db.query(
    `select ${ACTION_COLUMNS} from email.mailbox_actions
      where account_id = $1 and state = 'pending' and not (id = any($2::uuid[]))
      order by created_at, seq`,
    [input.account.id, trailInFlight()],
  );
  if (rows.length === 0) return { settled: 0 };
  const facts = await serverFacts(client);
  let settled = 0;
  for (const action of rows.map(toAction)) {
    const items = action.items.map((i) => ({ ...i }));
    let dropped = 0;
    for (const item of items) {
      if (statusOf(item) !== 'planned') continue;
      const target = (await loadTargets(db, [item.id]))[0];
      if (item.toFolder) {
        // Where it was first: on Gmail, All Mail also holds what is still
        // in the inbox, so "found in the destination" alone proves nothing.
        const stayed = item.messageId ? await client.findByMessageId(item.fromFolder, item.messageId) : null;
        if (stayed !== null) {
          item.status = 'dropped';
          dropped += 1;
          continue;
        }
        const there = item.messageId ? await client.findByMessageId(item.toFolder, item.messageId) : null;
        if (there !== null) {
          const status = await client.open(item.toFolder);
          item.status = 'done';
          item.toUidValidity = status.uidValidity;
          item.toUid = there;
          if (target) {
            const destId = await folderRow(db, input.account.id, item.toFolder, specialUseOf(facts.listing, item.toFolder));
            let labels: string[] | undefined;
            if (facts.gmail) labels = plainLabels((await client.fetchLabels(item.toFolder, [there])).get(there));
            await relocateRow(db, target, destId, status.uidValidity, there, labels);
          }
          continue;
        }
        item.status = 'unknown';
        continue;
      }
      // A flag change: is the read mark what the change wanted?
      const status = await client.open(item.fromFolder);
      let uid: number | null = item.fromUidValidity === status.uidValidity && item.fromUid > 0 ? item.fromUid : null;
      if (uid === null && item.messageId) uid = await client.findByMessageId(item.fromFolder, item.messageId);
      const flags = uid === null ? undefined : (await client.fetchFlags(item.fromFolder, [uid]))[0]?.flags;
      if (!flags) {
        item.status = 'unknown';
      } else if (flags.includes(SEEN) === (item.wantSeen ?? action.kind === 'mark-read')) {
        item.status = 'done';
        if (target) await setSeenLocally(db, [target.id], flags.includes(SEEN));
      } else {
        item.status = 'dropped';
        dropped += 1;
      }
    }
    const kept = items.filter((i) => statusOf(i) !== 'dropped');
    const done = kept.filter((i) => statusOf(i) === 'done');
    const unknown = kept.filter((i) => statusOf(i) === 'unknown');
    if (done.length === 0 && unknown.length === 0) {
      await db.query(`delete from email.mailbox_actions where id = $1`, [action.id]);
    } else {
      const state: ActionState = unknown.length > 0 ? 'unknown' : dropped > 0 ? 'partial' : 'done';
      const note =
        `buddi stopped while making this change; checked with the server afterwards: ${plural(done.length, 'message')} changed` +
        (dropped > 0 ? `, ${dropped} not` : '') +
        (unknown.length > 0 ? `, ${unknown.length} could not be confirmed (not found where it was or where it was going)` : '') +
        '.';
      await db.query(
        `update email.mailbox_actions set state = $2, note = $3, items = $4::jsonb, message_ids = $5::uuid[], changed = $6 where id = $1`,
        [action.id, state, note, JSON.stringify(kept), kept.map((i) => i.id), done.length],
      );
      if (action.kind === 'undo' && action.reverts) {
        const original = await findAction(db, action.reverts);
        if (original) await markReverted(db, original, done.map((i) => i.id), false, null, input.now);
      }
    }
    settled += 1;
  }
  return { settled };
}

/**
 * The poll's half of intent-first: when this account has `pending` trail rows
 * no change in this process is writing, open a writer and settle them
 * (`reconcileTrail`). One cheap query when there are none.
 */
export async function reconcilePendingChanges(
  ctx: { buddi?: import('@buddi/core/plugin').BuddiHost | undefined },
  account: AccountRecord,
  opts: WriterOptions,
): Promise<number> {
  const db = ctx.buddi!.db;
  const { rows } = await db.query(
    `select 1 from email.mailbox_actions
      where account_id = $1 and state = 'pending' and not (id = any($2::uuid[])) limit 1`,
    [account.id, trailInFlight()],
  );
  if (rows.length === 0) return 0;
  const { settled } = await withWriter(ctx, account, opts, (client) =>
    reconcileTrail(db, client, { account, now: ctx.buddi!.clock.now() }),
  );
  return settled;
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
