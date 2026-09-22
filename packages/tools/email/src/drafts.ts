/**
 * The draft lifecycle (docs/specs/email.md §8), as rows.
 *
 * One module because three callers need the same rules and must not each have
 * their own: the tools an agent uses (`email.draft_reply`, `email.read_draft`,
 * `email.send`), the dashboard's own editor under `/api/email/drafts`, and the
 * sweep that lapses what nobody touched. A second implementation of "is there
 * already a live draft on this thread" is a second answer to it.
 *
 * Two rules are worth stating here rather than only in the migration:
 *
 *  - **An owner-edited draft is not overwritten by an agent.** `edited_by` is
 *    the whole of that: once the owner has saved over the words, `draft_reply`
 *    on that thread refuses to replace them and says to read them first. The
 *    alternative — the agent's next attempt quietly winning — is the one way
 *    this feature could lose the owner's own writing.
 *  - **A body change is a new artifact.** The draft row points at an artifact
 *    version and the send envelope carries both that id and the body's hash, so
 *    editing a draft after a send was proposed invalidates the approval by
 *    construction rather than by anybody remembering to check.
 */
import { saveArtifact } from '@buddi/core';
import type { Pool } from 'pg';
import {
  DRAFT_COLUMNS,
  LIVE_DRAFT_STATUSES,
  toDraft,
  type DraftRecord,
  type DraftStatus,
} from './rows.js';

/** What `edited_by` says when the owner wrote the words that are in it. */
export const OWNER_EDITOR = 'owner';

/**
 * How long a live draft stands before it lapses, in days.
 *
 * A fortnight, from docs/specs/email.md §8: long enough that a draft written
 * about something slow is still there when the owner comes back to it, short
 * enough that a list of live drafts stays a list of decisions rather than an
 * archive. Nothing is deleted — `lapsed` is a status, and the draft is still
 * readable under "Older drafts".
 */
export const DRAFT_LAPSE_DAYS = 14;

/** A filename for the stored artifact — readable in a listing, safe on disk. */
export function draftFilename(subject: string, at: Date): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `draft-${at.toISOString().slice(0, 10)}-${slug || 'untitled'}.txt`;
}

/** The thread a message belongs to, or null for a row from before threads. */
export async function threadOfMessageId(db: Pool, messageId: string): Promise<string | null> {
  const { rows } = await db.query(`select thread_id from email.messages where id = $1`, [messageId]);
  const value = rows[0]?.thread_id;
  return value === null || value === undefined ? null : String(value);
}

/**
 * The live draft on a conversation, if there is one.
 *
 * At most one is expected — `draft_reply` updates rather than adds and the
 * editor never creates — but the query orders newest first rather than
 * asserting it: a history that somehow holds two is a thing to show the owner,
 * not a thing to throw on.
 */
export async function liveDraftForThread(
  db: Pool,
  threadId: string,
): Promise<DraftRecord | null> {
  const { rows } = await db.query(
    `select ${DRAFT_COLUMNS} from email.drafts
      where thread_id = $1 and status = any($2::text[])
      order by updated_at desc nulls last, created_at desc
      limit 1`,
    [threadId, [...LIVE_DRAFT_STATUSES]],
  );
  return rows[0] ? toDraft(rows[0]) : null;
}

/** Every draft on a conversation, newest first, whatever its status. */
export async function listDraftsForThread(db: Pool, threadId: string): Promise<DraftRecord[]> {
  const { rows } = await db.query(
    `select ${DRAFT_COLUMNS} from email.drafts
      where thread_id = $1
      order by updated_at desc nulls last, created_at desc`,
    [threadId],
  );
  return rows.map(toDraft);
}

export interface SaveDraftBodyInput {
  db: Pool;
  subject: string;
  bodyText: string;
  /** Whose words these are, for the artifact's provenance. */
  createdBy: string;
  conversationId?: string | null;
  now: Date;
}

/** The body, into the artifact store, before any row points at it. */
export async function saveDraftBody(input: SaveDraftBodyInput): Promise<{ id: string }> {
  return saveArtifact(input.db, {
    bytes: Buffer.from(input.bodyText, 'utf8'),
    mime: 'text/plain',
    filename: draftFilename(input.subject, input.now),
    caption: input.subject,
    createdBy: input.createdBy,
    conversationId: input.conversationId ?? null,
  });
}

export interface InsertDraftInput {
  db: Pool;
  /** The mailbox this draft will leave from. Never inferred at send time. */
  accountId: string;
  inReplyTo: string | null;
  threadId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  agentId: string;
  conversationId?: string | undefined;
  now: Date;
}

/** A new draft, body first. */
export async function insertDraftRow(input: InsertDraftInput): Promise<DraftRecord> {
  // The body lands in the artifact store first: an orphan artifact is harmless,
  // a draft row pointing at an artifact that was never written is a broken
  // reference an approval would later try to render.
  const artifact = await saveDraftBody({
    db: input.db,
    subject: input.subject,
    bodyText: input.bodyText,
    createdBy: input.agentId,
    conversationId: input.conversationId ?? null,
    now: input.now,
  });

  const { rows } = await input.db.query(
    `insert into email.drafts
       (account_id, in_reply_to, thread_id, to_addrs, cc, bcc, subject, body_text, artifact_id,
        created_by_agent, created_at, status, updated_at)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, 'draft', $11)
     returning ${DRAFT_COLUMNS}`,
    [
      input.accountId,
      input.inReplyTo,
      input.threadId,
      JSON.stringify(input.to),
      JSON.stringify(input.cc),
      JSON.stringify(input.bcc),
      input.subject,
      input.bodyText,
      artifact.id,
      input.agentId,
      input.now,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('draft insert returned no row');
  return toDraft(row);
}

export interface UpdateDraftInput {
  db: Pool;
  draftId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  /**
   * `owner` when the owner saved it — which sets the status to `edited` and
   * makes the draft one no agent may overwrite. An agent id puts the draft back
   * to `draft` with the agent's words in it.
   */
  editedBy: string;
  /** True when `editedBy` is the owner rather than an agent. */
  byOwner: boolean;
  conversationId?: string | null;
  now: Date;
}

/**
 * New words over an existing draft.
 *
 * Always a new artifact, never an edit in place: the send envelope names the
 * artifact version and hashes the body, so a draft that changed after a send
 * was proposed must be a different thing than the one the owner approved.
 */
export async function updateDraftRow(input: UpdateDraftInput): Promise<DraftRecord> {
  const artifact = await saveDraftBody({
    db: input.db,
    subject: input.subject,
    bodyText: input.bodyText,
    createdBy: input.editedBy,
    conversationId: input.conversationId ?? null,
    now: input.now,
  });

  const { rows } = await input.db.query(
    `update email.drafts
        set to_addrs = $2::jsonb, cc = $3::jsonb, bcc = $4::jsonb, subject = $5,
            body_text = $6, artifact_id = $7, status = $8, edited_by = $9, updated_at = $10
      where id = $1 and status = any($11::text[])
      returning ${DRAFT_COLUMNS}`,
    [
      input.draftId,
      JSON.stringify(input.to),
      JSON.stringify(input.cc),
      JSON.stringify(input.bcc),
      input.subject,
      input.bodyText,
      artifact.id,
      input.byOwner ? 'edited' : 'draft',
      input.byOwner ? OWNER_EDITOR : input.editedBy,
      input.now,
      [...LIVE_DRAFT_STATUSES],
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      `draft ${input.draftId} is no longer live; a sent, discarded or lapsed draft cannot be edited`,
    );
  }
  return toDraft(row);
}

/** The owner saying no. Terminal, and still readable afterwards. */
export async function discardDraftRow(
  db: Pool,
  draftId: string,
  now: Date,
): Promise<DraftRecord | null> {
  const { rows } = await db.query(
    `update email.drafts
        set status = 'discarded', discarded_at = $2, updated_at = $2
      where id = $1 and status = any($3::text[])
      returning ${DRAFT_COLUMNS}`,
    [draftId, now, [...LIVE_DRAFT_STATUSES]],
  );
  return rows[0] ? toDraft(rows[0]) : null;
}

export interface LapseOutcome {
  lapsed: number;
  /** The cut-off the sweep used, for the log line. */
  before: Date;
}

/**
 * Lapse every live draft older than the window.
 *
 * Time saying no, not the owner: a draft nobody has touched for a fortnight has
 * stopped being a decision anybody is waiting on, and leaving it on the thread
 * as an editable, sendable thing quietly misrepresents how current it is. It is
 * a status change and nothing else — the row, its artifact and its words all
 * stay, under "Older drafts".
 */
export async function lapseDueDrafts(
  db: Pool,
  now: Date,
  opts: { days?: number } = {},
): Promise<LapseOutcome> {
  const days = Math.max(1, Math.trunc(opts.days ?? DRAFT_LAPSE_DAYS));
  const before = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const { rowCount } = await db.query(
    `update email.drafts
        set status = 'lapsed', lapsed_at = $1, updated_at = $1
      where status = any($3::text[]) and updated_at <= $2`,
    [now, before, [...LIVE_DRAFT_STATUSES]],
  );
  return { lapsed: rowCount ?? 0, before };
}

export function lapseLogLine(outcome: LapseOutcome): string {
  return outcome.lapsed === 0
    ? 'email.retention: no drafts lapsed'
    : `email.retention: ${outcome.lapsed} draft${outcome.lapsed === 1 ? '' : 's'} lapsed (untouched since ${outcome.before.toISOString()})`;
}

/**
 * Why `email.send` will not touch this draft, in one sentence, or null.
 *
 * Read at describe time, so the refusal reaches the agent before an approval
 * card is ever put in front of the owner, and again at execute time through the
 * same function, so a draft discarded while the card was open is refused rather
 * than sent.
 */
export function sendRefusalFor(draft: DraftRecord): string | null {
  const reasons: Partial<Record<DraftStatus, string>> = {
    discarded: 'was discarded',
    lapsed: 'lapsed — nothing has touched it for a fortnight',
  };
  const reason = reasons[draft.status];
  if (!reason) return null;
  return `email.send: draft ${draft.id} ${reason}; write a new one rather than sending this`;
}
