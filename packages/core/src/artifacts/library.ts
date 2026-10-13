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
import { fileVersions } from './store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
const FAMILY_EXPR = familySql('lower(f.mime)', "lower(coalesce(substring(f.name from '\\.([A-Za-z0-9]+)$'), ''))");

export type FileOrigin = 'uploaded' | 'produced' | 'unknown';

export interface LibraryEntry {
  /** The version this entry shows: in a listing, the file's newest. */
  id: string;
  /** The file it is a version of. */
  fileId: string;
  /** That version's number. */
  version: number;
  filename: string | null;
  /** What the file was handed in with, or the label an agent filed a document under. */
  caption: string | null;
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
  /** How many live versions the file has. */
  versions: number;
}

/** One version of a file, newest first, for the file page and the canvas alike. */
export interface LibraryVersion {
  id: string;
  version: number;
  filename: string | null;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  /** Who wrote it: an agent, or `owner` for an upload, a save or a Restore. */
  createdBy: string;
  /** A Restore: the version whose bytes it copies. */
  restoredFrom: number | null;
}

/** A file's versions as both the Files page and the canvas read them. */
export async function libraryVersions(pool: Queryable, fileId: string): Promise<LibraryVersion[]> {
  return (await fileVersions(pool, fileId)).map((v) => ({
    id: v.id,
    version: v.version,
    filename: v.filename,
    createdAt: v.createdAt ?? '',
    sizeBytes: v.sizeBytes,
    sha256: v.sha256,
    createdBy: v.createdBy,
    restoredFrom: v.restoredFrom,
  }));
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

/** The versions of the file `f`, for what was recorded about any of them. */
const VERSION_IDS = `(select v.id from core.artifacts v where v.file_id = f.id)`;

/**
 * Origin, from what the file says and what a trusted use recorded: made by
 * the owner is an upload; made by an agent the catalog knows, or recorded as
 * produced by any agent, is produced — so a retired agent's outputs stay
 * produced; anything else is unknown, never guessed from a filename or a
 * missing surface. Who made the file decides, not who wrote its newest
 * version: the owner's edit of a report keeps it buddi's.
 */
function originSql(knownAgents: string): string {
  return `case
    when f.created_by in ('owner', '${OWNER_ID}') then 'uploaded'
    when f.created_by = any(${knownAgents}) then 'produced'
    when exists (select 1 from core.artifact_uses pu where pu.artifact_id in ${VERSION_IDS} and pu.kind = 'produced') then 'produced'
    else 'unknown' end`;
}

/**
 * What is in the library at all, for the list and the detail alike: a file
 * not deleted, with a live version, and — when the owner uploaded it — one
 * he made in Files itself (`POST /api/files`, surface `files`), one that a
 * message carries, or one a surface other than the dashboard's own tray
 * accepted. A draft in a tray is not a file yet.
 */
function membershipSql(knownAgents: string): string {
  return `f.deleted_at is null and not (
    (${originSql(knownAgents)}) = 'uploaded'
    and not exists (select 1 from core.artifacts v where v.file_id = f.id and v.version = 1 and v.source_surface = 'files')
    and not exists (select 1 from core.artifact_uses u where u.artifact_id in ${VERSION_IDS})
    and not exists (select 1 from core.surface_attachments sa where sa.artifact_id in (select v.id::text from core.artifacts v where v.file_id = f.id) and sa.surface <> 'web')
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
    // The caption is searched too: it holds the label a document was filed under.
    where.push(`(f.name ilike $${params.length} escape '\\' or a.caption ilike $${params.length} escape '\\')`);
  }
  const origin = originSql('$1::text[]');
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
  // One row per file: its newest live version, with how many there are.
  const { rows } = await pool.query(
    `select a.id, f.id as file_id, a.version, f.name as filename, a.caption, f.mime, a.size_bytes, a.created_at, a.created_at::text as created_at_exact,
            f.created_by, f.deleted_at, n.versions,
            (${origin}) as origin,
            (${FAMILY_EXPR}) as family,
            ${USE_EXPR}
       from core.files f
       cross join lateral (select * from core.artifacts a where a.file_id = f.id and a.deleted_at is null order by a.version desc limit 1) a
       cross join lateral (select count(*)::int as versions from core.artifacts v where v.file_id = f.id and v.deleted_at is null) n
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

/**
 * One version of a file (`id`, a version's id; the file's newest when it is
 * the file's id), with the file's versions and the conversations any of them
 * was used in.
 */
export async function getLibraryEntry(
  pool: Queryable,
  id: string,
  knownAgentIds: readonly string[],
  contextsOffset = 0,
): Promise<{ entry: LibraryEntry; contexts: LibraryContext[]; contextsTotal: number; contextsOffset: number; versions: LibraryVersion[] } | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query(
    `select a.id, f.id as file_id, a.version, f.name as filename, a.caption, f.mime, a.size_bytes, a.created_at, f.created_by, f.deleted_at,
            (select count(*)::int from core.artifacts v where v.file_id = f.id and v.deleted_at is null) as versions,
            (${originSql('$2::text[]')}) as origin,
            (${FAMILY_EXPR}) as family,
            ${USE_EXPR}
       from core.files f
       join core.artifacts a on a.file_id = f.id
      where a.deleted_at is null and ${membershipSql('$2::text[]')}
        and (a.id = $1::uuid or (f.id = $1::uuid and a.version = (select max(v.version) from core.artifacts v where v.file_id = f.id and v.deleted_at is null)))`,
    [id, knownAgentIds],
  );
  if (!rows[0]) return null;
  const fileId = String(rows[0].file_id);
  const versions = await libraryVersions(pool, fileId);
  const offset = Math.max(0, Math.trunc(contextsOffset));
  const { rows: uses } = await pool.query(
    `select u.conversation_id, u.kind, min(u.agent_id) as agent_id, min(u.created_at) as created_at,
            c.agent_id as conversation_agent, c.group_id, g.name as group_name,
            count(*) over () as total
       from core.artifact_uses u
       join core.artifacts v on v.id = u.artifact_id
       join core.conversations c on c.id = u.conversation_id
       left join core.groups g on g.id = c.group_id
      where v.file_id = $1::uuid
      group by u.conversation_id, u.kind, c.agent_id, c.group_id, g.name
      order by min(u.created_at) desc, u.conversation_id, u.kind
      limit $2 offset $3`,
    [fileId, CONTEXTS_PAGE, offset],
  );
  return {
    entry: toEntry(rows[0]),
    versions,
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

/** How many conversations used any version of the file `f`, the agent that first did, and who the first was with. */
const USE_EXPR = `(select count(distinct u.conversation_id)::int from core.artifact_uses u where u.artifact_id in ${VERSION_IDS}) as contexts,
            (select u.agent_id from core.artifact_uses u where u.artifact_id in ${VERSION_IDS} and u.agent_id is not null order by u.created_at asc limit 1) as use_agent,
            (select c.agent_id from core.artifact_uses u join core.conversations c on c.id = u.conversation_id where u.artifact_id in ${VERSION_IDS} order by u.created_at asc limit 1) as context_agent,
            (select g.name from core.artifact_uses u join core.conversations c on c.id = u.conversation_id join core.groups g on g.id = c.group_id where u.artifact_id in ${VERSION_IDS} order by u.created_at asc limit 1) as context_group`;

function toEntry(row: any): LibraryEntry {
  return {
    id: String(row.id),
    fileId: String(row.file_id),
    version: Number(row.version ?? 1),
    filename: row.filename ?? null,
    caption: row.caption ?? null,
    mime: String(row.mime),
    family: (FILE_FAMILIES as readonly string[]).includes(row.family) ? row.family : familyOf(String(row.mime), row.filename),
    sizeBytes: Number(row.size_bytes ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    origin: row.origin === 'uploaded' || row.origin === 'produced' ? row.origin : 'unknown',
    agentId: row.origin === 'produced' ? String(row.created_by) : (row.use_agent ?? null),
    deleted: row.deleted_at !== null && row.deleted_at !== undefined,
    contexts: Number(row.contexts ?? 0),
    context: row.context_agent || row.context_group ? { agentId: row.context_agent ?? null, groupName: row.context_group ?? null } : null,
    versions: Number(row.versions ?? 1) || 1,
  };
}
