/** The `mcp` schema: connections and the tools each one brought, as reviewed. */
import type { Pool, PoolClient } from 'pg';
import type { JSONSchema7 } from '@buddi/core/plugin';
import type { ServerTool, ToolTier } from './tiers.js';

export type ConnectionState = 'connected' | 'needs-reconnect' | 'unreachable' | 'pending-review' | 'needs-review';
export type Queryable = Pick<Pool, 'query'> | PoolClient;
/** How a connection signs in: not at all, OAuth, or a token the owner pasted. */
export type AuthKind = 'none' | 'oauth' | 'token';
/** How buddi speaks to it: over https, or to a program it starts on this computer. */
export type TransportKind = 'http' | 'stdio';

/** One variable a program is started with: its value, or the owner secret that holds it. */
export type ProgramEnvEntry = { name: string; value: string } | { name: string; secretRef: string };

/** A program on this computer, as the owner gave it. */
export interface ProgramSpec {
  command: string;
  args: string[];
  env: ProgramEnvEntry[];
}

export interface ConnectionRow {
  id: string;
  slug: string | null;
  name: string;
  url: string;
  host: string;
  transport: TransportKind;
  /** A program's command, arguments and variables; null for a remote server. */
  program: ProgramSpec | null;
  /** The program as it was last reviewed (`specHash`); null before a review, and for a remote server. */
  reviewedSpec: string | null;
  state: ConnectionState;
  authKind: AuthKind;
  /** Token sign-in: the header the token goes in, and the words before it (`Bearer `). */
  tokenHeader: string | null;
  tokenPrefix: string | null;
  clientId: string | null;
  clientSource: 'dynamic' | 'manual' | null;
  vaultRef: string | null;
  serverName: string | null;
  serverVersion: string | null;
  reviewedHash: string | null;
  reviewedAt: string | null;
  /** When it stopped answering; null while it answers. */
  unreachableSince: string | null;
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
  /** The server changed or dropped it since the review: not registered until reviewed again. */
  changed: boolean;
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

function program(r: Record<string, unknown>): ProgramSpec | null {
  if (r.transport !== 'stdio' || typeof r.command !== 'string') return null;
  const args = Array.isArray(r.args) ? r.args.map(String) : [];
  const env = Array.isArray(r.env)
    ? (r.env as Array<Record<string, unknown>>).map((e): ProgramEnvEntry => (typeof e.secretRef === 'string'
      ? { name: String(e.name), secretRef: e.secretRef }
      : { name: String(e.name), value: String(e.value ?? '') }))
    : [];
  return { command: r.command, args, env };
}

function connection(r: Record<string, unknown>): ConnectionRow {
  return {
    id: String(r.id), slug: (r.slug as string | null) ?? null, name: String(r.name), url: String(r.url), host: String(r.host),
    transport: r.transport === 'stdio' ? 'stdio' : 'http', program: program(r), reviewedSpec: (r.reviewed_spec as string | null) ?? null,
    state: r.state as ConnectionState, authKind: r.auth_kind as AuthKind,
    tokenHeader: (r.token_header as string | null) ?? null, tokenPrefix: (r.token_prefix as string | null) ?? null,
    clientId: (r.client_id as string | null) ?? null, clientSource: (r.client_source as ConnectionRow['clientSource']) ?? null,
    vaultRef: (r.vault_ref as string | null) ?? null,
    serverName: (r.server_name as string | null) ?? null, serverVersion: (r.server_version as string | null) ?? null,
    reviewedHash: (r.reviewed_hash as string | null) ?? null, reviewedAt: iso(r.reviewed_at), unreachableSince: iso(r.unreachable_since),
    createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}

function tool(r: Record<string, unknown>): ToolRow {
  return {
    connectionId: String(r.connection_id), name: String(r.name), localName: String(r.local_name),
    description: String(r.description ?? ''), inputSchema: r.input_schema as JSONSchema7,
    annotations: (r.annotations as ToolRow['annotations']) ?? null, tier: r.tier as ToolTier,
    destructive: r.destructive === true, enabled: r.enabled === true, reviewedHash: String(r.reviewed_hash), changed: r.changed === true,
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

/** A program on this computer, recorded before it is ever started. */
export async function insertProgram(db: Queryable, input: { name: string; url: string; host: string }): Promise<ConnectionRow> {
  const { rows } = await db.query(
    `insert into mcp.connections (name, url, host, auth_kind, transport, command, args, env)
     values ($1, $2, $3, 'none', 'stdio', '', '[]'::jsonb, '[]'::jsonb) returning *`,
    [input.name, input.url, input.host],
  );
  return connection(rows[0]);
}

export async function updateConnection(db: Queryable, id: string, patch: Partial<{
  slug: string; name: string; state: ConnectionState; clientId: string | null; clientSource: 'dynamic' | 'manual' | null;
  vaultRef: string | null; serverName: string | null; serverVersion: string | null; reviewedHash: string; reviewedAt: Date;
  unreachableSince: Date | null; authKind: AuthKind; tokenHeader: string | null; tokenPrefix: string | null;
  url: string; program: ProgramSpec; reviewedSpec: string | null;
}>): Promise<ConnectionRow | null> {
  const columns: Record<string, string> = {
    slug: 'slug', name: 'name', state: 'state', clientId: 'client_id', clientSource: 'client_source', vaultRef: 'vault_ref',
    serverName: 'server_name', serverVersion: 'server_version', reviewedHash: 'reviewed_hash', reviewedAt: 'reviewed_at', unreachableSince: 'unreachable_since',
    authKind: 'auth_kind', tokenHeader: 'token_header', tokenPrefix: 'token_prefix', url: 'url', reviewedSpec: 'reviewed_spec',
  };
  const sets: string[] = [];
  const values: unknown[] = [id];
  if (patch.program) {
    values.push(patch.program.command, JSON.stringify(patch.program.args), JSON.stringify(patch.program.env));
    sets.push(`command = $${values.length - 2}`, `args = $${values.length - 1}::jsonb`, `env = $${values.length}::jsonb`);
  }
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

/** Mark which reviewed tools the server changed or dropped since the review (all others unchanged). */
export async function markChanged(db: Queryable, connectionId: string, changed: readonly string[]): Promise<void> {
  await db.query(`update mcp.tools set changed = (name = any($2::text[])) where connection_id = $1`, [connectionId, [...changed]]);
}

export async function replaceTools(db: Queryable, connectionId: string, tools: readonly Omit<ToolRow, 'connectionId' | 'changed'>[]): Promise<void> {
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
