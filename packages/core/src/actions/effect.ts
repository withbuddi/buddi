import type { ToolContext } from '../tools.js';
import { hashEnvelope } from './types.js';

/**
 * Recheck resolved state immediately before dispatch, then execute from that
 * checked snapshot. Plugins with mutable inputs call this after their final
 * read; re-describing in the executor alone cannot close that race.
 */
export function assertApprovedEffect(ctx: ToolContext, envelope: unknown): void {
  ctx.signal?.throwIfAborted();
  if (!ctx.approvedEffect || hashEnvelope(envelope) !== hashEnvelope(ctx.approvedEffect.envelope)) {
    throw new Error('the effect no longer matches the approved preview; propose it again');
  }
}
