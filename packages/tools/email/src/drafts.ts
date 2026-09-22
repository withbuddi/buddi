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

/**
 * A live draft for this conversation: the one that is there, or a new one.
 *
 * `draft_reply` reads the thread, finds no live draft and inserts — and two
 * runs on one thread can both do that. The unique partial index from migration
 * 010 is what stops them, and this is the other half of it: the loser catches
 * the violation and becomes an update of the winner, so "tapping Draft a reply
 * twice edits one draft" survives the two taps arriving at once. The owner-edit
 * guard rides along in `updateDraftRow`'s own predicate, so a race whose winner
 * the owner had already edited is refused rather than overwritten.
 */
export async function insertLiveDraft(input: InsertDraftInput): Promise<DraftRecord> {
  try {
    return await insertDraftRow(input);
  } catch (err) {
    // 23505: unique_violation. Only ours is possible on this table.
    if (!(err && typeof err === 'object' && (err as { code?: string }).code === '23505')) throw err;
    if (input.threadId === null) throw err;
    const winner = await liveDraftForThread(input.db, input.threadId);
    if (!winner) throw err;
    return updateDraftRow({
      db: input.db,
      draftId: winner.id,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      bodyText: input.bodyText,
      editedBy: input.agentId,
      byOwner: false,
      // The version this writer just read, a moment after losing the insert.
      expectedArtifactId: winner.artifactId,
      conversationId: input.conversationId ?? null,
      now: input.now,
    });
  }
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
  /**
   * The `updated_at` the writer believes it is editing.
   *
   * The owner's editor carries it: a page left open while an agent rewrote the
   * draft would otherwise save the stale text that is on screen over the new
   * words. With it, the write matches nothing and the route answers 409 with
   * what is actually there.
   */
  expectedUpdatedAt?: string | null;
  /**
   * The artifact version the writer read, when it has one.
   *
   * An agent's rewrite carries it, and needs to: two runs can both read the
   * same draft and both rewrite it, and without a version in the predicate the
   * second silently replaces work the first had already done. `updated_at` is
   * the owner's token because that is what their editor holds; the artifact id
   * is the agent's, because that is what `draft_reply` read.
   */
  expectedArtifactId?: string | null;
  conversationId?: string | null;
  now: Date;
}

/** Why a guarded draft write matched no row. Each is a different race lost. */
export type DraftWriteRefusal =
  | 'not-live'
  | 'owner-edited'
  | 'stale'
  | 'claimed'
  | 'missing';

export class DraftWriteConflict extends Error {
  constructor(
    readonly reason: DraftWriteRefusal,
    readonly current: DraftRecord | null,
    message: string,
  ) {
    super(message);
    this.name = 'DraftWriteConflict';
  }
}

/**
 * Why a guarded write matched nothing, read back from the row afterwards.
 *
 * The predicate is what decides; this only *names* what decided it, for the
 * sentence the owner or the agent reads. Reading the row again cannot be
 * racy in a way that matters: the write already failed.
 */
async function refusalFor(
  db: Pool,
  draftId: string,
  byOwner: boolean,
  expectedArtifactId?: string | null,
): Promise<DraftWriteConflict> {
  const { rows } = await db.query(`select ${DRAFT_COLUMNS} from email.drafts where id = $1`, [draftId]);
  const current = rows[0] ? toDraft(rows[0]) : null;
  if (!current) {
    return new DraftWriteConflict('missing', null, `draft ${draftId} no longer exists`);
  }
  if (current.sentActionId !== null) {
    return new DraftWriteConflict(
      'claimed',
      current,
      `draft ${draftId} is being sent under action ${current.sentActionId}; it cannot be changed now`,
    );
  }
  if (!LIVE_DRAFT_STATUSES.includes(current.status)) {
    return new DraftWriteConflict(
      'not-live',
      current,
      `draft ${draftId} is ${current.status}; only a live draft can be edited`,
    );
  }
  if (!byOwner && current.editedBy === OWNER_EDITOR) {
    return new DraftWriteConflict(
      'owner-edited',
      current,
      `draft ${draftId} has been edited by the owner; read it before rewriting it`,
    );
  }
  if (!byOwner && expectedArtifactId !== undefined && current.artifactId !== expectedArtifactId) {
    // Another agent got there first. Same answer as an owner edit, and for the
    // same reason: whatever is in the draft now was written by somebody who has
    // seen something this writer has not.
    return new DraftWriteConflict(
      'stale',
      current,
      `draft ${draftId} was rewritten while you were composing; read it before rewriting it`,
    );
  }
  return new DraftWriteConflict(
    'stale',
    current,
    `draft ${draftId} changed while you were editing it`,
  );
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

  /*
   * Every guard is in the predicate, not in a check above it.
   *
   * Reading the row, deciding in TypeScript and then writing leaves a window
   * exactly as wide as the artifact save that sits between them — and what
   * fits in that window is the other writer. `status` keeps a terminal draft
   * terminal; `sent_action_id is null` keeps anyone from editing a draft a
   * dispatch already holds; `edited_by is distinct from 'owner'` is the rule
   * that an agent does not write over the owner's words, and it is here rather
   * than in `draft_reply` because here is where it cannot be overtaken;
   * `updated_at` is the editor's own precondition, so a page left open while
   * somebody else rewrote the draft saves nothing.
   */
  const { rows } = await input.db.query(
    `update email.drafts
        set to_addrs = $2::jsonb, cc = $3::jsonb, bcc = $4::jsonb, subject = $5,
            body_text = $6, artifact_id = $7, status = $8, edited_by = $9, updated_at = $10
      where id = $1
        and status = any($11::text[])
        and sent_action_id is null
        and ($12::boolean or edited_by is distinct from '${OWNER_EDITOR}')
        and ($13::timestamptz is null or updated_at = $13::timestamptz)
        and ($14::uuid is null or artifact_id is not distinct from $14::uuid)
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
      input.byOwner,
      input.expectedUpdatedAt ?? null,
      input.expectedArtifactId ?? null,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw await refusalFor(input.db, input.draftId, input.byOwner, input.expectedArtifactId);
  }
  return toDraft(row);
}

/** The owner saying no. Terminal, and still readable afterwards. */
export async function discardDraftRow(
  db: Pool,
  draftId: string,
  now: Date,
): Promise<DraftRecord | null> {
  // `sent_action_id is null` for the same reason the editor carries it: a
  // draft a dispatch is already holding is not the owner's to take back — the
  // message may be on the wire, and discarding the row would only hide that.
  const { rows } = await db.query(
    `update email.drafts
        set status = 'discarded', discarded_at = $2, updated_at = $2
      where id = $1 and status = any($3::text[]) and sent_action_id is null
      returning ${DRAFT_COLUMNS}`,
    [draftId, now, [...LIVE_DRAFT_STATUSES]],
  );
  return rows[0] ? toDraft(rows[0]) : null;
}

export interface ClaimDraftInput {
  db: Pool;
  draftId: string;
  /** The approved action id — the idempotency key the claim is written under. */
  actionId: string;
  /** The artifact version the approved envelope named. */
  artifactId: string | null;
  now: Date;
}

/**
 * Take the draft for one approved send, or refuse.
 *
 * This is `email.send`'s `claim` (see `ToolDefinition.claim`): the last moment
 * at which nothing has happened, and the only place the last race can be
 * closed. The executor re-describes before dispatch, but a re-description
 * *reads*; between that read and the first write the owner can save new text,
 * and a send that checked a moment earlier would put the old body on the wire
 * while the row held the new one. So the version the envelope named is a clause
 * in the claim itself.
 *
 * Returns the claimed row, or `'replayed'` when this very action already sent
 * it — the recorded receipt is the right answer to a repeat, not a second
 * message.
 */
export async function claimDraftForSend(
  input: ClaimDraftInput,
): Promise<DraftRecord | 'replayed'> {
  const { rows: existing } = await input.db.query(
    `select ${DRAFT_COLUMNS} from email.drafts where id = $1`,
    [input.draftId],
  );
  const current = existing[0] ? toDraft(existing[0]) : null;
  if (!current) throw new Error(`email.send: draft ${input.draftId} no longer exists`);
  if (current.sentActionId === input.actionId && current.sentAt) return 'replayed';
  if (current.sentActionId !== null && current.sentActionId !== input.actionId) {
    throw new Error(
      `email.send: draft ${current.id} is already claimed by action ${current.sentActionId}; refusing to send it again`,
    );
  }
  // Already ours and not yet sent: the `claim` hook took it a moment ago and
  // `execute` is asking for the same hold. Idempotent by construction, because
  // the claim is keyed on the action id and nothing else may write the row
  // while it stands.
  if (current.sentActionId === input.actionId) return current;

  const { rows } = await input.db.query(
    `update email.drafts
        set sent_action_id = $2, updated_at = $3
      where id = $1
        and sent_action_id is null
        and status = any($4::text[])
        and artifact_id is not distinct from $5
      returning ${DRAFT_COLUMNS}`,
    [input.draftId, input.actionId, input.now, [...LIVE_DRAFT_STATUSES], input.artifactId],
  );
  const row = rows[0];
  if (row) return toDraft(row);

  // Nothing matched. Say which clause lost, in the owner's terms: they are the
  // one who is about to be told their mail did not go.
  const { rows: after } = await input.db.query(
    `select ${DRAFT_COLUMNS} from email.drafts where id = $1`,
    [input.draftId],
  );
  const now = after[0] ? toDraft(after[0]) : null;
  if (!now) throw new Error(`email.send: draft ${input.draftId} no longer exists`);
  if (now.sentActionId !== null && now.sentActionId !== input.actionId) {
    throw new Error(
      `email.send: draft ${now.id} was claimed by action ${now.sentActionId} a moment ago; nothing was sent`,
    );
  }
  if (!LIVE_DRAFT_STATUSES.includes(now.status)) {
    throw new Error(
      `email.send: draft ${now.id} was ${now.status} while you were deciding; nothing was sent`,
    );
  }
  throw new Error(
    `email.send: draft ${now.id} was edited while you were deciding — the body you approved is a different version of this draft. Nothing was sent; approve the new one.`,
  );
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
  // A draft a dispatch is holding is never lapsed: `sent_action_id` with no
  // `sent_at` is the one state in this table that says "we do not know whether
  // this went out", and lapsing it would file the only visible trace of an
  // unresolved send away under "Older drafts".
  const { rowCount } = await db.query(
    `update email.drafts
        set status = 'lapsed', lapsed_at = $1, updated_at = $1
      where status = any($3::text[]) and updated_at <= $2 and sent_action_id is null`,
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
  // Every status that is not live, `sent` included. Listing only the two the
  // spec names would let a send be *proposed* for an already-sent draft: an
  // approval card put in front of the owner for a message they have already
  // sent, which only refuses at execute time, after they have said yes.
  if (LIVE_DRAFT_STATUSES.includes(draft.status)) return null;
  const reasons: Record<Exclude<DraftStatus, 'draft' | 'edited'>, string> = {
    sent: `was already sent${draft.sentAt ? ` (${draft.sentAt})` : ''}`,
    discarded: 'was discarded',
    lapsed: 'lapsed — nothing has touched it for a fortnight',
  };
  const reason = reasons[draft.status as Exclude<DraftStatus, 'draft' | 'edited'>];
  return `email.send: draft ${draft.id} ${reason}; write a new one rather than sending this`;
}
