import { randomUUID } from 'node:crypto';
import type { ToolContext } from '@buddi/core';

/** Call only at an authenticated owner input boundary, not from jobs, source
 * prompts, delegated tasks, tool outputs or reconstructed assistant messages. */
export function ownerRequestContext(ctx: ToolContext, text: string, id: string = randomUUID()): ToolContext {
  return { ...ctx, ownerRequest: { id, text, expiresAt: Date.now() + 20 * 60_000 } };
}

/** What a resumed run is resuming *for*: the decision, and the turn it came from. */
export interface ApprovalResumption {
  /** The tool the decided action ran, when the caller knows it. */
  tool?: string | undefined;
  /** The owner's original words, when a record still holds them (a group request does). */
  text?: string | undefined;
}

/**
 * The context for a run woken by a decided approval.
 *
 * Deciding an approval is the owner acting, at a keyboard, inside the same
 * conversation — so the run it wakes is an owner request like any other, and a
 * `session` tool narrowed per call works in it instead of failing with
 * `session-not-authorized`. The clock starts at the decision, not at the turn
 * that proposed the action, which may have been waiting for a day.
 *
 * Only an approval resume gets this. No other reason to resume a run exists
 * today; if one is ever added it must not call this, because nothing about it
 * would be the owner speaking.
 *
 * Nothing here loosens the delegate rule: `sessionAuthorized` also demands
 * depth zero and an explicit grant, and the runtime hands a delegate neither.
 */
export function approvalResumeContext(
  ctx: ToolContext,
  resumption: ApprovalResumption,
  id?: string,
): ToolContext {
  const original = resumption.text?.trim();
  const text = original ? original : `approved ${resumption.tool ?? 'action'}`;
  return ownerRequestContext(ctx, text, id);
}
