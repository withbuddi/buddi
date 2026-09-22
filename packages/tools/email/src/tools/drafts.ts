/**
 * Drafting. A draft is a proposal, never a send.
 *
 * Tier `auto` on purpose: writing a draft touches nothing outside the
 * installation. What makes it safe is that `email.send` is a separate, gated
 * tool — the agent may compose freely, and only an owner approval bound to the
 * finished envelope puts anything on the wire.
 *
 * Drafts are artifacts (ARCHITECTURE.md, roadmap step 3): the body text is
 * saved into the core artifact store with the authoring agent as its
 * provenance, and the draft row points at that version. That is what lets an
 * approval reference a version and what makes the preview *be* what ships.
 */
import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import {
  insertDraftRow,
  liveDraftForThread,
  listDraftsForThread,
  OWNER_EDITOR,
  threadOfMessageId,
  updateDraftRow,
} from '../drafts.js';
import { normalizeAddresses, replyRecipients, replySubject } from '../mail.js';
import type { DraftRecord } from '../rows.js';
import {
  ACCOUNT_ARG,
  accountOf,
  identityFor,
  ownAddresses,
  requireAgentId,
  requireMessage,
  requireDraft,
  requireOneAccount,
  UUID,
} from './shared.js';

const ADDRESS = z.string().min(3).describe('One email address.');

const BODY = z
  .string()
  .min(1)
  .describe('The full plain-text body of the message. Write it as it should be sent.');

/**
 * How a draft reads back to the agent that wrote it — or to the one that came
 * along afterwards and found the owner had rewritten it.
 */
export interface DraftView {
  id: string;
  from: string;
  account: string;
  threadId: string | null;
  inReplyTo: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  artifactId: string | null;
  createdBy: string;
  status: string;
  /** `owner` once the owner has saved over the words. */
  editedBy: string | null;
  updatedAt: string | null;
  sent: boolean;
  note: string;
}

const NOT_SENT =
  'Nothing has been sent. A draft only leaves the machine through email.send, which the owner must approve.';

export function draftView(
  draft: DraftRecord,
  identity: { from: string; account: string },
  note = NOT_SENT,
): DraftView {
  return {
    id: draft.id,
    from: identity.from,
    account: identity.account,
    threadId: draft.threadId,
    inReplyTo: draft.inReplyTo,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    bodyText: draft.bodyText,
    artifactId: draft.artifactId,
    createdBy: draft.createdByAgent,
    status: draft.status,
    editedBy: draft.editedBy,
    updatedAt: draft.updatedAt,
    sent: draft.status === 'sent',
    note,
  };
}

const draftReplyInput = z.object({
  inReplyTo: UUID.describe('The message being replied to, by the id the tools gave you.'),
  bodyText: BODY,
  subjectOverride: z
    .string()
    .min(1)
    .optional()
    .describe('Use a different subject line instead of "Re: <original>".'),
  audience: z
    .enum(['sender', 'everyone'])
    .optional()
    .describe(
      'Who the reply goes to. "sender" (the default, and what you get if you say nothing) is the person who wrote, and nobody else. "everyone" is the audience the original had: the sender plus everyone else it was addressed to, with everyone it copied kept in copy. The owner\'s own addresses are never included, a reply never carries a blind copy, and widening the audience is shown to the owner as a widening when they approve the send — so ask for it when the others genuinely need the answer, not by default.',
    ),
  alsoTo: z
    .array(ADDRESS)
    .optional()
    .describe('Named people to address as well, beyond the audience you chose.'),
  alsoCc: z
    .array(ADDRESS)
    .optional()
    .describe('Named people to copy as well, beyond the audience you chose.'),
});

export const draftReply: ToolDefinition<z.infer<typeof draftReplyInput>, unknown> = {
  name: 'email.draft_reply',
  producesArtifacts: true,
  description:
    'Write a reply to a message and save it as a draft. The subject and the threading come from the original, and so does the recipient: by default the reply goes to the sender alone. Use `audience` to reply to everyone the message went to instead. The result names everyone else who was on the original, and says so even when you chose the narrow shape — read it, because a narrow draft of a message other people were on leaves the owner a decision, and the result tells you what to do with it. This sends nothing — a draft goes out only through email.send, which the owner has to approve first.',
  tier: 'auto',
  input: draftReplyInput,
  async execute(input, ctx) {
    const agentId = requireAgentId(ctx.agentId, 'email.draft_reply');
    const original = await requireMessage(ctx.db, input.inReplyTo);
    // docs/specs/email.md §4: "`send` and `draft_reply` take the account from the
    // thread they answer". There is no argument for it and there must not be
    // one — a reply leaves from the mailbox it arrived in, and an agent that
    // could choose otherwise could answer a client from the owner's private
    // address without anyone naming the swap.
    const account = await accountOf(ctx.db, original.accountId);

    // Every rule about who may be on a reply lives in one pure function, so
    // the default cannot drift and the exclusions cannot be half-applied.
    const audience = replyRecipients({
      from: original.from,
      to: original.to,
      cc: original.cc,
      owner: ownAddresses(account),
      audience: input.audience,
      alsoTo: input.alsoTo,
      alsoCc: input.alsoCc,
    });
    if (audience.to.length === 0) {
      throw new Error(
        `email.draft_reply: message ${original.id} has no one to reply to — every address on it is the owner's own`,
      );
    }

    // docs/specs/email.md §8: one conversation, one live draft. A second
    // `draft_reply` on the same thread rewrites the one that is there rather
    // than stacking another beside it — "tapping Draft a reply twice edits one
    // draft" (§12.4) — with the one exception that makes the whole lifecycle
    // safe: a draft the *owner* has edited is the owner's words, and an agent
    // does not get to write over those without having read them.
    const threadId = original.threadId ?? (await threadOfMessageId(ctx.db, original.id));
    const live = threadId ? await liveDraftForThread(ctx.db, threadId) : null;

    // The account's own address. Never an alias picked off the original's To or
    // Cc — those are headers the sender wrote (see `identityChoices`); the owner
    // chooses an alias on the approval card, where the envelope lists them.
    const identity = { from: identityFor(account), account: account.address };
    const fields = {
      to: audience.to,
      cc: audience.cc,
      bcc: audience.bcc,
      subject: input.subjectOverride ?? replySubject(original.subject),
      bodyText: input.bodyText,
    };

    if (live && live.editedBy === OWNER_EDITOR) {
      return {
        ...draftView(live, identity, ownerEditedNote(live)),
        wrote: false,
        ownerEdited: true,
        ownerDecision: null,
      };
    }

    const record = live
      ? await updateDraftRow({
          db: ctx.db,
          draftId: live.id,
          ...fields,
          editedBy: agentId,
          byOwner: false,
          conversationId: ctx.conversationId ?? null,
          now: ctx.now(),
        })
      : await insertDraftRow({
          db: ctx.db,
          accountId: account.id,
          inReplyTo: original.id,
          threadId,
          ...fields,
          agentId,
          conversationId: ctx.conversationId,
          now: ctx.now(),
        });

    const draft = {
      ...draftView(record, identity),
      wrote: true,
      replaced: live ? live.id : null,
    };

    // What the draft says about its own audience, so the agent can tell the
    // owner who this would reach without re-deriving it from the original.
    //
    // And — the part that is not decoration — what it says about the audience
    // it did *not* take. A sender-only draft of a message five people read is
    // the one moment in this plugin where the turn ends at a decision only the
    // owner can make, where one of the two outcomes cannot be taken back, and
    // where the agent already knows how to carry out either one. A persona
    // paragraph is skimmable; a tool result that states the fact at the exact
    // moment it becomes true is not. `ownerDecision` is that statement.
    const decision = describeAudienceDecision(audience);
    return {
      ...draft,
      audience: audience.audience,
      beyondSender: audience.beyondSender,
      othersOnOriginal: audience.othersOnOriginal,
      ...(audience.excludedOwn.length > 0 ? { excludedOwnAddresses: audience.excludedOwn } : {}),
      ...(audience.senderLooksUnreplyable
        ? {
            senderNote: `${audience.sender} looks like an unattended address; a reply to it is unlikely to be read by anyone.`,
          }
        : {}),
      ...(decision ? { ownerDecision: decision } : {}),
      audienceNote: audienceNoteFor(audience, decision),
    };
  },
};

/** The two moves, named, when a sender-only draft had a wider audience available. */
export interface AudienceDecision {
  /** Stable marker: this turn ends at a decision about who the reply reaches. */
  decision: 'reply-audience';
  /** The people a widened reply would add. Never empty when this exists. */
  others: string[];
  /** Plain words for what taking each way would mean. */
  options: [string, string];
  instruction: string;
}

/**
 * Null whenever there is nothing to decide — which is most replies, and which
 * is what keeps a button from appearing where it would be noise: a reply that
 * was already widened has made the choice, and a message that was only ever
 * between the owner and the sender never offered one.
 */
export function describeAudienceDecision(audience: {
  audience: 'sender' | 'everyone';
  sender: string;
  othersOnOriginal: readonly string[];
}): AudienceDecision | null {
  if (audience.audience !== 'sender') return null;
  const others = [...audience.othersOnOriginal];
  if (others.length === 0) return null;
  const count = `${others.length} other ${others.length === 1 ? 'person' : 'people'}`;
  return {
    decision: 'reply-audience',
    others,
    options: [
      `send this draft to ${audience.sender} alone`,
      `write it again to everyone the original reached — ${others.join(', ')}`,
    ],
    instruction:
      `The message you replied to also went to ${count} (${others.join(', ')}), and the draft you just wrote goes to ${audience.sender} alone. ` +
      'Show the owner that draft in full, and name those people by address while you do — that part of your reply does not change, and a reply that says only "here are your two options" is not one. ' +
      'What changes is how the turn ends. Which of the two shapes goes out is the owner\'s to decide, not yours, and the wide one cannot be taken back once it is sent, ' +
      `so end by offering both as next actions in the language you are writing in — sending it to ${audience.sender} alone first, writing it again to everyone second — ` +
      'with whatever tool you have for offering the owner what to do next — call that tool first and write the reply after it, so the draft is in the message the owner is actually shown. ' +
      'Do not end instead with a question in prose ("shall I send it?", "veux-tu que je l\'envoie ?"), and do not also list the two options in your own text: ' +
      'an offer is recorded and can be taken, on any surface; a sentence you typed cannot.',
  };
}

function audienceNoteFor(
  audience: { beyondSender: readonly string[] },
  decision: AudienceDecision | null,
): string {
  if (decision) return decision.instruction;
  if (audience.beyondSender.length === 0) {
    return 'This reply goes to the sender alone, and no one else was on the message it answers — there is no audience choice to put to the owner.';
  }
  return `This reply goes to ${audience.beyondSender.length} ${
    audience.beyondSender.length === 1 ? 'person' : 'people'
  } beyond the sender: ${audience.beyondSender.join(', ')}. Say so when you show it to the owner — approving the send is the last chance to narrow it.`;
}

const draftNewInput = z.object({
  account: ACCOUNT_ARG.describe(
    'Which of the owner\'s mailboxes this leaves from, by its address or its id. Required: a new message has no thread to take an account from, and guessing which address the owner writes to a stranger as is not yours to do. Leave it out only when the installation has exactly one mailbox.',
  ).optional(),
  to: z
    .union([ADDRESS, z.array(ADDRESS).min(1)])
    .describe('Recipient address, or a list of them.'),
  subject: z.string().min(1).describe('The subject line.'),
  bodyText: BODY,
  cc: z.array(ADDRESS).optional().describe('Addresses to copy.'),
  bcc: z
    .array(ADDRESS)
    .optional()
    .describe('Addresses to blind-copy. They are shown in full in the approval preview.'),
});

export const draftNew: ToolDefinition<z.infer<typeof draftNewInput>, unknown> = {
  name: 'email.draft_new',
  producesArtifacts: true,
  description:
    'Write a new message and save it as a draft, from the mailbox you name in `account`. This sends nothing — a draft goes out only through email.send, which the owner has to approve first.',
  tier: 'auto',
  input: draftNewInput,
  async execute(input, ctx) {
    const agentId = requireAgentId(ctx.agentId, 'email.draft_new');
    // One account, named — or refused with the list to choose from. An
    // installation with a single mailbox never has to say which.
    const account = await requireOneAccount(ctx.db, input.account);
    const to = normalizeAddresses(Array.isArray(input.to) ? input.to : [input.to]);
    if (to.length === 0) throw new Error('email.draft_new: at least one recipient is required');
    // `draft_new` always creates. It answers nothing, so there is no thread to
    // hold a live draft, and two new messages to the same stranger are two
    // messages rather than one rewritten (docs/specs/email.md §8).
    const record = await insertDraftRow({
      db: ctx.db,
      accountId: account.id,
      inReplyTo: null,
      threadId: null,
      to,
      cc: normalizeAddresses(input.cc ?? []),
      bcc: normalizeAddresses(input.bcc ?? []),
      subject: input.subject,
      bodyText: input.bodyText,
      agentId,
      conversationId: ctx.conversationId,
      now: ctx.now(),
    });
    // Nothing was addressed to an alias, so this is the account speaking.
    return { ...draftView(record, { from: account.address, account: account.address }), wrote: true };
  },
};

/* ------------------------------------------------------------------ *
 * email.read_draft
 * ------------------------------------------------------------------ */

/**
 * What an agent is told when it tried to write over the owner's own words.
 *
 * It names the draft and the one tool that reads it, because the next thing the
 * agent does must be to look at what the owner wrote rather than to try again
 * with a slightly different sentence.
 */
export function ownerEditedNote(draft: DraftRecord): string {
  return (
    `The owner has edited this draft${draft.updatedAt ? ` (last changed ${draft.updatedAt})` : ''}, ` +
    'so nothing was written over it: their words are not yours to replace. ' +
    `Read what is there with email.read_draft { draftId: "${draft.id}" }, and if a change is still needed, ` +
    'say what you would change and let the owner decide — on the Email page they can edit it themselves, or discard it and ask you for a new one.'
  );
}

const readDraftInput = z.object({
  draftId: UUID.describe('The draft to read, by its id.').optional(),
  threadId: UUID.describe('A conversation, to read its live draft instead.').optional(),
  includeOlder: z
    .boolean()
    .optional()
    .describe('With `threadId`: also list the sent, discarded and lapsed drafts on that conversation.'),
});

export const readDraft: ToolDefinition<z.infer<typeof readDraftInput>, unknown> = {
  name: 'email.read_draft',
  description:
    "Read a draft as it stands now — including one the owner has edited. Give a draft id, or a thread id to read that conversation's live draft. Read before rewriting: email.draft_reply will not write over a draft the owner has edited, and this is how you find out what they said.",
  tier: 'auto',
  input: readDraftInput,
  async execute(input, ctx) {
    if (!input.draftId && !input.threadId) {
      throw new Error('email.read_draft: give either a draftId or a threadId');
    }
    const record = input.draftId
      ? await requireDraft(ctx.db, input.draftId)
      : await liveDraftForThread(ctx.db, input.threadId as string);
    if (!record) {
      return {
        draft: null,
        note: 'That conversation has no live draft. email.draft_reply would write a new one.',
      };
    }
    const account = record.accountId ? await accountOf(ctx.db, record.accountId) : null;
    const identity = {
      from: account ? identityFor(account) : '',
      account: account ? account.address : '',
    };
    const older =
      input.includeOlder && record.threadId
        ? (await listDraftsForThread(ctx.db, record.threadId))
            .filter((d) => d.id !== record.id)
            .map((d) => draftView(d, identity, ''))
        : undefined;
    return {
      draft: draftView(
        record,
        identity,
        record.editedBy === OWNER_EDITOR
          ? 'These are the owner\'s own words. Do not rewrite them without being asked to.'
          : 'Nothing has been sent. A draft only leaves the machine through email.send, which the owner must approve.',
      ),
      ...(older ? { olderDrafts: older } : {}),
    };
  },
};
