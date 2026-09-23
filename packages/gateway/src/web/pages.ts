/**
 * The three routes a plugin's screens are made of.
 *
 * `docs/specs/plugin-pages.md` §3. The dashboard reads the descriptors once,
 * draws them with its own generic components, and then:
 *
 *   - `GET  /api/pages`                     — every descriptor, session-gated;
 *   - `GET  /api/pages/<plugin>/<query>`    — one read, its parameters checked
 *                                             by the query's own schema;
 *   - `POST /api/pages/<plugin>/act`        — one write, as the owner.
 *
 * Three rules hold here and nowhere else:
 *
 *  1. **A query cannot write.** `produce` is handed `pageQueryContext`, whose
 *     pool refuses anything that is not a `select`. A plugin that tried gets a
 *     502 with its own refusal in it, not a write nobody approved.
 *  2. **A page writes only through its plugin's tools.** The act route resolves
 *     the tool through the registry and refuses any name that belongs to
 *     another plugin — and any name its own descriptors do not
 *     carry (`registry.pageTools`). A plugin's other tools are an agent's
 *     business; a page is not a console.
 *  3. **A write from a page is the owner acting.** It is invoked with
 *     `agentId: 'owner'`, so an `auto` tool runs and a `gated` one records the
 *     same immutable action an agent's call would have, and the page draws the
 *     approval card in place. There is no third path.
 */
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import {
  OWNER_AGENT_ID,
  QueryRefusal,
  isPageFile,
  type PageFile,
  ReadOnlyRefusal,
  pageQueryContext,
  type ToolContext,
  type ToolRegistry,
} from '@buddi/core';

/** What these routes need. Nothing that is not already in the server's deps. */
export interface PagesDeps {
  registry: ToolRegistry;
  ctx: ToolContext;
  now: () => Date;
  /** Where the detail of a failure goes. The browser gets a sentence. */
  log?: (line: string) => void;
}

export interface PagesReply {
  status: number;
  body: unknown;
  /** A query that answered with bytes: streamed by `sendPageFile`, not as JSON. */
  file?: PageFile;
}

/** How many parameters a query route will look at. A page asks small questions. */
export const PAGE_PARAM_LIMIT = 24;

/**
 * What one answer may weigh.
 *
 * A page draws a screen, and a screen is small. A query that answers with
 * every row it has is a plugin defect, and it is better found as a 502 naming
 * the query than as a browser tab that stops responding.
 */
export const PAGE_RESULT_LIMITS = { bytes: 1024 * 1024, rows: 2_000 } as const;

/** Writes from one session: 60 a minute, counted before anything is invoked. */
export const PAGE_ACT_RATE = { perMinute: 60, windowMs: 60_000 } as const;

/**
 * What a failure says.
 *
 * The owner is the only reader, but a Postgres error names tables and columns
 * and a refused statement is the plugin's business rather than the page's. So
 * the detail is logged with a reference and the browser gets one sentence it
 * can quote back.
 */
function failed(deps: PagesDeps, plugin: string, query: string, detail: string): PagesReply {
  const reference = randomUUID().slice(0, 8);
  deps.log?.(`pages: ${plugin}/${query} failed [${reference}]: ${detail}`);
  return {
    status: 502,
    body: { error: `The ${plugin} plugin could not answer ${query}.`, reference },
  };
}

/**
 * The biggest array anywhere in an answer, and what the whole thing weighs.
 *
 * Bytes, not characters: a page's answer is sent as UTF-8, and an answer full
 * of accents or emoji weighs half again what `String.length` claims. The
 * serialisation itself is inside the check, so a BigInt or a cycle a plugin
 * handed back is the same 502 as an answer that is merely too big — never an
 * exception on the way out of the route.
 */
function tooBig(value: unknown): string | null {
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length > PAGE_RESULT_LIMITS.rows) {
        return `it answered with ${node.length} rows; a page shows at most ${PAGE_RESULT_LIMITS.rows}`;
      }
      stack.push(...node);
      continue;
    }
    stack.push(...Object.values(node as Record<string, unknown>));
  }
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(value ?? null) ?? 'null', 'utf8');
  } catch (err) {
    return `its answer cannot be serialised: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (size > PAGE_RESULT_LIMITS.bytes) {
    return `it answered with ${size} bytes; a page reads at most ${PAGE_RESULT_LIMITS.bytes}`;
  }
  return null;
}

/** One session's recent writes, for the rate limit. Per process, like every other. */
const acts = new Map<string, number[]>();

/** How many sessions the limiter will remember at once. */
export const PAGE_ACT_SESSIONS = 1_000;

/**
 * Has this session run out of writes for the minute?
 *
 * The map is swept on every call and bounded above: a table keyed by session
 * id, in a process that runs for months, is a slow leak otherwise. Insertion
 * order is age order here — a session is re-inserted whenever it writes — so
 * evicting from the front drops the least recently active first.
 */
export function actRateLimited(sessionId: string, now: number): boolean {
  // Sweep first: every session whose window has gone by is forgotten.
  for (const [id, times] of acts) {
    if (times.every((at) => now - at >= PAGE_ACT_RATE.windowMs)) acts.delete(id);
  }
  const recent = (acts.get(sessionId) ?? []).filter((at) => now - at < PAGE_ACT_RATE.windowMs);
  if (recent.length >= PAGE_ACT_RATE.perMinute) {
    acts.set(sessionId, recent);
    return true;
  }
  recent.push(now);
  // Re-inserted at the back, so the oldest writer is the first key.
  acts.delete(sessionId);
  acts.set(sessionId, recent);
  while (acts.size > PAGE_ACT_SESSIONS) {
    const oldest = acts.keys().next();
    if (oldest.done) break;
    acts.delete(oldest.value);
  }
  return false;
}

/**
 * Every descriptor, with the plugin each came from.
 *
 * Data only: a `PageQuery` holds functions and a zod schema and never leaves
 * this process — the browser learns what to *ask for*, not how it is answered.
 */
export function listPageDescriptors(deps: PagesDeps): PagesReply {
  return { status: 200, body: { pages: deps.registry.pages(), files: deps.registry.files() } };
}

/**
 * One read.
 *
 * Every parameter arrives as a string, because a query string is strings: a
 * query that wants a number writes `z.coerce.number()`, and one that wants a
 * boolean writes `z.enum(['true','false'])`. The schema is the plugin's, so
 * the refusal is the plugin's sentence rather than a generic 400.
 */
export async function runPageQuery(
  deps: PagesDeps,
  plugin: string,
  name: string,
  params: URLSearchParams,
): Promise<PagesReply> {
  const query = deps.registry.queries().find((q) => q.plugin === plugin && q.name === name);
  if (!query) return { status: 404, body: { error: `No plugin page query called ${plugin}/${name}.` } };

  const given: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.keys(given).length >= PAGE_PARAM_LIMIT) {
      return { status: 400, body: { error: `A page query takes at most ${PAGE_PARAM_LIMIT} parameters.` } };
    }
    given[key] = value;
  }

  const parsed = query.params.safeParse(given);
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        error: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      },
    };
  }

  let produced: unknown;
  try {
    produced = await query.produce(parsed.data, pageQueryContext(deps.ctx));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    /*
     * A `QueryRefusal` is the query *answering*: the owner asked for a thread
     * that is not there, and the plugin's own sentence is the useful thing to
     * show them. Everything else is a defect, and a defect says one generic
     * sentence here and the whole of itself to the log.
     */
    if (error instanceof QueryRefusal) return { status: 400, body: { error: detail } };
    return failed(
      deps,
      plugin,
      name,
      error instanceof ReadOnlyRefusal ? `the query tried to write — ${detail}` : detail,
    );
  }

  // Bytes rather than data: no result shape or row count applies, and the
  // route streams them (`sendPageFile`) instead of serialising.
  if (isPageFile(produced)) return { status: 200, body: null, file: produced };

  if (query.result) {
    const checked = query.result.safeParse(produced);
    if (!checked.success) {
      // Validated before it leaves, exactly like a descriptor: the page draws
      // what it is handed and cannot check it.
      return failed(
        deps,
        plugin,
        name,
        `the answer breaks the query's own result shape: ${checked.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    produced = checked.data;
  }
  const oversized = tooBig(produced);
  if (oversized) return failed(deps, plugin, name, oversized);
  return { status: 200, body: { data: produced ?? null } };
}

/**
 * One write: `{ tool, args }`, invoked as the owner.
 *
 * The answer is the tool's own result, or `{ approvalId }` when the tool is
 * gated — the page then draws the approval card from the ordinary approvals
 * route, so a decision made there and a decision made on Home are the same
 * row and the same race.
 */
export async function actOnPage(
  deps: PagesDeps,
  plugin: string,
  body: unknown,
  session: { id: string },
): Promise<PagesReply> {
  /*
   * Counted before anything is looked up, let alone invoked: a page that has
   * gone into a loop, or a tab left refreshing, must not be able to spend a
   * plugin's rate limit — or the owner's money — sixty times a second.
   */
  if (actRateLimited(session.id, deps.now().getTime())) {
    return { status: 429, body: { error: 'Too many writes from this page. Wait a moment and try again.' } };
  }
  if (typeof body !== 'object' || body === null) {
    return { status: 400, body: { error: 'Send `{ tool, args }`.' } };
  }
  const { tool, args } = body as { tool?: unknown; args?: unknown };
  if (typeof tool !== 'string' || tool.trim() === '') {
    return { status: 400, body: { error: 'Name the tool with `tool`.' } };
  }
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    return { status: 400, body: { error: '`args` must be an object.' } };
  }
  /*
   * The plugin boundary, and the reason this route is not a general "run a
   * tool" endpoint: a page may write only through the tools of the plugin
   * whose page it is. A tool of another plugin is not refused with a lecture —
   * as far as this route is concerned it does not exist.
   */
  if (deps.registry.pluginOf(tool) !== plugin || !deps.registry.pageTools(plugin).includes(tool)) {
    return { status: 404, body: { error: `${plugin} has no page that writes through ${tool}.` } };
  }

  const result = await deps.registry.invoke(tool, args ?? {}, {
    ...deps.ctx,
    agentId: OWNER_AGENT_ID,
    now: deps.now,
  });
  if (result.ok) return { status: 200, body: { result: result.output } };
  if (result.reason === 'approval-required') {
    return { status: 200, body: { approvalId: result.actionId, preview: result.preview } };
  }
  if (result.reason === 'invalid-args') return { status: 400, body: { error: result.message } };
  if (result.reason === 'unknown-tool') return { status: 404, body: { error: result.message } };
  return { status: 400, body: { error: result.message } };
}

/**
 * What may be shown inline on the dashboard's own origin, and as what.
 *
 * The same three families the Files library previews (`/api/artifacts/<id>/
 * preview`), for the same reasons: text is always `text/plain`, so nothing in
 * it is parsed as markup; images are passive; a PDF goes to the browser's own
 * viewer. The CSP sandbox withholds scripts from all of them, an SVG included.
 * Whatever else a plugin asks to show is served as a download of
 * `application/octet-stream` — the plugin names the file, the gateway decides
 * what the browser does with it.
 */
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/svg+xml']);

export function pageFileHeaders(file: PageFile): Record<string, string> {
  const base = file.contentType.split(';')[0]!.trim().toLowerCase();
  const kind = base.startsWith('text/') ? 'text' : base === 'application/pdf' ? 'pdf' : INLINE_IMAGES.has(base) ? 'image' : null;
  const inline = file.disposition === 'inline' && kind !== null;
  const name = encodeURIComponent(file.filename || 'download').replace(/'/g, '%27');
  const headers: Record<string, string> = {
    'Content-Type': !inline ? (kind === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream') : kind === 'text' ? 'text/plain; charset=utf-8' : base,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': file.immutable ? 'private, max-age=86400, immutable' : 'no-store',
  };
  if (inline) headers['Content-Security-Policy'] = kind === 'pdf' ? "default-src 'none'; sandbox allow-same-origin" : "default-src 'none'; sandbox";
  if (file.size !== undefined) headers['Content-Length'] = String(file.size);
  return headers;
}

/** Stream a query's file out. A read that fails half-way ends the response. */
export function sendPageFile(res: ServerResponse, file: PageFile, head = false): Promise<void> {
  res.writeHead(200, pageFileHeaders(file));
  if (Buffer.isBuffer(file.body)) {
    res.end(head ? undefined : file.body);
    return Promise.resolve();
  }
  const stream = file.body as Readable;
  if (head) {
    stream.destroy?.();
    res.end();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    stream.on('error', () => { res.destroy(); resolve(); });
    res.on('close', () => { stream.destroy?.(); resolve(); });
    stream.pipe(res);
  });
}

/** `/api/pages/<plugin>/<query>` and `/api/pages/<plugin>/act`, as a path. */
export const PAGE_ROUTE = /^\/api\/pages\/([a-z][a-z0-9_-]{0,39})\/([a-z][a-z0-9_]{0,39})$/;
