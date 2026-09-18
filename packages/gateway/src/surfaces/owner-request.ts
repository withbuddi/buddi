import { randomUUID } from 'node:crypto';
import type { ToolContext } from '@buddi/core';

/** Call only at an authenticated owner input boundary, not from jobs, source
 * prompts, delegated tasks, tool outputs or reconstructed assistant messages. */
export function ownerRequestContext(ctx: ToolContext, text: string, id: string = randomUUID()): ToolContext {
  return { ...ctx, ownerRequest: { id, text, expiresAt: Date.now() + 20 * 60_000 } };
}
