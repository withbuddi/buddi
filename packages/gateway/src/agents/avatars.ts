/**
 * Agent pictures in `core.agent_avatars`: the one place they are kept.
 *
 * Only the dashboard's owner route writes here (`POST /api/agents/:id/avatar`);
 * no agent tool and no MCP write reaches it. Reads are by id, and the roster
 * asks for every version in one query so each face URL can carry its own.
 */
import type { Queryable } from '@buddi/core';
import type { NormalisedAvatar } from './avatar-image.js';

export interface StoredAvatar {
  png: Buffer;
  sha256: string;
  updatedAt: Date;
}

export async function readAvatar(db: Queryable, agentId: string): Promise<StoredAvatar | null> {
  const { rows } = await db.query('select png, sha256, updated_at from core.agent_avatars where agent_id = $1', [agentId]);
  const row = rows[0];
  return row ? { png: row.png as Buffer, sha256: String(row.sha256), updatedAt: row.updated_at as Date } : null;
}

export async function writeAvatar(db: Queryable, agentId: string, avatar: NormalisedAvatar): Promise<void> {
  await db.query(
    `insert into core.agent_avatars (agent_id, png, sha256, side, source, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (agent_id) do update
       set png = excluded.png, sha256 = excluded.sha256, side = excluded.side,
           source = excluded.source, updated_at = now()`,
    [agentId, avatar.png, avatar.sha256, avatar.side, avatar.source],
  );
}

/** True when there was one to remove. */
export async function removeAvatar(db: Queryable, agentId: string): Promise<boolean> {
  const { rows } = await db.query('delete from core.agent_avatars where agent_id = $1 returning agent_id', [agentId]);
  return rows.length > 0;
}

/**
 * Every agent with a picture, and the version to put in its URL. An
 * installation that has not migrated yet has none, rather than no roster.
 */
export async function avatarVersions(db: Queryable): Promise<Map<string, string>> {
  try {
    const { rows } = await db.query('select agent_id, sha256 from core.agent_avatars');
    return new Map(rows.map((r) => [String(r.agent_id), String(r.sha256)]));
  } catch {
    return new Map();
  }
}

/** The URL a face is drawn from: the version changes it, so no cache is ever stale. */
export function pictureUrl(agentId: string, sha256: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/avatar?v=${sha256.slice(0, 16)}`;
}
