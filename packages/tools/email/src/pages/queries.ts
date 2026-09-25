/**
 * What the mail pages read (`docs/plugin-pages.md` §3, `email.md` §8–§10).
 *
 * These are the reads the Mail page and Settings → Email used to make through
 * `/api/email/*`. They are the same reads, over the same store functions, with
 * one difference that is the whole point of the port: a query is handed a pool
 * that refuses anything but a `select`, so the page's data cannot come from
 * something that also wrote. Nothing here opens a transaction, calls IMAP or
 * touches the vault; every write the pages make is a tool (`tools.ts`).
 *
 * Two smaller rules shape what a query returns:
 *
 *  - **Rows are display-ready.** A list row's title, sub and meta are drawn as
 *    text with no formatting applied, so "3 days ago", "they wrote" and the
 *    line under a rule are built here rather than in the browser. A component
 *    that does format — `stats`, `detail`, `table` — is given the raw value.
 *  - **A page asks for what is on it.** The thread query answers with the
 *    messages' snippets and the drafts, never twenty message bodies: a body
 *    arrives from `message`, when the owner opens one.
 */
import { z } from 'zod';
import { QueryRefusal, type DbArea, type PageQuery, type ProposalsArea, type ToolContext } from '@buddi/core/plugin';
import { TRIAGE_AGENT_ID } from '../sources/inbox-poll.js';
import {
  booleanFilter,
  buildSearch,
  narrows,
  toSearchRow,
  validateFilters,
  windowNote,
  type SearchFilters,
  type SearchRow,
} from '../search.js';
import { lastSyncByAccount, listAccounts } from '../config.js';
import { THREAD_STATE_LABELS, findThread, listThreadRows, threadMessages, type ThreadState } from '../threads.js';
import { listDraftsForThread } from '../drafts.js';
import {
  toDraft,
  DRAFT_COLUMNS,
  LIVE_DRAFT_STATUSES,
  type DraftRecord,
} from '../rows.js';
import { policyLists, threadChoices } from '../tools/policies.js';
import { loadWatcherSettings, DEFAULT_WATCHER_SETTINGS } from '../watchers.js';
import type { AttachmentInfo } from '../ports.js';
import { draftStatusLine, isoOf, policyLine, relative } from './format.js';

/** How many conversations the list shows before the owner narrows it. */
export const THREAD_LIST_LIMIT = 30;

/** How many messages of a conversation the page draws. The newest ones. */
export const THREAD_MESSAGE_LIMIT = 20;

/** How many hits the search field shows. The owner narrows rather than pages. */
export const SEARCH_LIMIT = 30;

const UUID = z.string().uuid();

/** Every parameter arrives as a string, because a query string is strings. */
const noParams = z.object({}).strict();
const byId = z.object({ id: UUID }).strict();

const searchParams = z
  .object({
    /*
     * Set by the search component and by nothing else. The list above the
     * search asks this same query with no parameters at all, so without it
     * "the owner pressed Search with every field empty" and "the page drew its
     * list" are the same request — and the refusal that tells the owner what
     * to do would have to be silence.
     */
    searching: z.enum(['true']).optional(),
    q: z.string().optional(),
    from: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    hasAttachments: z.string().optional(),
  })
  .strict();

/** One attachment as the page draws it: the listing, plus where it went. */
export function attachmentRows(
  messageId: string,
  raw: unknown,
): Array<{
  messageId: string;
  index: number;
  filename: string;
  detail: string;
  line: string;
  artifactId: string | null;
  held: string;
}> {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index) => {
    const a = (entry ?? {}) as AttachmentInfo;
    const size = Number(a.sizeBytes ?? 0);
    const filename = a.filename ?? 'Unnamed file';
    const detail = `${a.mime ?? 'application/octet-stream'} · ${formatBytes(size)}`;
    return {
      messageId,
      index,
      filename,
      detail,
      line: `${filename} — ${detail}`,
      artifactId: a.artifactId ?? null,
      held: a.artifactId ? 'in your files' : 'not fetched',
    };
  });
}

/** `1.2 MB`. The same steps the dashboard drew before. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * How much of a body a page is given, **in bytes**.
 *
 * The engine refuses an answer over a megabyte, so a mail with a
 * half-megabyte signature chain would otherwise come back as "the email
 * plugin could not answer message" — the one message the owner opened,
 * unreadable because it was long. Bytes rather than characters because that is
 * what the cap downstream counts: 300k characters of Japanese is 900 KB on the
 * wire and would sail past a limit written in UTF-16 units.
 */
export const MAX_BODY_BYTES = 512 * 1024;

/** The sentence a cut body ends with. Said once, so a test can name it. */
export const TRUNCATED_NOTE =
  '… this message is too long to show in full; the rest is in your mailbox.';

export function truncateBody(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_BODY_BYTES) return text;
  /*
   * Cut on a character boundary: slicing bytes can land in the middle of a
   * multi-byte character, and the owner would read a replacement glyph at the
   * end of every long message. Decoding the slice leaves that partial
   * character as U+FFFD, which is exactly what is trimmed off here.
   */
  const bytes = Buffer.from(text, 'utf8').subarray(0, MAX_BODY_BYTES);
  const whole = new TextDecoder('utf-8').decode(bytes).replace(/\uFFFD+$/, '');
  return `${whole}\n\n${TRUNCATED_NOTE}`;
}

/** A draft as the editor and the draft list read it. Never a patch: all of it. */
function draftRow(draft: DraftRecord, now: Date): Record<string, unknown> {
  const live =
    (LIVE_DRAFT_STATUSES as readonly string[]).includes(draft.status) && draft.sentActionId === null;
  // Dispatched, never confirmed: the one state where nothing may be done to it
  // until somebody has looked in the mailbox.
  const unresolved = draft.sentActionId !== null && draft.sentAt === null;
  return {
    id: draft.id,
    subject: draft.subject === '' ? '(no subject)' : draft.subject,
    rawSubject: draft.subject,
    bodyText: draft.bodyText,
    // Joined here rather than in the editor: a text field holds a line, and
    // what the owner types is parsed back by `email.save_draft`.
    toText: draft.to.join(', '),
    ccText: draft.cc.join(', '),
    bccText: draft.bcc.join(', '),
    status: draft.status,
    statusLine: draftStatusLine(draft, now),
    updatedAt: draft.updatedAt,
    live,
    unresolved,
    /*
     * Ended, and *known* to have ended — which an unresolved draft is not. The
     * page draws one sentence or the other, never both: "it is kept so you can
     * read what was proposed" under "whether it went out is genuinely unknown"
     * would be two answers to the one question the owner is asking.
     */
    notLive: !live && !unresolved,
    notLiveLine: `This draft is ${draft.status} and cannot be edited or sent. It is kept so you can read what was proposed.`,
    unresolvedLine: unresolvedLine(draft.sendError),
    sendError: draft.sendError,
  };
}

/** What a dispatch that never came back says, with the server's own words. */
export function unresolvedLine(sendError: string | null): string {
  const said = sendError ? ` The server said: ${sendError}` : '';
  return (
    'buddi handed this message to the mail server and never got an answer, so whether it went out is genuinely unknown. ' +
    'Check the mailbox — the Sent folder and the recipient — before sending anything like it again. ' +
    `Nothing here can be edited, discarded or sent until you have.${said}`
  );
}

/**
 * The conversations, and — when the search above them was used — the hits.
 *
 * One query for both because they are one screen and one answer: the list
 * asks it with no parameters, the search asks it with what was typed, and the
 * `items` half is empty until something narrows it (the same refusal the
 * search route made, from the same `validateFilters`).
 */
export function threadsQuery(): PageQuery {
  return {
    name: 'threads',
    params: searchParams,
    async produce(params, ctx: ToolContext) {
      const input = params as z.infer<typeof searchParams>;
      const now = ctx.buddi!.clock.now();
      const accounts = await listAccounts(ctx.buddi!.db, { enabledOnly: false });
      const ids = accounts.map((a) => a.id);
      /*
       * The search is read *first*, refusals and all. An installation with no
       * mailbox yet is the likeliest place for an owner to press Search with
       * an empty box, and "nothing happened" is the one answer that teaches
       * them nothing: `searchHits` raises its refusal before it needs a single
       * account id.
       */
      const hits = await searchHits(ctx, input, ids);
      if (ids.length === 0) return { threads: [], ...hits };

      const threads = await listThreadRows(ctx.buddi!.db, { accountIds: ids, limit: THREAD_LIST_LIMIT });
      const { rows } = await ctx.buddi!.db.query(
        `select distinct thread_id from email.drafts
          where thread_id = any($1::uuid[]) and status = any($2::text[])`,
        [threads.map((t) => t.id), [...LIVE_DRAFT_STATUSES]],
      );
      const withDraft = new Set(rows.map((r: { thread_id: unknown }) => String(r.thread_id)));

      /*
       * Who the conversation is *with*: the first participant who is not one
       * of the owner's own addresses. The owner is on every thread, so the
       * list naming them first says nothing.
       */
      const own = new Set(
        accounts.flatMap((account) => [account.address, ...account.aliases]).map((address) => address.toLowerCase()),
      );
      return {
        threads: threads.map((thread) => ({
          id: thread.id,
          subject: thread.subject === '' ? '(no subject)' : thread.subject,
          sender:
            thread.participants.find((address) => !own.has(address.toLowerCase())) ??
            thread.participants[0] ??
            '(nobody)',
          participants: thread.participants.join(', '),
          state: thread.state,
          // The "draft" pill sits *beside* the state, never in place of it: a
          // conversation that is waiting on the owner and has a reply written
          // for it is two facts, and the old page showed both.
          draftPill: withDraft.has(thread.id) ? 'draft' : '',
          when: relative(thread.lastAt, now),
          messageCount: thread.messageCount,
        })),
        ...hits,
      };
    },
  };
}

/** The search half of `threads`, or nothing at all when nothing narrows it. */
async function searchHits(
  ctx: ToolContext,
  input: z.infer<typeof searchParams>,
  ids: string[],
): Promise<{ items: unknown[]; count: number; window?: string }> {
  const attachments = booleanFilter('hasAttachments', input.hasAttachments);
  if (!attachments.ok) throw new QueryRefusal(attachments.message);
  const filters: SearchFilters = {
    ...(input.q && input.q.trim() !== '' ? { query: input.q.trim() } : {}),
    ...(input.from && input.from.trim() !== '' ? { from: input.from.trim() } : {}),
    ...(input.since && input.since !== '' ? { since: input.since } : {}),
    ...(input.until && input.until !== '' ? { until: input.until } : {}),
    // Only ever *with* attachments: the field is a tick ("only messages with
    // attachments"), and an unticked box is no filter rather than a search for
    // messages that have none.
    ...(attachments.value === true ? { hasAttachments: true } : {}),
  };
  if ((filters.query ?? '') === '' && !narrows(filters)) {
    // A search with nothing in it is a question the owner can fix, so it is
    // answered rather than ignored — but only when they actually searched.
    if (input.searching === 'true') {
      throw new QueryRefusal('Type something to search for, or set one of the filters.');
    }
    return { items: [], count: 0 };
  }
  const wrong = validateFilters(filters);
  /*
   * The same refusal the route answered with, from the same function, and it
   * reaches the owner: a `QueryRefusal` is answered 400 with its own sentence
   * rather than folded into "the email plugin could not answer threads".
   * A malformed filter is something the owner can read and fix.
   */
  if (wrong) throw new QueryRefusal(wrong);
  // Every refusal is behind us; with no mailbox there is simply nothing here.
  if (ids.length === 0) return { items: [], count: 0 };

  const now = ctx.buddi!.clock.now();
  const built = buildSearch(ids, filters, {
    now,
    timezone: ctx.buddi!.owner.timezone,
    limit: SEARCH_LIMIT,
  });
  const { rows } = await ctx.buddi!.db.query(built.text, built.params);
  const items = rows.map(toSearchRow).map((m: SearchRow) => ({
    id: m.id,
    threadId: m.threadId,
    subject: m.subject === '' ? '(no subject)' : m.subject,
    line: `${m.from} — ${m.snippet}`,
    who: m.direction === 'out' ? 'you wrote' : 'they wrote',
    // A pill's tone may be read from the row: the owner's own words are the
    // ones they already know about, and the old list toned them the same way.
    whoTone: m.direction === 'out' ? 'good' : 'neutral',
    when: relative(m.date, now),
    attachment: m.hasAttachments ? 'attachment' : '',
  }));
  return {
    items,
    count: items.length,
    ...(built.windowed && built.windowFrom ? { window: windowNote(built.windowFrom) } : {}),
  };
}

/**
 * One conversation: its messages' snippets, then the drafts under them.
 *
 * The drafts come back three ways because the page draws them three ways —
 * the one in the editor, the others in a list beside it, and the ended ones
 * folded away under "Older drafts".
 */
export function threadQuery(): PageQuery {
  return {
    name: 'thread',
    params: byId,
    async produce(params, ctx: ToolContext) {
      const { id } = params as { id: string };
      const now = ctx.buddi!.clock.now();
      const thread = await findThread(ctx.buddi!.db, id);
      if (!thread) throw new QueryRefusal('No conversation here has that id.');
      // Headers and snippets only: twenty bodies is a page weight nobody
      // reads, and one arrives from `message` when the owner opens it.
      const messages = await threadMessages(ctx.buddi!.db, thread.id, THREAD_MESSAGE_LIMIT);
      const drafts = await listDraftsForThread(ctx.buddi!.db, thread.id);
      const live = drafts.filter((d) =>
        (LIVE_DRAFT_STATUSES as readonly string[]).includes(d.status),
      );
      const older = drafts.filter(
        (d) => !(LIVE_DRAFT_STATUSES as readonly string[]).includes(d.status),
      );
      const latest = messages[messages.length - 1] ?? null;
      return {
        id: thread.id,
        subject: thread.subject === '' ? '(no subject)' : thread.subject,
        state: thread.state,
        stateLabel: THREAD_STATE_LABELS[thread.state as ThreadState] ?? thread.state,
        participants: thread.participants.join(', '),
        lastAt: thread.lastAt,
        messageCount: thread.messageCount,
        messages: messages.map((message) => ({
          id: message.id,
          from: message.from,
          snippet: message.snippet,
          who: message.direction === 'out' ? 'you wrote' : 'they wrote',
          when: relative(message.date, now),
          // One line, because a repeated component draws text and formats
          // nothing: who wrote it, when, and what it opens with.
          summary: [
            message.from,
            message.direction === 'out' ? 'you wrote' : 'they wrote',
            relative(message.date, now),
          ]
            .filter((part) => part !== '')
            .join(' · ') + (message.snippet ? ` — ${message.snippet}` : ''),
        })),
        latestMessageId: latest?.id ?? null,
        hasMessages: messages.length > 0,
        hasDraft: live.length > 0,
        // Every live draft: the page draws an editor per row, so each row is
        // the whole envelope rather than a line about one.
        drafts: live.map((draft) => draftRow(draft, now)),
        hasOlder: older.length > 0,
        older: older.map((draft) => ({
          id: draft.id,
          subject: draft.subject === '' ? '(no subject)' : draft.subject,
          statusLine: draftStatusLine(draft, now),
          status: draft.status,
        })),
      };
    },
  };
}

/**
 * One draft, by id — what the editor loads and saves against.
 *
 * Its own query rather than a slice of `thread`, because the editor reloads
 * *it* after a save: the answer carries the new `updated_at`, which is the
 * version the next save is made against.
 */
export function draftQuery(): PageQuery {
  return {
    name: 'draft',
    params: byId,
    async produce(params, ctx: ToolContext) {
      const { id } = params as { id: string };
      const { rows } = await ctx.buddi!.db.query(
        `select ${DRAFT_COLUMNS} from email.drafts where id = $1::uuid`,
        [id],
      );
      if (!rows[0]) throw new QueryRefusal('No draft here has that id.');
      return draftRow(toDraft(rows[0]), ctx.buddi!.clock.now());
    },
  };
}

/** One message's body, on request, with its attachments' listing. */
export function messageQuery(): PageQuery {
  return {
    name: 'message',
    params: byId,
    async produce(params, ctx: ToolContext) {
      const { id } = params as { id: string };
      const { rows } = await ctx.buddi!.db.query(
        `select m.id, m.from_addr, m.to_addrs, m.cc, m.subject, m.date, m.direction,
                m.body_text, m.body_purged_at, m.attachments
           from email.messages m
           join email.accounts a on a.id = m.account_id
          where m.id = $1::uuid`,
        [id],
      );
      const row = rows[0] as Record<string, any> | undefined;
      if (!row) throw new QueryRefusal('No message here has that id.');
      const messageId = String(row.id);
      const purged = row.body_purged_at !== null;
      const body = purged
        ? 'The body of this message has been purged under your retention setting. Its headers are kept.'
        : truncateBody(String(row.body_text ?? ''));
      return {
        id: messageId,
        from: row.from_addr,
        to: (Array.isArray(row.to_addrs) ? row.to_addrs : []).join(', '),
        cc: (Array.isArray(row.cc) ? row.cc : []).join(', '),
        subject: row.subject ?? '',
        date: isoOf(row.date),
        who: row.direction === 'out' ? 'you wrote' : 'they wrote',
        // Null once retention has purged it: the headers stay, the body does
        // not, and the page says so rather than drawing an empty message.
        bodyText: body,
        purged,
        attachments: attachmentRows(messageId, row.attachments),
      };
    },
  };
}

/** Every mailbox, disabled ones included: a row you cannot see cannot be fixed. */
export function accountsQuery(): PageQuery {
  return {
    name: 'accounts',
    params: noParams,
    async produce(_params, ctx: ToolContext) {
      const now = ctx.buddi!.clock.now();
      const accounts = await listAccounts(ctx.buddi!.db, { enabledOnly: false });
      const synced = await lastSyncByAccount(ctx.buddi!.db);
      const waiting = await triageWaitingByAccount(ctx.buddi!.db);
      return {
        /*
         * Whether new mail has anybody to triage it. `needs-agent` is what
         * the page's offer line is drawn against: a mailbox, and no agent
         * with the id the poll hands messages to.
         */
        triage: triageState(accounts.length, ctx),
        accounts: accounts.map((account) => ({
          id: account.id,
          address: account.address,
          called: account.displayName ?? '',
          // What the rule form's mailbox picker reads. Built here because a
          // descriptor draws a label, it does not compose one.
          label: account.displayName ? `${account.displayName} — ${account.address}` : account.address,
          aliases: account.aliases.join(', '),
          host: `${account.imapHost}:${account.imapPort} · ${account.smtpHost}:${account.smtpPort}`,
          // Where the password is, in words; the secret's name is the detail
          // behind it (a tooltip), never the cell. A name, never a value:
          // nothing in the email schema holds a credential.
          password: 'In the vault',
          secretName: account.secretName,
          lastSync: synced.get(account.id)
            ? relative(synced.get(account.id) ?? null, now)
            : 'no mail has arrived yet',
          /*
           * Two facts about a mailbox, not one sentence to be parsed: whether
           * buddi is reading it, and whether it came from `.env` rather than
           * from the page. Each is its own pill, and the one worth catching an
           * eye — a mailbox that is switched off — carries the tone.
           */
          state: [
            account.enabled
              ? { value: 'on', tone: 'neutral' }
              : { value: 'off', tone: 'warning' },
            ...(account.addedVia === 'env' ? [{ value: 'from .env', tone: 'neutral' }] : []),
            // The poll's own record: new mail landed with nobody to triage it.
            ...(waiting.get(account.id) ? [{ value: 'triage waiting', tone: 'warning' }] : []),
          ],
        })),
      };
    },
  };
}

/**
 * How many of this plugin's rules wait on Settings → Proposals. Zero on an
 * installation whose core has no proposals table yet.
 */
async function openEmailRuleProposals(proposals: ProposalsArea): Promise<number> {
  try {
    return await proposals.countOpen();
  } catch (error) {
    if (undefinedTable(error)) return 0;
    throw error;
  }
}

/** The applied rules, how many learned ones wait in Proposals, and what the rules have saved. */
export function policiesQuery(): PageQuery {
  return {
    name: 'policies',
    params: noParams,
    async produce(_params, ctx: ToolContext) {
      const now = ctx.buddi!.clock.now();
      /*
       * A schema that is not there is not a failure of this page.
       *
       * `42P01` is `undefined_table`: the plugin's migrations have not run on
       * this installation. The routes answered "no policies" for exactly that
       * case, and a settings section that reads as broken because a table is
       * missing sends the owner looking for a fault they do not have. Anything
       * else is a real failure and is thrown: a pool that timed out must not
       * be drawn as "no rules".
       */
      let view: Awaited<ReturnType<typeof policyLists>>;
      try {
        view = await policyLists(ctx.buddi!.db);
      } catch (error) {
        if (undefinedTable(error)) {
          return {
            applied: [],
            appliedCount: 0,
            proposedCount: 0,
            savedRuns: 0,
            unavailable: true,
          };
        }
        throw error;
      }
      const line = (policy: (typeof view.applied)[number]): Record<string, unknown> => ({
        id: policy.id,
        // The row's own Keep and Revoke send this, and the bulk actions send
        // the selection: both tools take a list, so both are the same tool.
        ids: [policy.id],
        matcher: policy.matcher,
        action: policy.action,
        sub: policyLine(policy, now),
      });
      const savedRuns = view.applied.reduce((n, p) => n + p.runsSaved, 0);
      return {
        applied: view.applied.map(line),
        appliedCount: view.applied.length,
        // Learned rules wait on the owner's Proposals inbox, not here.
        proposedCount: await openEmailRuleProposals(ctx.buddi!.proposals!),
        savedRuns,
        unavailable: false,
      };
    },
  };
}

/**
 * The conversations a `thread` rule may be about (docs/email.md §5).
 *
 * A rule about one conversation is **picked, never typed**: the database names
 * a thread by the root Message-ID of its chain, which is not something an
 * owner has or should have to find, so the form offers subjects and sends the
 * id the gate matches. Scoped to the mailbox the form has already chosen —
 * a conversation lives in exactly one of them, and offering a busy mailbox's
 * threads for a rule meant for a quiet one is how a rule ends up about the
 * wrong conversation.
 */
export function ruleThreadsQuery(): PageQuery {
  return {
    name: 'rule_threads',
    params: z.object({ mailbox: UUID.optional() }).strict(),
    async produce(params, ctx: ToolContext) {
      const { mailbox } = params as { mailbox?: string };
      const accounts = await listAccounts(ctx.buddi!.db, { enabledOnly: false });
      const named = new Map(
        accounts.map((account) => [
          account.id,
          account.displayName ? account.displayName : account.address,
        ]),
      );
      const threads = await threadChoices(ctx.buddi!.db, mailbox);
      return {
        threads: threads.map((thread) => {
          const subject = thread.subject.trim() === '' ? '(no subject)' : thread.subject.trim();
          const others = thread.participants.slice(0, 2).join(', ');
          const base = others === '' ? subject : `${subject} — ${others}`;
          const box = named.get(thread.accountId);
          // The mailbox is named even when the list is already filtered to
          // one: a label should say what it is on its own.
          return { id: thread.id, accountId: thread.accountId, label: box ? `[${box}] ${base}` : base };
        }),
      };
    },
  };
}

/** The five numbers the mail watchers read (docs/email.md §7). */
export function watcherSettingsQuery(): PageQuery {
  return {
    name: 'watcher_settings',
    params: noParams,
    async produce(_params, ctx: ToolContext) {
      try {
        return await loadWatcherSettings(ctx.buddi!.db);
      } catch (error) {
        /*
         * The same two branches the route had, and the reason for the second
         * one is the whole point: with the plugin not installed there is no
         * `email.settings` table and the defaults *are* the answer, but a pool
         * that timed out would otherwise make this page show `2 / 0.6` as
         * though the owner had read his own settings back.
         */
        if (undefinedTable(error)) return DEFAULT_WATCHER_SETTINGS;
        throw error;
      }
    },
    result: z
      .object({
        waitingDays: z.number(),
        dateConfidence: z.number(),
        promisedDays: z.number(),
        receiptConfidence: z.number(),
        nudgeDays: z.number(),
      })
      .strict(),
  };
}

/** `42P01`: the plugin's own tables are not there. Not a failure of the page. */
function undefinedTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '42P01';
}

/**
 * `ready`, `needs-agent`, or `no-mailbox`: whether mail that lands has an
 * agent to triage it. Asked of the live roster, not of the last poll, so the
 * line appears the moment a mailbox is saved and goes the moment @mail exists.
 */
export function triageState(mailboxes: number, ctx: Pick<ToolContext, 'buddi'>): 'ready' | 'needs-agent' | 'no-mailbox' {
  if (mailboxes === 0) return 'no-mailbox';
  return ctx.buddi!.owner.hasAgent(TRIAGE_AGENT_ID) ? 'ready' : 'needs-agent';
}

/** Which accounts the poll last found with mail and nobody to triage it. */
async function triageWaitingByAccount(db: Pick<DbArea, 'query'>): Promise<Map<string, boolean>> {
  try {
    const { rows } = await db.query(`select id, triage_waiting_since from email.accounts`);
    return new Map(rows.map((row: { id: unknown; triage_waiting_since: unknown }) => [String(row.id), row.triage_waiting_since !== null && row.triage_waiting_since !== undefined]));
  } catch (error) {
    // A schema that predates the column is not a failure of the page.
    if ((error as { code?: string } | null)?.code === '42703') return new Map();
    throw error;
  }
}

/**
 * What Home asks before offering @mail (`SuggestedAgent.offer.query`): wanted
 * once there is a mailbox for it to read. Whether the agent already exists is
 * the gateway's half of the question.
 */
export function triageOfferQuery(): PageQuery {
  return {
    name: 'triage_offer',
    params: noParams,
    async produce(_params, ctx: ToolContext) {
      const accounts = await listAccounts(ctx.buddi!.db, { enabledOnly: false });
      return { wanted: accounts.length > 0 };
    },
  };
}

/** Every read the two mail pages make. */
export function emailPageQueries(): PageQuery[] {
  return [
    triageOfferQuery(),
    threadsQuery(),
    threadQuery(),
    draftQuery(),
    messageQuery(),
    accountsQuery(),
    policiesQuery(),
    ruleThreadsQuery(),
    watcherSettingsQuery(),
  ];
}
