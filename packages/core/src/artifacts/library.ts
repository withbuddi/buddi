/**
 * Files: the owner's library over the artifact store (docs/files.md).
 *
 * A read-only projection for a person: what a file is, where it came from,
 * which conversations used it. Nothing here touches bytes, and nothing here
 * is an agent tool. The one write is the association a runner records when
 * it writes a reference — `recordArtifactUse` — so the library never lags
 * the transcript.
 */
import { createHash } from 'node:crypto';
import { OWNER_ID } from '../owner.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What may be previewed as text: genuinely textual formats, by mime or by
 * extension, and nothing that is a binary container however it is named.
 * Display family is a different question — a .docx is a Document to look at
 * and download-only to preview.
 */
const TEXT_MIMES = new Set(['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/toml', 'application/sql']);
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml', 'sql', 'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'swift', 'sh', 'log', 'ini', 'conf', 'env']);
const NEVER_TEXT_EXTS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'numbers', 'pages', 'key', 'rtf', 'odt', 'ods', 'odp']);
export function textPreviewable(mime: string, filename?: string | null): boolean {
  const value = (mime || '').toLowerCase().split(';')[0]!.trim();
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? '';
  if (NEVER_TEXT_EXTS.has(ext)) return false;
  if (value.startsWith('text/')) return true;
  if (TEXT_MIMES.has(value)) return true;
  return (value === 'application/octet-stream' || value === '') && TEXT_EXTS.has(ext);
}

type Queryable = { query(sql: string, params?: any[]): Promise<{ rows: any[] }> };

/** The families a person tells apart at a glance. The same list as the page draws. */
export type FileFamily = 'image' | 'pdf' | 'table' | 'text' | 'code' | 'audio' | 'video' | 'archive' | 'file';
export const FILE_FAMILIES: readonly FileFamily[] = ['image', 'pdf', 'table', 'text', 'code', 'audio', 'video', 'archive', 'file'];

const TABLE_EXT = ['csv', 'tsv', 'xls', 'xlsx', 'numbers'];
const ARCHIVE_EXT = ['zip', 'gz', 'tgz', 'rar', '7z'];
const CODE_EXT = ['ts', 'tsx', 'js', 'py', 'rb', 'go', 'rs', 'swift', 'json', 'yaml', 'yml', 'toml', 'sh', 'sql', 'html', 'css'];
const TEXT_EXT = ['md', 'txt', 'rtf', 'doc', 'docx'];

export function familyOf(mime: string, filename?: string | null): FileFamily {
  const value = (mime || '').toLowerCase();
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? '';
  if (value.startsWith('image/')) return 'image';
  if (value === 'application/pdf') return 'pdf';
  if (value.startsWith('audio/')) return 'audio';
  if (value.startsWith('video/')) return 'video';
  if (value === 'text/csv' || value === 'text/tab-separated-values' || value.includes('spreadsheet') || value.includes('excel') || TABLE_EXT.includes(ext)) return 'table';
  if (value.includes('zip') || value.includes('tar') || value.includes('compressed') || ARCHIVE_EXT.includes(ext)) return 'archive';
  if (value === 'application/json' || value.includes('javascript') || value.includes('xml') || CODE_EXT.includes(ext)) return 'code';
  if (value.startsWith('text/') || TEXT_EXT.includes(ext)) return 'text';
  return 'file';
}

/**
 * The same classification as SQL, so a family filter runs in the database.
 * `$m` is the lower-cased mime, `$e` the lower-cased extension.
 */
function familySql(m: string, e: string): string {
  const inList = (xs: string[]): string => xs.map((x) => `'${x}'`).join(', ');
  return `case
    when ${m} like 'image/%' then 'image'
    when ${m} = 'application/pdf' then 'pdf'
    when ${m} like 'audio/%' then 'audio'
    when ${m} like 'video/%' then 'video'
    when ${m} in ('text/csv', 'text/tab-separated-values') or ${m} like '%spreadsheet%' or ${m} like '%excel%' or ${e} in (${inList(TABLE_EXT)}) then 'table'
    when ${m} like '%zip%' or ${m} like '%tar%' or ${m} like '%compressed%' or ${e} in (${inList(ARCHIVE_EXT)}) then 'archive'
    when ${m} = 'application/json' or ${m} like '%javascript%' or ${m} like '%xml%' or ${e} in (${inList(CODE_EXT)}) then 'code'
    when ${m} like 'text/%' or ${e} in (${inList(TEXT_EXT)}) then 'text'
    else 'file' end`;
}
const FAMILY_EXPR = familySql('lower(a.mime)', "lower(coalesce(substring(a.filename from '\\.([A-Za-z0-9]+)$'), ''))");

export type FileOrigin = 'uploaded' | 'produced' | 'unknown';

export interface LibraryEntry {
  id: string;
  filename: string | null;
  mime: string;
  family: FileFamily;
  sizeBytes: number;
  createdAt: string;
  origin: FileOrigin;
  /** The agent responsible when one is known: who produced, or who saved, it. */
  agentId: string | null;
  /** Whether the bytes are still on disk is the caller's to check; the row says deleted. */
  deleted: boolean;
  /** How many conversations used it. */
  contexts: number;
  /** The first conversation it was part of: the agent, or the group, it was with. */
  context: { agentId: string | null; groupName: string | null } | null;
}

export interface LibraryContext {
  conversationId: string;
  kind: 'uploaded' | 'produced' | 'reused';
  agentId: string | null;
  /** The conversation's agent, or the group it belongs to. */
  conversationAgentId: string;
  groupId: string | null;
  groupName: string | null;
  at: string;
}

export interface ListLibraryOptions {
  q?: string;
  origin?: FileOrigin;
  family?: FileFamily;
  limit?: number;
  /** Opaque, from the previous page. */
  cursor?: string;
}

export const LIBRARY_PAGE = 50;
export const LIBRARY_PAGE_MAX = 100;

/** The filters a cursor was issued under; a cursor reused with others is refused. */
export function filterKey(input: { q?: string; origin?: string; family?: string }): string {
  return createHash('sha256').update(JSON.stringify([input.q?.trim() ?? '', input.origin ?? '', input.family ?? ''])).digest('base64url').slice(0, 16);
}

/** `created_at|id|filters`, base64. Bound to the ordering and to the filters it was issued under. */
export function encodeCursor(createdAt: string, id: string, filters: string): string {
  return Buffer.from(`${createdAt}|${id}|${filters}`, 'utf8').toString('base64url');
}
export function decodeCursor(cursor: string, filters?: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id, key] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!createdAt || !id || !key || Number.isNaN(Date.parse(createdAt)) || !UUID.test(id)) return null;
    if (filters !== undefined && key !== filters) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Origin, from what the row says and what a trusted use recorded: the owner's
 * id is an upload; an agent the catalog knows, or a recorded production by
 * any agent, is produced — so a retired agent's outputs stay produced; anything
 * else is unknown, never guessed from a filename or a missing surface.
 */
function originSql(createdBy: string, knownAgents: string): string {
  return `case
    when ${createdBy} in ('owner', '${OWNER_ID}') then 'uploaded'
    when ${createdBy} = any(${knownAgents}) then 'produced'
    when exists (select 1 from core.artifact_uses pu where pu.artifact_id = a.id and pu.kind = 'produced') then 'produced'
    else 'unknown' end`;
}

/**
 * What is in the library at all, for the list and the detail alike: a live
 * row, and — when the owner uploaded it — one that a message carries or a
 * surface other than the dashboard's own tray accepted. A draft in a tray is
 * not a file yet.
 */
function membershipSql(knownAgents: string): string {
  return `a.deleted_at is null and not (
    (${originSql('a.created_by', knownAgents)}) = 'uploaded'
    and not exists (select 1 from core.artifact_uses u where u.artifact_id = a.id)
    and not exists (select 1 from core.surface_attachments sa where sa.artifact_id = a.id::text and sa.surface <> 'web')
  )`;
}

export async function listLibrary(
  pool: Queryable,
  input: ListLibraryOptions & { knownAgentIds: readonly string[] },
): Promise<{ entries: LibraryEntry[]; next: string | null }> {
  const limit = Math.min(LIBRARY_PAGE_MAX, Math.max(1, input.limit ?? LIBRARY_PAGE));
  const params: any[] = [input.knownAgentIds];
  const where: string[] = [membershipSql('$1::text[]')];
  const key = filterKey(input);
  if (input.q && input.q.trim() !== '') {
    params.push(`%${input.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    where.push(`a.filename ilike $${params.length} escape '\\'`);
  }
  const origin = originSql('a.created_by', '$1::text[]');
  if (input.origin) {
    params.push(input.origin);
    where.push(`(${origin}) = $${params.length}`);
  }
  if (input.family) {
    params.push(input.family);
    where.push(`(${FAMILY_EXPR}) = $${params.length}`);
  }
  const cursor = input.cursor ? decodeCursor(input.cursor, key) : null;
  if (input.cursor && !cursor) throw new Error('cursor: not one this listing issued');
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const { rows } = await pool.query(
    `select a.id, a.filename, a.mime, a.size_bytes, a.created_at, a.created_at::text as created_at_exact, a.created_by, a.deleted_at,
            (${origin}) as origin,
            (${FAMILY_EXPR}) as family,
            (select count(distinct u.conversation_id)::int from core.artifact_uses u where u.artifact_id = a.id) as contexts,
            (select u.agent_id from core.artifact_uses u where u.artifact_id = a.id and u.agent_id is not null order by u.created_at asc limit 1) as use_agent,
            ${CONTEXT_EXPR}
       from core.artifacts a
      where ${where.join(' and ')}
      order by a.created_at desc, a.id desc
      limit $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  // The cursor carries the timestamp as the database wrote it, microseconds
  // and all: a JavaScript Date keeps milliseconds, and rows within the lost
  // fraction would fall on the wrong side of the next page's predicate.
  return {
    entries: page.map(toEntry),
    next: rows.length > limit && last ? encodeCursor(String(last.created_at_exact), String(last.id), key) : null,
  };
}

export const CONTEXTS_PAGE = 50;

export async function getLibraryEntry(
  pool: Queryable,
  id: string,
  knownAgentIds: readonly string[],
  contextsOffset = 0,
): Promise<{ entry: LibraryEntry; contexts: LibraryContext[]; contextsTotal: number; contextsOffset: number } | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query(
    `select a.id, a.filename, a.mime, a.size_bytes, a.created_at, a.created_by, a.deleted_at,
            (${originSql('a.created_by', '$2::text[]')}) as origin,
            (${FAMILY_EXPR}) as family,
            (select count(distinct u.conversation_id)::int from core.artifact_uses u where u.artifact_id = a.id) as contexts,
            (select u.agent_id from core.artifact_uses u where u.artifact_id = a.id and u.agent_id is not null order by u.created_at asc limit 1) as use_agent,
            ${CONTEXT_EXPR}
       from core.artifacts a
      where a.id = $1::uuid and ${membershipSql('$2::text[]')}`,
    [id, knownAgentIds],
  );
  if (!rows[0]) return null;
  const offset = Math.max(0, Math.trunc(contextsOffset));
  const { rows: uses } = await pool.query(
    `select u.conversation_id, u.kind, u.agent_id, u.created_at, c.agent_id as conversation_agent, c.group_id, g.name as group_name,
            count(*) over () as total
       from core.artifact_uses u
       join core.conversations c on c.id = u.conversation_id
       left join core.groups g on g.id = c.group_id
      where u.artifact_id = $1::uuid
      order by u.created_at desc, u.conversation_id, u.kind
      limit $2 offset $3`,
    [id, CONTEXTS_PAGE, offset],
  );
  return {
    entry: toEntry(rows[0]),
    contextsTotal: Number(uses[0]?.total ?? 0),
    contextsOffset: offset,
    contexts: uses.map((u) => ({
      conversationId: String(u.conversation_id),
      kind: u.kind,
      agentId: u.agent_id ?? null,
      conversationAgentId: String(u.conversation_agent),
      groupId: u.group_id ? String(u.group_id) : null,
      groupName: u.group_name ?? null,
      at: new Date(u.created_at).toISOString(),
    })),
  };
}

/**
 * The association a runner writes when it writes a reference. Idempotent:
 * the same use recorded twice is one row, and a retry changes nothing.
 */
export async function recordArtifactUse(
  pool: Queryable,
  input: { artifactId: string; conversationId: string; kind: 'uploaded' | 'produced' | 'reused'; agentId?: string | null; at?: Date },
): Promise<void> {
  await pool.query(
    `insert into core.artifact_uses (artifact_id, conversation_id, kind, agent_id, created_at)
     values ($1::uuid, $2::uuid, $3, $4, $5)
     on conflict (artifact_id, conversation_id, kind, coalesce(agent_id, '')) do nothing`,
    [input.artifactId, input.conversationId, input.kind, input.agentId ?? null, input.at ?? new Date()],
  );
}

/** The earliest conversation a file was part of: who it was with. */
const CONTEXT_EXPR = `(select c.agent_id from core.artifact_uses u join core.conversations c on c.id = u.conversation_id where u.artifact_id = a.id order by u.created_at asc limit 1) as context_agent,
            (select g.name from core.artifact_uses u join core.conversations c on c.id = u.conversation_id join core.groups g on g.id = c.group_id where u.artifact_id = a.id order by u.created_at asc limit 1) as context_group`;

function toEntry(row: any): LibraryEntry {
  return {
    id: String(row.id),
    filename: row.filename ?? null,
    mime: String(row.mime),
    family: (FILE_FAMILIES as readonly string[]).includes(row.family) ? row.family : familyOf(String(row.mime), row.filename),
    sizeBytes: Number(row.size_bytes ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    origin: row.origin === 'uploaded' || row.origin === 'produced' ? row.origin : 'unknown',
    agentId: row.origin === 'produced' ? String(row.created_by) : (row.use_agent ?? null),
    deleted: row.deleted_at !== null && row.deleted_at !== undefined,
    contexts: Number(row.contexts ?? 0),
    context: row.context_agent || row.context_group ? { agentId: row.context_agent ?? null, groupName: row.context_group ?? null } : null,
  };
}
