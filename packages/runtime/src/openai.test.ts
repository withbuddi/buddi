import { describe, expect, it, vi } from 'vitest';
import { resolveProvider, type ProviderRef } from '@buddi/core';
import {
  CLAUDE_CODE_SYSTEM_PREFIX,
  ProviderCapabilityError,
  ProviderError,
  type CompletionRequest,
} from './anthropic.js';
import { providerCapabilities } from './capabilities.js';
import {
  createOpenAiProvider,
  dataUrl,
  MALFORMED_ARGUMENTS_KEY,
  mapFinishReason,
  parseToolArguments,
} from './openai.js';

const openAiRef: ProviderRef = {
  kind: 'openai',
  credential: { kind: 'api-key', env: 'K' },
  model: 'gpt-5',
};

function resolved() {
  const r = resolveProvider(openAiRef, { K: 'sk-openai-secret' });
  if (!r.ok) throw new Error(`fixture failed to resolve: ${r.problem.message}`);
  return r.provider;
}

function okBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'gpt-5-2026-04-01',
    choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
    usage: { prompt_tokens: 11, completion_tokens: 3 },
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const noSleep = async () => {};

it('forwards cancellation to the transport and never retries an aborted request', async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn(async (_url: unknown, init: { signal?: AbortSignal } | undefined) => {
    expect(init?.signal).toBe(controller.signal);
    controller.abort(new Error('owner stopped'));
    throw new Error('transport aborted');
  });
  const sleep = vi.fn(noSleep);
  const provider = createOpenAiProvider(resolved(), { fetch: fetchMock as unknown as typeof fetch, sleep });
  await expect(provider.complete({ system: 'probe', messages: [], tools: [], signal: controller.signal })).rejects.toThrow('owner stopped');
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(sleep).not.toHaveBeenCalled();
});

const tools: CompletionRequest['tools'] = [
  {
    name: 'finance.project_cashflow',
    description: 'Project.',
    input_schema: { type: 'object', properties: {} },
  },
];

const request: CompletionRequest = {
  system: 'You are the scout agent.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools,
};

/** Send `req` and return the parsed wire body plus the URL and headers used. */
async function send(req: CompletionRequest, body: unknown = okBody()) {
  const fetchMock = vi.fn(async () => jsonResponse(200, body));
  const provider = createOpenAiProvider(resolved(), {
    fetch: fetchMock as unknown as typeof fetch,
    sleep: noSleep,
  });
  const res = await provider.complete(req);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { res, url, init, sent: JSON.parse(init.body as string) };
}

describe('createOpenAiProvider — the wire', () => {
  it('posts to chat/completions with a bearer token', async () => {
    const { url, init } = await send(request);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-openai-secret',
    );
    expect(init.headers).not.toHaveProperty('x-api-key');
    expect(init.headers).not.toHaveProperty('anthropic-version');
  });

  it('sends the system prompt as a system role message and never the Claude Code identity', async () => {
    const { sent } = await send(request);
    expect(sent.messages[0]).toEqual({
      role: 'system',
      content: 'You are the scout agent.',
    });
    expect(JSON.stringify(sent)).not.toContain(CLAUDE_CODE_SYSTEM_PREFIX);
  });

  it('declares the output cap under the name this wire uses', async () => {
    const { sent } = await send({ ...request, maxTokens: 512 });
    expect(sent.max_completion_tokens).toBe(512);
    expect(sent).not.toHaveProperty('max_tokens');
  });

  it('maps stop reasons and usage onto the neutral union', async () => {
    const { res } = await send(request);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toEqual({ input: 11, output: 3 });
    expect(res.model).toBe('gpt-5-2026-04-01');

    for (const [finish, expected] of [
      ['tool_calls', 'tool_use'],
      ['length', 'max_tokens'],
      ['content_filter', 'other'],
    ] as const) {
      expect(mapFinishReason(finish)).toBe(expected);
    }
  });

  it('declares its own capability row', () => {
    const provider = createOpenAiProvider(resolved(), { fetch: (async () => {}) as any });
    expect(provider.capabilities).toEqual(providerCapabilities('openai'));
  });

  it('refuses to be built for another provider', () => {
    expect(() =>
      createOpenAiProvider({
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        credentialKind: 'api-key',
        secret: 'k',
        model: 'claude-sonnet-5',
      }),
    ).toThrow(/not "openai"/);
  });
});

describe('createOpenAiProvider — tool calls', () => {
  it('encodes dotted tool names and decodes them back', async () => {
    const { sent, res } = await send(
      { ...request, tools },
      okBody({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'finance_project_cashflow',
                    arguments: '{"horizonDays": 60}',
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    expect(sent.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'finance_project_cashflow',
        description: 'Project.',
        parameters: { type: 'object', properties: {} },
      },
    });
    expect(res.stopReason).toBe('tool_use');
    expect(res.content[0]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'finance.project_cashflow',
      input: { horizonDays: 60 },
    });
  });

  it('parses and validates arguments before anything can be dispatched', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArguments('')).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
    // Truncated, a bare array, a bare scalar: never an empty call, which would
    // run the tool with its defaults. The raw text is kept for the refusal.
    expect(parseToolArguments('{"a":')).toEqual({ [MALFORMED_ARGUMENTS_KEY]: '{"a":' });
    expect(parseToolArguments('[1,2]')).toEqual({ [MALFORMED_ARGUMENTS_KEY]: '[1,2]' });
    expect(parseToolArguments('null')).toEqual({ [MALFORMED_ARGUMENTS_KEY]: 'null' });
  });

  it('turns tool results into role:tool messages keyed by tool_call_id', async () => {
    const { sent } = await send({
      ...request,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'project it' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'looking' },
            { type: 'tool_use', id: 'call_9', name: 'finance.project_cashflow', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_9', content: '{"ok":true}' },
            { type: 'text', text: 'and then?' },
          ],
        },
      ],
    });
    const [, first, assistant, toolMessage, followUp] = sent.messages;
    expect(first.role).toBe('user');
    expect(assistant).toEqual({
      role: 'assistant',
      content: 'looking',
      tool_calls: [
        {
          id: 'call_9',
          type: 'function',
          function: { name: 'finance_project_cashflow', arguments: '{}' },
        },
      ],
    });
    // The tool answer comes immediately after the call, before the new text.
    expect(toolMessage).toEqual({
      role: 'tool',
      tool_call_id: 'call_9',
      content: '{"ok":true}',
    });
    expect(followUp).toEqual({ role: 'user', content: 'and then?' });
  });

  it('carries an error flag as visible text, since this wire has no is_error', async () => {
    const { sent } = await send({
      ...request,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'c1', content: 'refused: no', is_error: true },
          ],
        },
      ],
    });
    expect(sent.messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'error: refused: no',
    });
  });
});

describe('createOpenAiProvider — attachments', () => {
  it('sends an image as a data URL in an image_url part', async () => {
    const { sent } = await send({
      ...request,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', mime: 'image/png', data: 'AAAA' },
          ],
        },
      ],
    });
    expect(sent.messages[1].content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: dataUrl('image/png', 'AAAA') } },
    ]);
  });

  it('refuses a PDF with a typed capability error that says what to do instead', async () => {
    const provider = createOpenAiProvider(resolved(), {
      fetch: (async () => {
        throw new Error('must not be called');
      }) as unknown as typeof fetch,
      sleep: noSleep,
    });
    const attempt = provider.complete({
      ...request,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              mime: 'application/pdf',
              data: 'JVBER',
              name: 'statement.pdf',
            },
          ],
        },
      ],
    });
    await expect(attempt).rejects.toBeInstanceOf(ProviderCapabilityError);
    await expect(attempt).rejects.toThrow(/Extract the text first/);
  });
});

describe('createOpenAiProvider — failures', () => {
  it('never retries a 4xx and carries the API error through', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, { error: { type: 'invalid_request_error', message: 'bad model' } }),
    );
    const provider = createOpenAiProvider(resolved(), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(provider.complete(request)).rejects.toMatchObject({
      name: 'ProviderError',
      status: 400,
      type: 'invalid_request_error',
      message: 'bad model',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 on the shared budget and honours Retry-After', async () => {
    const slept: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'slow down' } }, {
        'retry-after': '7',
      }))
      .mockResolvedValueOnce(jsonResponse(200, okBody()));
    const provider = createOpenAiProvider(resolved(), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const res = await provider.complete(request);
    expect(res.stopReason).toBe('end_turn');
    // The server's own window beats the curve's first step (500ms).
    expect(slept).toEqual([7000]);
  });

  it('gives up after the shared retry budget', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, { error: { message: 'boom' } }));
    const provider = createOpenAiProvider(resolved(), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(provider.complete(request)).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('never puts the secret in an error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const provider = createOpenAiProvider(resolved(), {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(provider.complete(request)).rejects.toThrow(/network down/);
    await expect(provider.complete(request)).rejects.not.toThrow(/sk-openai-secret/);
  });
});
