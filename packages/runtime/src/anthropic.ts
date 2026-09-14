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
import { providerAuthHeaders, type ResolvedProvider } from '@buddi/core';
import { providerCapabilities, type ProviderCapabilities } from './capabilities.js';
import {
  defaultSleep,
  isRetryableStatus,
  nextDelayMs,
  RETRY_DELAYS_MS,
} from './retry.js';

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
  | { type: 'artifact_ref'; artifactId: string; mime: string; kind: string };

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
  /** The agent's own system prompt. Adapter-specific prefixes are added here. */
  system: string;
  messages: NeutralMessage[];
  tools: ToolSchema[];
  maxTokens?: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'other';

export interface Usage {
  input: number;
  output: number;
}

export interface CompletionResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  /** Concrete model the endpoint reports it served (per-run snapshot input). */
  model: string;
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

/** Typed transport/API failure. Never carries the credential. */
export class ProviderError extends Error {
  readonly status: number;
  readonly type: string;
  readonly requestId: string | null;

  constructor(args: {
    status: number;
    type: string;
    message: string;
    requestId?: string | null;
  }) {
    super(args.message);
    this.name = 'ProviderError';
    this.status = args.status;
    this.type = args.type;
    this.requestId = args.requestId ?? null;
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

export interface AnthropicProviderOptions {
  /** Injected for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Injected for tests so backoff does not burn wall-clock. */
  sleep?: (ms: number) => Promise<void>;
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
  | WireDocumentBlock;

type WireSystemBlock = { type: 'text'; text: string };

type WireRequest = {
  model: string;
  max_tokens: number;
  /** A plain string for `api-key`; blocks for `subscription-token`. */
  system: string | WireSystemBlock[];
  messages: { role: MessageRole; content: WireBlock[] }[];
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
};

type WireResponse = {
  model?: string;
  stop_reason?: string | null;
  content?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
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
): Map<string, string> {
  const map = new Map<string, string>();
  for (const tool of tools) {
    if (WIRE_TOOL_NAME_CHARS.test(tool.name) && tool.name.length <= maxLength) {
      map.set(tool.name, tool.name);
      continue;
    }
    const base = encodeToolName(tool.name, maxLength);
    let wire = base;
    for (let n = 2; map.has(wire); n++) wire = `${base.slice(0, maxLength - 4)}_${n}`;
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

function fromWireBlocks(raw: unknown, names: Map<string, string>): ContentBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: ContentBlock[] = [];
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
    }
    // Anything else (thinking, server tool blocks) is not part of this port.
  }
  return out;
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
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('createAnthropicProvider: no fetch implementation available');
  }
  const sleep = options.sleep ?? defaultSleep;
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
    if (req.tools.length > 0) {
      wire.tools = req.tools.map((t) => ({
        name: wireNameFor(names, t.name),
        description: t.description,
        input_schema: t.input_schema,
      }));
    }
    return wire;
  }

  async function errorFrom(res: Response): Promise<ProviderError> {
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
    return new ProviderError({ status: res.status, type, message, requestId });
  }

  const capabilities = providerCapabilities('anthropic');

  return {
    capabilities,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const names = toolNameMap(req.tools);
      const payload = JSON.stringify(body(req, names));
      let lastError: ProviderError | undefined;
      /** What the last failure asked us to wait, when it asked. */
      let delay = 0;

      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) await sleep(delay);

        let res: Response;
        try {
          res = await doFetch(url, { method: 'POST', headers: headers(), body: payload });
        } catch (err) {
          // Transport failure: retryable, same budget as a 5xx.
          lastError = new ProviderError({
            status: 0,
            type: 'transport_error',
            message: err instanceof Error ? err.message : String(err),
          });
          delay = nextDelayMs(attempt + 1);
          continue;
        }

        if (res.ok) {
          const json = (await res.json()) as WireResponse;
          return {
            content: fromWireBlocks(json.content, names),
            stopReason: mapStopReason(json.stop_reason),
            usage: {
              input: json.usage?.input_tokens ?? 0,
              output: json.usage?.output_tokens ?? 0,
            },
            model: json.model ?? resolved.model,
          };
        }

        // Read `Retry-After` before the body is consumed: a 429 that names its
        // own window is the one case where our curve is the wrong answer.
        const wait = nextDelayMs(attempt + 1, res.headers);
        const error = await errorFrom(res);
        if (!isRetryableStatus(res.status)) throw error; // never retry other 4xx
        lastError = error;
        delay = wait;
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
