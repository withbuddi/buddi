/**
 * Mail moved, archived or deleted in another mail app.
 *
 * Each inbox poll asks which of the messages buddi holds there have left the
 * server's INBOX, and writes the answer on the rows, so the unread count, the
 * Mail page, `email.select_messages` and the undo trail see the inbox as the
 * owner left it on his phone.
 *
 *  - **Usually free.** The SELECT the poll already made reports UIDNEXT and
 *    EXISTS. If both are what they were after the last check, nothing left
 *    and nothing arrived, so no command is sent at all.
 *  - **Otherwise one command.** On a server that ENABLEd QRESYNC (RFC 7162)
 *    and a modseq from the last check, the server's own VANISHED list; else a
 *    `UID SEARCH UID <lowest>:<highest>` over the rows buddi holds (at most
 *    the flag re-sync's window), diffed with them. Uids only.
 *  - **Gmail says where it went.** A departed message is looked up by its
 *    Message-ID in All Mail (archived; its X-GM-LABELS read, and a label the
 *    owner gave it is the folder the row points at), then Trash, then Spam.
 *    At most `LOCATE_PER_POLL` lookups a poll; the rest, and every departure
 *    on any other server, are marked gone (`messages.gone_at`, migration 020):
 *    no longer in the inbox, place unknown.
 */
import type { DbArea } from '@buddi/core/plugin';
import { folderRow, relocateRow, GMAIL_INBOX_LABEL } from '../mailbox/actions.js';
import type { AccountRecord, ImapClient, MailboxInfo, MailboxStatus } from '../ports.js';
import type { FolderRecord } from '../rows.js';

type Db = Pick<DbArea, 'query'>;

/** How many departed messages one poll looks up on Gmail. The rest are marked gone. */
export const LOCATE_PER_POLL = 50;

export interface PresenceResult {
  /** How the question was answered: not asked (nothing changed), VANISHED, or a search. */
  via: 'unchanged' | 'vanished' | 'search' | 'unsupported' | 'empty';
  departed: number;
  located: number;
  gone: number;
}

function attributes(info: MailboxInfo): string[] {
  return [info.specialUse ?? '', ...info.flags].map((f) => f.trim().toLowerCase()).filter((f) => f !== '');
}

function special(listing: readonly MailboxInfo[], use: string): MailboxInfo | null {
  return listing.find((info) => attributes(info).includes(use)) ?? null;
}

/**
 * Check the inbox's held rows against the server and record what left.
 * `deadline` wraps each IMAP call the way the poll does.
 */
export async function checkPresence(
  db: Db,
  account: AccountRecord,
  client: ImapClient,
  folder: FolderRecord,
  status: MailboxStatus,
  opts: {
    window: number;
    now: Date;
    log: (line: string) => void;
    deadline: <T>(op: string, work: Promise<T>) => Promise<T>;
  },
): Promise<PresenceResult> {
  const { rows: stateRows } = await db.query(
    `select presence_uidnext, presence_exists, presence_modseq, uidvalidity from email.folders where id = $1`,
    [folder.id],
  );
  const state = stateRows[0] as Record<string, any> | undefined;
  const sameGeneration = state !== undefined && Number(state.uidvalidity) === status.uidValidity;
  const record = async (): Promise<void> => {
    await db.query(
      `update email.folders set presence_uidnext = $2, presence_exists = $3, presence_modseq = $4
        where id = $1 and uidvalidity = $5`,
      [folder.id, status.uidNext, status.exists, status.highestModseq ?? null, status.uidValidity],
    );
  };

  if (
    sameGeneration &&
    state.presence_uidnext !== null && Number(state.presence_uidnext) === status.uidNext &&
    state.presence_exists !== null && Number(state.presence_exists) === status.exists
  ) {
    return { via: 'unchanged', departed: 0, located: 0, gone: 0 };
  }
  if (!client.departures) return { via: 'unsupported', departed: 0, located: 0, gone: 0 };

  const { rows: held } = await db.query(
    `select id, uid, message_id from email.messages
      where folder_id = $1 and uidvalidity = $2 and gone_at is null and uid > 0
      order by uid desc limit $3`,
    [folder.id, status.uidValidity, opts.window],
  );
  if (held.length === 0) {
    await record();
    return { via: 'empty', departed: 0, located: 0, gone: 0 };
  }
  const uids = held.map((r: Record<string, any>) => Number(r.uid));
  const fromUid = Math.min(...uids);
  const toUid = Math.max(...uids);
  const since = sameGeneration && state.presence_modseq !== null && status.highestModseq ? String(state.presence_modseq) : null;
  const answer = await opts.deadline('presence', client.departures(folder.name, { fromUid, toUid, changedSince: since }));
  const via: PresenceResult['via'] = 'vanished' in answer ? 'vanished' : 'search';
  const departedUids = 'vanished' in answer
    ? new Set(answer.vanished)
    : (() => {
        const present = new Set(answer.present);
        return new Set(uids.filter((u) => !present.has(u)));
      })();
  const departed = held.filter((r: Record<string, any>) => departedUids.has(Number(r.uid)));
  let located = 0;
  let gone = 0;
  if (departed.length > 0) {
    const found = await locateOnGmail(db, account, client, departed, opts);
    located = found.size;
    const unplaced = departed.filter((r: Record<string, any>) => !found.has(String(r.id))).map((r: Record<string, any>) => String(r.id));
    if (unplaced.length > 0) {
      const result = await db.query(
        `update email.messages set gone_at = $2 where id = any($1::uuid[]) and gone_at is null`,
        [unplaced, opts.now],
      );
      gone = result.rowCount ?? unplaced.length;
    }
    opts.log(
      `email.inbox-poll: ${departed.length} message(s) left ${account.address}/${folder.name} in another app ` +
        `(found via ${via}): ${located} located, ${gone} marked no longer in the inbox`,
    );
  }
  await record();
  return { via, departed: departed.length, located, gone };
}

/**
 * Gmail only: where each departed message went, by Message-ID — All Mail
 * (archived, with its labels; a label that is a folder is where the row then
 * points), Trash, Spam. Returns the row ids it placed.
 */
async function locateOnGmail(
  db: Db,
  account: AccountRecord,
  client: ImapClient,
  departed: Array<Record<string, any>>,
  opts: { deadline: <T>(op: string, work: Promise<T>) => Promise<T> },
): Promise<Set<string>> {
  const placed = new Set<string>();
  if (!client.capabilities || !client.findByMessageId || !client.fetchLabels) return placed;
  const caps = await opts.deadline('capability', client.capabilities());
  if (!caps.includes('X-GM-EXT-1')) return placed;
  const listing = await opts.deadline('list', client.listMailboxes());
  const allMail = special(listing, '\\all');
  const places = [allMail, special(listing, '\\trash'), special(listing, '\\junk')].filter((p): p is MailboxInfo => p !== null);
  if (places.length === 0) return placed;
  const userFolders = new Set(
    listing
      .filter((info) => info.name.toUpperCase() !== 'INBOX' && !attributes(info).some((a) => a.startsWith('\\') && a !== '\\haschildren' && a !== '\\hasnochildren'))
      .map((info) => info.name),
  );
  const generation = new Map<string, number>();
  const uidValidityOf = async (name: string): Promise<number> => {
    if (!generation.has(name)) generation.set(name, (await opts.deadline('select', client.open(name))).uidValidity);
    return generation.get(name)!;
  };
  for (const row of departed.slice(0, LOCATE_PER_POLL)) {
    const messageId = row.message_id as string | null;
    if (!messageId) continue;
    for (const place of places) {
      await uidValidityOf(place.name);
      const uid = await opts.deadline('search', client.findByMessageId(place.name, messageId));
      if (uid === null) continue;
      let folderName = place.name;
      let folderUid = uid;
      let labels: string[] = [];
      if (place === allMail) {
        labels = [...new Set(((await opts.deadline('labels', client.fetchLabels(place.name, [uid]))).get(uid) ?? [])
          .filter((l) => l !== GMAIL_INBOX_LABEL))].sort();
        // Labelled in another app: point the row at that label, as buddi's own move would.
        const label = labels.find((l) => userFolders.has(l));
        if (label) {
          await uidValidityOf(label);
          const there = await opts.deadline('search', client.findByMessageId(label, messageId));
          if (there !== null) {
            folderName = label;
            folderUid = there;
          }
        }
      }
      const uidValidity = await uidValidityOf(folderName);
      const info = listing.find((f) => f.name === folderName);
      const use = info ? attributes(info).find((a) => ['\\all', '\\trash', '\\junk'].includes(a)) ?? null : null;
      const destId = await folderRow(db, account.id, folderName, use);
      await relocateRow(db, { id: String(row.id), accountId: account.id }, destId, uidValidity, folderUid, labels);
      placed.add(String(row.id));
      break;
    }
  }
  return placed;
}
