/**
 * The two tests behind `email.suspicious-sender`, and where each of them lives.
 *
 * docs/specs/email.md §7: *«a first-time sender imitating a known one (display
 * name matches, address does not), or a message asking for credentials, a wire,
 * or a gift card»*. They are two different kinds of question and they are
 * answered in two different places on purpose:
 *
 *  - **(a) the look-alike** is a fact about the *mailbox as it stands today* —
 *    who the owner has written to, under what name, at what domains. It is
 *    computed in SQL on every tick and stored nowhere, so a correspondent the
 *    owner first wrote to this morning protects him this afternoon. Stamping a
 *    verdict on the message would freeze the comparison at the moment the body
 *    happened to be read, which for this one watcher is exactly wrong.
 *  - **(b) the ask** is a fact about the *body*, which does not change. It is
 *    read once by a bounded catch-up sweep, stamped
 *    (`messages.suspicion_scanned_at`) and stored (`email.suspicions`), the
 *    way dates and receipts are.
 *
 * **An `ignore` policy does not silence either of them**, and that is the whole
 * point of the watcher: somebody imitating a correspondent will be sending from
 * a domain the owner may well have silenced, and a fraud that can buy its own
 * silence with a `@newsletter.example` rule is not being watched for. Only a
 * muted conversation — the owner's own decision about *this* conversation —
 * keeps it quiet. The catch-up sweep therefore reads every inbound message,
 * including the ones the gate ignored.
 */
import type { DbArea } from '@buddi/core/plugin';
import { classifyAsk, type AskKind, type AskReading } from './phrases.js';

/** `ctx.buddi.db`, a transaction's handle, or anything that answers a query as they do. */
type Db = Pick<DbArea, 'query'>;

/** How many unscanned messages one sentinel tick reads. */
export const SUSPICION_SCAN_BATCH = 200;

/** How many out-of-window messages one tick stamps without reading. */
export const SUSPICION_STAMP_BATCH = 2000;

/** A message the catch-up sweep is about to read. No `ignored` flag: see above. */
export interface ScannableBody {
  id: string;
  bodyText: string | null;
}

/**
 * Bodies nothing has read yet, oldest first, and no older than the window.
 *
 * The window bound is what keeps the sweep from starving: this watcher only
 * ever reports mail from the last seven days, so reading a backlog older than
 * that is work for a finding that cannot be raised — and on a busy mailbox it
 * would mean today's mail is never reached at all, which for *this* watcher is
 * the difference between catching a fraud and reading about one. What ages out
 * unread is stamped in bulk by `stampOldSuspicions`.
 *
 * Every inbound message, silenced senders included — see the module note.
 */
export async function unscannedSuspicions(
  db: Db,
  since: Date,
  limit = SUSPICION_SCAN_BATCH,
): Promise<ScannableBody[]> {
  const { rows } = await db.query(
    `select m.id, m.body_text
       from email.messages m
      where m.suspicion_scanned_at is null
        and m.direction = 'in'
        and coalesce(m.internal_date, m.fetched_at) >= $1::timestamptz
      order by m.fetched_at asc, m.id asc
      limit $2`,
    [since, limit],
  );
  return rows.map((row: Record<string, any>) => ({
    id: String(row.id),
    bodyText: row.body_text ?? null,
  }));
}

/** Stamp, in one bounded statement, the mail that aged out of the window. */
export async function stampOldSuspicions(
  db: Db,
  before: Date,
  now: Date,
  limit = SUSPICION_STAMP_BATCH,
): Promise<number> {
  const { rowCount } = await db.query(
    `update email.messages set suspicion_scanned_at = $2
      where id in (
        select id from email.messages
         where suspicion_scanned_at is null
           and direction = 'in'
           and coalesce(internal_date, fetched_at) < $1::timestamptz
         order by fetched_at asc, id asc
         limit $3
      )`,
    [before, now, limit],
  );
  return rowCount ?? 0;
}

/**
 * Store one reading **and** stamp the message, in a single statement.
 *
 * One statement for the reason `recordReceipt` gives: a stamp that survives a
 * failed insert is a message marked read with nothing read out of it, and
 * nothing will ever look at it again.
 */
export async function recordSuspicion(
  db: Db,
  messageId: string,
  reading: AskReading | null,
  now: Date,
): Promise<void> {
  if (reading === null) {
    await db.query(`update email.messages set suspicion_scanned_at = $2 where id = $1::uuid`, [
      messageId,
      now,
    ]);
    return;
  }
  await db.query(
    `with stored as (
       insert into email.suspicions (message_id, kind, confidence, phrase, urgent, found_at)
       values ($1::uuid, $2, $3, $4, $5, $6)
       on conflict (message_id) do update
          set kind = excluded.kind,
              confidence = greatest(email.suspicions.confidence, excluded.confidence),
              phrase = excluded.phrase,
              urgent = excluded.urgent
       returning message_id
     )
     update email.messages set suspicion_scanned_at = $6
      where id = (select message_id from stored)`,
    [messageId, reading.kind, reading.confidence, reading.phrase, reading.urgent, now],
  );
}

/** Read one body for the ask and keep the result. */
export async function scanMessageAsk(
  db: Db,
  message: ScannableBody,
  now: Date,
): Promise<AskReading | null> {
  const reading = classifyAsk(message.bodyText);
  await recordSuspicion(db, message.id, reading, now);
  return reading;
}

/** One message either test fired on, with what the finding needs to say. */
export interface SuspectMessage {
  messageId: string;
  threadId: string | null;
  subject: string;
  from: string;
  bodyText: string | null;
  snippet: string;
}

export interface AskRow extends SuspectMessage {
  kind: AskKind;
  confidence: number;
  phrase: string;
  urgent: boolean;
}

const MESSAGE_COLUMNS = `m.id as message_id, m.thread_id, m.subject, m.from_addr,
                         m.body_text, m.snippet`;

/** How far back the owner's own mail is read for names he writes to. */
export const KNOWN_NAMES_YEARS = 2;

/**
 * Test (a): inbound mail since `since` wearing a name the owner writes to at
 * another address entirely.
 *
 * `known` is every address the owner has sent to in the last
 * `KNOWN_NAMES_YEARS` years, in that mailbox, that carried a display name —
 * To and Cc alike, because an impostor imitates whoever the owner is in a room
 * with. Four things bound it, and each of them was a way for this test to be
 * wrong rather than merely slow:
 *
 *  - **`distinct`**: the rows are only ever used for membership, and a
 *    correspondent written to weekly was otherwise a thousand identical rows;
 *  - **two years**: a name last written to in 2019 is not a name the owner
 *    would recognise being imitated today, and scanning a decade of Sent mail
 *    hourly to find that out is a full table scan for nothing;
 *  - **not the owner himself**: his own address and every alias on the account
 *    are excluded, or mail he sends to his own alias teaches this test that his
 *    own name belongs to that address — and the next message from himself, or
 *    from anybody sharing his name, is an urgent fraud warning;
 *  - **a name that identifies somebody**: `email.discriminating_name`, which is
 *    `phrases.ts`'s `discriminatingName` in SQL. `Support` is a name the owner
 *    writes to at a dozen addresses.
 *
 * Then two conditions on the candidate, and both are needed: somebody of that
 * name at a *different* address, and no address of that name at *this* domain.
 * The second is what keeps a colleague's second mailbox on the company domain
 * from being called a fraud.
 */
const LOOK_ALIKE_SQL = `
  with known as (
    select distinct
           o.account_id,
           email.name_key(email.display_name_of(a.addr)) as name,
           email.address_of(a.addr) as addr,
           split_part(email.address_of(a.addr), '@', 2) as domain
      from email.messages o
      join email.accounts acc on acc.id = o.account_id
      cross join lateral (
        select jsonb_array_elements_text(o.to_addrs) as addr
        union all
        select jsonb_array_elements_text(o.cc) as addr
      ) a
     where o.direction = 'out'
       and coalesce(o.internal_date, o.fetched_at) >= $1::timestamptz - make_interval(years => $2::int)
       and email.discriminating_name(email.display_name_of(a.addr))
       -- Never the owner's own identities: see the note above.
       and email.address_of(a.addr) <> email.address_of(acc.address)
       and not (email.address_of(a.addr) = any (select email.address_of(x) from unnest(acc.aliases) as x))
  )
  select ${MESSAGE_COLUMNS}
    from email.messages m
    left join email.threads t on t.id = m.thread_id
   where m.direction = 'in'
     and coalesce(m.internal_date, m.fetched_at) >= $3::timestamptz
     -- Only the owner's own mute silences this one. See the module note.
     and coalesce(t.state, 'waiting-on-me') <> 'muted'
     and email.discriminating_name(email.display_name_of(m.from_addr))
     and exists (
       select 1 from known k
        where k.account_id = m.account_id
          and k.name = email.name_key(email.display_name_of(m.from_addr))
          and k.addr <> email.address_of(m.from_addr)
     )
     and not exists (
       select 1 from known k
        where k.account_id = m.account_id
          and k.name = email.name_key(email.display_name_of(m.from_addr))
          and k.domain = split_part(email.address_of(m.from_addr), '@', 2)
     )
   order by coalesce(m.internal_date, m.fetched_at) desc, m.id asc`;

function toSuspect(row: Record<string, any>): SuspectMessage {
  return {
    messageId: String(row.message_id),
    threadId: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
    subject: row.subject ?? '',
    from: row.from_addr ?? '',
    bodyText: row.body_text ?? null,
    snippet: row.snippet ?? '',
  };
}

export async function lookAlikesSince(
  db: Db,
  since: Date,
  now: Date,
): Promise<SuspectMessage[]> {
  const { rows } = await db.query(LOOK_ALIKE_SQL, [now, KNOWN_NAMES_YEARS, since]);
  return rows.map(toSuspect);
}

/** Test (b): stored asks on mail since `since`. Mute is the only silence. */
export async function asksSince(db: Db, since: Date): Promise<AskRow[]> {
  const { rows } = await db.query(
    `select ${MESSAGE_COLUMNS}, s.kind, s.confidence, s.phrase, s.urgent
       from email.suspicions s
       join email.messages m on m.id = s.message_id
       left join email.threads t on t.id = m.thread_id
      where m.direction = 'in'
        and coalesce(m.internal_date, m.fetched_at) >= $1::timestamptz
        and coalesce(t.state, 'waiting-on-me') <> 'muted'
      order by coalesce(m.internal_date, m.fetched_at) desc, m.id asc`,
    [since],
  );
  return rows.map((row: Record<string, any>) => ({
    ...toSuspect(row),
    kind: row.kind as AskKind,
    confidence: Number(row.confidence),
    phrase: row.phrase ?? '',
    urgent: row.urgent === true,
  }));
}
