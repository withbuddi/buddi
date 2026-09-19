import type { Queryable } from '../owner.js';
import type { ToolContext } from '../tools.js';
import { emitActionEvent } from './store.js';

export type PermissionScope = 'once' | 'conversation' | 'always';
export interface ToolPermission {
  id: string; ownerId: string; agentId: string; tool: string;
  toolVersion: string; conversationId: string; createdAt: string;
}
function view(row: any): ToolPermission {
  return { id: row.id, ownerId: row.owner_id, agentId: row.agent_id,
    tool: row.tool, toolVersion: row.tool_version, conversationId: row.conversation_id,
    createdAt: new Date(row.created_at).toISOString() };
}
export async function listToolPermissions(pool: Queryable, ownerId: string): Promise<ToolPermission[]> {
  const { rows } = await pool.query('select * from core.tool_permissions where owner_id = $1 order by created_at', [ownerId]);
  return rows.map(view);
}
export async function findToolPermission(pool: Queryable, ctx: ToolContext, tool: string, version: string): Promise<ToolPermission | undefined> {
  if (!ctx.agentId || !ctx.conversationId || (ctx.delegationDepth ?? 0) > 0) return undefined;
  const { rows } = await pool.query(`select * from core.tool_permissions
    where owner_id=$1 and agent_id=$2 and tool=$3 and tool_version=$4
      and conversation_id in ('', $5) order by conversation_id desc limit 1`,
  [ctx.ownerId, ctx.agentId, tool, version, ctx.conversationId]);
  return rows[0] ? view(rows[0]) : undefined;
}
export async function revokeToolPermission(pool: Queryable, ownerId: string, id: string): Promise<boolean> {
  const { rows } = await pool.query('delete from core.tool_permissions where owner_id=$1 and id=$2 returning *', [ownerId, id]);
  if (rows[0]) await emitActionEvent(pool, 'permission.revoked', { id, ownerId, agentId: rows[0].agent_id, tool: rows[0].tool }, rows[0].conversation_id || null);
  return rows.length > 0;
}
