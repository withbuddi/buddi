/**
 * The owner's own hands on a draft — the conversations, and the editor over
 * them (docs/specs/email.md §8).
 *
 * Everything here is the owner acting on their own installation, so there is no
 * approval card between them and the row: the gate on `email.draft_reply` exists
 * because a *model* proposed something, and a person editing their own unsent
 * letter has already said what they want. The one thing that is still gated is
 * the one thing that reaches the world — and **Send does not send**. It creates
 * the `email.send` action by the same path an agent takes (`registry.invoke`,
 * which describes the effect, records the immutable action and returns
 * `approval-required`), and hands the dashboard that action id so the owner
 * approves it on the card, with the alias select on it, like any other send.
 * There is no second road to SMTP in this file and there must never be one.
 *
 * Two smaller rules worth naming:
 *
 *  - **A save is the owner's words.** It writes `status = 'edited'` and
 *    `edited_by = 'owner'`, which is what stops the next `draft_reply` from
 *    writing over it, and it saves a *new* artifact version, which is what makes
 *    a send approved a minute ago refuse instead of going out with different
 *    text (`assertUnchangedSinceApproval`).
 *  - **Only a live draft is editable.** Sent, discarded and lapsed drafts read
 *    back but refuse every write, in the store rather than here, so the rule
 *    holds for the tools too.
 */
import {
  discardDraftRow,
  findThread,
  listAccounts,
  listDraftsForThread,
  listThreadRows,
  normalizeAddresses,
  threadMessages,
  updateDraftRow,
  DraftWriteConflict,
  DRAFT_COLUMNS,
  LIVE_DRAFT_STATUSES,
  toDraft,
  type DraftRecord,
  type ThreadRecord,
} from '@buddi/tool-email';
import type { ToolContext, ToolRegistry } from '@buddi/core';
import type { Pool } from 'pg';
import type { RouteReply } from './email.js';

/** How many messages of a conversation the page draws. The newest ones. */
export const THREAD_MESSAGE_LIMIT = 20;

/** How many conversations the list shows before the owner narrows it. */
export const THREAD_LIST_LIMIT = 30;

/**
 * A body longer than this is not a draft, it is a file. In **bytes**, measured
 * with `Buffer.byteLength`, because that is the unit the transport counts in:
 * a cap in UTF-16 units lets 32k characters of non-ASCII text sail past this
 * check and hit the 64 KiB body cap instead, where the owner reads a sentence
 * about request sizes rather than one about drafts.
 */
export const MAX_DRAFT_BODY = 32_000;

export interface EmailDraftsDeps {
  pool: Pool;
  /** Needed only by Send: the registry that owns `email.send`. */
  registry?: ToolRegistry | undefined;
  /** The context a tool call runs with. Send needs it; nothing else does. */
  ctx?: ToolContext | undefined;
  now: () => Date;
}

/** One draft as the page draws it. Never more than the page shows. */
export interface EmailDraftView {
  id: string;
  threadId: string | null;
  accountId: string | null;
  inReplyTo: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  /** The agent that wrote it — the page says whose draft this is. */
  createdByAgent: string;
  status: string;
  /** `owner` once the owner has saved over the agent's words. */
  editedBy: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  sentAt: string | null;
  /** True while the draft can still be edited, discarded or sent. */
  live: boolean;
  /**
   * The approved action that holds this draft, when one does.
   *
   * With `sentAt` still null it is the one state in this table that means "a
   * message was dispatched and never confirmed". The page has to say so: an
   * editable-looking draft that may already be on the wire is how the same
   * letter gets sent twice.
   */
  sentActionId: string | null;
  /** What the failed dispatch said, when one failed. */
  sendError: string | null;
  /** Dispatched, never confirmed: nothing may be done to it until someone looks. */
  unresolved: boolean;
}

export function draftRouteView(draft: DraftRecord): EmailDraftView {
  return {
    id: draft.id,
    threadId: draft.threadId,
    accountId: draft.accountId,
    inReplyTo: draft.inReplyTo,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    bodyText: draft.bodyText,
    createdByAgent: draft.createdByAgent,
    status: draft.status,
    editedBy: draft.editedBy,
    updatedAt: draft.updatedAt,
    createdAt: draft.createdAt,
    sentAt: draft.sentAt,
    // Live *and* unclaimed. A draft a dispatch is holding is not editable, not
    // discardable and not sendable, whatever its status still says.
    live:
      (LIVE_DRAFT_STATUSES as readonly string[]).includes(draft.status) &&
      draft.sentActionId === null,
    sentActionId: draft.sentActionId,
    sendError: draft.sendError,
    unresolved: draft.sentActionId !== null && draft.sentAt === null,
  };
}

/** One conversation in the list: enough to choose it, plus the draft pill. */
export interface EmailThreadView {
  id: string;
  accountId: string;
  subject: string;
  participants: string[];
  state: string;
  lastAt: string | null;
  messageCount: number;
  /** Whether a draft is waiting on this conversation — the "draft" pill. */
  hasLiveDraft: boolean;
}

function threadView(thread: ThreadRecord, hasLiveDraft: boolean): EmailThreadView {
  return {
    id: thread.id,
    accountId: thread.accountId,
    subject: thread.subject,
    participants: thread.participants,
    state: thread.state,
    lastAt: thread.lastAt,
    messageCount: thread.messageCount,
    hasLiveDraft,
  };
}

async function findDraftRow(pool: Pool, id: string): Promise<DraftRecord | null> {
  const { rows } = await pool.query(`select ${DRAFT_COLUMNS} from email.drafts where id = $1::uuid`, [
    id,
  ]);
  return rows[0] ? toDraft(rows[0]) : null;
}

/**
 * The conversations, most recently moved first, each saying whether a draft is
 * waiting on it.
 *
 * The pill is computed in one query for the whole page rather than one per row:
 * the partial index from migration 010 is exactly this read.
 */
export async function readEmailThreads(
  deps: EmailDraftsDeps,
  opts: { accountId?: string | undefined; limit?: number } = {},
): Promise<RouteReply> {
  const accounts = await listAccounts(deps.pool, { enabledOnly: false });
  const ids = (opts.accountId ? accounts.filter((a) => a.id === opts.accountId) : accounts).map(
    (a) => a.id,
  );
  if (ids.length === 0) return { status: 200, body: { threads: [] } };

  const threads = await listThreadRows(deps.pool, {
    accountIds: ids,
    limit: Math.min(Math.max(1, opts.limit ?? THREAD_LIST_LIMIT), 100),
  });
  const { rows } = await deps.pool.query(
    `select distinct thread_id from email.drafts
      where thread_id = any($1::uuid[]) and status = any($2::text[])`,
    [threads.map((t) => t.id), [...LIVE_DRAFT_STATUSES]],
  );
  const withDraft = new Set(rows.map((r: { thread_id: unknown }) => String(r.thread_id)));
  return {
    status: 200,
    body: { threads: threads.map((t) => threadView(t, withDraft.has(t.id))) },
  };
}

/**
 * One conversation: its messages, then its drafts under them.
 *
 * The order is the page's order and is the point (docs/specs/email.md §8): a
 * draft is an answer to what is above it, so it is drawn under the messages
 * rather than beside them.
 */
export async function readEmailThread(
  deps: EmailDraftsDeps,
  threadId: string,
): Promise<RouteReply> {
  const thread = await findThread(deps.pool, threadId);
  if (!thread) return { status: 404, body: { error: 'No conversation here has that id.' } };
  // Headers and snippets only. `threadMessages` selects the bodies because the
  // triage prompt needs them; shipping twenty of them to a page that draws one
  // line each is a page weight nobody reads. A body arrives when the owner
  // opens that message, through `readEmailMessage` below.
  const messages = (await threadMessages(deps.pool, thread.id, THREAD_MESSAGE_LIMIT)).map(
    ({ bodyText: _body, ...rest }) => rest,
  );
  const drafts = await listDraftsForThread(deps.pool, thread.id);
  const live = drafts.filter((d) => (LIVE_DRAFT_STATUSES as readonly string[]).includes(d.status));
  return {
    status: 200,
    body: {
      thread: threadView(thread, live.length > 0),
      messages,
      // Two lists, because the page draws two things: what is waiting on the
      // owner, and, folded away under "Older drafts", what already ended.
      drafts: live.map(draftRouteView),
      older: drafts
        .filter((d) => !(LIVE_DRAFT_STATUSES as readonly string[]).includes(d.status))
        .map(draftRouteView),
    },
  };
}

/**
 * One message's body, on request.
 *
 * The other half of not shipping twenty bodies: the thread view draws snippets,
 * and opening a message fetches exactly the one being read. Scoped to a message
 * that belongs to an account this installation has, so an id from nowhere
 * cannot read a row.
 */
export async function readEmailMessage(
  deps: EmailDraftsDeps,
  messageId: string,
): Promise<RouteReply> {
  const { rows } = await deps.pool.query(
    `select m.id, m.from_addr, m.to_addrs, m.cc, m.subject, m.date, m.direction,
            m.body_text, m.body_purged_at
       from email.messages m
       join email.accounts a on a.id = m.account_id
      where m.id = $1::uuid`,
    [messageId],
  );
  const row = rows[0];
  if (!row) return { status: 404, body: { error: 'No message here has that id.' } };
  return {
    status: 200,
    body: {
      message: {
        id: String(row.id),
        from: row.from_addr,
        to: Array.isArray(row.to_addrs) ? row.to_addrs : [],
        cc: Array.isArray(row.cc) ? row.cc : [],
        subject: row.subject ?? '',
        date: row.date instanceof Date ? row.date.toISOString() : row.date,
        direction: row.direction === 'out' ? 'out' : 'in',
        // Null once retention has purged it: the headers stay, the body does
        // not, and the page says so rather than drawing an empty message.
        bodyText: row.body_purged_at ? null : (row.body_text ?? ''),
        purged: row.body_purged_at !== null,
      },
    },
  };
}

/** Every draft on one conversation — the list route. */
export async function readEmailDrafts(
  deps: EmailDraftsDeps,
  threadId: string,
): Promise<RouteReply> {
  const thread = await findThread(deps.pool, threadId);
  if (!thread) return { status: 404, body: { error: 'No conversation here has that id.' } };
  const drafts = await listDraftsForThread(deps.pool, thread.id);
  return { status: 200, body: { drafts: drafts.map(draftRouteView) } };
}

/** One draft, by id. */
export async function readEmailDraft(deps: EmailDraftsDeps, id: string): Promise<RouteReply> {
  const draft = await findDraftRow(deps.pool, id);
  if (!draft) return { status: 404, body: { error: 'No draft here has that id.' } };
  return { status: 200, body: { draft: draftRouteView(draft) } };
}

function addressList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`\`${field}\` must be a list of addresses.`);
  }
  return normalizeAddresses(value as string[]);
}

/**
 * The owner's save.
 *
 * It writes the whole envelope of the draft, not a patch: the editor holds all
 * of it on screen, and a partial write would make "what I can see is what is
 * saved" false the first time a field was left out of a request.
 */
export async function writeEmailDraft(
  deps: EmailDraftsDeps,
  id: string,
  body: unknown,
): Promise<RouteReply> {
  const input = (body ?? {}) as Record<string, unknown>;
  const draft = await findDraftRow(deps.pool, id);
  if (!draft) return { status: 404, body: { error: 'No draft here has that id.' } };
  if (draft.sentActionId !== null) {
    return {
      status: 409,
      body: { error: 'This draft is being sent right now and cannot be changed.' },
    };
  }
  if (!(LIVE_DRAFT_STATUSES as readonly string[]).includes(draft.status)) {
    return {
      status: 409,
      body: { error: `This draft is ${draft.status}; only a live draft can be edited.` },
    };
  }

  // The version the editor loaded. Without it a page left open while an agent
  // rewrote the draft saves the stale text that is still on screen over the
  // new words — and the editor shows exactly that stale text, so nothing about
  // the screen would say anything was lost.
  const expectedUpdatedAt =
    typeof input.updatedAt === 'string' && input.updatedAt.trim() !== '' ? input.updatedAt : null;

  const subject = typeof input.subject === 'string' ? input.subject : draft.subject;
  const bodyText = typeof input.bodyText === 'string' ? input.bodyText : draft.bodyText;
  if (bodyText.trim() === '') {
    return { status: 400, body: { error: 'A draft needs a body. Discard it instead of emptying it.' } };
  }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_DRAFT_BODY) {
    return { status: 413, body: { error: 'That body is too long to keep as a draft.' } };
  }

  let to: string[];
  let cc: string[];
  let bcc: string[];
  try {
    to = input.to === undefined ? draft.to : addressList(input.to, 'to');
    cc = input.cc === undefined ? draft.cc : addressList(input.cc, 'cc');
    bcc = input.bcc === undefined ? draft.bcc : addressList(input.bcc, 'bcc');
  } catch (err) {
    return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
  }
  if (to.length === 0) {
    return { status: 400, body: { error: 'A draft needs at least one recipient.' } };
  }

  try {
    const saved = await updateDraftRow({
      db: deps.pool,
      draftId: draft.id,
      to,
      cc,
      bcc,
      subject,
      bodyText,
      // The owner. This is what `edited_by` is for, and what an agent must not
      // write over without reading first.
      editedBy: 'owner',
      byOwner: true,
      expectedUpdatedAt,
      now: deps.now(),
    });
    return { status: 200, body: { draft: draftRouteView(saved) } };
  } catch (err) {
    if (err instanceof DraftWriteConflict) {
      // 409 with what is actually there, so the editor can redraw rather than
      // ask again and guess.
      return {
        status: 409,
        body: {
          error: conflictSentence(err),
          ...(err.current ? { draft: draftRouteView(err.current) } : {}),
        },
      };
    }
    throw err;
  }
}

/** The 409, in the owner's terms. Each reason is a different race they lost. */
function conflictSentence(conflict: DraftWriteConflict): string {
  switch (conflict.reason) {
    case 'stale':
      return 'This draft changed while you had it open. What is here now is shown below — your text was not saved over it.';
    case 'claimed':
      return 'This draft is being sent right now and cannot be changed.';
    case 'not-live':
      return `This draft is ${conflict.current?.status ?? 'no longer live'}; only a live draft can be edited.`;
    case 'missing':
      return 'That draft no longer exists.';
    default:
      return conflict.message;
  }
}

/** The owner saying no. The row stays, under "Older drafts". */
export async function discardEmailDraft(deps: EmailDraftsDeps, id: string): Promise<RouteReply> {
  const draft = await findDraftRow(deps.pool, id);
  if (!draft) return { status: 404, body: { error: 'No draft here has that id.' } };
  const discarded = await discardDraftRow(deps.pool, draft.id, deps.now());
  if (!discarded) {
    return {
      status: 409,
      body: { error: `This draft is ${draft.status}; only a live draft can be discarded.` },
    };
  }
  return { status: 200, body: { draft: draftRouteView(discarded) } };
}

/**
 * Send — which proposes a send and nothing else.
 *
 * `registry.invoke` on a `gated` tool describes the effect, records the
 * immutable action with its preview and its declared choices, and answers
 * `approval-required` with the action id. That refusal *is* the success here:
 * the page takes the id and draws the approval card, where the owner reads the
 * envelope and picks the identity, exactly as they would for a send an agent
 * proposed. An `ok: true` from this call would mean a gated tool had executed
 * without an approval, which cannot happen and is treated as a fault if it
 * somehow did.
 */
export async function sendEmailDraft(deps: EmailDraftsDeps, id: string): Promise<RouteReply> {
  const draft = await findDraftRow(deps.pool, id);
  if (!draft) return { status: 404, body: { error: 'No draft here has that id.' } };
  if (draft.sentActionId !== null) {
    // Claimed, and `sent_at` null means the dispatch never came back. Proposing
    // a second send is how the same letter goes out twice.
    return {
      status: 409,
      body: {
        error: draft.sentAt
          ? 'This draft has already been sent.'
          : 'This draft was already dispatched and never confirmed. Check the mailbox before sending anything again.',
      },
    };
  }
  if (!(LIVE_DRAFT_STATUSES as readonly string[]).includes(draft.status)) {
    return {
      status: 409,
      body: { error: `This draft is ${draft.status}; there is nothing here to send.` },
    };
  }
  if (!deps.registry || !deps.ctx) {
    return { status: 503, body: { error: 'This process cannot propose a send.' } };
  }

  const result = await deps.registry.invoke(
    'email.send',
    { draftId: draft.id },
    // The owner is the one asking, and the action records who asked.
    { ...deps.ctx, agentId: deps.ctx.agentId ?? 'owner' },
  );
  if (result.ok) {
    return {
      status: 500,
      body: { error: 'email.send ran without an approval; that is a fault, and nothing here expects it.' },
    };
  }
  if (result.reason !== 'approval-required') {
    return { status: 400, body: { error: result.message } };
  }
  return { status: 200, body: { actionId: result.actionId, preview: result.preview } };
}
