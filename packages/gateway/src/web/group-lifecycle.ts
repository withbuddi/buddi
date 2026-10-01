/**
 * The end of a group's life, from the dashboard: deleting it (softly, with a
 * minute to undo, then for good) and clearing its history (docs/groups.md,
 * "Deleting a group").
 *
 * Both first stop whatever the group is doing. A coordinator mid-turn, or a
 * member's approval waiting on Telegram, must not outlive the room it speaks
 * in: the request is stopped and its pending approval rejected, exactly as
 * the composer's Stop does, so a late decision anywhere finds it decided.
 */
import { forgetScope, groupScope } from '@buddi/tool-memory';
import { decideApproval, openGroupRequestForGroup, purgeDeletedGroups, setGroupRequestState } from '@buddi/core';

type Queryable = { query(sql: string, params?: any[]): Promise<{ rows: any[] }> };

/** Stop the group's open request, if it has one. With no chat running, the row is closed directly. */
export async function stopGroupWork(
  pool: Queryable,
  chat: { stopGroupRequest(conversationId: string): Promise<boolean> } | undefined,
  groupId: string,
  now: Date,
  ownerId: string,
): Promise<void> {
  const open = await openGroupRequestForGroup(pool, groupId);
  if (!open) return;
  if (chat && (await chat.stopGroupRequest(open.conversationId))) return;
  if (!(await setGroupRequestState(pool, open.id, { state: 'stopped', from: ['running', 'suspended'], finishedAt: now }))) return;
  if (open.awaitingActionId) {
    await decideApproval(pool as never, { actionId: open.awaitingActionId, decision: 'rejected', by: ownerId, via: 'web', now }).catch(() => {});
  }
}

/**
 * Remove for good the groups whose undo window has passed, and forget what
 * their rooms remembered. Never throws: a failure is logged and the next
 * call tries again. An installation without the memory schema has no room
 * memory to forget.
 */
export async function purgeGroups(pool: Queryable, now: Date, log: (line: string) => void): Promise<void> {
  try {
    const gone = await purgeDeletedGroups(pool, now);
    for (const id of gone) {
      await forgetScope(pool, { scope: groupScope(id), now }).catch((err: unknown) => {
        if ((err as { code?: string }).code !== '42P01') log(`groups: forgetting the memory of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  } catch (err) {
    log(`groups: removing deleted groups failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
