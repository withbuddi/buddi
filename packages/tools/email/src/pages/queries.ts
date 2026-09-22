/**
 * What the mail pages read (`docs/specs/plugin-pages.md` §3, `email.md` §8–§10).
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
import type { PageQuery, ToolContext } from '@buddi/core';
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
import { findThread, listThreadRows, threadMessages } from '../threads.js';
import { listDraftsForThread } from '../drafts.js';
import {
  toDraft,
  DRAFT_COLUMNS,
  LIVE_DRAFT_STATUSES,
  type DraftRecord,
} from '../rows.js';
import { policiesView } from '../tools/policies.js';
import { loadWatcherSettings } from '../watchers.js';
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

/** A draft as the editor and the draft list read it. Never a patch: all of it. */
function draftRow(draft: DraftRecord, now: Date): Record<string, unknown> {
  const live =
    (LIVE_DRAFT_STATUSES as readonly string[]).includes(draft.status) && draft.sentActionId === null;
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
    // Dispatched, never confirmed: the one state where nothing may be done to
    // it until somebody has looked in the mailbox.
    unresolved: draft.sentActionId !== null && draft.sentAt === null,
    sendError: draft.sendError,
  };
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
      const now = ctx.now();
      const accounts = await listAccounts(ctx.db, { enabledOnly: false });
      const ids = accounts.map((a) => a.id);
      if (ids.length === 0) return { threads: [], items: [], count: 0 };

      const threads = await listThreadRows(ctx.db, { accountIds: ids, limit: THREAD_LIST_LIMIT });
      const { rows } = await ctx.db.query(
        `select distinct thread_id from email.drafts
          where thread_id = any($1::uuid[]) and status = any($2::text[])`,
        [threads.map((t) => t.id), [...LIVE_DRAFT_STATUSES]],
      );
      const withDraft = new Set(rows.map((r: { thread_id: unknown }) => String(r.thread_id)));

      return {
        threads: threads.map((thread) => ({
          id: thread.id,
          subject: thread.subject === '' ? '(no subject)' : thread.subject,
          participants: thread.participants.join(', '),
          state: thread.state,
          // The "draft" pill: a reply waiting on the owner, visible without
          // opening anything.
          pill: withDraft.has(thread.id) ? 'draft' : thread.state,
          when: relative(thread.lastAt, now),
          messageCount: thread.messageCount,
        })),
        ...(await searchHits(ctx, input, ids)),
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
  if (!attachments.ok) throw new Error(attachments.message);
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
  if ((filters.query ?? '') === '' && !narrows(filters)) return { items: [], count: 0 };
  const wrong = validateFilters(filters);
  // The same sentence the route answered with, from the same function: a
  // malformed filter is something the owner can read and fix.
  if (wrong) throw new Error(wrong);

  const now = ctx.now();
  const built = buildSearch(ids, filters, {
    now,
    timezone: ctx.timezone,
    limit: SEARCH_LIMIT,
  });
  const { rows } = await ctx.db.query(built.text, built.params);
  const items = rows.map(toSearchRow).map((m: SearchRow) => ({
    id: m.id,
    threadId: m.threadId,
    subject: m.subject === '' ? '(no subject)' : m.subject,
    line: `${m.from} — ${m.snippet}`,
    who: m.direction === 'out' ? 'you wrote' : 'they wrote',
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
      const now = ctx.now();
      const thread = await findThread(ctx.db, id);
      if (!thread) throw new Error('No conversation here has that id.');
      // Headers and snippets only: twenty bodies is a page weight nobody
      // reads, and one arrives from `message` when the owner opens it.
      const messages = await threadMessages(ctx.db, thread.id, THREAD_MESSAGE_LIMIT);
      const drafts = await listDraftsForThread(ctx.db, thread.id);
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
      const { rows } = await ctx.db.query(
        `select ${DRAFT_COLUMNS} from email.drafts where id = $1::uuid`,
        [id],
      );
      if (!rows[0]) throw new Error('No draft here has that id.');
      return draftRow(toDraft(rows[0]), ctx.now());
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
      const { rows } = await ctx.db.query(
        `select m.id, m.from_addr, m.to_addrs, m.cc, m.subject, m.date, m.direction,
                m.body_text, m.body_purged_at, m.attachments
           from email.messages m
           join email.accounts a on a.id = m.account_id
          where m.id = $1::uuid`,
        [id],
      );
      const row = rows[0] as Record<string, any> | undefined;
      if (!row) throw new Error('No message here has that id.');
      const messageId = String(row.id);
      const purged = row.body_purged_at !== null;
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
        bodyText: purged
          ? 'The body of this message has been purged under your retention setting. Its headers are kept.'
          : (row.body_text ?? ''),
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
      const now = ctx.now();
      const accounts = await listAccounts(ctx.db, { enabledOnly: false });
      const synced = await lastSyncByAccount(ctx.db);
      return {
        accounts: accounts.map((account) => ({
          id: account.id,
          address: account.address,
          called: account.displayName ?? '',
          aliases: account.aliases.join(', '),
          host: `${account.imapHost}:${account.imapPort} · ${account.smtpHost}:${account.smtpPort}`,
          // A name, never a value. Nothing in the email schema holds a credential.
          secretName: account.secretName,
          lastSync: synced.get(account.id)
            ? relative(synced.get(account.id) ?? null, now)
            : 'no mail has arrived yet',
          state: [
            account.enabled ? 'on' : 'off',
            account.addedVia === 'env' ? 'from .env' : '',
          ]
            .filter((word) => word !== '')
            .join(' · '),
        })),
      };
    },
  };
}

/** The two lists of standing decisions, their counts, and what they have saved. */
export function policiesQuery(): PageQuery {
  return {
    name: 'policies',
    params: noParams,
    async produce(_params, ctx: ToolContext) {
      const now = ctx.now();
      const view = await policiesView(ctx.db);
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
        proposed: view.proposed.map(line),
        appliedCount: view.applied.length,
        proposedCount: view.proposed.length,
        savedRuns,
      };
    },
  };
}

/** The five numbers the mail watchers read (docs/specs/email.md §7). */
export function watcherSettingsQuery(): PageQuery {
  return {
    name: 'watcher_settings',
    params: noParams,
    async produce(_params, ctx: ToolContext) {
      return loadWatcherSettings(ctx.db);
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

/** Every read the two mail pages make. */
export function emailPageQueries(): PageQuery[] {
  return [
    threadsQuery(),
    threadQuery(),
    draftQuery(),
    messageQuery(),
    accountsQuery(),
    policiesQuery(),
    watcherSettingsQuery(),
  ];
}
