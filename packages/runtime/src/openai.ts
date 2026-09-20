/**
 * OpenAI adapter for the RuntimeProvider port — the proof that the port swaps.
 *
 * **Chat Completions, deliberately.** OpenAI recommends the Responses API for
 * new projects, and that is the forward path here too; Chat Completions is
 * chosen for the first cut as a *compatibility* choice (codex review, "Wire
 * formats and budgets"): it is the shape every OpenAI-compatible host also
 * speaks, so this adapter proves the port against more than one vendor. The
 * cost is named in the capability matrix rather than discovered at runtime —
 * most visibly, this wire has no document part at all.
 *
 * Raw `fetch`, no SDK, wire types private to this file. Same retry budget, same
 * `ProviderError`, same `Retry-After` handling as the Anthropic adapter, so
 * swapping the provider changes the endpoint and nothing about how failures
 * behave.
 *
 * Credential: `api-key` only. There is no subscription-token analogue and
 * nothing is discovered from the environment — `resolveProvider` has already
 * settled it, and this file never looks.
 *
 * What is *not* done here, on purpose:
 *  - the Claude Code identity block is never injected. It is an Anthropic
 *    subscription requirement, and sending it to another vendor would be a lie
 *    about who is calling.
 *  - tool arguments arrive as a JSON *string*; they are parsed and shape-checked
 *    before they can reach a dispatch. A string that is not a JSON object never
 *    becomes a silently-empty tool call.
 */
import { SseParser, frameJson, type SseFrame } from './sse.js';
import { providerAuthHeaders, type ResolvedProvider } from '@buddi/core';
import {
  OPENAI_TOOL_NAME_MAX,
  ProviderCapabilityError,
  ProviderError,
  toolNameMap,
  wireToolName,
  type CompletionRequest,
  type CompletionResponse,
  type ContentBlock,
  type NeutralMessage,
  type RetryNotice,
  type RuntimeProvider,
  type StopReason,
  type ToolSchema,
  type CompletionDelta,
} from './anthropic.js';
import { providerCapabilities } from './capabilities.js';
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

/** Chat Completions path, appended to the resolved base URL. */
export const CHAT_COMPLETIONS_PATH = '/chat/completions';

const DEFAULT_MAX_TOKENS = 16000;

/**
 * The key a malformed `arguments` string is handed to the registry under.
 *
 * A model that emits invalid JSON for a tool call must not produce an *empty*
 * call — that would run the tool with its defaults, which is an effect nobody
 * asked for. Instead the raw string is preserved under a key no tool schema
 * declares, so zod refuses it and the model sees the refusal, with its own
 * broken arguments quoted back.
 */
export const MALFORMED_ARGUMENTS_KEY = '__malformed_arguments';

export interface OpenAiProviderOptions {
  /**
   * Injected for tests. Defaults to `defaultHttpTransport` — `node:https` with
   * connection reuse off, not the global `fetch`. See `transport.ts` for why.
   */
  fetch?: HttpTransport;
  /** Injected for tests so backoff does not burn wall-clock. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected for tests: the transport retry window is measured against this. */
  now?: () => number;
  /** Called before each wait, with the cause chain of the attempt that failed. */
  onRetry?: (notice: RetryNotice) => void;
  /** Default output-token cap when a request does not set one. */
  maxTokens?: number;
  maxStatusRetries?: number;
}

/* ------------------------------------------------------------------ *
 * OpenAI wire types — private to this module
 * ------------------------------------------------------------------ */

type WireTextPart = { type: 'text'; text: string };
type WireImagePart = { type: 'image_url'; image_url: { url: string } };
type WirePart = WireTextPart | WireImagePart;

type WireToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | WirePart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type WireRequest = {
  model: string;
  /** Chat Completions' modern name for the output cap. */
  max_completion_tokens?: number;
  max_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  /**
   * How hard the model thinks. `none` switches reasoning off on hosts that
   * expose it that way (Ollama does); OpenAI's own models take `minimal` as
   * their lowest and refuse `none`.
   */
  reasoning_effort?: string;
  messages: WireMessage[];
  tools?: {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }[];
};

type WireResponse = {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      /** What the model thought first, on hosts that return it (Ollama). */
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/* ------------------------------------------------------------------ *
 * Neutral -> wire
 * ------------------------------------------------------------------ */

/** A base64 image block as this wire wants it: a `data:` URL in an image part. */
export function dataUrl(mime: string, data: string): string {
  return `data:${mime};base64,${data}`;
}

/**
 * Turn one neutral message into the wire messages it becomes.
 *
 * The asymmetry the capability matrix records as `toolResultOrdering`: a
 * neutral user turn carrying `tool_result` blocks becomes one `role:'tool'`
 * message per result — emitted *before* whatever else that turn carried, so the
 * assistant's `tool_calls` are answered immediately, as this wire requires.
 */
export function toWireMessages(
  message: NeutralMessage,
  names: Map<string, string>,
  provider: string,
): WireMessage[] {
  if (message.role === 'assistant') {
    const text = message.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const toolCalls: WireToolCall[] = message.content
      .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: {
          name: wireToolName(names, b.name),
          arguments: JSON.stringify(b.input ?? {}),
        },
      }));
    const wire: WireMessage = {
      role: 'assistant',
      content: text === '' ? null : text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    return [wire];
  }

  const toolMessages: WireMessage[] = [];
  const parts: WirePart[] = [];
  for (const block of message.content) {
    switch (block.type) {
      case 'tool_result':
        toolMessages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          // This wire has no `is_error`; the flag becomes visible text so the
          // model still learns the call failed.
          content: block.is_error ? `error: ${block.content}` : block.content,
        });
        break;
      case 'text':
        parts.push({ type: 'text', text: block.text });
        break;
      case 'image':
        parts.push({ type: 'image_url', image_url: { url: dataUrl(block.mime, block.data) } });
        break;
      case 'document':
        throw new ProviderCapabilityError({
          provider,
          blockType: 'document',
          message:
            `the ${provider} chat-completions wire cannot carry a document ` +
            `(${block.mime}${block.name ? `, "${block.name}"` : ''}). ` +
            'Extract the text first and send that, or run this agent on a ' +
            'provider whose wire accepts documents.',
        });
      case 'artifact_ref':
        // The loop hydrates these before any provider call; reaching here means
        // an un-hydrated history. Say so rather than dropping the block.
        parts.push({ type: 'text', text: '[attachment unavailable]' });
        break;
      case 'tool_use':
        // A tool_use in a user turn is not a shape this port produces.
        break;
      case 'provider_native':
        // Another vendor's opaque block. It is not persisted, so it can only
        // reach here through a hand-built history; dropping it is correct —
        // posting Anthropic's `server_tool_use` to this endpoint is not.
        break;
      case 'thinking':
        // The model's own earlier thoughts are not replayed on this wire.
        break;
    }
  }

  if (parts.length === 0) return toolMessages;
  const onlyText =
    parts.length === 1 && parts[0]?.type === 'text' ? (parts[0] as WireTextPart).text : undefined;
  return [
    ...toolMessages,
    { role: 'user', content: onlyText === undefined ? parts : onlyText },
  ];
}

export function toWireTools(tools: ToolSchema[], names: Map<string, string>): WireRequest['tools'] {
  if (tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: wireToolName(names, t.name),
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/* ------------------------------------------------------------------ *
 * Wire -> neutral
 * ------------------------------------------------------------------ */

/**
 * Parse a tool call's `arguments`.
 *
 * Complete-argument validation before dispatch (codex review, "Wire formats and
 * budgets"): the string must parse *and* must be a JSON object. Anything else —
 * a truncated stream, a bare array, `null` — is handed on under
 * `MALFORMED_ARGUMENTS_KEY` so the registry's schema refuses it loudly.
 */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  const text = (raw ?? '').trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { [MALFORMED_ARGUMENTS_KEY]: text };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { [MALFORMED_ARGUMENTS_KEY]: text };
  }
  return parsed as Record<string, unknown>;
}

export function mapFinishReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    default:
      return 'other';
  }
}

export function fromWireChoice(
  json: WireResponse,
  names: Map<string, string>,
): { content: ContentBlock[]; stopReason: StopReason } {
  const choice = json.choices?.[0];
  const out: ContentBlock[] = [];
  const thought = choice?.message?.reasoning ?? choice?.message?.reasoning_content;
  if (typeof thought === 'string' && thought.trim() !== '') out.push({ type: 'thinking', text: thought });
  const text = choice?.message?.content;
  if (typeof text === 'string' && text !== '') out.push({ type: 'text', text });
  for (const call of choice?.message?.tool_calls ?? []) {
    const name = call?.function?.name;
    if (typeof name !== 'string' || name === '') continue;
    out.push({
      type: 'tool_use',
      // A host that omits the id leaves nothing to key the answer by; an empty
      // string would be sent straight back and refused, so name it here.
      id: typeof call.id === 'string' && call.id !== '' ? call.id : `call_${out.length}`,
      name: names.get(name) ?? name,
      input: parseToolArguments(call?.function?.arguments),
    });
  }
  let stopReason = mapFinishReason(choice?.finish_reason);
  // Some compatible hosts answer `stop` while still returning tool calls.
  if (stopReason !== 'tool_use' && out.some((b) => b.type === 'tool_use')) {
    stopReason = 'tool_use';
  }
  return { content: out, stopReason };
}

/* ------------------------------------------------------------------ *
 * Adapter
 * ------------------------------------------------------------------ */

export function createOpenAiProvider(
  resolved: ResolvedProvider,
  options: OpenAiProviderOptions = {},
): RuntimeProvider {
  if (resolved.kind !== 'openai') {
    throw new Error(
      `createOpenAiProvider: provider is "${resolved.kind}", not "openai" — ` +
        'a provider is pinned, never coerced',
    );
  }
  const doFetch = options.fetch ?? defaultHttpTransport;
  if (typeof doFetch !== 'function') {
    throw new Error('createOpenAiProvider: no fetch implementation available');
  }
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? ((): number => Date.now());
  const defaultMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const url = `${resolved.baseUrl.replace(/\/+$/, '')}${CHAT_COMPLETIONS_PATH}`;
  const capabilities = providerCapabilities('openai');

  function headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      // OpenAI takes a bearer token and nothing else; `providerAuthHeaders`
      // already knows that from the resolved provider's kind.
      ...providerAuthHeaders(resolved),
    };
  }

  function body(req: CompletionRequest, names: Map<string, string>): WireRequest {
    const messages: WireMessage[] = [];
    // The system prompt is a `system` role message — never the Claude Code
    // identity line, which belongs to one vendor's subscription and nowhere else.
    if (req.system.trim() !== '') messages.push({ role: 'system', content: req.system });
    for (const message of req.messages) {
      messages.push(...toWireMessages(message, names, 'openai'));
    }
    const wire: WireRequest = {
      model: resolved.model,
      ...(resolved.compatible
        ? { max_tokens: req.maxTokens ?? defaultMaxTokens }
        : { max_completion_tokens: req.maxTokens ?? defaultMaxTokens }),
      messages,
    };
    const tools = toWireTools(req.tools, names);
    if (tools) wire.tools = tools;
    if (req.thinking === 'off') wire.reasoning_effort = resolved.compatible ? 'none' : 'minimal';
    else if (req.thinking === 'on' && !resolved.compatible) wire.reasoning_effort = 'medium';
    if (req.onDelta) {
      wire.stream = true;
      wire.stream_options = { include_usage: true };
    }
    return wire;
  }

  async function errorFrom(res: TransportResponse): Promise<ProviderError> {
    const requestId =
      res.headers?.get?.('x-request-id') ?? res.headers?.get?.('request-id') ?? null;
    let type = 'http_error';
    let message = `${res.status} ${res.statusText ?? ''}`.trim();
    try {
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: { type?: string; message?: string } };
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

  return {
    capabilities,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const names = toolNameMap(req.tools, OPENAI_TOOL_NAME_MAX);
      // Built before the first attempt: a capability refusal is a configuration
      // answer, not something to retry three times against a paid endpoint.
      const payload = JSON.stringify(body(req, names));
      const startedAt = now();
      // Two budgets, counted apart: see the Anthropic adapter's `complete`.
      let statusFailures = 0;
      let transportFailures = 0;
      let lastError: ProviderError | undefined;

      for (;;) {
        req.signal?.throwIfAborted();
        let res: TransportResponse;
        // Streaming: see the Anthropic adapter — the chunks are put back into
        // the non-streaming shape, and a failure after the first delta is final.
        const assembly = req.onDelta ? new OpenAiStreamAssembly(req.onDelta) : null;
        // Every attempt is a dispatch; a caller counting calls is told of each.
        await req.onDispatch?.();
        try {
          res = await doFetch(url, {
            method: 'POST', headers: headers(), body: payload,
            ...(req.signal ? { signal: req.signal } : {}),
            ...(assembly ? { onChunk: (text: string, status: number) => { if (status >= 200 && status < 300) assembly.push(text); } } : {}),
          });
        } catch (err) {
          req.signal?.throwIfAborted();
          if (assembly?.spoke) throw new ProviderError({ status: 0, type: 'transport_error', message: err instanceof Error ? err.message : String(err), cause: err });
          transportFailures += 1;
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
          const json = assembly ? assembly.finish() : ((await res.json()) as WireResponse);
          const { content, stopReason } = fromWireChoice(json, names);
          return {
            content,
            stopReason,
            usage: {
              input: json.usage?.prompt_tokens ?? 0,
              output: json.usage?.completion_tokens ?? 0,
            },
            model: json.model ?? resolved.model,
          };
        }

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

/**
 * The streamed form of one chat completion, put back together.
 *
 * Each chunk carries `choices[0].delta` with a piece of `content`, a piece of
 * `reasoning`, or a piece of a tool call keyed by `index`; the last chunk
 * with a choice names `finish_reason`, and with `include_usage` a final
 * chunk carries the counts. The result is the `WireResponse` the
 * non-streaming path would have received.
 */
class OpenAiStreamAssembly {
  readonly #parser = new SseParser();
  readonly #calls = new Map<number, { id?: string; function: { name?: string; arguments: string } }>();
  #content = '';
  #reasoning = '';
  #model: string | undefined;
  #finish: string | null = null;
  #usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  spoke = false;

  constructor(private readonly onDelta: (delta: CompletionDelta) => void) {}

  push(text: string): void {
    for (const frame of this.#parser.push(text)) this.#frame(frame);
  }

  #frame(frame: SseFrame): void {
    const json = frameJson(frame);
    if (!json) return;
    if (json.error && typeof json.error === 'object') {
      const error = json.error as Record<string, unknown>;
      throw new ProviderError({
        status: 0,
        type: typeof error.type === 'string' ? error.type : 'stream_error',
        message: typeof error.message === 'string' ? error.message : 'the stream reported an error',
      });
    }
    if (typeof json.model === 'string') this.#model = json.model;
    const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | null | undefined;
    if (usage && typeof usage === 'object') this.#usage = usage;
    const choices = Array.isArray(json.choices) ? (json.choices as Record<string, unknown>[]) : [];
    const choice = choices[0];
    if (!choice) return;
    if (typeof choice.finish_reason === 'string') this.#finish = choice.finish_reason;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.content === 'string' && delta.content !== '') {
      this.#content += delta.content;
      this.spoke = true;
      this.onDelta({ kind: 'text', text: delta.content });
    }
    const thought = typeof delta.reasoning === 'string' ? delta.reasoning
      : typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
    if (thought !== '') {
      this.#reasoning += thought;
      this.spoke = true;
      this.onDelta({ kind: 'thinking', text: thought });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const piece of delta.tool_calls as Record<string, unknown>[]) {
        const index = typeof piece.index === 'number' ? piece.index : this.#calls.size;
        const call = this.#calls.get(index) ?? { function: { arguments: '' } };
        if (typeof piece.id === 'string' && piece.id !== '') call.id = piece.id;
        const fn = (piece.function ?? {}) as Record<string, unknown>;
        if (typeof fn.name === 'string' && fn.name !== '') call.function.name = fn.name;
        if (typeof fn.arguments === 'string') call.function.arguments += fn.arguments;
        this.#calls.set(index, call);
      }
    }
  }

  finish(): WireResponse {
    for (const frame of this.#parser.end()) this.#frame(frame);
    const toolCalls = [...this.#calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    return {
      ...(this.#model ? { model: this.#model } : {}),
      choices: [{
        finish_reason: this.#finish,
        message: {
          content: this.#content === '' ? null : this.#content,
          ...(this.#reasoning === '' ? {} : { reasoning: this.#reasoning }),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      }],
      ...(this.#usage ? { usage: this.#usage } : {}),
    };
  }
}
