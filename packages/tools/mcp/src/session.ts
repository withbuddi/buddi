/**
 * One MCP session per connection per process (docs/connections.md): opened on
 * the first call that needs it, closed after ten quiet minutes, reopened on
 * the next call. The SDK's Streamable HTTP client, over `connectionFetch`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { HttpTransport } from './ports.js';
import { connectionFetch } from './fetch.js';
import type { ServerTool } from './tiers.js';

export const CLIENT_INFO = { name: 'buddi', version: '0.1.0' } as const;
export const IDLE_MS = 10 * 60_000;
/** The most tools a review reads from one server. */
export const MAX_TOOLS = 200;

export interface OpenOptions {
  url: string;
  transport: HttpTransport;
  token?: () => Promise<string | undefined>;
  credential?: () => Promise<{ header: string; value: string }>;
  allowLoopbackHttp?: boolean;
  signal?: AbortSignal;
}

export interface Opened {
  client: Client;
  /** Set when the server answered 401: its `WWW-Authenticate`, or '' when it sent none. */
  unauthorized(): string | null;
  /** A program that stopped by itself: the session is dead and is opened again. */
  closed?(): boolean;
  close(): Promise<void>;
}

/** Open a session: `initialize`, and nothing else. */
export async function openSession(opts: OpenOptions): Promise<Opened> {
  let challenge: string | null = null;
  const fetch = connectionFetch({
    url: opts.url,
    transport: opts.transport,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.credential ? { credential: opts.credential } : {}),
    ...(opts.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
    onUnauthorized: (www) => { challenge = www ?? ''; },
  });
  const transport = new StreamableHTTPClientTransport(new URL(opts.url), { fetch });
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await client.connect(transport, opts.signal ? { signal: opts.signal } : undefined);
  } catch (error) {
    await client.close().catch(() => {});
    if (challenge !== null) throw new Unauthorized(challenge);
    throw error;
  }
  return {
    client,
    unauthorized: () => challenge,
    close: () => client.close().catch(() => {}),
  };
}

/** The server wants a sign-in (or a new one). */
export class Unauthorized extends Error {
  override readonly name = 'Unauthorized';
  constructor(readonly wwwAuthenticate: string) {
    super('The service asked buddi to sign in.');
  }
}

/** Every tool the server lists, page by page, up to `MAX_TOOLS`. */
export async function listAllTools(client: Client, signal?: AbortSignal): Promise<ServerTool[]> {
  const out: ServerTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20 && out.length < MAX_TOOLS; page++) {
    const answer = await client.listTools(cursor ? { cursor } : undefined, signal ? { signal } : undefined);
    for (const tool of answer.tools) {
      if (out.length >= MAX_TOOLS) break;
      out.push(tool as unknown as ServerTool);
    }
    cursor = answer.nextCursor;
    if (!cursor) break;
  }
  return out;
}

interface Held {
  opened: Promise<Opened>;
  timer?: NodeJS.Timeout;
}

/** The sessions this process holds, by connection id. */
export class Sessions {
  readonly #held = new Map<string, Held>();
  constructor(private readonly idleMs = IDLE_MS) {}

  /** The open session for `id`, opening it with `open` when there is none. */
  async get(id: string, open: () => Promise<Opened>): Promise<Opened> {
    let held = this.#held.get(id);
    if (held) {
      const current = held;
      const opened = await current.opened.catch(() => undefined);
      if (opened?.closed?.() && this.#held.get(id) === current) await this.close(id);
      held = this.#held.get(id);
    }
    if (!held) {
      held = { opened: open() };
      this.#held.set(id, held);
      held.opened.catch(() => { if (this.#held.get(id) === held) this.#held.delete(id); });
    }
    this.#touch(id, held);
    return held.opened;
  }

  #touch(id: string, held: Held): void {
    if (held.timer) clearTimeout(held.timer);
    held.timer = setTimeout(() => { void this.close(id); }, this.idleMs);
    held.timer.unref?.();
  }

  has(id: string): boolean { return this.#held.has(id); }

  async close(id: string): Promise<void> {
    const held = this.#held.get(id);
    if (!held) return;
    this.#held.delete(id);
    if (held.timer) clearTimeout(held.timer);
    try { await (await held.opened).close(); } catch { /* it never opened */ }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#held.keys()].map((id) => this.close(id)));
  }
}
