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
 *    changes, every stored uid for that mailbox is meaningless: the cursor goes
 *    back to 0, the change is logged, and the mailbox re-syncs from the start.
 *    Already-stored rows are kept — they are a different generation and the
 *    unique constraint keeps them apart.
 *  - **Transactional cursor advancement.** Rows and `last_uid` commit together,
 *    so a crash can re-fetch but can never skip.
 *  - **Offline contract.** Catch-up is durable by construction: IMAP keeps the
 *    messages, the cursor is where we left off, and a machine that slept a week
 *    simply walks forward 50 messages per poll until it catches up. Nothing is
 *    lost the way a Telegram update is.
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
import { currentAccount, INBOX, resolveAuth, type EnvLike } from '../config.js';
import { prepareForIngest, triagePrompt } from '../mail.js';
import type { AccountRecord, ImapClient, ImapClientFactory } from '../ports.js';
import { MAILBOX_COLUMNS, toMailbox, type MailboxRecord } from '../rows.js';
import type { Source, SourceContext } from '../types.js';

/** The agent every new message is triaged by. */
export const TRIAGE_AGENT_ID = 'mail-triage';

/** Poll period, in seconds. */
export const POLL_EVERY_SECONDS = 300;

/** Hard cap per poll. A backlog drains over several polls rather than in one gulp. */
export const MAX_PER_POLL = 50;

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
}

/** One message that has landed but whose triage run has not been created yet. */
interface PendingTriage {
  id: string;
  prompt: string;
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
           (account_id, mailbox_id, uidvalidity, uid, message_id, thread_key, from_addr,
            to_addrs, subject, date, snippet, body_text, has_attachments, attachments, flags)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb)
         on conflict (account_id, mailbox_id, uidvalidity, uid) do nothing
         returning id`,
        [
          account.id,
          mailbox.id,
          uidValidity,
          message.uid,
          message.messageId,
          message.threadKey,
          message.from,
          JSON.stringify(message.to),
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
        prompt: triagePrompt({
          messageId: String(id),
          from: message.from,
          to: message.to,
          subject: message.subject,
          date: message.date ? message.date.toISOString() : null,
          hasAttachments: message.hasAttachments,
          attachments: message.attachments,
          bodyText: message.bodyText,
        }),
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
    `select id, from_addr, to_addrs, subject, date, has_attachments, attachments, body_text
       from email.messages
      where account_id = $1 and triage_enqueued_at is null
      order by fetched_at asc, uid asc
      limit $2`,
    [accountId, limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    prompt: triagePrompt({
      messageId: String(row.id),
      from: row.from_addr,
      to: Array.isArray(row.to_addrs) ? row.to_addrs : [],
      subject: row.subject ?? '',
      date: row.date instanceof Date ? row.date.toISOString() : (row.date ?? null),
      hasAttachments: Boolean(row.has_attachments),
      attachments: Array.isArray(row.attachments) ? row.attachments : [],
      bodyText: row.body_text ?? '',
    }),
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

      const account = await currentAccount(ctx.db);
      // No mailbox configured is a valid, running state, not a failure.
      if (!account) return;

      const auth = resolveAuth(account, env);
      if (!auth.ok) {
        // A typed configuration problem: say it once per poll and stop. An
        // unattended run that needs a secret fails with a problem; it never
        // hangs and never falls back to asking.
        log(`email.inbox-poll: ${auth.problem.code}: ${auth.problem.message}`);
        return;
      }

      let mailbox = await ensureMailbox(ctx.db, account, mailboxName);

      let client: ImapClient | null = null;
      let pending: PendingTriage[] = [];
      try {
        client = await opts.connect(account, auth.value);
        const status = await client.open(mailboxName);

        if (mailbox.uidValidity !== null && mailbox.uidValidity !== status.uidValidity) {
          // Every uid we stored belongs to a generation that no longer exists.
          log(
            `email.inbox-poll: UIDVALIDITY changed on ${account.address}/${mailboxName} ` +
              `(${mailbox.uidValidity} -> ${status.uidValidity}); cursor reset, re-syncing`,
          );
          const { rows } = await ctx.db.query(
            `update email.mailboxes set uidvalidity = $2, last_uid = 0
              where id = $1 returning ${MAILBOX_COLUMNS}`,
            [mailbox.id, status.uidValidity],
          );
          mailbox = toMailbox(rows[0] as Record<string, unknown>);
        }

        const fetched = await client.fetchSince(mailboxName, mailbox.lastUid, limit);
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
      } finally {
        await client?.close().catch(() => {});
      }

      // Anything an earlier poll ingested but never enqueued comes along now.
      const recovered = await unstamped(ctx.db, account.id, limit);
      const byId = new Map(recovered.map((p) => [p.id, p]));
      for (const p of pending) byId.set(p.id, p);

      for (const message of byId.values()) {
        await ctx.enqueueRun({
          agentId,
          prompt: message.prompt,
          dedupKey: triageDedupKey(message.id),
        });
        await ctx.db.query(
          `update email.messages set triage_enqueued_at = $2
            where id = $1 and triage_enqueued_at is null`,
          [message.id, ctx.now()],
        );
      }
    },
  };
}
