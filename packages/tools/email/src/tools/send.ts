/**
 * `email.send` — the effect tool. Tier `gated`; the only thing in this plugin
 * that reaches the world.
 *
 * The shape of this file is the approval contract (ARCHITECTURE.md, "Actions
 * and approvals"):
 *
 *  - **`describe` renders the full envelope**, from rows, before any approval is
 *    asked for: every recipient including BCC, the subject, the body text and
 *    its hash, the attachment hashes, and the threading headers. The preview is
 *    rendered *from that object* and from nothing else — never from text the
 *    model wrote — so what the owner reads is what leaves the machine.
 *  - **`execute` is called only by the Executor, only after approval**, and it
 *    is safe to call exactly once per action id. The idempotency key is
 *    `ctx.actionId`, claimed atomically on the draft row: the first claim wins,
 *    a replay of the same action returns the recorded receipt, and a second
 *    action against an already-sent draft is refused.
 *  - **Ambiguity is not failure.** Credentials and the client are resolved
 *    *before* the claim, so a configuration problem never locks a draft. Once
 *    dispatched, a throw leaves the claim in place and records `send_error`:
 *    the attempt is `unknown` and wants review, never a blind retry — RFC 5321
 *    does not offer exactly-once and pretending otherwise is how mail gets sent
 *    twice.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EnvLike } from '../config.js';
import { mailboxAuth } from '../credentials.js';
import { EmailProblemError, type SmtpClientFactory, type SmtpEnvelope } from '../ports.js';
import { mailboxKey } from '../mail.js';
import { DRAFT_COLUMNS, toDraft, type DraftRecord } from '../rows.js';
import { claimDraftForSend, sendRefusalFor } from '../drafts.js';
import type { EffectDescription, GatedToolDefinition, OwnerChoice, ToolContext } from '../types.js';
import { accountOf, findMessage, identityChoices, identityFor, requireDraft, UUID } from './shared.js';

/**
 * The implementation version pinned into the action object.
 *
 * 0.2.0 added `replyAudience`: the envelope now states how a reply's audience
 * compares with the sender-only default, so the preview can say "four people
 * beyond the sender" rather than showing one longer list.
 *
 * 0.3.0 made the sending identity the owner's choice. `from` is the account's
 * own address unless the owner picks otherwise, and `fromChoices` lists what
 * they may pick: no alias is derived from the original's `To`/`Cc` any more,
 * because those are headers the sender writes. It is the envelope's own version
 * and is recorded inside it; the approval is bound to the plugin manifest's
 * version, which has not moved, so approvals already waiting stay valid.
 *
 * The alias became a *control* without moving this version, and deliberately:
 * `toolVersion` is inside the envelope, the envelope is hashed, and the
 * Executor re-describes before dispatch — so bumping it would have refused
 * every `email.send` already waiting for the owner at the moment of the
 * upgrade, each with "the effect changed since its preview" about a change
 * nobody made to the mail. The envelope's *shape* is what this number is
 * about, and it did not change: the same fields, the same `from`, the same
 * `fromChoices`. What changed is where the alternatives are shown — a line of
 * preview prose became an `EffectDescription.choices` entry the card draws as
 * a select, and `execute` reads the answer from `ctx.choices.from`. Neither is
 * part of the envelope.
 *
 * Move it when a field appears, disappears or changes meaning. Not for
 * presentation.
 */
export const SEND_TOOL_VERSION = '0.3.0';

/** The key of the identity control. One name, used by the tool and its tests. */
export const FROM_CHOICE_KEY = 'from';

/** One dispatch's budget. Past it the Executor marks the attempt `unknown`. */
export const SEND_TIMEOUT_MS = 60_000;

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** An attachment as the envelope names it: identity by hash, not by filename. */
export interface EnvelopeAttachment {
  filename: string | null;
  mime: string;
  sizeBytes: number;
  sha256: string | null;
}

/**
 * How a reply's audience compares with the sender-only default.
 *
 * Present only on a reply, because only a reply *has* a default to differ
 * from. It is derived from the rows, never from anything the model said, and
 * it exists so the owner reads "this goes to four more people" rather than a
 * longer list of addresses that looks like every other list of addresses.
 */
export interface ReplyAudienceSummary {
  /** The message this replies to, as the reply addresses them. */
  sender: string;
  /** Everyone on the reply who is not the sender, To, Cc and Bcc alike. */
  beyondSender: string[];
  /** True when this reply reaches anyone beyond the sender. */
  widened: boolean;
}

/** The immutable effect envelope. Everything the owner is approving. */
export interface SendEnvelope {
  tool: 'email.send';
  toolVersion: string;
  draftId: string;
  accountAddress: string;
  /**
   * The identity this leaves under. The account's own address unless the owner
   * chose one of `fromChoices` on the approval card — never an alias inferred
   * from the original's headers.
   */
  from: string;
  /** Every identity the owner may choose here: the address, then its aliases. */
  fromChoices: string[];
  to: string[];
  cc: string[];
  /** Blind recipients. Always present, always shown: a hidden one is the bug. */
  bcc: string[];
  subject: string;
  bodyText: string;
  bodySha256: string;
  attachments: EnvelopeAttachment[];
  /** Threading headers, so a reply lands in its thread and not in a new one. */
  inReplyTo: string | null;
  references: string[];
  /** How this reply's audience compares with the default. Null on a new message. */
  replyAudience: ReplyAudienceSummary | null;
  /** The draft body's artifact version — the preview is rendered from it. */
  artifactId: string | null;
  createdByAgent: string;
}

function list(addresses: readonly string[]): string {
  return addresses.length === 0 ? '(none)' : addresses.join(', ');
}

/** The human preview. Rendered from the envelope; no model text reaches it. */
export function renderPreview(envelope: SendEnvelope): string {
  const lines = [
    // The identity *and* the mailbox, because with several accounts they are
    // two facts: an alias says who this is from, the account says which
    // mailbox authenticates it and which Sent folder will hold it.
    envelope.from === envelope.accountAddress
      ? `Send mail as ${envelope.from}`
      : `Send mail as ${envelope.from} (from the ${envelope.accountAddress} mailbox)`,
    // The alternatives are not printed here any more. They are a control on the
    // card now (`fromChoice`), and a preview that also listed them would be
    // describing the control rather than the effect — and would go stale the
    // moment the owner moved it.
    '',
    `To:      ${list(envelope.to)}`,
    `Cc:      ${list(envelope.cc)}`,
    `Bcc:     ${list(envelope.bcc)}`,
    `Subject: ${envelope.subject || '(no subject)'}`,
  ];
  // The audience line, immediately under the recipients and before anything
  // else, because a widened reply must not read as a slightly longer list.
  const audience = envelope.replyAudience;
  if (audience) {
    if (!audience.widened) {
      lines.push('Audience: the sender alone — the default for a reply.');
    } else {
      const n = audience.beyondSender.length;
      lines.push(
        `Audience: WIDER THAN A REPLY TO THE SENDER — ${n} ${n === 1 ? 'person' : 'people'} beyond ${audience.sender}:`,
        `         ${audience.beyondSender.join(', ')}`,
      );
    }
  }
  if (envelope.inReplyTo) lines.push(`In-Reply-To: ${envelope.inReplyTo}`);
  lines.push(
    `Attachments: ${
      envelope.attachments.length === 0
        ? 'none'
        : envelope.attachments
            .map((a) => `${a.filename ?? '(unnamed)'} [${a.sha256?.slice(0, 12) ?? 'no hash'}]`)
            .join(', ')
    }`,
    '',
    envelope.bodyText,
    '',
    `body sha256: ${envelope.bodySha256}`,
    `recipients: ${envelope.to.length + envelope.cc.length + envelope.bcc.length} (bcc included)`,
  );
  return lines.join('\n');
}

/**
 * What this reply's audience is, next to the sender-only default.
 *
 * Computed from the draft's own recipient lists rather than from how the draft
 * was asked for: a widening is a widening however it got there — the audience
 * argument, a named extra recipient, or a row edited by hand.
 */
function replyAudienceOf(from: string, draft: DraftRecord): ReplyAudienceSummary {
  const senderKey = mailboxKey(from);
  const beyondSender = [...draft.to, ...draft.cc, ...draft.bcc].filter(
    (address) => mailboxKey(address) !== senderKey,
  );
  return { sender: from, beyondSender, widened: beyondSender.length > 0 };
}

/**
 * The account a draft leaves from, from the draft's own row.
 *
 * Never "the configured account", and never the first one: with several
 * mailboxes the sending identity is the one thing the owner is approving that
 * a lookup could silently get wrong, so it is written at draft time and only
 * read here. A draft whose account was removed since is refused rather than
 * reassigned.
 */
async function sendingAccount(ctx: ToolContext, draft: DraftRecord) {
  if (!draft.accountId) {
    throw new Error(
      `email.send: draft ${draft.id} does not say which mailbox it leaves from; draft the reply again`,
    );
  }
  return accountOf(ctx.buddi!.db, draft.accountId);
}

/** Build the envelope from rows. Pure with respect to the world. */
export async function buildEnvelope(
  ctx: ToolContext,
  draftId: string,
): Promise<SendEnvelope> {
  const draft = await requireDraft(ctx.buddi!.db, draftId);
  /*
   * docs/specs/email.md §8: a draft that is discarded or lapsed is refused
   * here, at describe time — before an approval card is ever put in front of
   * the owner, and again on the Executor's re-describe, which is what makes a
   * draft discarded while the card was open refuse instead of send.
   *
   * It throws rather than returning a refusal object because `describe` has
   * exactly one way to say no, and the Executor turns a throwing re-describe
   * into `refused` with this sentence in it — the action is marked as never
   * having been attempted, which is the truth.
   */
  const refusal = sendRefusalFor(draft, ctx.actionId ?? null);
  if (refusal) throw new Error(refusal);
  const account = await sendingAccount(ctx, draft);
  const original = draft.inReplyTo ? await findMessage(ctx.buddi!.db, draft.inReplyTo) : null;
  const references = original?.threadKey
    ? original.messageId && original.messageId !== original.threadKey
      ? [original.threadKey, original.messageId]
      : [original.threadKey]
    : original?.messageId
      ? [original.messageId]
      : [];

  return {
    tool: 'email.send',
    toolVersion: SEND_TOOL_VERSION,
    draftId: draft.id,
    accountAddress: account.address,
    // docs/specs/email.md §4, identity: the account's own address, and one of its
    // aliases only when the owner says so on the card. Nothing is read off the
    // original's To or Cc — a sender can write any address there, including an
    // alias of the owner's that the message never actually reached. Both the
    // identity and the alternatives are in the envelope the approval is bound
    // to, so the owner reads what will be on the wire and what else it could be.
    from: identityFor(account),
    fromChoices: identityChoices(account),
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    bodyText: draft.bodyText,
    bodySha256: sha256(draft.bodyText),
    // v1 drafts carry no attachments; the field exists because the envelope is
    // what the approval is bound to, and a later attachment must change it.
    attachments: [],
    inReplyTo: original?.messageId ?? null,
    references,
    replyAudience: original ? replyAudienceOf(original.from, draft) : null,
    artifactId: draft.artifactId,
    createdByAgent: draft.createdByAgent,
  };
}

/**
 * The identity control, or nothing.
 *
 * Declared only when the account actually has an alias to offer: a select with
 * one option is not a choice, it is a fact, and the preview already states it
 * in its first line. The default is the account's own address — the identity
 * that is certainly the owner's to send as — so an approval decided anywhere
 * that draws no control at all sends exactly what the preview says it will.
 */
export function fromChoice(envelope: SendEnvelope): OwnerChoice | null {
  if (envelope.fromChoices.length < 2) return null;
  return {
    key: FROM_CHOICE_KEY,
    label: 'Send as',
    options: [...envelope.fromChoices],
    // The default is taken from the list itself, not from `envelope.from`.
    // They agree for every account this build writes — both the settings page
    // and the `.env` seed normalize the address on the way in — but a row put
    // in by hand with a capitalised address would put `from` outside
    // `fromChoices`, `validateDeclaredChoices` would throw inside
    // `createAction`, and *every* send from that mailbox would fail before it
    // ever reached a card. `fromChoices[0]` is the account's own address by
    // construction (`identityChoices`), which is what the default means.
    default: envelope.fromChoices.includes(envelope.from)
      ? envelope.from
      : (envelope.fromChoices[0] as string),
  };
}

/**
 * The identity this send will actually leave under.
 *
 * `ctx.choices` has already been validated by core against the menu the action
 * declared, but this checks it again against the envelope the approval is bound
 * to — the one object that certainly says what the owner was shown. A value
 * that is not on it is refused rather than sent under: it is the identity of
 * the message, and the whole reason the alias stopped being derived from
 * headers is that nobody should be able to pick it but the owner.
 */
export function chosenIdentity(
  envelope: SendEnvelope,
  choices: Readonly<Record<string, string>> | undefined,
): string {
  const chosen = choices?.[FROM_CHOICE_KEY];
  if (chosen === undefined) return envelope.from;
  if (!envelope.fromChoices.includes(chosen)) {
    throw new Error(
      `email.send: ${chosen} is not one of the identities this approval offered (${envelope.fromChoices.join(', ')})`,
    );
  }
  return chosen;
}

/**
 * Refuse, in the owner's own terms, when the draft moved under a standing
 * approval (docs/specs/email.md §8).
 *
 * The Executor already catches this: it re-describes before dispatch and
 * compares envelope hashes, and a changed body changes both `bodySha256` and
 * `artifactId`. What it cannot do is *say* what changed — "the effect changed
 * since its preview" is true of a subject, a recipient and a whole rewritten
 * letter alike. So the tool says it, here, in the one place that knows what
 * these fields mean, and the Executor's refusal carries that sentence.
 *
 * It runs only when there is an approved envelope to compare against, so the
 * first describe — the one that *creates* the approval — is untouched.
 */
export function assertUnchangedSinceApproval(envelope: SendEnvelope, ctx: ToolContext): void {
  const approved = ctx.approvedEffect?.envelope as SendEnvelope | undefined;
  if (!approved || approved.tool !== 'email.send') return;
  if (approved.artifactId !== envelope.artifactId) {
    throw new Error(
      `email.send: draft ${envelope.draftId} has been edited since you approved it — ` +
        'the body you approved is a different version of this draft. Nothing was sent; approve the new one.',
    );
  }
  if (approved.bodySha256 !== envelope.bodySha256) {
    throw new Error(
      `email.send: the body of draft ${envelope.draftId} has changed since you approved it ` +
        `(approved ${approved.bodySha256.slice(0, 12)}, now ${envelope.bodySha256.slice(0, 12)}). Nothing was sent.`,
    );
  }
}

const sendInput = z.object({
  draftId: UUID.describe('The draft to send, by the id email.draft_reply or email.draft_new gave you.'),
});

export type SendInput = z.infer<typeof sendInput>;

export interface SendToolOptions {
  /** How an SMTP client is made. Injected so the tests never open a socket. */
  send: SmtpClientFactory;
  /** Where the named secret is read from. Never read ambiently. */
  env?: EnvLike;
}

/** What a send returns to the run that proposed it. */
export interface SendResult {
  draftId: string;
  actionId: string;
  messageId: string;
  response: string;
  accepted: string[];
  rejected: string[];
  sentAt: string | null;
  /** True when this call replayed an action that had already been executed. */
  replayed: boolean;
}

function receipt(draft: DraftRecord, actionId: string, replayed: boolean): SendResult {
  return {
    draftId: draft.id,
    actionId,
    messageId: draft.sentMessageId ?? '',
    response: draft.sentResponse ?? '',
    accepted: [...draft.to, ...draft.cc, ...draft.bcc],
    rejected: [],
    sentAt: draft.sentAt,
    replayed,
  };
}

export function createSendTool(
  opts: SendToolOptions,
): GatedToolDefinition<SendInput, SendResult, SendEnvelope> {
  return {
    name: 'email.send',
    description:
      'Send a draft. This is irreversible and always needs the owner\'s approval: the owner sees every recipient — including blind copies — the subject, the whole body and its hash before deciding. Never promise that a message has been sent; propose the send and report what the owner decided.',
    tier: 'gated',
    timeoutMs: SEND_TIMEOUT_MS,
    input: sendInput,

    async describe(input, ctx): Promise<EffectDescription & { envelope: SendEnvelope }> {
      const envelope = await buildEnvelope(ctx, input.draftId);
      assertUnchangedSinceApproval(envelope, ctx);
      const choices = fromChoice(envelope);
      return {
        envelope,
        preview: renderPreview(envelope),
        ...(choices ? { choices: [choices] } : {}),
      };
    },

    /*
     * The claim, run by the Executor after its re-description and before the
     * ledger row exists (`ToolDefinition.claim`).
     *
     * Everything this guards against is somebody editing the draft while the
     * owner was reading the card. The version the approved envelope named is a
     * clause in the statement, so an edit that landed after the re-description
     * takes the claim away rather than being overtaken by it — and a lost claim
     * settles the approval `refused`, with no effect attempt, because nothing
     * was attempted.
     *
     * Credentials are resolved first, still: a missing secret must refuse
     * before the row is locked to a dead action, not after.
     */
    async claim(input, ctx: ToolContext): Promise<void> {
      const actionId = ctx.actionId?.trim();
      if (!actionId) {
        throw new Error('email.send: no approved action id in the tool context; refusing to send');
      }
      const draft = await requireDraft(ctx.buddi!.db, input.draftId);
      if (draft.sentActionId === actionId && draft.sentAt) return; // a replay

      // Configuration and the envelope are checked *before* the claim, so a
      // missing secret or an effect that no longer matches never leaves a draft
      // locked to an action that will not run.
      const account = await sendingAccount(ctx, draft);
      const auth = await mailboxAuth(ctx, account, opts.env);
      if (!auth.ok) throw new EmailProblemError(auth.problem);
      const envelope = await buildEnvelope(ctx, input.draftId);
      // The tool's own sentence first — "this draft has been edited since you
      // approved it" — because the generic hash refusal underneath is true of a
      // subject, a recipient and a whole rewritten letter alike, and the owner
      // is about to be told their mail did not go.
      assertUnchangedSinceApproval(envelope, ctx);
      ctx.buddi!.approvals.assert(ctx, envelope);

      await claimDraftForSend({
        db: ctx.buddi!.db,
        draftId: input.draftId,
        actionId,
        artifactId: envelope.artifactId,
        now: ctx.buddi!.clock.now(),
      });
    },

    async execute(input, ctx: ToolContext): Promise<SendResult> {
      const actionId = ctx.actionId?.trim();
      if (!actionId) {
        // Fail closed: without an action id there is no idempotency key, and a
        // retry could send the same mail twice.
        throw new Error('email.send: no approved action id in the tool context; refusing to send');
      }

      const found = await requireDraft(ctx.buddi!.db, input.draftId);
      if (found.sentActionId === actionId && found.sentAt) {
        // The same approved action, executed again: hand back the receipt
        // rather than putting a second copy on the wire.
        return receipt(found, actionId, true);
      }

      // Configuration is resolved *before* the claim, so a missing secret or an
      // unimplemented auth mode never leaves a draft locked to a dead action.
      const account = await sendingAccount(ctx, found);
      const auth = await mailboxAuth(ctx, account, opts.env);
      if (!auth.ok) throw new EmailProblemError(auth.problem);

      const envelope = await buildEnvelope(ctx, input.draftId);
      ctx.buddi!.approvals.assert(ctx, envelope);
      if (account.address !== envelope.accountAddress) {
        throw new Error('the sending account changed; propose the send again');
      }
      if (envelope.to.length === 0) {
        throw new Error(`email.send: draft ${found.id} has no recipient`);
      }

      /*
       * The claim. Normally the `claim` hook already took this row a moment
       * ago and this is the same hold asked for again — it is keyed on the
       * action id, so re-taking it is a no-op. It is done here as well rather
       * than assumed, because a tool that trusts a hook to have run is a tool
       * that sends twice the day the hook is skipped, and because `execute` is
       * reachable directly.
       */
      const claimed = await claimDraftForSend({
        db: ctx.buddi!.db,
        draftId: input.draftId,
        actionId,
        artifactId: envelope.artifactId,
        now: ctx.buddi!.clock.now(),
      });
      if (claimed === 'replayed') return receipt(await requireDraft(ctx.buddi!.db, input.draftId), actionId, true);
      const draft = claimed;

      // The identity the owner picked on the card, or the envelope's default.
      const from = chosenIdentity(envelope, ctx.choices);
      const wire: SmtpEnvelope = {
        from,
        to: envelope.to,
        cc: envelope.cc,
        bcc: envelope.bcc,
        subject: envelope.subject,
        text: envelope.bodyText,
        inReplyTo: envelope.inReplyTo,
        references: envelope.references,
      };

      const client = await opts.send(account, auth.value);
      const onAbort = (): void => { void client.close().catch(() => {}); };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        ctx.signal?.throwIfAborted();
        const result = await client.send(wire);
        const { rows } = await ctx.buddi!.db.query(
          `update email.drafts
              set sent_at = $2, sent_message_id = $3, sent_response = $4, send_error = null,
                  status = 'sent', updated_at = $2
            where id = $1
          returning ${DRAFT_COLUMNS}`,
          [draft.id, ctx.buddi!.clock.now(), result.messageId, result.response],
        );
        const sent = toDraft(rows[0] as Record<string, unknown>);
        return {
          draftId: sent.id,
          actionId,
          messageId: result.messageId,
          response: result.response,
          accepted: result.accepted,
          rejected: result.rejected,
          sentAt: sent.sentAt,
          replayed: false,
        };
      } catch (err) {
        // The claim stays. Whether the message left is genuinely unknown, and
        // an unknown attempt is reviewed by the owner, never retried blindly.
        const message = err instanceof Error ? err.message : String(err);
        await ctx.buddi!.db
          .query(`update email.drafts set send_error = $2 where id = $1`, [draft.id, message])
          .catch(() => {});
        throw new Error(
          `email.send: dispatch for draft ${draft.id} did not complete cleanly (${message}); ` +
            'the attempt is unknown — whether it was delivered needs checking before any retry',
          { cause: err },
        );
      } finally {
        ctx.signal?.removeEventListener('abort', onAbort);
        await client.close().catch(() => {});
      }
    },
  };
}
