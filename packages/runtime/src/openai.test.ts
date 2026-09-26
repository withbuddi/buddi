import { describe, expect, it, vi } from 'vitest';
import { resolveProvider, type ProviderRef } from '@buddi/core';
import {
  CLAUDE_CODE_SYSTEM_PREFIX,
  ProviderCapabilityError,
  ProviderError,
  refusesImages,
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

it('supports a compatible local endpoint, custom model and no-key auth without leaking an OpenAI key', async () => {
  const fetchMock = vi.fn(async (_url: string, _init: any) => jsonResponse(200, okBody({ model: 'local-custom' })));
  const provider = createOpenAiProvider({ ...resolved(), compatible: true, secret: '', baseUrl: 'http://localhost:11434/v1', model: 'local-custom' }, { fetch: fetchMock });
  await provider.complete({ system: '', messages: [], tools: [], maxTokens: 100 });
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('http://localhost:11434/v1/chat/completions');
  expect(init.headers.authorization).toBeUndefined();
  expect(JSON.parse(init.body)).toMatchObject({ model: 'local-custom', max_tokens: 100 });
  expect(JSON.parse(init.body)).not.toHaveProperty('max_completion_tokens');
});

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

it('reports rate limits immediately for connection probes', async () => {
  const fetchMock = vi.fn(async () => jsonResponse(429, { error: { message: 'limited', type: 'rate_limit_error' } }));
  const sleep = vi.fn(noSleep);
  const provider = createOpenAiProvider(resolved(), { fetch: fetchMock, sleep, maxStatusRetries: 0 });
  await expect(provider.complete(request)).rejects.toMatchObject({ status: 429 });
  expect(fetchMock).toHaveBeenCalledOnce(); expect(sleep).not.toHaveBeenCalled();
});

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
  it('keeps a length stop and flags the tool call it cut off', async () => {
    const { res } = await send(
      { ...request, tools },
      okBody({
        choices: [{
          finish_reason: 'length',
          message: {
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'finance_project_cashflow', arguments: '{"rows": [' } }],
          },
        }],
      }),
    );
    expect(res.stopReason).toBe('max_tokens');
    expect(res.content).toEqual([{
      type: 'tool_use', id: 'call_1', name: 'finance.project_cashflow',
      input: { [MALFORMED_ARGUMENTS_KEY]: '{"rows": [' }, truncated: true,
    }]);
  });

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
  it('preserves retry timing and quota type for connection diagnostics', async () => {
    const provider = createOpenAiProvider(resolved(), { maxStatusRetries: 0,
      fetch: vi.fn(async () => jsonResponse(429, { error: { type: 'insufficient_quota', message: 'quota' } }, { 'retry-after': '7200' })) });
    const before = Date.now();
    const error = await provider.complete(request).catch(e => e);
    expect(error.type).toBe('insufficient_quota');
    expect(Date.parse(error.retryAt)).toBeGreaterThanOrEqual(before + 7200_000);
  });
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

  it('marks a model that does not take images, so the loop can send the turn again without them', async () => {
    const provider = createOpenAiProvider(resolved(), { sleep: noSleep,
      fetch: vi.fn(async () => jsonResponse(400, { error: { type: 'invalid_request_error', message: 'this model does not support image input' } })) as unknown as typeof fetch });
    await expect(provider.complete(request)).rejects.toMatchObject({ name: 'ProviderError', status: 400, reason: 'images-unsupported' });
    const other = createOpenAiProvider(resolved(), { sleep: noSleep,
      fetch: vi.fn(async () => jsonResponse(400, { error: { type: 'invalid_request_error', message: 'bad model' } })) as unknown as typeof fetch });
    expect((await other.complete(request).catch((e) => e)).reason).toBeNull();
  });

  it('recognises the ways a provider says a model does not take images', () => {
    for (const said of [
      'this model does not support image input',
      'Model does not support images',
      'image_url is not supported by this model',
      'vision is not supported for this model',
      'Image input is disabled for this deployment',
    ]) expect(refusesImages(said), said).toBe(true);
    for (const said of ['bad model', 'context length exceeded', 'rate limited']) expect(refusesImages(said), said).toBe(false);
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

describe('createOpenAiProvider — thinking and streaming', () => {
  it('turns reasoning off in the words each host understands', async () => {
    const bodies: any[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init: any) => { bodies.push(JSON.parse(init.body)); return jsonResponse(200, okBody()); });
    const local = createOpenAiProvider({ ...resolved(), compatible: true, secret: '', baseUrl: 'http://localhost:11434/v1', model: 'gemma4:12b' }, { fetch: fetchMock as unknown as typeof fetch });
    await local.complete({ ...request, thinking: 'off' });
    await local.complete({ ...request, thinking: 'on' });
    await local.complete(request);
    const cloud = createOpenAiProvider(resolved(), { fetch: fetchMock as unknown as typeof fetch });
    await cloud.complete({ ...request, thinking: 'off' });
    expect(bodies[0].reasoning_effort).toBe('none');
    // Ollama's default is on; nothing is sent so the model keeps its own.
    expect(bodies[1].reasoning_effort).toBeUndefined();
    expect(bodies[2].reasoning_effort).toBeUndefined();
    expect(bodies[3].reasoning_effort).toBe('minimal');
    // Ollama is also asked in its own words, and only Ollama.
    expect(bodies[0].think).toBe(false);
    expect(bodies[1].think).toBeUndefined();
    expect(bodies[2].think).toBeUndefined();
    expect(bodies[3].think).toBeUndefined();
  });

  it('asks the hosted Ollama the same way, and no one else', async () => {
    const bodies: any[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init: any) => { bodies.push(JSON.parse(init.body)); return jsonResponse(200, okBody()); });
    const hosted = createOpenAiProvider({ ...resolved(), compatible: true, baseUrl: 'https://ollama.com/v1', model: 'glm-5.3-flash' }, { fetch: fetchMock as unknown as typeof fetch });
    await hosted.complete({ ...request, thinking: 'off' });
    const elsewhere = createOpenAiProvider({ ...resolved(), compatible: true, baseUrl: 'https://api.together.xyz/v1', model: 'whatever' }, { fetch: fetchMock as unknown as typeof fetch });
    await elsewhere.complete({ ...request, thinking: 'off' });
    expect(bodies[0].think).toBe(false);
    expect(bodies[1].think).toBeUndefined();
    expect(bodies[1].reasoning_effort).toBe('none');
  });

  /*
   * Measured against the Ollama on this machine: `reasoning_effort: 'none'`
   * and `think: false` are both accepted and both ignored by a thinking model,
   * which opens its *answer* with `<think>…</think>` instead. Left there, the
   * reasoning is the answer as far as every surface is concerned.
   */
  it('takes the reasoning a model wrote into its own answer back out of it', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody({
      choices: [{ finish_reason: 'stop', message: { content: '<think> They asked for five words. Keep it short. </think>\n\nHello, good to meet you.' } }],
    })));
    const provider = createOpenAiProvider({ ...resolved(), compatible: true, baseUrl: 'http://localhost:11434/v1' }, { fetch: fetchMock as unknown as typeof fetch });
    const res = await provider.complete({ ...request, thinking: 'off' });
    expect(res.content).toEqual([
      { type: 'thinking', text: ' They asked for five words. Keep it short. ' },
      { type: 'text', text: 'Hello, good to meet you.' },
    ]);
  });

  it('keeps an unfinished thought out of the answer entirely', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody({
      choices: [{ finish_reason: 'length', message: { content: '<think>Still deciding how to' } }],
    })));
    const provider = createOpenAiProvider({ ...resolved(), compatible: true, baseUrl: 'http://localhost:11434/v1' }, { fetch: fetchMock as unknown as typeof fetch });
    const res = await provider.complete({ ...request, thinking: 'off' });
    expect(res.content).toEqual([{ type: 'thinking', text: 'Still deciding how to' }]);
  });

  it('keeps what the model thought as its own block', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody({ choices: [{ finish_reason: 'stop', message: { content: '391', reasoning: '17 times 23…' } }] })));
    const provider = createOpenAiProvider(resolved(), { fetch: fetchMock as unknown as typeof fetch });
    const res = await provider.complete(request);
    expect(res.content).toEqual([{ type: 'thinking', text: '17 times 23…' }, { type: 'text', text: '391' }]);
  });

  it('streams a written-in thought to the thinking channel, never to the answer', async () => {
    // The tag arrives in pieces, which is the case that leaks: a chunk
    // boundary inside `<think>` must not put a word of it in the answer.
    const chunks = [
      { model: 'lfm2.5-thinking', choices: [{ delta: { role: 'assistant', content: '<thi' } }] },
      { choices: [{ delta: { content: 'nk>Five words. ' } }] },
      { choices: [{ delta: { content: 'Keep it short.</think>' } }] },
      { choices: [{ delta: { content: '\n\nHello, good to' } }] },
      { choices: [{ delta: { content: ' meet you.' } }, { finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 6 } },
    ];
    const wire = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      init.onChunk(wire, 200);
      return new Response(wire, { status: 200 });
    });
    const provider = createOpenAiProvider({ ...resolved(), compatible: true, baseUrl: 'http://localhost:11434/v1' }, { fetch: fetchMock as unknown as typeof fetch });
    const deltas: any[] = [];
    const res = await provider.complete({ ...request, thinking: 'off', onDelta: (d) => deltas.push(d) });
    expect(deltas.filter((d) => d.kind === 'text').map((d) => d.text).join('')).toBe('Hello, good to meet you.');
    expect(deltas.filter((d) => d.kind === 'thinking').map((d) => d.text).join('')).toBe('Five words. Keep it short.');
    expect(res.content).toEqual([
      { type: 'thinking', text: 'Five words. Keep it short.' },
      { type: 'text', text: 'Hello, good to meet you.' },
    ]);
  });

  it('streams when asked, hands out each piece, and returns the assembled answer', async () => {
    const chunks = [
      { model: 'gemma4:12b', choices: [{ delta: { role: 'assistant', reasoning: 'think' } }] },
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'finance_balance', arguments: '{"a"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 6 } },
    ];
    const wire = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      const cut = Math.floor(wire.length / 3);
      init.onChunk(wire.slice(0, cut), 200);
      init.onChunk(wire.slice(cut), 200);
      return new Response(wire, { status: 200 });
    });
    const provider = createOpenAiProvider(resolved(), { fetch: fetchMock as unknown as typeof fetch });
    const deltas: any[] = [];
    const res = await provider.complete({ ...request, onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual([
      { kind: 'thinking', text: 'think' },
      { kind: 'text', text: 'Hel' },
      { kind: 'text', text: 'lo' },
    ]);
    expect(res.content).toEqual([
      { type: 'thinking', text: 'think' },
      { type: 'text', text: 'Hello' },
      // No such tool in this request's map, so the wire name stands.
      { type: 'tool_use', id: 'call_1', name: 'finance_balance', input: { a: 1 } },
    ]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.usage).toEqual({ input: 4, output: 6 });
    expect(res.model).toBe('gemma4:12b');
  });
});
