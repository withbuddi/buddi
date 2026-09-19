/**
 * Anthropic Messages adapter for the RuntimeProvider port.
 *
 * Raw `fetch` only — no SDK. Wire types stay private to this file; everything the
 * loop sees is provider-neutral, so a second adapter (OpenAI) can implement the
 * same port without leaking Anthropic shapes upward.
 *
 * Credential kinds (ARCHITECTURE.md, "Credential kinds"):
 *  - `api-key`            -> `x-api-key`, nothing else.
 *  - `subscription-token` -> `Authorization: Bearer` **plus** the Claude Code
 *    identity line as the system prompt's own first block. Without it the API
 *    answers 429. The `anthropic-beta: oauth-2025-04-20` header rides along for
 *    parity with Claude Code; it was not enforced at verification time.
 *    Verified against the live API 2026-09-13: `system` must be a **block array**
 *    whose first block's text is *exactly* the identity line. Merging it into one
 *    concatenated string (`"<line>\n<agent prompt>"`, string or single block) is
 *    rejected with 429 — the check is equality on the first block, not a prefix
 *    test. The adapter emits that form itself; callers never opt in.
 *
 * No ambient credentials: everything comes from the already-resolved provider.
 */
import {
  describeCause,
  errorCodes,
  providerAuthHeaders,
  type ResolvedProvider,
} from '@buddi/core';
import { providerCapabilities, type ProviderCapabilities } from './capabilities.js';
import {
  defaultSleep,
  isRetryableStatus,
  nextDelayMs,
  providerRetryAt,
  nextTransportDelayMs,
  RETRY_DELAYS_MS,
} from './retry.js';
import {
  defaultHttpTransport,
  type HttpTransport,
  type TransportResponse,
} from './transport.js';

/**
 * Exact text of the system block the subscription-token path must send first.
 * No trailing newline: the API compares the first block's text for equality.
 */
export const CLAUDE_CODE_SYSTEM_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/** Beta flag that makes `/v1/messages` accept a subscription (oauth) token. */
export const OAUTH_BETA = 'oauth-2025-04-20';

export const ANTHROPIC_VERSION = '2023-06-01';

/* ------------------------------------------------------------------ *
 * Provider-neutral port
 * ------------------------------------------------------------------ */

/**
 * Multimodal blocks are provider-neutral: `data` is always base64, `mime` is
 * always the real media type. An adapter that cannot carry one is expected to
 * degrade to text rather than invent a wire shape.
 *
 * `artifact_ref` is the *persisted* form of an attachment: it is what
 * `core.messages` stores so a transcript never carries base64, and the loop
 * hydrates it into an `image` / `document` block before any provider call. An
 * adapter should never see one; if it does, it renders as a text placeholder
 * rather than being silently dropped.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }
  | { type: 'image'; mime: string; data: string }
  | { type: 'document'; mime: 'application/pdf'; data: string; name?: string }
  | { type: 'artifact_ref'; artifactId: string; mime: string; kind: string }
  /**
   * A block this port does not model, carried back to the provider that made
   * it, verbatim.
   *
   * It exists for exactly one thing: the provider's own server-side tools. A
   * `server_tool_use` and its `web_search_tool_result` are not tool calls the
   * loop dispatches — the API ran them before it answered — but they are part
   * of the assistant turn the model wrote, and a turn the API paused
   * (`stop_reason: pause_turn`) has to be handed back with them intact or the
   * continuation is a different conversation. Opaque on purpose: nothing above
   * the adapter reads `raw`, and `provider` is there so one vendor's blocks are
   * never posted to another's endpoint.
   *
   * It is never persisted. The loop strips these before writing `core.messages`
   * — untrusted search results belong in the answer's citations, not in durable
   * history that gets replayed for ever.
   */
  | { type: 'provider_native'; provider: string; raw: unknown };

/** What the model is shown when an attachment cannot be reconstructed. */
export const ATTACHMENT_UNAVAILABLE = '[attachment unavailable]';

export type MessageRole = 'user' | 'assistant';

export interface NeutralMessage {
  role: MessageRole;
  content: ContentBlock[];
}

/** A tool as the model sees it. Derived from `ToolRegistry.list()` by the loop. */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface CompletionRequest {
  signal?: AbortSignal;
  /** The agent's own system prompt. Adapter-specific prefixes are added here. */
  system: string;
  messages: NeutralMessage[];
  tools: ToolSchema[];
  maxTokens?: number;
  /**
   * Let the provider search the web on its own servers for this request.
   *
   * Set by the loop from `planNativeSearch`, never by a caller reaching past
   * it: whether an agent may search is the owner's grant, and which backend
   * honours the grant is `BUDDI_SEARCH_PROVIDER`. An adapter whose matrix row
   * says `nativeWebSearch: false` ignores this field entirely.
   */
  nativeSearch?: { maxUses: number };
}

/**
 * `pause_turn` is not an ending. The API stops a long-running server-tool turn
 * part-way and expects the same turn to be continued — the assistant content
 * handed straight back, no new user message. The loop does exactly that; see
 * `provider_native` for why the blocks survive the round trip.
 */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'pause_turn' | 'other';

export interface Usage {
  input: number;
  output: number;
  /**
   * Server-side web searches the provider ran for this request.
   *
   * Metered, not free: under a subscription it counts against the plan, and on
   * an API key it is billed per thousand requests. It is surfaced everywhere
   * tokens are (`/usage`, the chat footer, the `run.finished` event) for the
   * same reason tokens are — a capability nobody can count is a capability
   * nobody can account for.
   */
  webSearches?: number;
}

/**
 * One server-side search, as the audit trail needs it.
 *
 * The claim that native search costs us the audit trail turned out to be
 * wrong on inspection: the adapter sees the query in the `server_tool_use`
 * block and the result URLs in the `web_search_tool_result` block that follows
 * it. That is every column `web.fetches` has — who asked, when, what for,
 * where it went, how it ended — so a native search leaves the same trace a
 * `web.search` call does. What is *not* here is the page text, which is the
 * same thing the plugin's own log refuses to store.
 */
export interface NativeSearchRecord {
  /** What the model asked for, in its own words. */
  query: string;
  /** Result hosts, de-duplicated, in the order they ranked. */
  hosts: string[];
  resultCount: number;
  outcome: 'ok' | 'error';
  /** The provider's error code, when it failed. */
  detail?: string;
}

export interface CompletionResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  /** Concrete model the endpoint reports it served (per-run snapshot input). */
  model: string;
  /** Every server-side search this response ran. Absent when it ran none. */
  searches?: NativeSearchRecord[];
}

export interface RuntimeProvider {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  /**
   * What this adapter can actually carry. Optional so a two-line test double
   * stays two lines; absent means the native wire this runtime was built on
   * (see `DEFAULT_CAPABILITIES`), never "everything".
   */
  readonly capabilities?: ProviderCapabilities;
}

/**
 * Typed transport/API failure. Never carries the credential.
 *
 * `cause`, `code` and `detail` are the answer to a day spent learning nothing
 * from 129 log lines that all said `fetch failed`. The wrapper's message is
 * kept as the message, because that is what the caller saw; the error that
 * actually happened is preserved on `cause`, its identifier is lifted to
 * `code` so the queue's classifier can read it without walking anything, and
 * the whole chain is flattened into `detail` for the log.
 */
export class ProviderError extends Error {
  readonly retryAt: string | null;
  readonly status: number;
  readonly type: string;
  readonly requestId: string | null;
  /** The innermost identifier: `ECONNRESET`, `UND_ERR_SOCKET`, or null. */
  readonly code: string | null;
  /** The whole cause chain on one line. For a log, never for a chat window. */
  readonly detail: string;

  constructor(args: {
    status: number;
    type: string;
    message: string;
    requestId?: string | null;
    retryAt?: string | null;
    cause?: unknown;
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.name = 'ProviderError';
    this.status = args.status;
    this.type = args.type;
    this.requestId = args.requestId ?? null;
    this.retryAt = args.retryAt ?? null;
    this.code = args.cause === undefined ? null : (errorCodes(args.cause)[0] ?? null);
    this.detail =
      args.cause === undefined ? args.message : `${args.message} <- ${describeCause(args.cause)}`;
  }
}

/**
 * A request an adapter refuses to send because its wire cannot express it.
 *
 * Thrown rather than approximated: an adapter that quietly dropped a PDF would
 * leave the model answering about a document it never saw. The loop consults
 * the capability matrix first, so in practice this fires only for a caller that
 * went round the loop — and it still says what to do instead.
 */
export class ProviderCapabilityError extends ProviderError {
  override readonly name = 'ProviderCapabilityError';
  /** The neutral block kind that could not be carried. */
  readonly blockType: string;

  constructor(args: { provider: string; blockType: string; message: string }) {
    super({ status: 0, type: 'unsupported_content', message: args.message });
    this.blockType = args.blockType;
  }
}

/**
 * What a surface or an operator is told while the adapter is still trying.
 *
 * It exists so the cause chain of *every* attempt reaches the log, not only
 * the last one. A failure that healed on the second attempt is exactly the
 * evidence that says which failure it was.
 */
export interface RetryNotice {
  /** 1 for the failure of the first attempt. */
  attempt: number;
  /** How long we are about to wait before the next one. */
  delayMs: number;
  /** `transport` (never reached the model) or `status` (it answered). */
  kind: 'transport' | 'status';
  /** The whole cause chain on one line. Safe for a log; never for a chat. */
  detail: string;
}

export interface AnthropicProviderOptions {
  maxStatusRetries?: number;
  /**
   * Injected for tests. Defaults to `defaultHttpTransport` — `node:https` with
   * connection reuse off, not the global `fetch`. See `transport.ts` for why.
   */
  fetch?: HttpTransport;
  /** Injected for tests so backoff does not burn wall-clock. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected for tests: the retry window is measured against this. */
  now?: () => number;
  /** Called before each wait, with the cause chain of the attempt that failed. */
  onRetry?: (notice: RetryNotice) => void;
  /** Default `max_tokens` when a request does not set one. */
  maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 16000;

/* ------------------------------------------------------------------ *
 * Anthropic wire types — private to this module
 * ------------------------------------------------------------------ */

type WireTextBlock = { type: 'text'; text: string };
type WireToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
type WireToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
type WireBase64Source = { type: 'base64'; media_type: string; data: string };
type WireImageBlock = { type: 'image'; source: WireBase64Source };
type WireDocumentBlock = {
  type: 'document';
  source: WireBase64Source;
  title?: string;
};
type WireBlock =
  | WireTextBlock
  | WireToolUseBlock
  | WireToolResultBlock
  | WireImageBlock
  | WireDocumentBlock
  /** A `provider_native` block going straight back out, exactly as it arrived. */
  | Record<string, unknown>;

/**
 * The server-side web search tool, as `/v1/messages` takes it.
 *
 * It rides in the same `tools` array as buddi's own tools, which is why
 * `toolNameMap` reserves the name: a registry tool called `web.search` encodes
 * to `web_search` and would otherwise collide with it on the wire.
 */
export const WEB_SEARCH_TOOL_TYPE = 'web_search_20250305';
export const WEB_SEARCH_TOOL_NAME = 'web_search';

type WireSystemBlock = { type: 'text'; text: string };

type WireRequest = {
  model: string;
  max_tokens: number;
  /** A plain string for `api-key`; blocks for `subscription-token`. */
  system: string | WireSystemBlock[];
  messages: { role: MessageRole; content: WireBlock[] }[];
  tools?: (
    | { name: string; description: string; input_schema: Record<string, unknown> }
    | { type: string; name: string; max_uses?: number }
  )[];
};

type WireResponse = {
  model?: string;
  stop_reason?: string | null;
  content?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    server_tool_use?: { web_search_requests?: number };
  };
};

function toWireBlock(block: ContentBlock, names: Map<string, string>): WireBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: wireNameFor(names, block.name),
        input: block.input,
      };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mime, data: block.data },
      };
    case 'document': {
      const wire: WireDocumentBlock = {
        type: 'document',
        source: { type: 'base64', media_type: block.mime, data: block.data },
      };
      if (block.name) wire.title = block.name;
      return wire;
    }
    case 'provider_native':
      // Verbatim, or it is not a continuation of the same turn. `raw` came off
      // this same endpoint; it is never constructed here and never read.
      return block.raw as Record<string, unknown>;
    case 'artifact_ref':
      // The loop hydrates these before calling a provider. Reaching here means
      // an un-hydrated history — say so rather than dropping the block.
      return { type: 'text', text: ATTACHMENT_UNAVAILABLE };
    case 'tool_result':
      return block.is_error
        ? {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: true,
          }
        : {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
          };
  }
}

/**
 * Anthropic constrains tool names to `^[a-zA-Z0-9_-]{1,128}$`, but buddi's tool
 * names are namespaced with a dot (`finance.project_cashflow`) because the
 * registry's namespace is a core concept, not a wire detail. The adapter
 * translates: every unwire-able character becomes `_`, collisions get a numeric
 * suffix, and a per-request map turns the model's answer back into the real
 * name. Nothing above this module ever sees the wire spelling.
 */
const WIRE_TOOL_NAME_CHARS = /^[a-zA-Z0-9_-]+$/;

/** Anthropic allows 128 characters; OpenAI's function names stop at 64. */
export const ANTHROPIC_TOOL_NAME_MAX = 128;
export const OPENAI_TOOL_NAME_MAX = 64;

export function encodeToolName(name: string, maxLength = ANTHROPIC_TOOL_NAME_MAX): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, maxLength);
}

/**
 * wire name -> registry name, for one request's tool list. `maxLength` is the
 * wire's own limit; both adapters share the encoding so a tool answers to the
 * same registry name whichever provider proposed it.
 */
export function toolNameMap(
  tools: ToolSchema[],
  maxLength = ANTHROPIC_TOOL_NAME_MAX,
  /**
   * Wire names the provider has already claimed for this request — today, the
   * server-side `web_search` tool. Without this a registry tool named
   * `web.search` would encode to `web_search` and land in the same `tools`
   * array as the server tool, and the API would answer 400 with the owner's
   * message already in the body.
   */
  reserved: readonly string[] = [],
): Map<string, string> {
  const map = new Map<string, string>();
  const taken = (wire: string): boolean => map.has(wire) || reserved.includes(wire);
  for (const tool of tools) {
    if (
      WIRE_TOOL_NAME_CHARS.test(tool.name) &&
      tool.name.length <= maxLength &&
      !reserved.includes(tool.name)
    ) {
      map.set(tool.name, tool.name);
      continue;
    }
    const base = encodeToolName(tool.name, maxLength);
    let wire = base;
    for (let n = 2; taken(wire); n++) wire = `${base.slice(0, maxLength - 4)}_${n}`;
    map.set(wire, tool.name);
  }
  return map;
}

/** wire name for a registry name, within one request's map. */
export function wireToolName(map: Map<string, string>, registryName: string): string {
  for (const [wire, real] of map) if (real === registryName) return wire;
  return registryName;
}

const wireNameFor = wireToolName;

/**
 * Wire content -> neutral blocks, plus whatever the provider searched for.
 *
 * The one thing this must never do is turn a `server_tool_use` into a
 * `tool_use`. They are different events wearing similar names: a `tool_use` is
 * a *proposal* the loop has to execute and answer, a `server_tool_use` is a
 * report that the API already did something. Dispatching one would send the
 * loop looking for a tool called `web_search` in a registry that has no such
 * tool, and answering a `tool_use_id` the API never asked about — so server
 * blocks become `provider_native`, which the loop carries and never dispatches.
 */
function fromWireBlocks(
  raw: unknown,
  names: Map<string, string>,
): { content: ContentBlock[]; searches: NativeSearchRecord[] } {
  if (!Array.isArray(raw)) return { content: [], searches: [] };
  const out: ContentBlock[] = [];
  const searches: NativeSearchRecord[] = [];
  /** `server_tool_use.id` -> the query it asked, so the result can find it. */
  const queries = new Map<string, string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const b = item as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      out.push({ type: 'text', text: b.text });
    } else if (
      b.type === 'tool_use' &&
      typeof b.id === 'string' &&
      typeof b.name === 'string'
    ) {
      out.push({
        type: 'tool_use',
        id: b.id,
        name: names.get(b.name) ?? b.name,
        input: b.input ?? {},
      });
    } else if (b.type === 'server_tool_use') {
      if (typeof b.id === 'string') {
        const input = (b.input ?? {}) as Record<string, unknown>;
        queries.set(b.id, typeof input.query === 'string' ? input.query : '');
      }
      out.push({ type: 'provider_native', provider: 'anthropic', raw: b });
    } else if (b.type === 'web_search_tool_result') {
      searches.push(searchRecord(b, queries));
      out.push({ type: 'provider_native', provider: 'anthropic', raw: b });
    }

    // Everything else — a thinking block, anything a future API version adds —
    // is still not part of this port and is still dropped. Only the server-tool
    // pair above is carried, and only because a paused turn cannot be continued
    // without it.
  }
  return { content: out, searches };
}

/** One `web_search_tool_result`, reduced to what the audit log stores. */
function searchRecord(
  block: Record<string, unknown>,
  queries: Map<string, string>,
): NativeSearchRecord {
  const query = (typeof block.tool_use_id === 'string' ? queries.get(block.tool_use_id) : '') ?? '';
  const content = block.content;
  // The failure shape is `{ type: 'web_search_tool_result_error', error_code }`.
  if (!Array.isArray(content)) {
    const code =
      typeof content === 'object' && content !== null
        ? String((content as Record<string, unknown>).error_code ?? 'unknown')
        : 'unknown';
    return { query, hosts: [], resultCount: 0, outcome: 'error', detail: code };
  }
  const hosts: string[] = [];
  for (const entry of content) {
    if (typeof entry !== 'object' || entry === null) continue;
    const url = (entry as Record<string, unknown>).url;
    if (typeof url !== 'string') continue;
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      continue;
    }
    if (!hosts.includes(host)) hosts.push(host);
  }
  return { query, hosts, resultCount: content.length, outcome: 'ok' };
}

function mapStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case 'tool_use':
      return 'tool_use';
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'pause_turn':
      return 'pause_turn';
    default:
      return 'other';
  }
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

/**
 * Build the system field for the subscription-token kind: the identity line as
 * its own first block, the agent's prompt after it. An agent prompt that already
 * *is* the identity line is not duplicated.
 */
export function withClaudeCodeIdentity(system: string): { type: 'text'; text: string }[] {
  const rest = system.replace(/^You are Claude Code, Anthropic's official CLI for Claude\.\n?/, '');
  const blocks: { type: 'text'; text: string }[] = [
    { type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX },
  ];
  if (rest.trim() !== '') blocks.push({ type: 'text', text: rest });
  return blocks;
}

export function createAnthropicProvider(
  resolved: ResolvedProvider,
  options: AnthropicProviderOptions = {},
): RuntimeProvider {
  const doFetch = options.fetch ?? defaultHttpTransport;
  if (typeof doFetch !== 'function') {
    throw new Error('createAnthropicProvider: no fetch implementation available');
  }
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? ((): number => Date.now());
  const defaultMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const url = `${resolved.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const isSubscription = resolved.credentialKind === 'subscription-token';

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      ...providerAuthHeaders(resolved),
    };
    if (isSubscription) h['anthropic-beta'] = OAUTH_BETA;
    return h;
  }

  function body(req: CompletionRequest, names: Map<string, string>): WireRequest {
    const wire: WireRequest = {
      model: resolved.model,
      max_tokens: req.maxTokens ?? defaultMaxTokens,
      system: isSubscription ? withClaudeCodeIdentity(req.system) : req.system,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content.map((b) => toWireBlock(b, names)),
      })),
    };
    const tools: NonNullable<WireRequest['tools']> = req.tools.map((t) => ({
      name: wireNameFor(names, t.name),
      description: t.description,
      input_schema: t.input_schema,
    }));
    // The server-side search is declared like any other tool, and bounded per
    // request: `max_uses` is the only budget the API enforces for us.
    if (req.nativeSearch && capabilities.nativeWebSearch) {
      tools.push({
        type: WEB_SEARCH_TOOL_TYPE,
        name: WEB_SEARCH_TOOL_NAME,
        max_uses: req.nativeSearch.maxUses,
      });
    }
    if (tools.length > 0) wire.tools = tools;
    return wire;
  }

  async function errorFrom(res: TransportResponse): Promise<ProviderError> {
    const requestId =
      res.headers?.get?.('request-id') ?? res.headers?.get?.('x-request-id') ?? null;
    let type = 'http_error';
    let message = `${res.status} ${res.statusText ?? ''}`.trim();
    try {
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as {
            error?: { type?: string; message?: string };
          };
          if (parsed?.error?.type) type = parsed.error.type;
          if (parsed?.error?.message) message = parsed.error.message;
          else message = text.slice(0, 500);
        } catch {
          message = text.slice(0, 500);
        }
      }
    } catch {
      /* body already consumed or unreadable — status is enough */
    }
    return new ProviderError({ status: res.status, type, message, requestId, retryAt: providerRetryAt(res.headers) });
  }

  const capabilities = providerCapabilities('anthropic');

  return {
    capabilities,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const names = toolNameMap(
        req.tools,
        ANTHROPIC_TOOL_NAME_MAX,
        req.nativeSearch ? [WEB_SEARCH_TOOL_NAME] : [],
      );
      const payload = JSON.stringify(body(req, names));
      const startedAt = now();
      /**
       * Two budgets, counted separately, because they are answers to two
       * different questions. A request the provider answered with a 429 or a
       * 500 gets the short status curve — it reached the model, and the model
       * said no. A request that never got there gets the wider transport
       * curve, bounded by its own window.
       */
      let statusFailures = 0;
      let transportFailures = 0;
      let lastError: ProviderError | undefined;

      for (;;) {
        req.signal?.throwIfAborted();
        let res: TransportResponse;
        try {
          res = await doFetch(url, { method: 'POST', headers: headers(), body: payload, ...(req.signal ? { signal: req.signal } : {}) });
        } catch (err) {
          req.signal?.throwIfAborted();
          transportFailures += 1;
          // The message stays the caller's; the cause chain rides along, and
          // `detail` is the line that finally says what actually broke.
          lastError = new ProviderError({
            status: 0,
            type: 'transport_error',
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          });
          const delay = nextTransportDelayMs(transportFailures, now() - startedAt);
          if (delay === undefined) break;
          options.onRetry?.({
            attempt: transportFailures,
            delayMs: delay,
            kind: 'transport',
            detail: lastError.detail,
          });
          await sleep(delay, req.signal);
          continue;
        }

        if (res.ok) {
          const json = (await res.json()) as WireResponse;
          const parsed = fromWireBlocks(json.content, names);
          const webSearches = json.usage?.server_tool_use?.web_search_requests ?? 0;
          return {
            content: parsed.content,
            stopReason: mapStopReason(json.stop_reason),
            usage: {
              input: json.usage?.input_tokens ?? 0,
              output: json.usage?.output_tokens ?? 0,
              ...(webSearches > 0 ? { webSearches } : {}),
            },
            model: json.model ?? resolved.model,
            ...(parsed.searches.length > 0 ? { searches: parsed.searches } : {}),
          };
        }

        // Read `Retry-After` before the body is consumed: a 429 that names its
        // own window is the one case where our curve is the wrong answer.
        statusFailures += 1;
        const wait = nextDelayMs(statusFailures, res.headers);
        const error = await errorFrom(res);
        if (!isRetryableStatus(res.status)) throw error; // never retry other 4xx
        lastError = error;
        if (statusFailures > (options.maxStatusRetries ?? RETRY_DELAYS_MS.length)) break;
        options.onRetry?.({
          attempt: statusFailures,
          delayMs: wait,
          kind: 'status',
          detail: error.detail,
        });
        await sleep(wait, req.signal);
      }

      throw (
        lastError ??
        new ProviderError({
          status: 0,
          type: 'unknown',
          message: 'request failed with no response',
        })
      );
    },
  };
}
