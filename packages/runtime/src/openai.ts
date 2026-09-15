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
} from './anthropic.js';
import { providerCapabilities } from './capabilities.js';
import {
  defaultSleep,
  isRetryableStatus,
  nextDelayMs,
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
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests: the transport retry window is measured against this. */
  now?: () => number;
  /** Called before each wait, with the cause chain of the attempt that failed. */
  onRetry?: (notice: RetryNotice) => void;
  /** Default output-token cap when a request does not set one. */
  maxTokens?: number;
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
  max_completion_tokens: number;
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
      max_completion_tokens: req.maxTokens ?? defaultMaxTokens,
      messages,
    };
    const tools = toWireTools(req.tools, names);
    if (tools) wire.tools = tools;
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
    return new ProviderError({ status: res.status, type, message, requestId });
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
        let res: TransportResponse;
        try {
          res = await doFetch(url, { method: 'POST', headers: headers(), body: payload });
        } catch (err) {
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
          await sleep(delay);
          continue;
        }

        if (res.ok) {
          const json = (await res.json()) as WireResponse;
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
        if (statusFailures > RETRY_DELAYS_MS.length) break;
        options.onRetry?.({
          attempt: statusFailures,
          delayMs: wait,
          kind: 'status',
          detail: error.detail,
        });
        await sleep(wait);
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
