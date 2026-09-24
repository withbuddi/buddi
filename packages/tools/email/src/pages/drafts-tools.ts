/**
 * The owner's own hands on a draft (docs/specs/email.md §8).
 *
 * An agent writes a draft; the owner reads the conversation it answers, edits
 * it, throws it away, or sends it — and "sends it" is `email.send`, gated,
 * unchanged, which is why there is no send tool in this file. **Nothing here
 * reaches SMTP.** These two are the edit and the refusal, as `ownerOnly` tools
 * over the very same store functions the routes used:
 *
 *  - **A save is the owner's words.** It writes `status = 'edited'` and
 *    `edited_by = 'owner'`, which is what stops the next `draft_reply` from
 *    writing over it, and it saves a *new* artifact version, which is what
 *    makes a send approved a minute ago refuse instead of going out with
 *    different text (`assertUnchangedSinceApproval`).
 *  - **Only a live draft is editable.** Sent, discarded and lapsed drafts read
 *    back but refuse every write, in the store rather than here, so the rule
 *    holds for the tools too.
 *
 * The `version` is **required**, and that is the whole point: an optional
 * precondition is not one. The editor carries the `updated_at` it loaded, and a
 * page left open while an agent rewrote the draft saves nothing instead of
 * quietly putting the stale text back.
 */
import type { ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import { discardDraftRow, updateDraftRow, DraftWriteConflict } from '../drafts.js';
import { toDraft, DRAFT_COLUMNS, LIVE_DRAFT_STATUSES, type DraftRecord } from '../rows.js';
import { normalizeAddresses } from '../mail.js';
import type { DbArea } from '@buddi/core/plugin';

/** `ctx.buddi.db`, a transaction's handle, or anything that answers a query as they do. */
type Db = Pick<DbArea, 'query'>;

/**
 * A body longer than this is not a draft, it is a file. In **bytes**, because
 * that is the unit the transport counts in.
 */
export const MAX_DRAFT_BODY = 32_000;

/** A refusal the owner reads in the editor, in their own words. */
export class DraftRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftRefusal';
  }
}

async function findDraftRow(db: Db, id: string): Promise<DraftRecord | null> {
  const { rows } = await db.query(`select ${DRAFT_COLUMNS} from email.drafts where id = $1::uuid`, [id]);
  return rows[0] ? toDraft(rows[0]) : null;
}

/** A comma-or-space separated list of addresses, as a list. */
export function addressesOf(text: string): string[] {
  return normalizeAddresses(
    text
      .split(/[,;\s]+/)
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  );
}

/** The 409, in the owner's terms. Each reason is a different race they lost. */
export function conflictSentence(conflict: DraftWriteConflict): string {
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

const saveInput = z
  .object({
    draftId: z.string().uuid(),
    to: z.string(),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    subject: z.string(),
    bodyText: z.string(),
    /**
     * The `updated_at` the editor loaded, as the page's implicit `version`
     * field. Required: a precondition that a caller may leave out is one that
     * protects the careful and not the careless.
     */
    version: z.string().min(1),
  })
  .strict();

export type SaveDraftInput = z.infer<typeof saveInput>;

/**
 * The owner's save. It writes the whole envelope, not a patch: the editor holds
 * all of it on screen, and a partial write would make "what I can see is what
 * is saved" false the first time a field was left out.
 */
export function createSaveDraftTool(): ToolDefinition<SaveDraftInput, unknown> {
  return {
    name: 'email.save_draft',
    description:
      "The owner's own edit of a draft, from the Mail page: the whole envelope, saved against the version the editor loaded.",
    tier: 'auto',
    ownerOnly: true,
    input: saveInput,
    async execute(input, ctx) {
      const draft = await findDraftRow(ctx.buddi!.db, input.draftId);
      if (!draft) throw new DraftRefusal('No draft here has that id.');
      if (draft.sentActionId !== null) {
        throw new DraftRefusal('This draft is being sent right now and cannot be changed.');
      }
      if (!(LIVE_DRAFT_STATUSES as readonly string[]).includes(draft.status)) {
        throw new DraftRefusal(`This draft is ${draft.status}; only a live draft can be edited.`);
      }
      if (Number.isNaN(Date.parse(input.version))) {
        throw new DraftRefusal(
          'The version must be the timestamp of the draft you loaded. Reload the draft and save again.',
        );
      }
      if (input.bodyText.trim() === '') {
        throw new DraftRefusal('A draft needs a body. Discard it instead of emptying it.');
      }
      if (Buffer.byteLength(input.bodyText, 'utf8') > MAX_DRAFT_BODY) {
        throw new DraftRefusal('That body is too long to keep as a draft.');
      }
      const to = addressesOf(input.to);
      if (to.length === 0) throw new DraftRefusal('A draft needs at least one recipient.');

      try {
        const saved = await updateDraftRow({
          db: ctx.buddi!.db,
          files: ctx.buddi!.files!,
          draftId: draft.id,
          to,
          cc: addressesOf(input.cc ?? ''),
          bcc: addressesOf(input.bcc ?? ''),
          subject: input.subject,
          bodyText: input.bodyText,
          // The owner. This is what `edited_by` is for, and what an agent must
          // not write over without reading first.
          editedBy: 'owner',
          byOwner: true,
          expectedUpdatedAt: input.version,
          now: ctx.buddi!.clock.now(),
        });
        return {
          saved: true,
          draftId: saved.id,
          note: 'Saved. These are your words now — no agent will write over them, and a send you approved before this edit will refuse rather than go out with the old text.',
        };
      } catch (err) {
        if (err instanceof DraftWriteConflict) throw new DraftRefusal(conflictSentence(err));
        throw err;
      }
    },
  };
}

const discardInput = z.object({ draftId: z.string().uuid() }).strict();

/** The owner saying no. The row stays, under "Older drafts". */
export function createDiscardDraftTool(): ToolDefinition<z.infer<typeof discardInput>, unknown> {
  return {
    name: 'email.discard_draft',
    description:
      "The owner throwing away a draft from the Mail page. The row is kept, so what was proposed can still be read.",
    tier: 'auto',
    ownerOnly: true,
    input: discardInput,
    async execute(input, ctx) {
      const draft = await findDraftRow(ctx.buddi!.db, input.draftId);
      if (!draft) throw new DraftRefusal('No draft here has that id.');
      const discarded = await discardDraftRow(ctx.buddi!.db, draft.id, ctx.buddi!.clock.now());
      if (!discarded) {
        throw new DraftRefusal(`This draft is ${draft.status}; only a live draft can be discarded.`);
      }
      return {
        discarded: true,
        draftId: discarded.id,
        note: 'Discarded. It is kept under Older drafts, so you can still read what was proposed.',
      };
    },
  };
}
