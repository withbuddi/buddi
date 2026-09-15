/**
 * The audit trail: what was asked for, where it went, and what happened.
 *
 * Two rules.
 *
 * **It never fails a fetch.** A log write that throws — the migration has not
 * run, the pool is busy, the schema was dropped — must not turn a page the
 * agent successfully read into an error. The record is for the owner's benefit
 * after the fact; the answer is for the owner's benefit now, and the answer
 * wins. Every call here swallows its own errors.
 *
 * **It never stores a body.** The URL and the host, never the page; the query,
 * never the results. See the migration for why.
 */
import type { Pool } from 'pg';

export interface FetchLogEntry {
  kind: 'search' | 'read';
  agentId?: string | undefined;
  conversationId?: string | undefined;
  /** The query for a search, the requested URL for a read. */
  target: string;
  host?: string | null | undefined;
  outcome: 'ok' | 'blocked' | 'error';
  detail?: string | null | undefined;
  httpStatus?: number | null | undefined;
  bytes?: number | null | undefined;
}

export async function recordFetch(db: Pool, entry: FetchLogEntry): Promise<void> {
  try {
    await db.query(
      `insert into web.fetches
         (kind, agent_id, conversation_id, target, host, outcome, detail, http_status, bytes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.kind,
        entry.agentId ?? null,
        entry.conversationId ?? null,
        entry.target.slice(0, 2000),
        entry.host ?? null,
        entry.outcome,
        entry.detail?.slice(0, 500) ?? null,
        entry.httpStatus ?? null,
        entry.bytes ?? null,
      ],
    );
  } catch {
    // Deliberately silent. See the header: an unwritten log line is not a
    // reason to fail a request the owner is waiting on.
  }
}
