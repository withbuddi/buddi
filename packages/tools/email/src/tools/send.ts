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
import { assertApprovedEffect } from '@buddi/core';
import { currentAccount, resolveAuth, type EnvLike } from '../config.js';
import { EmailProblemError, type SmtpClientFactory, type SmtpEnvelope } from '../ports.js';
import { mailboxKey } from '../mail.js';
import { DRAFT_COLUMNS, toDraft, type DraftRecord } from '../rows.js';
import type { EffectDescription, GatedToolDefinition, ToolContext } from '../types.js';
import { findMessage, requireDraft, UUID } from './shared.js';

/**
 * The implementation version pinned into the action object.
 *
 * 0.2.0 added `replyAudience`: the envelope now states how a reply's audience
 * compares with the sender-only default, so the preview can say "four people
 * beyond the sender" rather than showing one longer list. It is the envelope's
 * own version and is recorded inside it; the approval is bound to the plugin
 * manifest's version, which has not moved, so approvals already waiting stay
 * valid.
 */
export const SEND_TOOL_VERSION = '0.2.0';

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
  from: string;
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
    `Send mail as ${envelope.from}`,
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

/** Build the envelope from rows. Pure with respect to the world. */
export async function buildEnvelope(
  ctx: ToolContext,
  draftId: string,
): Promise<SendEnvelope> {
  const draft = await requireDraft(ctx.db, draftId);
  const account = await currentAccount(ctx.db);
  if (!account) {
    throw new Error('no mail account is configured on this installation');
  }
  const original = draft.inReplyTo ? await findMessage(ctx.db, draft.inReplyTo) : null;
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
    from: account.address,
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
      return { envelope, preview: renderPreview(envelope) };
    },

    async execute(input, ctx: ToolContext): Promise<SendResult> {
      const actionId = ctx.actionId?.trim();
      if (!actionId) {
        // Fail closed: without an action id there is no idempotency key, and a
        // retry could send the same mail twice.
        throw new Error('email.send: no approved action id in the tool context; refusing to send');
      }

      const draft = await requireDraft(ctx.db, input.draftId);
      if (draft.sentActionId && draft.sentActionId !== actionId) {
        throw new Error(
          `email.send: draft ${draft.id} was already sent under action ${draft.sentActionId}; refusing to send it again`,
        );
      }
      if (draft.sentActionId === actionId && draft.sentAt) {
        // The same approved action, executed again: hand back the receipt
        // rather than putting a second copy on the wire.
        return receipt(draft, actionId, true);
      }

      // Configuration is resolved *before* the claim, so a missing secret or an
      // unimplemented auth mode never leaves a draft locked to a dead action.
      const account = await currentAccount(ctx.db);
      if (!account) throw new Error('email.send: no mail account is configured');
      const auth = resolveAuth(account, opts.env ?? process.env);
      if (!auth.ok) throw new EmailProblemError(auth.problem);

      const envelope = await buildEnvelope(ctx, input.draftId);
      assertApprovedEffect(ctx, envelope);
      if (account.address !== envelope.accountAddress) {
        throw new Error('the sending account changed; propose the send again');
      }
      if (envelope.to.length === 0) {
        throw new Error(`email.send: draft ${draft.id} has no recipient`);
      }

      // Atomic claim. Two executors racing on one draft: exactly one proceeds.
      const claim = await ctx.db.query(
        `update email.drafts set sent_action_id = $2
          where id = $1 and sent_action_id is null
        returning ${DRAFT_COLUMNS}`,
        [draft.id, actionId],
      );
      if (claim.rows.length === 0) {
        const current = await requireDraft(ctx.db, draft.id);
        if (current.sentActionId === actionId && current.sentAt) return receipt(current, actionId, true);
        throw new Error(
          `email.send: draft ${draft.id} is already claimed by action ${current.sentActionId}`,
        );
      }

      const wire: SmtpEnvelope = {
        from: envelope.from,
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
        const { rows } = await ctx.db.query(
          `update email.drafts
              set sent_at = $2, sent_message_id = $3, sent_response = $4, send_error = null
            where id = $1
          returning ${DRAFT_COLUMNS}`,
          [draft.id, ctx.now(), result.messageId, result.response],
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
        await ctx.db
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
