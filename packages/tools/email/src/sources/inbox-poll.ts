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
import { prepareForIngest, triagePrompt } from '../mail.js';
import { applyPolicies, type GateDecision, type PolicyRecord } from '../policies/gate.js';
import { loadPolicies, recordEvent, settleEvent } from '../policies/store.js';
import { senderVerdicts } from '../policies/learn.js';
import type { AccountRecord, ImapClient, ImapClientFactory } from '../ports.js';
import { MAILBOX_COLUMNS, toMailbox, type MailboxRecord } from '../rows.js';
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

/** The mailbox row for `(account, name)`, created on first sight. */
async function ensureMailbox(
  db: Pool,
  account: AccountRecord,
  name: string,
): Promise<MailboxRecord> {
  const { rows } = await db.query(
    `insert into email.mailboxes (account_id, name)
     values ($1, $2)
     on conflict (account_id, name) do update set name = excluded.name
     returning ${MAILBOX_COLUMNS}`,
    [account.id, name],
  );
  const row = rows[0];
  if (!row) throw new Error('email.inbox-poll: mailbox upsert returned no row');
  return toMailbox(row);
}

/**
 * Insert what was fetched and move the cursor, in one transaction.
 *
 * Returns the rows that are actually new. `on conflict do nothing` makes a
 * re-fetch after a crash idempotent: the same uid lands once, and a message
 * already stored produces no second triage run.
 */
async function commitBatch(
  db: Pool,
  account: AccountRecord,
  mailbox: MailboxRecord,
  uidValidity: number,
  fetched: ReturnType<typeof prepareForIngest>[],
): Promise<PendingTriage[]> {
  const client: PoolClient = await db.connect();
  const pending: PendingTriage[] = [];
  try {
    await client.query('begin');
    for (const message of fetched) {
      const { rows } = await client.query(
        `insert into email.messages
           (account_id, mailbox_id, uidvalidity, uid, message_id, thread_key, list_id, from_addr,
            to_addrs, cc, subject, date, snippet, body_text, has_attachments, attachments, flags)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15,
                 $16::jsonb, $17::jsonb)
         on conflict (account_id, mailbox_id, uidvalidity, uid) do nothing
         returning id`,
        [
          account.id,
          mailbox.id,
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
          message.snippet,
          message.bodyText,
          message.hasAttachments,
          JSON.stringify(message.attachments),
          JSON.stringify(message.flags),
        ],
      );
      const id = rows[0]?.id;
      if (!id) continue;
      pending.push({
        id: String(id),
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

    const highest = fetched.reduce((max, m) => Math.max(max, m.uid), mailbox.lastUid);
    await client.query(
      `update email.mailboxes set uidvalidity = $2, last_uid = $3 where id = $1`,
      [mailbox.id, uidValidity, highest],
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

/** Messages that landed but whose triage run was never created. */
async function unstamped(db: Pool, accountId: string, limit: number): Promise<PendingTriage[]> {
  const { rows } = await db.query(
    `select id, from_addr, to_addrs, cc, subject, date, has_attachments, attachments, body_text,
            thread_key, list_id
       from email.messages
      where account_id = $1 and triage_enqueued_at is null
      order by fetched_at asc, uid asc
      limit $2`,
    [accountId, limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
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
  const mailboxName = opts.mailbox ?? INBOX;
  const limit = Math.min(Math.max(1, opts.limit ?? MAX_PER_POLL), MAX_PER_POLL);
  const agentId = opts.agentId ?? TRIAGE_AGENT_ID;

  return {
    id: 'email.inbox-poll',
    description: `Poll ${mailboxName} for new mail and start a triage run for each new message.`,
    every: POLL_EVERY_SECONDS,

    async poll(ctx: SourceContext): Promise<void> {
      const log = ctx.log ?? ((line: string) => console.error(line));
      const env = opts.env ?? process.env;

      // Accounts are plural (docs/specs/email.md §2). Every enabled one is polled in
      // this pass, each with its own mailbox row and its own cursor — the
      // per-account logic below is unchanged, it simply runs once per account
      // now instead of once. No mailbox configured is still a valid, running
      // state rather than a failure: the loop has nothing to walk.
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

        let mailbox = await ensureMailbox(ctx.db, account, mailboxName);

        // The connection is opened for this poll and closed at the end of it,
        // always. A long-lived IMAP session is a socket that silently dies while
        // nobody is looking; one per poll is cheap (half a second) and honest.
        let client: ImapClient | null = null;
        let pending: PendingTriage[] = [];
        let skipFetch = false;
        try {
          client = await withDeadline(
            'connect',
            timeoutMs,
            opts.connect(account, auth.value),
            // We gave up waiting, but the connection may still arrive: close it
            // rather than leave a socket nobody owns.
            (late) => void late.close().catch(() => {}),
          );
          const status = await withDeadline('select', timeoutMs, client.open(mailboxName));

          const changed =
            mailbox.uidValidity !== null && mailbox.uidValidity !== status.uidValidity;
          if (changed) {
            // Every uid we stored belongs to a generation that no longer exists.
            log(
              `email.inbox-poll: UIDVALIDITY changed on ${account.address}/${mailboxName} ` +
                `(${mailbox.uidValidity} -> ${status.uidValidity}); re-planting the cursor`,
            );
          }

          if (mailbox.uidValidity === null || changed) {
            // First contact with this generation. "No cursor" means *start now*,
            // not "read the whole mailbox": a real INBOX is six figures of mail
            // and walking it from UID 1 is how a poll becomes a hang. The cursor
            // is planted at UIDNEXT-1 (minus the requested backfill) and the
            // generation is persisted on the spot, so a crash before the first
            // real fetch still leaves a mailbox that starts from now.
            const startUid = Math.max(0, status.uidNext - 1 - backfill);
            mailbox = await plantCursor(ctx.db, mailbox.id, status.uidValidity, startUid);
            log(
              `email.inbox-poll: initial sync on ${account.address}/${mailboxName} — ` +
                `uidvalidity ${status.uidValidity}, uidnext ${status.uidNext}, ` +
                `${status.exists} message(s) in the mailbox; cursor planted at ${startUid}` +
                (backfill > 0 ? ` (backfilling the newest ${backfill})` : ' (no history fetched)'),
            );
            // Nothing to backfill: skip the fetch entirely. The next poll picks
            // up whatever arrives after UIDNEXT-1, which is exactly "new mail".
            skipFetch = backfill === 0;
          }

          if (!skipFetch) {
            const fetched = await withDeadline(
              'fetch',
              timeoutMs,
              client.fetchSince(mailboxName, mailbox.lastUid, limit),
            );
            pending = await commitBatch(
              ctx.db,
              account,
              mailbox,
              status.uidValidity,
              fetched.map(prepareForIngest),
            );
            if (pending.length > 0) {
              log(
                `email.inbox-poll: ${pending.length} new message(s) on ${account.address}/${mailboxName}`,
              );
            }
          }
        } catch (err) {
          if (err instanceof ImapTimeoutError) {
            // A recorded give-up. Rethrowing it at the end of the pass is
            // deliberate: `runSources` writes it to
            // core.source_runs.last_error and emits `source.polled` with it,
            // so a mailbox that stopped answering is visible rather than silent.
            log(
              `email.inbox-poll: ${err.message} on ${account.address}/${mailboxName}; ` +
                `connection closed, retrying next poll`,
            );
          }
          failures.push(err);
          // Nothing landed for this account, so there is nothing to enqueue;
          // the next account still gets its poll.
          continue;
        } finally {
          await client?.close().catch(() => {});
        }

        await drain(ctx, account, agentId, limit, pending);
      }

      if (failures.length > 0) throw failures[0];
    },
  };
}

/** Persist the generation and the cursor together, and return the fresh row. */
async function plantCursor(
  db: Pool,
  mailboxId: string,
  uidValidity: number,
  lastUid: number,
): Promise<MailboxRecord> {
  const { rows } = await db.query(
    `update email.mailboxes set uidvalidity = $2, last_uid = $3
      where id = $1 returning ${MAILBOX_COLUMNS}`,
    [mailboxId, uidValidity, lastUid],
  );
  const row = rows[0];
  if (!row) throw new Error('email.inbox-poll: cursor update returned no row');
  return toMailbox(row);
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
        threadKey: message.threadKey,
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
      verdicts: verdicts.map((v) => ({
        category: v.category,
        urgency: v.urgency,
        decidedAt: v.decidedAt,
      })),
    },
    ...(instructionFor(decision) ? { instruction: instructionFor(decision) as string } : {}),
  });
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
