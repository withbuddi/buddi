/**
 * `email.inbox-poll` — the source half of the plugin contract.
 *
 * Mail arrives and a triage run starts; no agent is in the loop, and nobody
 * asked. That is what makes this a *source* rather than a tool, and it carries
 * everything the contract demands (ARCHITECTURE.md, "Drop-in tools and skills"):
 *
 *  - **Identity is the quad.** `(account, mailbox, uidvalidity, uid)` with a
 *    unique constraint. A UID means nothing without its UIDVALIDITY.
 *  - **UIDVALIDITY resets are handled, not hoped about.** When the generation
 *    changes, every stored uid for that mailbox is meaningless: the change is
 *    logged and the cursor is re-planted by the first-contact policy below.
 *    Already-stored rows are kept — they are a different generation and the
 *    unique constraint keeps them apart.
 *  - **Transactional cursor advancement.** Rows and `last_uid` commit together,
 *    so a crash can re-fetch but can never skip.
 *  - **A new mailbox starts at *now*, not at message one.** A first contact has
 *    no cursor, and "no cursor" must never mean "read 140,000 messages from
 *    UID 1". The cursor is planted at `UIDNEXT - 1` — everything that arrives
 *    from this moment on is new mail, and the history stays where it is.
 *    `EMAIL_BACKFILL=N` plants it N lower instead, so the newest N messages
 *    come along for context. The same policy runs on a UIDVALIDITY reset: a new
 *    generation is a new mailbox, and re-reading a decade of mail is not a
 *    re-sync, it is an outage.
 *  - **Offline contract.** Catch-up is durable by construction: IMAP keeps the
 *    messages, the cursor is where we left off, and a machine that slept a week
 *    simply walks forward 50 messages per poll until it catches up. Nothing is
 *    lost the way a Telegram update is.
 *  - **Every IMAP call has a deadline.** A socket to a mail server can accept
 *    the connection and then say nothing. Connect, select and fetch each run
 *    under `EMAIL_POLL_TIMEOUT_MS` (45s); on expiry the poll aborts, the
 *    connection is closed, the error is recorded in `core.source_runs` and the
 *    next poll starts clean. A poll that hangs is a bug; a poll that gives up
 *    and says so is a source.
 *  - **Flags are never mutated.** The fetch is a peek; `\Seen` stays whatever
 *    the owner's own mail client made it.
 *
 * The one seam: `enqueueRun` is the gateway's, and it cannot join this module's
 * transaction. So rows land with `triage_enqueued_at` null, the runs are
 * created after the commit, and the stamp is written last. A crash in between
 * leaves the row unstamped and the next poll re-enqueues it; the dedup key
 * makes that a no-op if the run already exists. Durable intent, no lost mail,
 * no double triage.
 */
import type { Pool, PoolClient } from 'pg';
import { INBOX, listAccounts, resolveAuth, type EnvLike } from '../config.js';
import { planFolders } from '../folders.js';
import { prepareForIngest, triagePrompt, type ThreadForPrompt } from '../mail.js';
import { applyPolicies, type GateDecision, type PolicyRecord } from '../policies/gate.js';
import { loadPolicies, recordEvent, settleEvent } from '../policies/store.js';
import { ownerReplies, senderVerdicts } from '../policies/learn.js';
import type { AccountRecord, ImapClient, ImapClientFactory } from '../ports.js';
import { FOLDER_COLUMNS, toFolder, type FolderRecord, type MessageDirection } from '../rows.js';
import { findThread, joinThread, threadMessages } from '../threads.js';
import { PROCESSING_VERSION } from '../tools/shared.js';
import type { Source, SourceContext } from '../types.js';

/** The agent every new message is triaged by. */
export const TRIAGE_AGENT_ID = 'mail-triage';

/** Poll period, in seconds. */
export const POLL_EVERY_SECONDS = 300;

/** Hard cap per poll. A backlog drains over several polls rather than in one gulp. */
export const MAX_PER_POLL = 50;

/** Deadline for every single IMAP call. Env: `EMAIL_POLL_TIMEOUT_MS`. */
export const DEFAULT_POLL_TIMEOUT_MS = 45_000;
export const POLL_TIMEOUT_VAR = 'EMAIL_POLL_TIMEOUT_MS';

/**
 * How many of the newest messages a first contact brings along for context.
 * Zero means "start at now": no history is fetched at all. Env: `EMAIL_BACKFILL`.
 */
export const DEFAULT_BACKFILL = 0;
export const BACKFILL_VAR = 'EMAIL_BACKFILL';

/** A deliberate, recorded give-up — not a defect. Carries which call expired. */
export class ImapTimeoutError extends Error {
  override readonly name = 'ImapTimeoutError';
  constructor(
    readonly op: string,
    readonly ms: number,
  ) {
    super(`imap ${op} timed out after ${ms}ms`);
  }
}

/**
 * Run one IMAP call under a deadline.
 *
 * A promise cannot be cancelled, so the loser is *abandoned*, not killed:
 * `onAbandoned` is the caller's chance to clean up whatever it eventually
 * yields (a connection nobody is holding any more). Without it, a connect that
 * times out would leak the socket it later opens.
 */
export async function withDeadline<T>(
  op: string,
  ms: number,
  work: Promise<T>,
  onAbandoned?: (value: T) => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let expired = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new ImapTimeoutError(op, ms));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  // The loser must never surface as an unhandled rejection.
  work.then(
    (value) => {
      if (expired && onAbandoned) onAbandoned(value);
    },
    () => {},
  );
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A positive integer from the environment, or the default. */
function envInt(env: EnvLike, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** `triage:<message row id>` — stable for the life of the row. */
export function triageDedupKey(messageRowId: string): string {
  return `triage:${messageRowId}`;
}

export interface InboxPollOptions {
  /** How an IMAP client is made. Injected so tests never open a socket. */
  connect: ImapClientFactory;
  /** Where the named secret is read from. Never read ambiently. */
  env?: EnvLike;
  mailbox?: string;
  limit?: number;
  agentId?: string;
  /** Deadline per IMAP call, ms. Overrides `EMAIL_POLL_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Newest-N to bring along on first contact. Overrides `EMAIL_BACKFILL`. */
  backfill?: number;
}

/**
 * One message that has landed but whose triage run has not been created yet.
 *
 * It carries the header the gate reads as well as the prompt, because the gate
 * runs *here*, between the commit and the enqueue, and re-reading the row to
 * find out who sent it would be a second query for something we already had.
 */
interface PendingTriage {
  id: string;
  /** The conversation it landed in. Null only for a row from before threads. */
  threadId: string | null;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string | null;
  hasAttachments: boolean;
  attachments: Parameters<typeof triagePrompt>[0]['attachments'];
  bodyText: string;
  threadKey: string | null;
  listId: string | null;
}

/**
 * The folder row for `(account, name)`, created on first sight.
 *
 * `kind` and `synced` are written on insert and *refreshed* on conflict, so a
 * later discovery can promote a folder that was already there — the INBOX row
 * every installation has predates discovery entirely. A Sent boundary from
 * LIST/STATUS fills an uninitialised cursor but never replaces one already in
 * use.
 */
async function ensureFolder(
  db: Pool,
  account: AccountRecord,
  name: string,
  kind: 'inbox' | 'sent' | 'other' = 'other',
  synced = false,
  boundary?: { uidValidity: number; lastUid: number },
): Promise<FolderRecord> {
  const { rows } = await db.query(
    `insert into email.folders (account_id, name, kind, synced, uidvalidity, last_uid)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (account_id, name) do update
        set kind = excluded.kind,
            synced = excluded.synced,
            uidvalidity = case
              when email.folders.uidvalidity is null and excluded.kind = 'sent'
                then excluded.uidvalidity
              else email.folders.uidvalidity
            end,
            last_uid = case
              when email.folders.uidvalidity is null and excluded.kind = 'sent'
                then excluded.last_uid
              else email.folders.last_uid
            end
     returning ${FOLDER_COLUMNS}`,
    [account.id, name, kind, synced, boundary?.uidValidity ?? null, boundary?.lastUid ?? 0],
  );
  const row = rows[0];
  if (!row) throw new Error('email.inbox-poll: folder upsert returned no row');
  return toFolder(row);
}

/** The folders of one account, as they stand. */
async function foldersOf(db: Pool, accountId: string): Promise<FolderRecord[]> {
  const { rows } = await db.query(
    `select ${FOLDER_COLUMNS} from email.folders where account_id = $1 order by kind, name`,
    [accountId],
  );
  return rows.map(toFolder);
}

/**
 * Find out what folders this account has, once — and *record* that it is done.
 *
 * Once per account, not once per poll: a LIST is cheap but it is not free, and
 * the folders of a mailbox do not move. The trigger is
 * `accounts.folders_discovered_at` (migration 008), which is the fact itself
 * rather than a proxy for it. The shape of the `folders` table used to be the
 * proxy — "more than one row means this account has been listed" — and it read
 * the wrong thing: an account whose INBOX row was written while the *Sent*
 * insert failed has two rows the moment any other folder is recorded, so it
 * looked discovered forever and never got the Sent row. Its threads would then
 * never hear the owner's side, silently, for good.
 *
 * So the stamp is written only when every folder the plan named was persisted,
 * Sent included. A pass that lost one of them leaves it null and the next poll
 * tries again; INBOX is polled either way, which is why a Sent insert that
 * fails is logged and walked past rather than thrown.
 *
 * A server with no Sent folder is a running state, not a failure: the inbox is
 * polled as it always was, thread state simply never hears the owner's side.
 * It also leaves the stamp null, deliberately — one LIST per poll is the price
 * of ever noticing a Sent folder the owner creates later.
 *
 * Whatever the server returns is written down; exactly two rows are marked
 * synced, INBOX and Sent (`folders.ts` decides which one that is).
 */
async function discoverFolders(
  db: Pool,
  account: AccountRecord,
  client: ImapClient,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<FolderRecord[]> {
  if (account.foldersDiscoveredAt !== null) return foldersOf(db, account.id);

  const listing = await withDeadline('list', timeoutMs, client.listMailboxes());
  const plan = planFolders(listing);
  // Whatever the server said, the inbox is polled. A LIST that omits INBOX
  // (some servers do, under some namespaces) must not switch ingest off.
  if (!plan.some((f) => f.kind === 'inbox')) {
    plan.unshift({ name: INBOX, kind: 'inbox', synced: true });
  }
  let lost = 0;
  let sentPersisted = false;
  for (const folder of plan) {
    const listed = listing.find((candidate) => candidate.name === folder.name);
    const boundary = folder.kind === 'sent' && listed?.status
      ? {
          uidValidity: listed.status.uidValidity,
          lastUid: Math.max(0, listed.status.uidNext - 1),
        }
      : undefined;
    try {
      await ensureFolder(db, account, folder.name, folder.kind, folder.synced, boundary);
      if (folder.kind === 'sent') sentPersisted = true;
    } catch (err) {
      if (folder.kind === 'inbox') throw err;
      lost += 1;
      log(
        `email.inbox-poll: could not record discovered folder ${account.address}/${folder.name}: ` +
          `${err instanceof Error ? err.message : String(err)}; continuing with INBOX`,
      );
    }
  }
  const sent = plan.find((f) => f.kind === 'sent');
  // Discovery is complete only when the whole plan landed *and* it included a
  // Sent folder. Anything less stays null: the next poll lists again, which is
  // how a Sent row lost to a transient error — or a Sent folder the owner
  // creates after buddi first looked — is ever picked up.
  const complete = lost === 0 && sentPersisted;
  if (complete) {
    try {
      await db.query(`update email.accounts set folders_discovered_at = now() where id = $1`, [
        account.id,
      ]);
    } catch (err) {
      // The folders are recorded; only the stamp is missing, so the next poll
      // repeats a listing it has already written down. Harmless, and said out
      // loud rather than retried in a loop nobody is watching.
      log(
        `email.inbox-poll: could not record discovery for ${account.address}: ` +
          `${err instanceof Error ? err.message : String(err)}; it will be listed again next poll`,
      );
    }
  }
  log(
    `email.inbox-poll: ${account.address} has ${plan.length} folder(s); ` +
      (sent ? `Sent is ${sent.name}` : 'no Sent folder was found, so only the inbox is synced') +
      (complete ? '' : '; discovery is incomplete and will be retried next poll'),
  );
  return foldersOf(db, account.id);
}

/**
 * Insert what was fetched, thread it, and move the cursor, in one transaction.
 *
 * Returns the rows that are actually new **and worth waking somebody about**.
 * `on conflict do nothing` makes a re-fetch after a crash idempotent: the same
 * uid lands once, and a message already stored produces no second triage run.
 *
 * Two things happen here that did not before.
 *
 *  - **Every message joins a thread**, in the same transaction as its own row.
 *    A message stored without its thread would be a conversation that silently
 *    lost a turn, and the thread's state is what the watchers and the triage
 *    prompt are about to be built on.
 *  - **The owner's own mail is stamped as it lands.** A message from the Sent
 *    folder is `direction: out`: it never faces the gate and never starts a
 *    run — buddi does not triage what the owner just wrote — so
 *    `triage_enqueued_at` is set in the insert itself rather than left for a
 *    drain that must never pick it up.
 */
async function commitBatch(
  db: Pool,
  account: AccountRecord,
  folder: FolderRecord,
  uidValidity: number,
  fetched: ReturnType<typeof prepareForIngest>[],
  direction: MessageDirection,
  now: Date,
): Promise<PendingTriage[]> {
  const client: PoolClient = await db.connect();
  const pending: PendingTriage[] = [];
  try {
    await client.query('begin');
    for (const message of fetched) {
      const { rows } = await client.query(
        `insert into email.messages
           (account_id, folder_id, uidvalidity, uid, message_id, thread_key, list_id, from_addr,
            to_addrs, cc, subject, date, internal_date, snippet, body_text, has_attachments,
            attachments, flags, direction, triage_enqueued_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15,
                 $16, $17::jsonb, $18::jsonb, $19, $20)
         on conflict (account_id, folder_id, uidvalidity, uid) do nothing
         returning id`,
        [
          account.id,
          folder.id,
          uidValidity,
          message.uid,
          message.messageId,
          message.threadKey,
          message.listId,
          message.from,
          JSON.stringify(message.to),
          JSON.stringify(message.cc),
          message.subject,
          message.date,
          message.internalDate,
          message.snippet,
          message.bodyText,
          message.hasAttachments,
          JSON.stringify(message.attachments),
          JSON.stringify(message.flags),
          direction,
          // Sent mail is nobody's to triage; it is stamped as it lands.
          direction === 'out' ? now : null,
        ],
      );
      const id = rows[0]?.id;
      if (!id) continue;
      const messageRowId = String(id);
      const thread = await joinThread(client, {
        accountId: account.id,
        threadKey: message.threadKey,
        messageRowId,
        subject: message.subject,
        participants: [message.from, ...message.to, ...message.cc],
        // The ordering clock: INTERNALDATE, `now` (this poll's clock, which
        // is what `fetched_at` would carry) when the server gave none. Never
        // `message.date` — see threads.ts.
        at: message.internalDate ?? now,
        folderId: folder.id,
        uidValidity,
        uid: message.uid,
        direction,
      });
      if (direction === 'out') continue;
      pending.push({
        id: messageRowId,
        threadId: thread.id,
        from: message.from,
        to: message.to,
        cc: message.cc,
        subject: message.subject,
        date: message.date ? message.date.toISOString() : null,
        hasAttachments: message.hasAttachments,
        attachments: message.attachments,
        bodyText: message.bodyText,
        threadKey: message.threadKey,
        listId: message.listId,
      });
    }

    const highest = fetched.reduce((max, m) => Math.max(max, m.uid), folder.lastUid);
    await client.query(
      `update email.folders set uidvalidity = $2, last_uid = $3 where id = $1`,
      [folder.id, uidValidity, highest],
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return pending;
}

/**
 * Messages that landed but whose triage run was never created.
 *
 * Inbound only: the owner's own mail is stamped as it lands and has no run to
 * recover, and a `direction` filter here says that in the query rather than
 * relying on the stamp having been written.
 */
async function unstamped(db: Pool, accountId: string, limit: number): Promise<PendingTriage[]> {
  const { rows } = await db.query(
    `select id, thread_id, from_addr, to_addrs, cc, subject, date, has_attachments, attachments,
            body_text, thread_key, list_id
       from email.messages
      where account_id = $1 and triage_enqueued_at is null and direction = 'in'
      order by fetched_at asc, uid asc
      limit $2`,
    [accountId, limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    threadId: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
    from: row.from_addr,
    to: Array.isArray(row.to_addrs) ? row.to_addrs : [],
    cc: Array.isArray(row.cc) ? row.cc : [],
    subject: row.subject ?? '',
    date: row.date instanceof Date ? row.date.toISOString() : (row.date ?? null),
    hasAttachments: Boolean(row.has_attachments),
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    bodyText: row.body_text ?? '',
    threadKey: row.thread_key ?? null,
    listId: row.list_id ?? null,
  }));
}

/**
 * Build the source. The IMAP factory is a parameter, not a default, so the
 * whole ingest path is exercised against a fake in tests.
 */
export function createInboxPollSource(opts: InboxPollOptions): Source {
  const onlyFolder = opts.mailbox;
  const limit = Math.min(Math.max(1, opts.limit ?? MAX_PER_POLL), MAX_PER_POLL);
  const agentId = opts.agentId ?? TRIAGE_AGENT_ID;

  return {
    id: 'email.inbox-poll',
    description: onlyFolder
      ? `Poll ${onlyFolder} for new mail and start a triage run for each new message.`
      : 'Poll the inbox and the Sent folder of every account: start a triage run for each new message, and keep each thread\'s state.',
    every: POLL_EVERY_SECONDS,

    async poll(ctx: SourceContext): Promise<void> {
      const log = ctx.log ?? ((line: string) => console.error(line));
      const env = opts.env ?? process.env;

      // Accounts are plural (docs/specs/email.md §2). Every enabled one is polled in
      // this pass, each with its own folders and its own cursor per folder. No
      // mailbox configured is still a valid, running state rather than a
      // failure: the loop has nothing to walk.
      //
      // One account's failure must not cost the others their poll: a timeout on
      // a mailbox that stopped answering is collected and rethrown after every
      // other account has had its turn, so `runSources` still records it in
      // `core.source_runs.last_error` and the rest of the mail still lands.
      const failures: unknown[] = [];
      for (const account of await listAccounts(ctx.db)) {
        const auth = resolveAuth(account, env);
        if (!auth.ok) {
          // A typed configuration problem: say it once per poll and stop. An
          // unattended run that needs a secret fails with a problem; it never
          // hangs and never falls back to asking.
          log(`email.inbox-poll: ${auth.problem.code}: ${auth.problem.message}`);
          continue;
        }

        const timeoutMs = Math.max(1, opts.timeoutMs ?? envInt(env, POLL_TIMEOUT_VAR, DEFAULT_POLL_TIMEOUT_MS));
        const backfill = Math.max(0, opts.backfill ?? envInt(env, BACKFILL_VAR, DEFAULT_BACKFILL));

        // The connection is opened for this poll and closed at the end of it,
        // always. A long-lived IMAP session is a socket that silently dies while
        // nobody is looking; one per poll is cheap (half a second) and honest.
        // Both folders are walked over the same connection.
        let client: ImapClient | null = null;
        const pending: PendingTriage[] = [];
        try {
          client = await withDeadline(
            'connect',
            timeoutMs,
            opts.connect(account, auth.value),
            // We gave up waiting, but the connection may still arrive: close it
            // rather than leave a socket nobody owns.
            (late) => void late.close().catch(() => {}),
          );

          // Which folders this account has, discovered once and remembered.
          // A caller that named one folder gets that folder and no listing:
          // the CLI and the tests both drive a single mailbox on purpose.
          const folders = onlyFolder
            ? [await ensureFolder(ctx.db, account, onlyFolder, 'inbox', true)]
            : (await discoverFolders(ctx.db, account, client, timeoutMs, log)).filter((f) => f.synced);

          // New discovery persists Sent's LIST/STATUS boundary above. This
          // loop is for an older or partially initialised row that still has
          // no generation: try to plant it before INBOX work, but isolate a
          // failed SELECT or cursor write so incoming mail still lands.
          const attemptedSent = new Set<string>();
          for (const folder of folders.filter((f) => f.kind === 'sent' && f.uidValidity === null)) {
            attemptedSent.add(folder.id);
            try {
              await pollFolder(ctx, account, client, folder, { timeoutMs, backfill, limit, log });
            } catch (err) {
              log(
                `email.inbox-poll: could not initialize Sent folder ${account.address}/${folder.name}: ` +
                  `${err instanceof Error ? err.message : String(err)}; continuing with INBOX`,
              );
              failures.push(err);
            }
          }

          // The inbox first: it is the one that wakes anybody, and a Sent
          // folder that times out must not cost the new mail its run.
          for (const folder of [...folders].filter((f) => !attemptedSent.has(f.id)).sort((a, b) => (a.kind === 'inbox' ? -1 : b.kind === 'inbox' ? 1 : 0))) {
            try {
              pending.push(
                ...(await pollFolder(ctx, account, client, folder, {
                  timeoutMs,
                  backfill,
                  limit,
                  log,
                })),
              );
            } catch (err) {
              if (folder.kind !== 'sent') throw err;
              log(
                `email.inbox-poll: could not poll Sent folder ${account.address}/${folder.name}: ` +
                  `${err instanceof Error ? err.message : String(err)}; INBOX was still polled`,
              );
              failures.push(err);
            }
          }
        } catch (err) {
          if (err instanceof ImapTimeoutError) {
            // A recorded give-up. Rethrowing it at the end of the pass is
            // deliberate: `runSources` writes it to
            // core.source_runs.last_error and emits `source.polled` with it,
            // so a mailbox that stopped answering is visible rather than silent.
            log(
              `email.inbox-poll: ${err.message} on ${account.address}; ` +
                `connection closed, retrying next poll`,
            );
          }
          failures.push(err);
          // Whatever did land before the failure is still drained below: a
          // Sent folder that timed out is no reason to sit on the inbox.
        } finally {
          await client?.close().catch(() => {});
        }

        try {
          await drain(ctx, account, agentId, limit, pending);
        } catch (err) {
          failures.push(err);
        }
      }

      if (failures.length > 0) throw failures[0];
    },
  };
}

/**
 * One folder of one account: open it, honour its generation, fetch what is new,
 * and commit the rows with the cursor.
 *
 * The cursor logic is per folder and is exactly what it was for the inbox —
 * UIDVALIDITY is a property of a mailbox, and Sent has its own. What the folder
 * *is* decides one thing only, and it is the important one: mail found in Sent
 * is the owner's own (`direction: out`), so it never faces the gate, never
 * starts a run, and leaves its thread waiting on the other party.
 */
async function pollFolder(
  ctx: SourceContext,
  account: AccountRecord,
  client: ImapClient,
  folder: FolderRecord,
  opts: { timeoutMs: number; backfill: number; limit: number; log: (line: string) => void },
): Promise<PendingTriage[]> {
  const { timeoutMs, backfill, limit, log } = opts;
  const name = folder.name;
  const direction: MessageDirection = folder.kind === 'sent' ? 'out' : 'in';
  let current = folder;

  const status = await withDeadline('select', timeoutMs, client.open(name));

  const changed = current.uidValidity !== null && current.uidValidity !== status.uidValidity;
  if (changed) {
    // Every uid we stored belongs to a generation that no longer exists.
    log(
      `email.inbox-poll: UIDVALIDITY changed on ${account.address}/${name} ` +
        `(${current.uidValidity} -> ${status.uidValidity}); re-planting the cursor`,
    );
  }

  if (current.uidValidity === null || changed) {
    // First contact with this generation. "No cursor" means *start now*, not
    // "read the whole mailbox": a real INBOX is six figures of mail and walking
    // it from UID 1 is how a poll becomes a hang. The cursor is planted at
    // UIDNEXT-1 (minus the requested backfill) and the generation is persisted
    // on the spot, so a crash before the first real fetch still leaves a folder
    // that starts from now.
    //
    // `EMAIL_BACKFILL` is an inbox setting. Sent is discovered later than most
    // installations' first boot — an account upgrading with years of inbox
    // history and a large `EMAIL_BACKFILL` must not have that same depth
    // applied to Sent the day it is first found: Sent's cursor always plants
    // at UIDNEXT-1 exactly, so only mail sent from here on is ever pulled from
    // it, regardless of what the inbox's backfill is set to.
    const effectiveBackfill = folder.kind === 'sent' ? 0 : backfill;
    const startUid = Math.max(0, status.uidNext - 1 - effectiveBackfill);
    current = await plantCursor(ctx.db, current.id, status.uidValidity, startUid);
    log(
      `email.inbox-poll: initial sync on ${account.address}/${name} — ` +
        `uidvalidity ${status.uidValidity}, uidnext ${status.uidNext}, ` +
        `${status.exists} message(s) in the folder; cursor planted at ${startUid}` +
        (effectiveBackfill > 0 ? ` (backfilling the newest ${effectiveBackfill})` : ' (no history fetched)'),
    );
    // Nothing to backfill: skip the fetch entirely. The next poll picks up
    // whatever arrives after UIDNEXT-1, which is exactly "new mail".
    if (effectiveBackfill === 0) return [];
  }

  const fetched = await withDeadline('fetch', timeoutMs, client.fetchSince(name, current.lastUid, limit));
  const pending = await commitBatch(
    ctx.db,
    account,
    current,
    status.uidValidity,
    fetched.map((m) => prepareForIngest(m, ctx.now())),
    direction,
    ctx.now(),
  );
  if (direction === 'out' && fetched.length > 0) {
    log(
      `email.inbox-poll: ${fetched.length} message(s) the owner sent on ` +
        `${account.address}/${name}; threads updated, no run started`,
    );
  } else if (pending.length > 0) {
    log(`email.inbox-poll: ${pending.length} new message(s) on ${account.address}/${name}`);
  }
  return pending;
}

/** Persist the generation and the cursor together, and return the fresh row. */
async function plantCursor(
  db: Pool,
  folderId: string,
  uidValidity: number,
  lastUid: number,
): Promise<FolderRecord> {
  const { rows } = await db.query(
    `update email.folders set uidvalidity = $2, last_uid = $3
      where id = $1 returning ${FOLDER_COLUMNS}`,
    [folderId, uidValidity, lastUid],
  );
  const row = rows[0];
  if (!row) throw new Error('email.inbox-poll: cursor update returned no row');
  return toFolder(row);
}

/**
 * The gate, and then the queue.
 *
 * docs/specs/email.md §5. Every message that landed is put in front of the policy
 * table *before* anybody is woken, and what the gate decided is written to
 * `email.events` — every decision, including "nothing matched", because the
 * owner auditing the silence needs to be able to tell a message that was
 * ignored on purpose from one that was never seen.
 *
 * What each action does here:
 *
 *  - **`ignore`** writes the triage row from the policy itself and stops. No
 *    run, no model, no line. This is the whole point of the feature.
 *  - **`notify`** queues a run with a one-line instruction, because a source
 *    cannot reach the owner. `SourceContext` is `db`, `now`, `timezone`, `log`
 *    and `enqueueRun`, and `log` is operational output, not a channel — the
 *    contract says so in as many words (docs/plugins.md §2.2: *«a source
 *    notifies nobody»*). Speaking to the owner is an agent's act, so the
 *    honest implementation of "send the Telegram line" today is a run whose
 *    instruction is to send exactly that line and nothing else. It costs a
 *    model call, which `ignore` does not: the saving this action makes is in
 *    what the owner has to read, not in what buddi has to run.
 *  - **`hand-to-agent`** queues the run for the named agent instead.
 *  - **`draft`** queues the triage agent with the drafting instruction.
 *  - **`wake`** is the ordinary run, said out loud.
 *  - **`archive` / `label`** cannot happen: they are refused at creation, and
 *    a row carrying one falls through to an ordinary run with the refusal
 *    recorded, rather than dropping the message.
 *
 * Runs outside the IMAP connection on purpose: the socket is already closed by
 * the time we get here.
 */
async function drain(
  ctx: SourceContext,
  account: AccountRecord,
  agentId: string,
  limit: number,
  pending: PendingTriage[],
): Promise<void> {
  const recovered = await unstamped(ctx.db, account.id, limit);
  const byId = new Map(recovered.map((p) => [p.id, p]));
  for (const p of pending) byId.set(p.id, p);
  if (byId.size === 0) return;

  // One read of the policy table per poll, not per message.
  const policies = await loadPolicies(ctx.db, account.id);

  for (const message of byId.values()) {
    const decision = applyPolicies(
      {
        // The thread's own id, not the key off the wire: see `gate.ts`.
        threadId: message.threadId,
        from: message.from,
        listId: message.listId,
        accountId: account.id,
      },
      policies,
    );
    const action = decision.refused ? 'refused' : decision.action;

    if (!decision.refused && decision.action === 'ignore' && decision.policy) {
      // Everything this claims happens here, or none of it does: the triage
      // row, the event that says the message was ignored, and the stamp that
      // stops the next poll picking it up. A committed "ignored" beside a
      // missing triage row would be the audit log lying about the one action
      // that produces silence.
      await inOneTransaction(ctx.db, async (tx) => {
        await ignoreByPolicy(tx, message, decision.policy as PolicyRecord, ctx.now());
        await recordEvent(
          tx,
          {
            messageId: message.id,
            policyId: decision.policy?.id ?? null,
            action,
            detail: decision.detail,
            status: 'done',
          },
          ctx.now(),
        );
        await stampOn(tx, message.id, ctx.now());
      });
      (ctx.log ?? (() => {}))(
        `email.inbox-poll: ${message.from} handled by policy ${decision.policy.scope} ` +
          `${decision.policy.matcher} (ignore); no run started`,
      );
      continue;
    }

    // The enqueue is the gateway's and cannot join a transaction here, so the
    // event is written `pending` first, and only becomes `done` once the run
    // exists. A throw leaves `failed` and an unstamped message: the next poll
    // tries again and updates this same row rather than adding another.
    await recordEvent(
      ctx.db,
      {
        messageId: message.id,
        policyId: decision.policy?.id ?? null,
        action,
        detail: decision.detail,
        status: 'pending',
      },
      ctx.now(),
    );
    try {
      await ctx.enqueueRun({
        agentId: runAgentFor(decision, agentId),
        prompt: await promptFor(ctx, account, message, decision, policies),
        dedupKey: triageDedupKey(message.id),
      });
    } catch (err) {
      await settleEvent(
        ctx.db,
        message.id,
        'failed',
        `${decision.detail} The run could not be queued: ${
          err instanceof Error ? err.message : String(err)
        } — the message stays pending and the next poll tries again.`,
      );
      throw err;
    }
    await settleEvent(ctx.db, message.id, 'done');
    await stamp(ctx, message.id);
  }
}

/**
 * Run one unit of work in a transaction of its own.
 *
 * The pool is the source's, not a client, so the client is taken and given
 * back here rather than held across the poll: a connection kept open for the
 * length of a drain is a connection the rest of the installation cannot use.
 */
async function inOneTransaction(
  pool: Pool,
  work: (tx: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await work(client);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Who runs: the named agent for `hand-to-agent`, the triage agent otherwise. */
function runAgentFor(decision: GateDecision, fallback: string): string {
  if (decision.action === 'hand-to-agent' && !decision.refused) {
    return decision.policy?.params.agentId?.trim() || fallback;
  }
  return fallback;
}

/**
 * The prompt, with what was decided about this sender before.
 *
 * docs/specs/email.md §1's complaint was that a run *«judges it from zero, records a
 * verdict nothing reads back»*. The verdicts are read back here, along with the
 * sender's policy when there is one, so the run can be consistent with what was
 * decided rather than starting the argument again every week.
 */
async function promptFor(
  ctx: SourceContext,
  account: AccountRecord,
  message: PendingTriage,
  decision: GateDecision,
  policies: readonly PolicyRecord[],
): Promise<string> {
  // This account's history and nobody else's: what a sender did in another
  // mailbox is not evidence about this one, and a run told otherwise would
  // carry verdicts about mail that never arrived here.
  const verdicts = await senderVerdicts(ctx.db, account.id, message.from, 5);
  const replies = await ownerReplies(ctx.db, account.id, message.from);
  const senderPolicy =
    decision.policy ??
    policies.find(
      (p) => p.scope === 'sender' && p.matcher === message.from.trim().toLowerCase(),
    ) ??
    null;
  return triagePrompt({
    messageId: message.id,
    from: message.from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    date: message.date,
    hasAttachments: message.hasAttachments,
    attachments: message.attachments,
    bodyText: message.bodyText,
    ...(message.threadId ? { thread: await threadFor(ctx, message) } : {}),
    history: {
      policy: senderPolicy
        ? {
            action: senderPolicy.action,
            scope: senderPolicy.scope,
            matcher: senderPolicy.matcher,
            origin: senderPolicy.origin,
            proposed: senderPolicy.proposed,
          }
        : null,
      replies,
      verdicts: verdicts.map((v) => ({
        category: v.category,
        urgency: v.urgency,
        decidedAt: v.decidedAt,
      })),
    },
    ...(instructionFor(decision) ? { instruction: instructionFor(decision) as string } : {}),
  });
}

/** How many earlier turns of the thread are quoted, and how many are a line. */
export const THREAD_TURNS_QUOTED = 3;
export const THREAD_TURNS_LISTED = 10;

/**
 * The conversation, bounded, as docs/specs/email.md §6 asks for it: the last few
 * messages quoted, everything before them one line each, and the state.
 *
 * The message being triaged is left out of the block — it is the prompt's
 * subject and is already there in full, and printing it twice would only teach
 * the run that the newest message is the important one.
 */
async function threadFor(ctx: SourceContext, message: PendingTriage): Promise<ThreadForPrompt> {
  const threadId = message.threadId as string;
  const thread = await findThread(ctx.db, threadId);
  const turns = (await threadMessages(ctx.db, threadId, THREAD_TURNS_QUOTED + THREAD_TURNS_LISTED))
    .filter((m) => m.id !== message.id);
  const quoted = turns.slice(-THREAD_TURNS_QUOTED);
  const listed = turns.slice(0, Math.max(0, turns.length - quoted.length));
  return {
    id: threadId,
    state: thread?.state ?? 'waiting-on-me',
    messageCount: thread?.messageCount ?? turns.length + 1,
    recent: quoted.map((m) => ({
      direction: m.direction,
      from: m.from,
      date: m.date,
      subject: m.subject,
      snippet: m.snippet,
      bodyText: m.bodyText,
    })),
    older: listed.map((m) => ({
      direction: m.direction,
      from: m.from,
      date: m.date,
      subject: m.subject,
      snippet: m.snippet,
    })),
  };
}

/** The standing instruction a policy adds to the run, or undefined. */
function instructionFor(decision: GateDecision): string | undefined {
  if (decision.refused || !decision.policy) return undefined;
  const params = decision.policy.params;
  switch (decision.action) {
    case 'draft':
      return (
        params.instruction?.trim() ||
        'draft a reply to this message with email.draft_reply, and do not send it'
      );
    case 'notify':
      return (
        `send the owner one line about this message — ${params.note?.trim() || 'what it is and who it is from'} — ` +
        'and nothing else; no draft, no report'
      );
    case 'hand-to-agent':
      return 'this message was handed to you by a standing policy of the owner\'s';
    default:
      return undefined;
  }
}

/**
 * An ignored message still gets a triage row — written from the policy, not by
 * a model. "No run happened" must not read as "nothing is known about this
 * message": the list view, the sender profile and every later count all read
 * the triage table, and a hole in it would look like a bug.
 */
async function ignoreByPolicy(
  db: Pool | PoolClient,
  message: PendingTriage,
  policy: PolicyRecord,
  now: Date,
): Promise<void> {
  await db.query(
    `insert into email.triage
       (message_id, processing_version, category, urgency, summary, action_needed, decided_at)
     values ($1, $2, $3, $4, $5, null, $6)
     on conflict (message_id, processing_version) do nothing`,
    [
      message.id,
      PROCESSING_VERSION,
      policy.params.category ?? 'promo',
      policy.params.urgency ?? 'low',
      `Handled by a standing policy (${policy.scope} ${policy.matcher}): ignored without a triage run.`,
      now,
    ],
  );
}

/** The enqueue stamp, written last. See the module comment. */
async function stamp(ctx: SourceContext, messageId: string): Promise<void> {
  await stampOn(ctx.db, messageId, ctx.now());
}

/** The same stamp, on a handle the caller chose — a transaction, usually. */
async function stampOn(db: Pool | PoolClient, messageId: string, now: Date): Promise<void> {
  await db.query(
    `update email.messages set triage_enqueued_at = $2
      where id = $1 and triage_enqueued_at is null`,
    [messageId, now],
  );
}
