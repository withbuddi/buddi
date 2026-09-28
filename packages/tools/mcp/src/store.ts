/** The `mcp` schema: connections and the tools each one brought, as reviewed. */
import type { Pool, PoolClient } from 'pg';
import type { JSONSchema7 } from '@buddi/core/plugin';
import type { ServerTool, ToolTier } from './tiers.js';

export type ConnectionState = 'connected' | 'needs-reconnect' | 'unreachable' | 'pending-review';
export type Queryable = Pick<Pool, 'query'> | PoolClient;

export interface ConnectionRow {
  id: string;
  slug: string | null;
  name: string;
  url: string;
  host: string;
  state: ConnectionState;
  authKind: 'none' | 'oauth';
  clientId: string | null;
  clientSource: 'dynamic' | 'manual' | null;
  vaultRef: string | null;
  serverName: string | null;
  serverVersion: string | null;
  reviewedHash: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolRow {
  connectionId: string;
  name: string;
  localName: string;
  description: string;
  inputSchema: JSONSchema7;
  annotations: ServerTool['annotations'] | null;
  tier: ToolTier;
  destructive: boolean;
  enabled: boolean;
  reviewedHash: string;
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

function connection(r: Record<string, unknown>): ConnectionRow {
  return {
    id: String(r.id), slug: (r.slug as string | null) ?? null, name: String(r.name), url: String(r.url), host: String(r.host),
    state: r.state as ConnectionState, authKind: r.auth_kind as 'none' | 'oauth',
    clientId: (r.client_id as string | null) ?? null, clientSource: (r.client_source as ConnectionRow['clientSource']) ?? null,
    vaultRef: (r.vault_ref as string | null) ?? null,
    serverName: (r.server_name as string | null) ?? null, serverVersion: (r.server_version as string | null) ?? null,
    reviewedHash: (r.reviewed_hash as string | null) ?? null, reviewedAt: iso(r.reviewed_at),
    createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}

function tool(r: Record<string, unknown>): ToolRow {
  return {
    connectionId: String(r.connection_id), name: String(r.name), localName: String(r.local_name),
    description: String(r.description ?? ''), inputSchema: r.input_schema as JSONSchema7,
    annotations: (r.annotations as ToolRow['annotations']) ?? null, tier: r.tier as ToolTier,
    destructive: r.destructive === true, enabled: r.enabled === true, reviewedHash: String(r.reviewed_hash),
  };
}

export async function listConnections(db: Queryable): Promise<ConnectionRow[]> {
  const { rows } = await db.query(`select * from mcp.connections order by created_at`);
  return rows.map(connection);
}

export async function getConnection(db: Queryable, id: string): Promise<ConnectionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db.query(`select * from mcp.connections where id = $1`, [id]);
  return rows[0] ? connection(rows[0]) : null;
}

export async function insertConnection(db: Queryable, input: {
  name: string; url: string; host: string; authKind: 'none' | 'oauth'; serverName: string | null; serverVersion: string | null;
}): Promise<ConnectionRow> {
  const { rows } = await db.query(
    `insert into mcp.connections (name, url, host, auth_kind, server_name, server_version)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [input.name, input.url, input.host, input.authKind, input.serverName, input.serverVersion],
  );
  return connection(rows[0]);
}

export async function updateConnection(db: Queryable, id: string, patch: Partial<{
  slug: string; name: string; state: ConnectionState; clientId: string | null; clientSource: 'dynamic' | 'manual' | null;
  vaultRef: string | null; serverName: string | null; serverVersion: string | null; reviewedHash: string; reviewedAt: Date;
}>): Promise<ConnectionRow | null> {
  const columns: Record<string, string> = {
    slug: 'slug', name: 'name', state: 'state', clientId: 'client_id', clientSource: 'client_source', vaultRef: 'vault_ref',
    serverName: 'server_name', serverVersion: 'server_version', reviewedHash: 'reviewed_hash', reviewedAt: 'reviewed_at',
  };
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !(key in columns)) continue;
    values.push(value);
    sets.push(`${columns[key]} = $${values.length}`);
  }
  const { rows } = await db.query(
    `update mcp.connections set ${[...sets, 'updated_at = now()'].join(', ')} where id = $1 returning *`,
    values,
  );
  return rows[0] ? connection(rows[0]) : null;
}

export async function deleteConnection(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`delete from mcp.connections where id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

export async function slugTaken(db: Queryable, slug: string, except: string): Promise<boolean> {
  const { rows } = await db.query(`select 1 from mcp.connections where slug = $1 and id <> $2`, [slug, except]);
  return rows.length > 0;
}

export async function listTools(db: Queryable, connectionId?: string): Promise<ToolRow[]> {
  const { rows } = connectionId
    ? await db.query(`select * from mcp.tools where connection_id = $1 order by local_name`, [connectionId])
    : await db.query(`select * from mcp.tools order by connection_id, local_name`);
  return rows.map(tool);
}

export async function replaceTools(db: Queryable, connectionId: string, tools: readonly Omit<ToolRow, 'connectionId'>[]): Promise<void> {
  await db.query(`delete from mcp.tools where connection_id = $1`, [connectionId]);
  for (const t of tools) {
    await db.query(
      `insert into mcp.tools (connection_id, name, local_name, description, input_schema, annotations, tier, destructive, enabled, reviewed_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [connectionId, t.name, t.localName, t.description, JSON.stringify(t.inputSchema), t.annotations ? JSON.stringify(t.annotations) : null,
        t.tier, t.destructive, t.enabled, t.reviewedHash],
    );
  }
}
