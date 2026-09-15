import { describe, expect, it, vi } from 'vitest';
import { resolveProvider, type ProviderRef } from '@buddi/core';
import {
  ATTACHMENT_UNAVAILABLE,
  CLAUDE_CODE_SYSTEM_PREFIX,
  ProviderError,
  createAnthropicProvider,
  toolNameMap,
  type CompletionRequest,
} from './anthropic.js';

const AGENT_PROMPT = 'You are the finance agent.';

const request: CompletionRequest = {
  system: AGENT_PROMPT,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [
    { name: 'finance.balance', description: 'Balance.', input_schema: { type: 'object' } },
  ],
};

function okBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 11, output_tokens: 3 },
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function resolve(kind: 'api-key' | 'subscription-token') {
  const ref: ProviderRef =
    kind === 'api-key'
      ? {
          kind: 'anthropic',
          credential: { kind: 'api-key', env: 'K' },
          model: 'claude-sonnet-5',
        }
      : {
          kind: 'anthropic',
          credential: { kind: 'subscription-token', env: 'K' },
          model: 'claude-sonnet-5',
        };
  const r = resolveProvider(ref, { K: 'secret-value' });
  if (!r.ok) throw new Error('fixture failed to resolve');
  return r.provider;
}

const noSleep = async () => {};

describe('createAnthropicProvider — subscription-token wire requirements', () => {
  it('sends the oauth beta header and the Claude Code system prefix', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody()));
    const provider = createAnthropicProvider(resolve('subscription-token'), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: noSleep,
    });

    await provider.complete(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBe('Bearer secret-value');
    expect(headers['x-api-key']).toBeUndefined();

    const body = JSON.parse(init.body as string);
    // The API compares the FIRST system block for equality with the identity
    // line — a concatenated "<line>\n<prompt>" string is rejected with 429.
    expect(body.system).toEqual([
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX },
      { type: 'text', text: AGENT_PROMPT },
    ]);
    expect(body.system[0].text).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.tools).toEqual([
      { name: 'finance_balance', description: 'Balance.', input_schema: { type: 'object' } },
    ]);
  });

  it('does not double the identity line when the prompt already carries it', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody()));
    const provider = createAnthropicProvider(resolve('subscription-token'), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: noSleep,
    });

    await provider.complete({
      ...request,
      system: `${CLAUDE_CODE_SYSTEM_PREFIX}\n${AGENT_PROMPT}`,
    });

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.system).toEqual([
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX },
      { type: 'text', text: AGENT_PROMPT },
    ]);
  });

  it('sends the identity line alone when the agent has no prompt of its own', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody()));
    const provider = createAnthropicProvider(resolve('subscription-token'), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: noSleep,
    });
    await provider.complete({ ...request, system: '' });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.system).toEqual([{ type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX }]);
  });
});

describe('createAnthropicProvider — api-key wire requirements', () => {
  it('sends x-api-key and neither the beta header nor the prefix', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody()));
    const provider = createAnthropicProvider(resolve('api-key'), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: noSleep,
    });

    await provider.complete(request);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('secret-value');
    expect(headers['anthropic-beta']).toBeUndefined();
    expect(headers.authorization).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body.system).toBe(AGENT_PROMPT);
  });
});

describe('createAnthropicProvider — responses and errors', () => {
  it('maps content blocks, stop reason and usage', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        200,
        okBody({
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'calling' },
            { type: 'thinking', thinking: 'ignored' },
            { type: 'tool_use', id: 'tu_1', name: 'finance.balance', input: { a: 1 } },
          ],
        }),
      ),
    );
    const provider = createAnthropicProvider(resolve('api-key'), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: noSleep,
    });

    const res = await provider.complete(request);
    expect(res.stopReason).toBe('tool_use');
    expect(res.usage).toEqual({ input: 11, output: 3 });
    expect(res.model).toBe('claude-sonnet-5');
    expect(res.content).toEqual([
      { type: 'text', text: 'calling' },
      { type: 'tool_use', id: 'tu_1', name: 'finance.balance', input: { a: 1 } },
    ]);
  });

  it('maps max_tokens', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody({ stop_reason: 'max_tokens' })));
    const provider = createAnthropicProvider(resolve('api-key'), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect((await provider.complete(request)).stopReason).toBe('max_tokens');
  });

  it('retries a 429 and then succeeds', async () => {
    const delays: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, okBody()));

    const provider = createAnthropicProvider(resolve('subscription-token'), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const res = await provider.complete(request);
    expect(res.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([500]);
  });

  it('gives up after three retries and throws the typed error', async () => {
    const delays: number[] = [];
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        529,
        { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } },
        { 'request-id': 'req_123' },
      ),
    );
    const provider = createAnthropicProvider(resolve('api-key'), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(provider.complete(request)).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([500, 1500, 4000]);
  });

  it('never retries a non-retryable 4xx', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        400,
        { type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } },
        { 'request-id': 'req_abc' },
      ),
    );
    const provider = createAnthropicProvider(resolve('api-key'), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: noSleep,
    });

    const err = await provider.complete(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const pe = err as ProviderError;
    expect(pe.status).toBe(400);
    expect(pe.type).toBe('invalid_request_error');
    expect(pe.message).toBe('bad model');
    expect(pe.requestId).toBe('req_abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transport failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(200, okBody()));
    const provider = createAnthropicProvider(resolve('api-key'), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(provider.complete(request)).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours an explicit base URL without doubling slashes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody()));
    const provider = createAnthropicProvider(
      { ...resolve('api-key'), baseUrl: 'https://proxy.internal/' },
      { fetch: fetchMock as unknown as typeof fetch, sleep: noSleep },
    );
    await provider.complete(request);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe(
      'https://proxy.internal/v1/messages',
    );
  });
});

describe('tool name wire encoding', () => {
  const tools = [
    { name: 'finance.project_cashflow', description: 'd', input_schema: {} },
    { name: 'plain_tool', description: 'd', input_schema: {} },
  ];

  it('maps dotted registry names to wire-legal names and back', () => {
    const map = toolNameMap(tools);
    expect(map.get('finance_project_cashflow')).toBe('finance.project_cashflow');
    expect(map.get('plain_tool')).toBe('plain_tool');
  });

  it('disambiguates names that collide once encoded', () => {
    const map = toolNameMap([
      { name: 'a.b', description: 'd', input_schema: {} },
      { name: 'a-b', description: 'd', input_schema: {} },
      { name: 'a:b', description: 'd', input_schema: {} },
    ]);
    expect([...map.values()].sort()).toEqual(['a-b', 'a.b', 'a:b']);
    expect(new Set(map.keys()).size).toBe(3);
  });

  it('sends the encoded name and decodes tool_use back to the registry name', async () => {
    let sent: any;
    const fetchMock = async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'claude-sonnet-5',
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'finance_project_cashflow',
              input: { horizonDays: 60 },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      } as any;
    };
    const provider = createAnthropicProvider(
      {
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        credentialKind: 'api-key',
        secret: 'k',
        model: 'claude-sonnet-5',
      },
      { fetch: fetchMock as any },
    );
    const res = await provider.complete({
      system: 's',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_0', name: 'finance.project_cashflow', input: {} },
          ],
        },
      ],
      tools,
    });
    expect(sent.tools[0].name).toBe('finance_project_cashflow');
    expect(sent.messages[0].content[0].name).toBe('finance_project_cashflow');
    expect(res.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'finance.project_cashflow',
    });
  });
});

describe('createAnthropicProvider — multimodal blocks', () => {
  /** Send one user message and return the parsed wire body. */
  async function wireBodyFor(content: CompletionRequest['messages'][number]['content']) {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody()));
    const provider = createAnthropicProvider(resolve('api-key'), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: noSleep,
    });
    await provider.complete({ ...request, messages: [{ role: 'user', content }] });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return JSON.parse(init.body as string);
  }

  it('maps a neutral image block to an Anthropic base64 image source', async () => {
    const body = await wireBodyFor([
      { type: 'text', text: 'what is this?' },
      { type: 'image', mime: 'image/png', data: 'QUJD' },
    ]);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
  });

  it('maps a neutral document block to an Anthropic base64 PDF document', async () => {
    const body = await wireBodyFor([
      { type: 'document', mime: 'application/pdf', data: 'JVBERi0=', name: 'august.pdf' },
    ]);
    expect(body.messages[0].content).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
        title: 'august.pdf',
      },
    ]);
  });

  it('omits the document title when the block carries no name', async () => {
    const body = await wireBodyFor([
      { type: 'document', mime: 'application/pdf', data: 'JVBERi0=' },
    ]);
    expect(body.messages[0].content[0].title).toBeUndefined();
  });

  it('never puts a persisted artifact_ref on the wire', async () => {
    // The loop hydrates refs before calling a provider; if one still arrives,
    // the model is told the attachment is unavailable rather than shown nothing.
    const body = await wireBodyFor([
      { type: 'artifact_ref', artifactId: 'a-1', mime: 'image/png', kind: 'image' },
    ]);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: ATTACHMENT_UNAVAILABLE },
    ]);
  });
});

/**
 * The wire contract that actually broke. The Messages API rejects the whole
 * request — every turn, before a single token — when a tool's schema has no
 * `input_schema.type` (`tools.8.custom.input_schema.type: Field required`),
 * and rejects it again if the schema is a union at the top level even with the
 * type stated (`input_schema does not support oneOf, allOf, or anyOf at the top
 * level`). The registry is what guarantees the shape (see `toolInputSchema`);
 * this is the assertion that the adapter puts it on the wire unaltered.
 */
describe('createAnthropicProvider — input_schema on the wire', () => {
  /**
   * What the registry produces for a discriminated-union input such as
   * `canvas.show`: the object type stated alongside the rendered branches.
   */
  const flattenedUnion = {
    type: 'object',
    properties: {
      renderer: { type: 'string', enum: ['table', 'bars'] },
      data: {
        anyOf: [
          { type: 'object', properties: { rows: { type: 'array' } } },
          { type: 'object', properties: { bars: { type: 'array' } } },
        ],
      },
    },
    required: ['renderer', 'data'],
  };

  it('sends every tool with an object type, branches intact', async () => {
    let sent: any;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return jsonResponse(200, okBody());
    });
    const provider = createAnthropicProvider(
      {
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        credentialKind: 'api-key',
        secret: 'k',
        model: 'claude-sonnet-5',
      },
      { fetch: fetchMock as any },
    );
    await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [
        { name: 'finance.balance', description: 'd', input_schema: { type: 'object' } },
        { name: 'canvas.show', description: 'd', input_schema: flattenedUnion },
      ],
    });
    for (const tool of sent.tools) {
      expect(tool.input_schema.type, tool.name).toBe('object');
      expect(tool.input_schema.anyOf, tool.name).toBeUndefined();
      expect(tool.input_schema.oneOf, tool.name).toBeUndefined();
      expect(tool.input_schema.allOf, tool.name).toBeUndefined();
    }
    // Unaltered below the top level, where alternatives are legal.
    expect(sent.tools[1].input_schema).toEqual(flattenedUnion);
  });
});
