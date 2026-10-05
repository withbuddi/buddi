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
import { POLL_EVERY_SECONDS, TRIAGE_AGENT_ID } from '../sources/inbox-poll.js';
import { idleLive } from '../sources/idle.js';
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
import { lastSyncedByAccount, listAccounts } from '../config.js';
import { ACCOUNT_KIND } from '../credentials.js';
import type { AccountRecord } from '../ports.js';
import { attentionReasons, findThread, listThreadRows, threadMessages } from '../threads.js';
import { attentionLine, reasonOf, viewOf, type AttentionView } from '../needs-you.js';
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
import { describeUndo, movedSince, plural, recentActions, undoRefusal, verbOf, type ActionRecord } from '../mailbox/actions.js';
import { learnedRules } from '../policies/auto.js';
import { ACTION_COLUMNS, SEEN, toAction } from '../mailbox/actions.js';

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
    /** Which conversations the list shows: every one, the ones that need a reply, or the notifications. */
    show: z.enum(['all', 'needs-reply', 'notifications']).optional(),
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
  name: string;
  size: number;
  mime: string;
  contentId: string | null;
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
      // The `message` component's own words for the same file (host API 1.30).
      name: filename,
      size: Number.isFinite(size) ? size : 0,
      mime: a.mime ?? 'application/octet-stream',
      contentId: typeof a.contentId === 'string' && a.contentId !== '' ? a.contentId : null,
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

/**
 * How much of the plain text rides along when there is an HTML body too: the
 * text is then only the fallback, and the answer must stay under the
 * engine's megabyte with both in it.
 */
export const TEXT_WITH_HTML_BYTES = 64 * 1024;

export function truncateBody(text: string, max: number = MAX_BODY_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  /*
   * Cut on a character boundary: slicing bytes can land in the middle of a
   * multi-byte character, and the owner would read a replacement glyph at the
   * end of every long message. Decoding the slice leaves that partial
   * character as U+FFFD, which is exactly what is trimmed off here.
   */
  const bytes = Buffer.from(text, 'utf8').subarray(0, max);
  const whole = new TextDecoder('utf-8').decode(bytes).replace(/\uFFFD+$/, '');
  return `${whole}\n\n${TRUNCATED_NOTE}`;
}

/** A draft as the editor and the draft list read it. Never a patch: all of it. */
function draftRow(draft: DraftRecord, now: Date, fromAddress?: string): Record<string, unknown> {
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
    /*
     * The reply as the reading pane shows it before anyone edits it: drawn
     * the way a message is (host API 1.30), from the mailbox it will leave.
     */
    preview: {
      from: { name: 'Your reply', address: fromAddress ?? draft.to[0] ?? 'you' },
      to: draft.to.map((address) => ({ address })),
      cc: draft.cc.map((address) => ({ address })),
      at: draft.updatedAt,
      text: draft.bodyText,
    },
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

      const attention =
        input.show === 'needs-reply' ? 'needs-you' : input.show === 'notifications' ? 'notification' : undefined;
      const threads = await listThreadRows(ctx.buddi!.db, {
        accountIds: ids,
        limit: THREAD_LIST_LIMIT,
        ...(attention ? { attention, now } : {}),
      });
      const reasons = await attentionReasons(ctx.buddi!.db, threads, now);
      const { rows } = await ctx.buddi!.db.query(
        `select distinct thread_id from email.drafts
          where thread_id = any($1::uuid[]) and status = any($2::text[])`,
        [threads.map((t) => t.id), [...LIVE_DRAFT_STATUSES]],
      );
      const withDraft = new Set(rows.map((r: { thread_id: unknown }) => String(r.thread_id)));
      const reading = await listReading(ctx.buddi!.db, threads.map((t) => t.id));

      /*
       * Who the conversation is *with*: the first participant who is not one
       * of the owner's own addresses. The owner is on every thread, so the
       * list naming them first says nothing.
       */
      const own = new Set(
        accounts.flatMap((account) => [account.address, ...account.aliases]).map((address) => address.toLowerCase()),
      );
      return {
        threads: threads.map((thread) => {
          const sender =
            thread.participants.find((address) => !own.has(address.toLowerCase())) ??
            thread.participants[0] ??
            '(nobody)';
          const read = reading.get(thread.id);
          return {
          id: thread.id,
          subject: thread.subject === '' ? '(no subject)' : thread.subject,
          sender,
          /*
           * The person, not the address: the display name on their latest
           * message when they gave one (host API 1.30's reading pane), the
           * address otherwise.
           */
          senderName: read?.senderName && read.senderAddress?.toLowerCase() === sender.toLowerCase() ? read.senderName : sender,
          // What the conversation last said, on one line; the owner's own words say so.
          preview: read ? (read.lastOut ? `You: ${read.snippet}` : read.snippet) : '',
          unread: read?.unread ?? false,
          // Mail Triage's word for the latest message, as a chip: "Bill", "Receipt".
          tag: read?.category && read.category !== 'other' ? tagLabel(read.category) : '',
          participants: thread.participants.join(', '),
          state: thread.state,
          /*
           * The state as the owner reads it (`needs-you.ts`): "Waiting on you"
           * only when the one rule says so. A notification and a message
           * nobody expects an answer to carry no pill at all — a word on every
           * row is how forty "Waiting on you" pills came to mean nothing.
           */
          attention: viewOf(reasons.get(thread.id) ?? reasonOf(null, thread.state)),
          pill: listPillOf(viewOf(reasons.get(thread.id) ?? reasonOf(null, thread.state))),
          // The "draft" pill sits *beside* the state, never in place of it: a
          // conversation that is waiting on the owner and has a reply written
          // for it is two facts, and the old page showed both.
          draftPill: withDraft.has(thread.id) ? 'draft' : '',
          when: relative(thread.lastAt, now),
          messageCount: thread.messageCount,
          };
        }),
        ...hits,
      };
    },
  };
}

/** Triage's categories as a chip says them. Anything else reads as itself, capitalised. */
const TAG_WORDS: Record<string, string> = {
  'reply-needed': 'Reply needed',
  'payment-failed': 'Payment failed',
  'bank-notice': 'Bank',
  'service-notice': 'Service',
  promo: 'Promotion',
};

export function tagLabel(category: string): string {
  const known = TAG_WORDS[category];
  if (known) return known;
  const words = category.replace(/-/g, ' ').trim();
  return words === '' ? '' : words[0]!.toUpperCase() + words.slice(1);
}

interface Reading {
  snippet: string;
  lastOut: boolean;
  senderName: string | null;
  senderAddress: string | null;
  unread: boolean;
  category: string | null;
}

/**
 * What the list draws beside each conversation, in one read: how its last
 * message opens, the name on the latest message they sent, whether anything
 * they sent is still unread on the server (no `\Seen`, as the flag sync last
 * saw it), and Mail Triage's latest category.
 */
async function listReading(db: Pick<DbArea, 'query'>, ids: string[]): Promise<Map<string, Reading>> {
  const out = new Map<string, Reading>();
  if (ids.length === 0) return out;
  const { rows } = await db.query(
    `select t.id,
            lm.snippet, lm.direction as last_direction,
            li.from_name, li.from_addr,
            exists (select 1 from email.messages u
                     where u.thread_id = t.id and u.direction = 'in'
                       and not (coalesce(u.flags, '[]'::jsonb) ? $2)) as unread,
            (select tr.category from email.triage tr
              where tr.message_id = li.id
              order by tr.decided_at desc, tr.processing_version desc limit 1) as category
       from email.threads t
       left join email.messages lm on lm.id = t.last_message_id
       left join lateral (
         select m.id, m.from_name, m.from_addr from email.messages m
          where m.thread_id = t.id and m.direction = 'in'
          order by coalesce(m.internal_date, m.fetched_at) desc, m.id desc limit 1
       ) li on true
      where t.id = any($1::uuid[])`,
    [ids, SEEN],
  );
  for (const row of rows as Array<Record<string, any>>) {
    out.set(String(row.id), {
      snippet: String(row.snippet ?? ''),
      lastOut: row.last_direction === 'out',
      senderName: typeof row.from_name === 'string' && row.from_name.trim() !== '' ? row.from_name.trim() : null,
      senderAddress: typeof row.from_addr === 'string' ? row.from_addr : null,
      unread: row.unread === true,
      category: typeof row.category === 'string' ? row.category : null,
    });
  }
  return out;
}

/** One address as the `message` component reads it. */
function addressRow(address: string, name?: string | null): { address: string; name?: string } {
  return name ? { address, name } : { address };
}

/**
 * The parts of a conversation's reading pane that are buddi's rather than the
 * mail's: Mail Triage's verdict on the latest message they sent, and what
 * buddi changed in the mailbox about this conversation, newest first, with
 * Undo where it still applies (the same rows and words as Recent changes).
 */
async function threadLayer(
  db: Pick<DbArea, 'query'>,
  threadId: string,
  accountAddress: string,
  now: Date,
): Promise<{ triage: Record<string, unknown> | null; changes: Array<Record<string, unknown>> }> {
  const verdict = await db.query(
    `select tr.category, tr.urgency, tr.summary, tr.action_needed, tr.decided_at
       from email.triage tr
       join lateral (
         select m.id from email.messages m
          where m.thread_id = $1::uuid and m.direction = 'in'
          order by coalesce(m.internal_date, m.fetched_at) desc, m.id desc limit 1
       ) li on li.id = tr.message_id
      order by tr.decided_at desc, tr.processing_version desc limit 1`,
    [threadId],
  );
  const v = verdict.rows[0] as Record<string, any> | undefined;
  const triage = v
    ? {
        category: String(v.category),
        tag: tagLabel(String(v.category)),
        urgency: String(v.urgency),
        // "Bill · normal — The October invoice from Studio North, €1,240. To do: pay by 14 Oct."
        line: [
          `${tagLabel(String(v.category))} · ${v.urgency === 'urgent' ? 'urgent' : v.urgency === 'low' ? 'low' : 'this week'}`,
          '—',
          String(v.summary ?? '').trim(),
          v.action_needed ? `To do: ${String(v.action_needed).trim()}` : '',
        ]
          .filter((part) => part !== '')
          .join(' '),
        when: relative(isoOf(v.decided_at), now),
      }
    : null;

  const { rows } = await db.query(
    `select ${ACTION_COLUMNS_SQL} from email.mailbox_actions a
      where a.message_ids && (select coalesce(array_agg(m.id), '{}') from email.messages m where m.thread_id = $1::uuid)
      order by a.created_at desc, a.seq desc limit $2`,
    [threadId, THREAD_CHANGES],
  );
  const changes: Array<Record<string, unknown>> = [];
  for (const c of rows.map(toAction)) {
    const undoable = undoRefusal(c) === null;
    const moved = undoable ? await movedSince(db, c) : 0;
    const who = c.origin === 'policy' ? `by ${c.actor}` : c.origin === 'owner' ? 'by you' : c.actor === TRIAGE_AGENT_ID ? 'by Mail Triage' : `by @${c.actor}`;
    changes.push({
      id: c.id,
      // The words Recent changes uses: "Mark as read · by Mail Triage · yesterday".
      line: [verbOf(c.kind, c.destination), who, relative(c.createdAt, now), c.note ?? ''].filter((p) => p !== '').join(' · '),
      state: changeState(c),
      undoable,
      undoLine: describeUndo(c, accountAddress, moved),
    });
  }
  return { triage, changes };
}

/**
 * The list's pill for a conversation: the views that are worth a word.
 * A notification and "they wrote" are the inbox's ordinary weather and say
 * nothing; the detail's State row still names them.
 */
export function listPillOf(view: AttentionView): string {
  return view === 'notification' || view === 'they-wrote' ? '' : view;
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

/** How many of buddi's changes a reading pane lists for one conversation. */
export const THREAD_CHANGES = 3;

const ACTION_COLUMNS_SQL = ACTION_COLUMNS.split(',').map((c) => `a.${c.trim()}`).join(', ');

/** The display name, the server's own arrival time and the read mark of each message, by id. */
async function messageExtras(
  db: Pick<DbArea, 'query'>,
  ids: string[],
): Promise<Map<string, { fromName: string | null; at: string | null; unread: boolean }>> {
  const out = new Map<string, { fromName: string | null; at: string | null; unread: boolean }>();
  if (ids.length === 0) return out;
  const { rows } = await db.query(
    `select id, from_name, coalesce(internal_date, fetched_at) as at, direction,
            coalesce(flags, '[]'::jsonb) ? $2 as seen
       from email.messages where id = any($1::uuid[])`,
    [ids, SEEN],
  );
  for (const row of rows as Array<Record<string, any>>) {
    out.set(String(row.id), {
      fromName: typeof row.from_name === 'string' && row.from_name.trim() !== '' ? row.from_name.trim() : null,
      at: isoOf(row.at),
      unread: row.direction === 'in' && row.seen !== true,
    });
  }
  return out;
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
      const reason = (await attentionReasons(ctx.buddi!.db, [thread], now)).get(thread.id) ?? reasonOf(null, thread.state);
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
      const accounts = await listAccounts(ctx.buddi!.db, { enabledOnly: false });
      const account = accounts.find((a) => a.id === thread.accountId);
      const layer = await threadLayer(ctx.buddi!.db, thread.id, account?.address ?? 'your mailbox', now);
      const extra = await messageExtras(ctx.buddi!.db, messages.map((m) => m.id));
      const view = viewOf(reason);
      return {
        id: thread.id,
        /*
         * buddi's layer above the thread (host API 1.30's reading pane): the
         * verdict, what was changed and Undo, and "Needs a reply" with Done.
         */
        hasTriage: layer.triage !== null,
        triage: layer.triage,
        triageLine: layer.triage ? String(layer.triage.line) : '',
        changes: layer.changes,
        hasChanges: layer.changes.length > 0,
        needsReply: view === 'needs-you',
        subject: thread.subject === '' ? '(no subject)' : thread.subject,
        state: thread.state,
        attention: viewOf(reason),
        // The state in words, with why: "They wrote — no reply expected: a no-reply sender."
        stateLabel: attentionLine(reason),
        participants: thread.participants.join(', '),
        lastAt: thread.lastAt,
        messageCount: thread.messageCount,
        messages: messages.map((message, index) => {
          const more = extra.get(message.id);
          return {
          id: message.id,
          // The header the reading pane draws before the body arrives (`message`).
          from: addressRow(message.from, more?.fromName),
          to: message.to.map((address) => addressRow(address)),
          at: more?.at ?? message.date,
          // Every message but the newest is one line until it is opened, unless the owner has not read it.
          folded: index < messages.length - 1 && !(more?.unread ?? false),
          fromAddress: message.from,
          snippet: message.snippet,
          who: message.direction === 'out' ? 'you wrote' : 'they wrote',
          when: relative(message.date, now),
          // Where it is now when that is not the inbox: archived, in Trash,
          // in a label, or no longer in the inbox (moved in another app).
          place: message.place,
          // One line, because a repeated component draws text and formats
          // nothing: who wrote it, when, where it is now, and what it opens with.
          summary: [
            message.from,
            message.direction === 'out' ? 'you wrote' : 'they wrote',
            relative(message.date, now),
            message.place,
          ]
            .filter((part) => part !== '')
            .join(' · ') + (message.snippet ? ` — ${message.snippet}` : ''),
          };
        }),
        latestMessageId: latest?.id ?? null,
        hasMessages: messages.length > 0,
        hasDraft: live.length > 0,
        // Every live draft: the page draws an editor per row, so each row is
        // the whole envelope rather than a line about one.
        drafts: live.map((draft) => draftRow(draft, now, account?.address)),
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
        `select m.id, m.from_addr, m.from_name, m.to_addrs, m.cc, m.subject, m.date, m.direction,
                m.body_text, m.body_html, m.body_purged_at, m.attachments, m.snippet,
                coalesce(m.internal_date, m.fetched_at) as at
           from email.messages m
           join email.accounts a on a.id = m.account_id
          where m.id = $1::uuid`,
        [id],
      );
      const row = rows[0] as Record<string, any> | undefined;
      if (!row) throw new QueryRefusal('No message here has that id.');
      const messageId = String(row.id);
      const purged = row.body_purged_at !== null;
      const purgedNote = 'The body of this message has been purged under your retention setting. Its headers are kept.';
      const html = !purged && typeof row.body_html === 'string' && row.body_html !== '' ? (row.body_html as string) : null;
      const text = purged ? '' : truncateBody(String(row.body_text ?? ''), html ? TEXT_WITH_HTML_BYTES : MAX_BODY_BYTES);
      const body = purged ? purgedNote : text;
      const toList: string[] = Array.isArray(row.to_addrs) ? row.to_addrs : [];
      const ccList: string[] = Array.isArray(row.cc) ? row.cc : [];
      return {
        id: messageId,
        /*
         * The `message` component's shape (host API 1.30): who, to whom,
         * when (the server's arrival time, as the thread orders by), the
         * stored HTML — sanitised at ingest, and again by the dashboard — and
         * the text it falls back to. Never anything fetched now.
         */
        from: addressRow(String(row.from_addr), typeof row.from_name === 'string' ? row.from_name : null),
        to: toList.map((address) => addressRow(address)),
        cc: ccList.map((address) => addressRow(address)),
        at: isoOf(row.at) ?? isoOf(row.date),
        html,
        text: purged ? null : text,
        snippet: row.snippet ?? '',
        note: purged ? purgedNote : null,
        toText: toList.join(', '),
        ccText: ccList.join(', '),
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

/**
 * The mailboxes whose password buddi cannot read here, by id.
 *
 * Read from what core already records, never from the vault (this plugin
 * never opens it): no owner secret of the row's name bound to this mailbox's
 * login — a restore brings the row and not the value — or the last use of it
 * for this mailbox refused or failed, which is what an unreadable value
 * leaves behind. A row the old `.env` seed left is one by definition. When
 * the secrets cannot be listed at all, nothing is claimed.
 */
async function passwordsNeeded(accounts: AccountRecord[], ctx: ToolContext): Promise<Set<string>> {
  const out = new Set<string>();
  const secrets = ctx.buddi?.secrets;
  let listed: Awaited<ReturnType<NonNullable<typeof secrets>['list']>> | null = null;
  try {
    listed = secrets ? await secrets.list() : null;
  } catch {
    listed = null;
  }
  for (const account of accounts) {
    if (account.authMode !== 'app-password') continue;
    // The provider refused the stored password at the last login (the poll
    // records it, `logins.ts`): the secret is readable, and still wrong.
    if (account.loginFailedAt) {
      out.add(account.id);
      continue;
    }
    if (account.addedVia === 'env') {
      out.add(account.id);
      continue;
    }
    if (listed === null) continue;
    const secret = listed.find((s) => s.name === account.secretName);
    const bound = secret?.bindings.some((b) => b.kind === ACCOUNT_KIND && b.target === account.id) ?? false;
    const last = secret?.lastUse;
    const broken = last != null && last.kind === ACCOUNT_KIND && (last.outcome === 'refused' || last.outcome === 'failed');
    if (!bound || broken) out.add(account.id);
  }
  return out;
}

/** Every mailbox, disabled ones included: a row you cannot see cannot be fixed. */
export function accountsQuery(): PageQuery {
  return {
    name: 'accounts',
    params: noParams,
    async produce(_params, ctx: ToolContext) {
      const now = ctx.buddi!.clock.now();
      const accounts = await listAccounts(ctx.buddi!.db, { enabledOnly: false });
      // When each mailbox last *finished* a poll: "connected, synced 3 min
      // ago" is true of a quiet mailbox too, where "when mail last landed"
      // read "no mail has arrived yet" on the day it was connected.
      const synced = await lastSyncedByAccount(ctx.buddi!.db);
      const waiting = await triageWaitingByAccount(ctx.buddi!.db);
      const needed = await passwordsNeeded(accounts, ctx);
      const { rows: storedRows } = await ctx.buddi!.db.query(
        `select a.id from email.accounts a where exists (select 1 from email.messages m where m.account_id = a.id)`,
      );
      const stored = new Set(storedRows.map((row: Record<string, unknown>) => String(row.id)));
      return {
        // A connected mailbox with nothing stored yet: the Mail page's "Read
        // the last 7 days" lands here, and the note it lands on reads this.
        anyFresh: accounts.some((account) => account.enabled && !stored.has(account.id)),
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
          password: needed.has(account.id) ? 'Password needed' : 'In the vault',
          passwordNeeded: needed.has(account.id),
          // What the provider said the last time it refused the stored
          // password at login, or null since a login worked (`logins.ts`).
          loginRefused: account.loginError ?? null,
          secretName: account.secretName,
          /*
           * How soon new mail is seen: the IDLE watcher of this process has
           * the inbox open and the server tells us ("Instant"), or the poll
           * checks on its period (no IDLE on the server, the connection is
           * down and retrying, or the password is refused).
           */
          arrival: !account.enabled
            ? '—'
            : idleLive(account.id)
              ? 'Instant'
              : `Checking every ${Math.round(POLL_EVERY_SECONDS / 60)} min`,
          lastSync: !account.enabled
            ? '—'
            : synced.get(account.id)
              ? relative(synced.get(account.id)!.toISOString(), now)
              : 'not yet',
          /*
           * Facts about a mailbox, not one sentence to be parsed: whether
           * buddi is reading it, and whether it is a mailbox `.env` used to
           * name that could not be adopted (its password was not readable at
           * start) — adding it again here is what brings it back, with its
           * mail. Each is its own pill, and the ones worth catching an eye
           * carry the tone.
           */
          state: [
            // Connected once a poll has finished with the password it has;
            // until the first one, "connecting".
            !account.enabled
              ? { value: 'off', tone: 'warning' }
              : synced.get(account.id) && !needed.has(account.id)
                ? { value: 'connected', tone: 'neutral' }
                : { value: needed.has(account.id) ? 'on' : 'connecting', tone: 'neutral' },
            // A mailbox `.env` used to name that could not be adopted is a
            // password nobody can read here: Set password brings it back.
            ...(account.addedVia === 'env' ? [{ value: 'password needed', tone: 'neutral' }] : []),
            // The poll's own record: new mail landed with nobody to triage it.
            ...(waiting.get(account.id) ? [{ value: 'triage waiting', tone: 'warning' }] : []),
          ],
        })),
      };
    },
  };
}

/**
 * The Mail page's own read: which mailboxes are connected, and which of them
 * are fresh — connected, a first poll finished, and nothing stored yet. A
 * fresh mailbox gets a first state instead of an empty list ("Connected to
 * you@example.com. Reading new mail from now on; 412 older messages left
 * alone."), because "No conversations here" on the day you connect reads as a
 * fault. Until that first poll has finished nothing is known about what was
 * left alone, so the page says "Connecting to you@example.com…" instead.
 */
export function mailStatusQuery(): PageQuery {
  return {
    name: 'mail_status',
    params: noParams,
    async produce(_params, ctx: ToolContext) {
      const accounts = await listAccounts(ctx.buddi!.db, { enabledOnly: true });
      // The conversation list reads every mailbox, a disabled one's retained
      // conversations included; whether there is mail to list asks the same.
      const everyId = (await listAccounts(ctx.buddi!.db, { enabledOnly: false })).map((account) => account.id);
      const { rows } = await ctx.buddi!.db.query(
        `select a.id,
                exists (select 1 from email.messages m where m.account_id = a.id) as stored,
                (a.last_synced_at is not null
                  or exists (select 1 from email.folders f
                              where f.account_id = a.id and f.first_contact_at is not null)) as polled,
                (select f.left_alone from email.folders f
                  where f.account_id = a.id and f.kind = 'inbox' order by f.first_contact_at nulls last limit 1) as left_alone
           from email.accounts a where a.enabled`,
      );
      const facts = new Map(rows.map((row: Record<string, unknown>) => [String(row.id), row]));
      const empty = accounts.filter((account) => facts.get(account.id)?.stored !== true);
      const fresh = empty.filter((account) => facts.get(account.id)?.polled === true);
      const connecting = empty.filter((account) => facts.get(account.id)?.polled !== true);
      const mail = everyId.length === 0
        ? { rows: [] }
        : await ctx.buddi!.db.query(
            `select exists (select 1 from email.messages where account_id = any($1::uuid[])) as has_mail`,
            [everyId],
          );
      const hasMail = (mail.rows[0] as { has_mail?: unknown } | undefined)?.has_mail === true;
      return {
        connected: accounts.length
          ? `Connected: ${accounts.map((account) => account.address).join(' · ')}`
          : '',
        hasAccounts: accounts.length > 0,
        anyFresh: fresh.length > 0,
        anyConnecting: connecting.length > 0,
        connecting: connecting.length > 0 ? connectingLine(connecting.map((account) => account.address)) : '',
        hasMail,
        // The list is drawn when there is mail to list, or nothing connected
        // at all (its empty sentence is then the honest one).
        showList: hasMail || accounts.length === 0,
        fresh: fresh.map((account) => ({
          id: account.id,
          address: account.address,
          line: freshLine(account.address, facts.get(account.id)?.left_alone),
        })),
      };
    },
  };
}

/** What the page says while a mailbox's first poll has not finished. */
export function connectingLine(addresses: string[]): string {
  const list = addresses.length <= 1
    ? (addresses[0] ?? '')
    : `${addresses.slice(0, -1).join(', ')} and ${addresses[addresses.length - 1]}`;
  return `Connecting to ${list}…`;
}

/** The first-state sentence for one fresh mailbox. */
export function freshLine(address: string, leftAlone: unknown): string {
  const older = leftAlone === null || leftAlone === undefined ? null : Number(leftAlone);
  const head = `Connected to ${address}. Reading new mail from now on`;
  if (older === null || !Number.isFinite(older)) return `${head}; older messages left alone.`;
  if (older === 0) return `${head}.`;
  return `${head}; ${older.toLocaleString('en-US')} older ${older === 1 ? 'message' : 'messages'} left alone.`;
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
/** How many changes the Mail page lists. */
export const RECENT_CHANGES = 20;

/**
 * Recent changes to the mailbox itself, for the Mail page: what was done, to
 * how many, by whom, when, and whether Undo still applies.
 */
export function mailboxChangesQuery(): PageQuery {
  return {
    name: 'mailbox_changes',
    params: noParams,
    async produce(_params, ctx: ToolContext) {
      const now = ctx.buddi!.clock.now();
      const accounts = await listAccounts(ctx.buddi!.db, { enabledOnly: false });
      const address = new Map(accounts.map((a) => [a.id, a.address]));
      const changes = await recentActions(ctx.buddi!.db, accounts.map((a) => a.id), RECENT_CHANGES);
      // How many of each undoable change's messages moved since in another
      // app: the Undo confirmation says they will stay where they are.
      const moved = new Map<string, number>();
      for (const c of changes) if (undoRefusal(c) === null) moved.set(c.id, await movedSince(ctx.buddi!.db, c));
      return {
        changes: changes.map((c) => {
          const who = c.origin === 'policy' ? `by ${c.actor}` : c.origin === 'owner' ? 'by you' : `by @${c.actor}`;
          const sample = c.items[0];
          const more = c.items.length > 1 ? ` and ${c.items.length - 1} more` : '';
          return {
            id: c.id,
            title: `${verbOf(c.kind, c.destination)} · ${plural(c.changed, 'message')}`,
            line: [
              address.get(c.accountId) ?? '',
              who,
              sample ? `${sample.from} — ${sample.subject || '(no subject)'}${more}` : '',
              c.note ?? '',
            ].filter((part) => part !== '').join(' · '),
            when: relative(c.createdAt, now),
            state: changeState(c),
            undoable: undoRefusal(c) === null,
            undoLine: describeUndo(c, address.get(c.accountId) ?? 'your mailbox', moved.get(c.id) ?? 0),
          };
        }),
      };
    },
  };
}

/**
 * The pill on a Recent changes row: undone, partly undone (an undo stopped
 * part-way; Undo finishes it), an undo itself, or a change that did not go
 * all the way — partial, still being checked after a stop, or unconfirmed.
 */
export function changeState(c: ActionRecord): string | null {
  if (c.undoneAt) return 'undone';
  if (c.state === 'pending') return 'pending';
  if (c.state === 'unknown') return 'unknown';
  if (c.kind !== 'undo' && c.revertedIds.length > 0) return 'partly-undone';
  if (c.state === 'partial') return 'partial';
  if (c.kind === 'undo') return 'undo';
  return null;
}

/** How many rules that kept themselves the Mail page lists. */
export const LEARNED_SHOWN = 50;

/** Why a rule kept itself, in the owner's words. */
export function autoReasonLine(reason: string | null): string {
  return reason === 'bulk'
    ? 'mail sent to many, and you never wrote to them'
    : 'you kept every rule like it so far';
}

/**
 * The rules that kept themselves (docs/email.md §5), newest first, for the
 * Mail page's Learned list: whom, why, when, and Undo while it still decides.
 */
export function learnedRulesQuery(): PageQuery {
  return {
    name: 'learned_rules',
    params: noParams,
    async produce(_params, ctx: ToolContext) {
      const now = ctx.buddi!.clock.now();
      const accounts = await listAccounts(ctx.buddi!.db, { enabledOnly: false });
      const address = new Map(accounts.map((a) => [a.id, a.address]));
      const rules = await learnedRules(ctx.buddi!.db, LEARNED_SHOWN);
      return {
        rules: rules.map((r) => {
          const live = r.revokedAt === null;
          const changes = r.arrivalChanges.length;
          return {
            id: r.id,
            title: `Quieted ${r.matcher}`,
            line: [
              r.accountId ? address.get(r.accountId) ?? '' : 'every mailbox',
              autoReasonLine(r.autoReason),
              changes > 0 ? `changed your mailbox ${plural(changes, 'time')} on arrival` : '',
            ].filter((part) => part !== '').join(' · '),
            when: r.keptAt ? relative(r.keptAt, now) : '',
            state: live ? null : 'undone',
            undoable: live,
            canPutBack: live && changes > 0,
            undoLine: `Stop quieting ${r.matcher}? Their next message is triaged as usual, and buddi will not learn this rule again for 90 days.`,
          };
        }),
      };
    },
  };
}

export function emailPageQueries(): PageQuery[] {
  return [
    triageOfferQuery(),
    threadsQuery(),
    threadQuery(),
    draftQuery(),
    messageQuery(),
    accountsQuery(),
    mailStatusQuery(),
    policiesQuery(),
    ruleThreadsQuery(),
    watcherSettingsQuery(),
    mailboxChangesQuery(),
    learnedRulesQuery(),
  ];
}
