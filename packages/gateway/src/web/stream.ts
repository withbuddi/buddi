/**
 * The conversation stream — Server-Sent Events over the event log.
 *
 * The browser is a surface like any other, and a surface has to watch a run
 * happen: a tool being called, a result coming back, an approval stopping
 * everything. Telegram does it by editing a bubble; the page does it here.
 *
 * The design decision worth naming is that this **has no bus of its own**. It
 * tails `core.events` for one conversation and emits what it finds. Three
 * things fall out of that, and each of them is a bug avoided:
 *
 *  - **Resume is free and exact.** Every SSE `id:` is an event-log row id, so
 *    `Last-Event-ID` (or `?since=`) is a `where id > $1` and a reconnect loses
 *    nothing. An in-memory bus would have to buffer, and would still lose a
 *    run that happened while nobody was listening.
 *  - **It sees runs it did not start.** A mission, a Telegram turn, an approval
 *    decided from the CLI — all of them write to the same log, so all of them
 *    appear in the page without a single extra call site.
 *  - **There is one ordering.** The log's, which is the durable one. A bus
 *    would have a second, and the two would disagree under load.
 *
 * The cost is a poll. It is a single indexed `select` every 250ms against one
 * conversation, and only while a page is actually open on it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import type { LiveTurns } from './live.js';
import { baseHeaders, first } from './http.js';

/** How often the log is asked for anything new. */
export const STREAM_POLL_MS = 250;

/** A comment-free keep-alive, so a proxy or a laptop lid cannot kill the pipe. */
export const STREAM_PING_MS = 25_000;

/** Streams one session may hold open at once. A tab per conversation, plus slack. */
export const MAX_STREAMS_PER_SESSION = 8;

/** How many replayed events one reconnect may be handed in a single batch. */
export const STREAM_BATCH = 200;

/**
 * Event-log kinds the page cares about, mapped to the SSE event names the UI
 * is written against.
 *
 * Two kinds are written by the web surface itself (`chat.*`) because the
 * runtime does not record them: "a message was appended" and "this run is
 * waiting for you". Everything else is the runtime's own vocabulary, unchanged.
 */
export const STREAM_KINDS: Readonly<Record<string, string>> = {
  'run.started': 'run.started',
  // A resumed run is, to a page, a run starting. The payload says which it was.
  'run.resumed': 'run.started',
  'tool.called': 'tool.called',
  'tool.result': 'tool.result',
  'run.finished': 'run.finished',
  'chat.message.appended': 'message.appended',
  'chat.awaiting-approval': 'awaiting-approval',
  // A run that threw, was cancelled, or was refused never reaches the runtime's
  // own `run.finished`. It still has to end on the stream, or the page waits
  // forever — so it ends as one, with the honest `stopped`.
  'chat.run.failed': 'run.finished',
};

/** The kinds the tail asks for. Derived, so the two can never drift. */
export const STREAM_KIND_LIST: readonly string[] = Object.keys(STREAM_KINDS);

export interface LogRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/**
 * What one log row becomes on the wire.
 *
 * Projected rather than passed through: the payload of `run.started` carries
 * the whole per-run snapshot, and a page does not need the credential kind of
 * the provider to draw a spinner. What the contract names is what is sent.
 */
export function toStreamEvent(row: LogRow): { event: string; data: Record<string, unknown> } {
  const name = STREAM_KINDS[row.kind] as string;
  const p = row.payload ?? {};
  const at = row.createdAt.toISOString();
  switch (name) {
    case 'run.started':
      return {
        event: name,
        data: {
          at,
          agentId: p.agentId ?? null,
          runId: p.runId ?? null,
          surface: p.surface ?? null,
          resumed: row.kind === 'run.resumed',
          ...(p.actionId ? { actionId: p.actionId } : {}),
        },
      };
    case 'tool.called':
      return { event: name, data: { at, name: p.name ?? '', input: p.input ?? null } };
    case 'tool.result':
      return {
        event: name,
        data: {
          at,
          name: p.name ?? '',
          ok: p.ok === true,
          ...(typeof p.reason === 'string' ? { reason: p.reason } : {}),
          ...(typeof p.actionId === 'string' ? { actionId: p.actionId } : {}),
        },
      };
    case 'message.appended':
      return { event: name, data: { at, role: p.role ?? 'assistant', runId: p.runId ?? null } };
    case 'awaiting-approval':
      return { event: name, data: { at, actionId: p.actionId ?? null, runId: p.runId ?? null } };
    case 'run.finished':
      return {
        event: name,
        data: {
          at,
          runId: p.runId ?? null,
          turns: typeof p.turns === 'number' ? p.turns : 0,
          stopped: typeof p.stopped === 'string' ? p.stopped : 'unknown',
          usage: usageOf(p.usage),
          // `message` is the sentence a person reads; `error` is the cause
          // chain, kept for the record. A page that shows `error` is a page
          // showing the owner `fetch failed`, which is the bug this replaced.
          ...(typeof p.message === 'string' ? { message: p.message } : {}),
          ...(typeof p.failureClass === 'string' ? { failureClass: p.failureClass } : {}),
          ...(typeof p.error === 'string' ? { error: p.error } : {}),
          ...(typeof p.actionId === 'string' ? { actionId: p.actionId } : {}),
        },
      };
    default:
      return { event: name, data: { at } };
  }
}

function usageOf(raw: unknown): { input: number; output: number } {
  const u = (raw ?? {}) as { input?: unknown; output?: unknown };
  return { input: Number(u.input ?? 0), output: Number(u.output ?? 0) };
}

/** The cursor this request resumes from: `?since=`, else `Last-Event-ID`. */
export function resumeCursor(req: IncomingMessage, since: string | null): string | undefined {
  const header = first(req.headers['last-event-id']);
  const raw = (since ?? header ?? '').trim();
  return /^\d+$/.test(raw) ? raw : undefined;
}

/** One SSE frame. `id` is omitted on a ping: a keep-alive is not a position. */
export function frame(event: string, data: unknown, id?: string): string {
  const body = JSON.stringify(data ?? null);
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${body}\n\n`;
}

export interface StreamOptions {
  pool: Pool;
  conversationId: string;
  /** The answer being written right now, when the surface keeps one. */
  live?: LiveTurns | undefined;
  /** Replay from just after this event-log id. Absent: only what happens next. */
  since?: string | undefined;
  pollMs?: number;
  pingMs?: number;
  now?: () => Date;
}

/**
 * A tail over `core.events`, with the *what* left to the caller.
 *
 * Two things stream from this log to a browser now — one conversation's run,
 * and "some agent's claim on the owner may have changed" — and they differ only
 * in which rows they ask for and what a row becomes on the wire. The
 * connection handling, the cursor, the keep-alive and the "a database blip must
 * not kill a page" rule are the same for both, and there is one copy of them.
 */
export interface LogStreamOptions {
  /** The newest id this stream would care about, for a client with no cursor. */
  head: () => Promise<string>;
  /** Rows after `cursor`, ascending, at most `limit` of them. */
  tail: (cursor: string, limit: number) => Promise<LogRow[]>;
  /** What one row becomes on the wire. `null` drops it silently. */
  project: (row: LogRow) => { event: string; data: Record<string, unknown> } | null;
  since?: string | undefined;
  pollMs?: number;
  pingMs?: number;
  now?: () => Date;
  /**
   * Frames that do not come from the log: what is being written this second.
   * They carry no id, so a reconnect never resumes from one — the snapshot on
   * connect is how a mid-turn page catches up.
   */
  live?: {
    snapshot: () => { event: string; data: unknown } | null;
    subscribe: (write: (frame: { event: string; data: unknown }) => void) => () => void;
  } | undefined;
}

export async function streamLog(
  req: IncomingMessage,
  res: ServerResponse,
  opts: LogStreamOptions,
): Promise<void> {
  const pollMs = opts.pollMs ?? STREAM_POLL_MS;
  const pingMs = opts.pingMs ?? STREAM_PING_MS;
  const now = opts.now ?? ((): Date => new Date());

  // No Content-Length, no compression, no buffering anywhere in between.
  res.writeHead(200, {
    ...baseHeaders(),
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
    // nginx and friends buffer text/* by default, which turns a live stream
    // into a batch that arrives when the run is already over.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  req.socket.setNoDelay(true);
  // A stream that is quiet for 25s is healthy, not idle: no socket timeout.
  req.socket.setTimeout(0);

  let cursor = opts.since ?? (await opts.head());
  let open = true;
  const closed = new Promise<void>((resolve) => {
    const finish = (): void => {
      if (!open) return;
      open = false;
      resolve();
    };
    res.on('close', finish);
    res.on('error', finish);
    req.on('aborted', finish);
  });

  const write = (text: string): boolean => {
    if (!open) return false;
    // A page that has gone away shows up as backpressure, then as an error.
    return res.write(text) || true;
  };

  // The first frame goes out immediately, so the page knows it is connected
  // before anything has happened.
  write(frame('ping', { at: now().toISOString(), from: cursor }));

  // What is being written right now, then every piece from here on. Written
  // straight to the socket as it happens: these frames are not in the log
  // and wait for no poll.
  const first = opts.live?.snapshot();
  if (first) write(frame(first.event, first.data));
  const unsubscribe = opts.live?.subscribe((piece) => { write(frame(piece.event, piece.data)); });

  let lastPing = Date.now();
  while (open) {
    let rows: LogRow[];
    try {
      rows = await opts.tail(cursor, STREAM_BATCH);
    } catch {
      // A database blip must not kill a page. Wait a beat and ask again; the
      // cursor has not moved, so nothing is lost.
      rows = [];
    }
    for (const row of rows) {
      const projected = opts.project(row);
      if (projected !== null && !write(frame(projected.event, projected.data, row.id))) break;
      cursor = row.id;
      lastPing = Date.now();
    }
    if (!open) break;
    if (Date.now() - lastPing >= pingMs) {
      write(frame('ping', { at: now().toISOString() }));
      lastPing = Date.now();
    }
    await Promise.race([closed, sleep(pollMs)]);
  }

  await closed;
  unsubscribe?.();
  res.end();
}

/**
 * Hold the connection open and write the conversation's events as they land.
 *
 * Resolves when the client goes away — the caller uses that to release the
 * session's stream slot. Nothing here ever ends the stream on its own: a run
 * finishing is not a reason to close a page that is still open.
 */
export async function streamConversation(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StreamOptions,
): Promise<void> {
  const { live, ...rest } = opts;
  await streamLog(req, res, {
    ...rest,
    head: () => head(opts.pool, opts.conversationId),
    tail: (cursor, limit) => tail(opts.pool, opts.conversationId, cursor, limit),
    project: toStreamEvent,
    ...(live ? {
      live: {
        snapshot: () => {
          const turn = live.snapshot(opts.conversationId);
          return turn ? { event: 'live.snapshot', data: turn } : null;
        },
        subscribe: (write) => live.subscribe(opts.conversationId, write),
      },
    } : {}),
  });
}

/** The newest event id in this conversation, or `'0'` for an empty one. */
async function head(pool: Pool, conversationId: string): Promise<string> {
  const { rows } = await pool.query(
    `select coalesce(max(id), 0)::text as id from core.events where conversation_id = $1::uuid`,
    [conversationId],
  );
  return String(rows[0]?.id ?? '0');
}

async function tail(
  pool: Pool,
  conversationId: string,
  cursor: string,
  limit: number,
): Promise<LogRow[]> {
  const { rows } = await pool.query(
    `select id, kind, payload, created_at from core.events
      where conversation_id = $1::uuid and id > $2::bigint and kind = any($3::text[])
      order by id asc
      limit $4`,
    [conversationId, cursor, STREAM_KIND_LIST, limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    payload: (r.payload ?? {}) as Record<string, unknown>,
    createdAt: new Date(r.created_at),
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * How many streams each session holds open.
 *
 * In memory and per process, like the sessions themselves: a stream is a live
 * socket, so a count that outlived the process would be a count of nothing.
 */
export class StreamBudget {
  readonly #open = new Map<string, number>();
  readonly #max: number;

  constructor(max: number = MAX_STREAMS_PER_SESSION) {
    this.#max = max;
  }

  /** Take a slot, or refuse. The returned function gives it back, once. */
  take(sessionId: string): (() => void) | null {
    const current = this.#open.get(sessionId) ?? 0;
    if (current >= this.#max) return null;
    this.#open.set(sessionId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.#open.get(sessionId) ?? 1) - 1;
      if (n <= 0) this.#open.delete(sessionId);
      else this.#open.set(sessionId, n);
    };
  }

  count(sessionId: string): number {
    return this.#open.get(sessionId) ?? 0;
  }
}
