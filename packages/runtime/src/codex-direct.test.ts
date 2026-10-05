import { describe, expect, it, vi } from 'vitest';
import { CODEX_CLIENT_VERSION, CODEX_DEFAULT_MODEL, createCodexDirectAdapter, generateCodexImage, listCodexModels } from './codex-direct.js';
import type { CompletionRequest } from './anthropic.js';
import type { HttpTransport, TransportRequest, TransportResponse } from './transport.js';

const sse = (...events: Record<string, unknown>[]) => events.map(e => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
function reply(status: number, body: string): TransportResponse {
  return { ok: status >= 200 && status < 300, status, statusText: '', headers: { get: () => null },
    json: async () => JSON.parse(body), text: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
}
/** Delivers the body through onChunk in small pieces, like a stream. */
function streaming(status: number, body: string) {
  return vi.fn<HttpTransport>(async (_url: string, init: TransportRequest) => {
    for (let i = 0; i < body.length; i += 37) init.onChunk?.(body.slice(i, i + 37), status);
    return reply(status, body);
  });
}
const completed = (usage = { input_tokens: 11, output_tokens: 7 }) => ({ type: 'response.completed', response: { status: 'completed', model: 'gpt-5.5', usage } });
const request = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({
  system: 'Be brief.', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], ...over,
});
const adapter = (transport: HttpTransport) => createCodexDirectAdapter({ model: 'gpt-5.5', accessToken: 'tok-1', accountId: 'acct-1', transport });

describe('Codex direct adapter', () => {
  it('assembles text and streams deltas', async () => {
    const send = streaming(200, sse(
      { type: 'response.created', response: {} },
      { type: 'response.output_item.added', item: { type: 'message', id: 'm1' } },
      { type: 'response.output_text.delta', item_id: 'm1', delta: 'Hel' },
      { type: 'response.output_text.delta', item_id: 'm1', delta: 'lo' },
      completed(),
    ));
    const deltas: unknown[] = [];
    const out = await adapter(send).complete(request({ onDelta: d => deltas.push(d) }));
    expect(out).toEqual({ content: [{ type: 'text', text: 'Hello' }], stopReason: 'end_turn', usage: { input: 11, output: 7 }, model: 'gpt-5.5' });
    expect(deltas).toEqual([{ kind: 'text', text: 'Hel' }, { kind: 'text', text: 'lo' }]);
  });

  it('builds the request: headers, input items, tools, no output cap', async () => {
    const send = streaming(200, sse(completed()));
    const onDispatch = vi.fn(async () => {});
    await adapter(send).complete(request({
      thinking: 'on', onDispatch,
      tools: [{ name: 'web.fetch', description: 'Fetch', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mime: 'image/png', data: 'AAA' }] },
        { role: 'assistant', content: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 'call_1', name: 'web.fetch', input: { url: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'boom', is_error: true }] },
      ],
    }));
    expect(onDispatch).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok-1', 'chatgpt-account-id': 'acct-1', originator: 'buddi',
      'openai-beta': 'responses=experimental', accept: 'text/event-stream', 'content-type': 'application/json' });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'gpt-5.5', store: false, stream: true, instructions: 'Be brief.', tool_choice: 'auto', parallel_tool_calls: true,
      reasoning: { effort: 'medium', summary: 'auto' },
      tools: [{ type: 'function', name: 'web_fetch', description: 'Fetch', parameters: { type: 'object' }, strict: false }],
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
        { type: 'function_call', call_id: 'call_1', name: 'web_fetch', arguments: '{"url":"x"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '[Buddi tool failed]\nboom' },
      ],
    });
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(init.idleTimeoutMs).toBe(120_000);
  });

  it('omits reasoning unless thinking is on, and refuses an exact output cap before sending', async () => {
    const send = streaming(200, sse(completed()));
    await adapter(send).complete(request({ thinking: 'off' }));
    expect(JSON.parse(send.mock.calls[0]![1].body as string)).not.toHaveProperty('reasoning');
    await expect(adapter(send).complete(request({ maxTokens: 32 }))).rejects.toThrow('output-token cap');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('maps a tool call with argument deltas', async () => {
    const tools = [{ name: 'notes.add', description: '', input_schema: {} }];
    const send = streaming(200, sse(
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc1', call_id: 'call_9', name: 'notes_add' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"text":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '"hi"}' },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc1', call_id: 'call_9', name: 'notes_add', arguments: '{"text":"hi"}' } },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc2', call_id: 'call_10', name: 'notes_add' } },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc2', call_id: 'call_10', name: 'notes_add', arguments: '{"text":"two"}' } },
      completed(),
    ));
    const out = await adapter(send).complete(request({ tools }));
    expect(out.stopReason).toBe('tool_use');
    expect(out.content).toEqual([
      { type: 'tool_use', id: 'call_9', name: 'notes.add', input: { text: 'hi' } },
      { type: 'tool_use', id: 'call_10', name: 'notes.add', input: { text: 'two' } },
    ]);
  });

  it('takes arguments from output_item.done when no deltas came', async () => {
    const send = streaming(200, sse(
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'x', arguments: '{"a":1}' } },
      completed(),
    ));
    const out = await adapter(send).complete(request({ tools: [{ name: 'x', description: '', input_schema: {} }] }));
    expect(out.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'x', input: { a: 1 } }]);
  });

  it('puts reasoning summaries on the thinking channel, in item order', async () => {
    const send = streaming(200, sse(
      { type: 'response.output_item.added', item: { type: 'reasoning', id: 'r1' } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'r1', delta: 'Consider' },
      { type: 'response.output_text.delta', item_id: 'm1', delta: 'Answer' },
      completed(),
    ));
    const deltas: unknown[] = [];
    const out = await adapter(send).complete(request({ onDelta: d => deltas.push(d) }));
    expect(out.content).toEqual([{ type: 'thinking', text: 'Consider' }, { type: 'text', text: 'Answer' }]);
    expect(deltas[0]).toEqual({ kind: 'thinking', text: 'Consider' });
  });

  it('reads an incomplete response as max_tokens', async () => {
    const send = streaming(200, sse(
      { type: 'response.output_text.delta', item_id: 'm1', delta: 'cut' },
      { type: 'response.incomplete', response: { status: 'incomplete', usage: { input_tokens: 1, output_tokens: 2 } } },
    ));
    expect(await adapter(send).complete(request())).toMatchObject({ stopReason: 'max_tokens', usage: { input: 1, output: 2 } });
  });

  it.each([
    [401, '{"error":{"message":"SECRET"}}', 401, 'authentication_error', 'Reconnect'],
    [429, '{"error":{"code":"usage_limit_reached","message":"SECRET"}}', 429, 'rate_limit_error', 'limit is reached'],
    [400, '{"detail":"The \'gpt-9\' model is not supported when using Codex with a ChatGPT account."}', 400, 'model_not_supported', 'not available for this ChatGPT account'],
    [400, '{"error":{"message":"SECRET bad"}}', 400, 'invalid_request_error', 'refused'],
    [503, 'SECRET', 503, 'provider_error', 'HTTP 503'],
  ])('classifies HTTP %i without echoing provider text', async (status, body, wantStatus, type, text) => {
    const error = await adapter(streaming(status, body)).complete(request()).catch(e => e);
    expect(error).toMatchObject({ status: wantStatus, type });
    expect(error.message).toContain(text);
    expect(error.message).not.toContain('SECRET');
  });

  it("carries a plan's usage limit with its reset, so the account is held until then", async () => {
    const resets = Math.floor(Date.now() / 1000) + 7200;
    const error = await adapter(streaming(429, JSON.stringify({ error: { type: 'usage_limit_reached', message: 'SECRET', resets_at: resets } }))).complete(request()).catch(e => e);
    expect(error).toMatchObject({ status: 429, type: 'rate_limit_error', retryAt: new Date(resets * 1000).toISOString(),
      limit: { scope: 'day', provider: 'ChatGPT', retryAt: new Date(resets * 1000).toISOString() } });
    expect(error.message).not.toContain('SECRET');
  });

  it('classifies a failed response and a stream cut', async () => {
    const failed = await adapter(streaming(200, sse({ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'SECRET' } } })))
      .complete(request()).catch(e => e);
    expect(failed).toMatchObject({ status: 429, type: 'rate_limit_error' });
    const cut = await adapter(streaming(200, sse({ type: 'response.output_text.delta', item_id: 'm', delta: 'half' }))).complete(request()).catch(e => e);
    expect(cut).toMatchObject({ type: 'transport_error' });
    const down = await adapter(vi.fn<HttpTransport>().mockRejectedValue(new Error('ECONNRESET'))).complete(request()).catch(e => e);
    expect(down).toMatchObject({ status: 0, type: 'transport_error' });
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    const send = vi.fn<HttpTransport>((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const pending = adapter(send).complete(request({ signal: controller.signal }));
    controller.abort(new Error('owner stopped'));
    await expect(pending).rejects.toThrow('owner stopped');
    controller.abort();
    await expect(adapter(send).complete(request({ signal: controller.signal }))).rejects.toThrow();
  });

  it('declares the Responses capabilities', () => {
    expect(adapter(streaming(200, '')).capabilities).toMatchObject({ parallelToolCalls: true, usageReporting: true, nativeWebSearch: false });
  });
});

describe('Codex model list', () => {
  const get = (status: number, data: unknown) => vi.fn<HttpTransport>(async () => reply(status, JSON.stringify(data)));
  it('lists visible models by priority', async () => {
    const send = get(200, { models: [
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 5 },
      { slug: 'hidden', visibility: 'hide', priority: 0 },
      { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', visibility: 'list', priority: 1 },
    ] });
    const out = await listCodexModels({ accessToken: 't', accountId: 'a', transport: send });
    expect(out).toEqual({ models: [{ id: 'gpt-6-sol', name: 'GPT-6 Sol', isDefault: true }, { id: 'gpt-5.5', name: 'GPT-5.5', isDefault: false }], truncated: false, source: 'provider' });
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe(`https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`);
    expect(CODEX_CLIENT_VERSION).toBe('0.160.1');
    expect(init.headers).toMatchObject({ authorization: 'Bearer t', 'chatgpt-account-id': 'a' });
  });
  it('carries the backend context window, clamped, and ignores odd values', async () => {
    const send = get(200, { models: [
      { slug: 'gpt-6-astra', visibility: 'list', priority: 1, context_window: 272000, max_context_window: 872000 },
      { slug: 'huge', visibility: 'list', priority: 2, context_window: 9_000_000 },
      { slug: 'tiny', visibility: 'list', priority: 3, context_window: 10 },
      { slug: 'odd', visibility: 'list', priority: 4, context_window: '272000' },
      { slug: 'frac', visibility: 'list', priority: 5, context_window: 1000.5 },
    ] });
    const out = await listCodexModels({ accessToken: 't', accountId: 'a', transport: send });
    expect(out.models.map(m => [m.id, m.contextWindow])).toEqual([
      ['gpt-6-astra', 272_000], ['huge', 2_000_000], ['tiny', 8_000], ['odd', undefined], ['frac', undefined],
    ]);
    expect('contextWindow' in out.models[3]!).toBe(false);
  });
  it('falls back to the known list on failure', async () => {
    for (const send of [get(500, {}), get(200, { nope: 1 }), vi.fn<HttpTransport>().mockRejectedValue(new Error('x'))]) {
      const out = await listCodexModels({ accessToken: 't', accountId: 'a', transport: send });
      expect(out.truncated).toBe(false);
      expect(out.source).toBe('built-in');
      // Every plan serves gpt-5.5; a newer default answered 400 on plans without it.
      expect(CODEX_DEFAULT_MODEL).toBe('gpt-5.5');
      expect(out.models.find(m => m.isDefault)).toEqual({ id: 'gpt-5.5', name: 'gpt-5.5', isDefault: true });
      expect(out.models.filter(m => m.isDefault)).toHaveLength(1);
    }
  });
});

describe('Codex direct adapter — prompt caching', () => {
  it('sends prompt_cache_key when the caller keys the request', async () => {
    const send = streaming(200, sse(completed()));
    await adapter(send).complete(request({ cacheKey: 'conv-9' }));
    const body = JSON.parse(String(send.mock.calls[0]![1].body));
    expect(body.prompt_cache_key).toBe('conv-9');
    const bare = streaming(200, sse(completed()));
    await adapter(bare).complete(request());
    expect(JSON.parse(String(bare.mock.calls[0]![1].body))).not.toHaveProperty('prompt_cache_key');
  });

  it('lifts input_tokens_details.cached_tokens out of input', async () => {
    const send = streaming(200, sse({ type: 'response.completed', response: { status: 'completed', model: 'gpt-5.5', usage: { input_tokens: 5_000, output_tokens: 9, input_tokens_details: { cached_tokens: 4_608 } } } }));
    const out = await adapter(send).complete(request());
    expect(out.usage).toEqual({ input: 392, output: 9, cacheRead: 4_608 });
  });
});

describe('Codex direct image', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const opts = (transport: HttpTransport) => ({ model: 'gpt-5.5', accessToken: 'tok-1', accountId: 'acct-1', transport });
  const imageStream = () => sse(
    { type: 'response.created', response: {} },
    { type: 'response.image_generation_call.partial_image', item_id: 'ig1', partial_image_b64: 'AAAA' },
    { type: 'response.output_item.done', item: { type: 'image_generation_call', id: 'ig1', status: 'completed', revised_prompt: 'a red fox', result: png.toString('base64') } },
    completed(),
  );

  it('sends one forced image_generation tool and decodes the result', async () => {
    const send = streaming(200, imageStream());
    const out = await generateCodexImage(opts(send), { prompt: 'a fox', references: [{ bytes: Uint8Array.from([1, 2]), mime: 'image/jpeg' }], size: '1536x1024' });
    expect(out.bytes.equals(png)).toBe(true);
    expect(out).toMatchObject({ mime: 'image/png', revisedPrompt: 'a red fox' });
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok-1', 'chatgpt-account-id': 'acct-1', accept: 'text/event-stream' });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'gpt-5.5', store: false, stream: true,
      tools: [{ type: 'image_generation', size: '1536x1024', quality: 'auto', output_format: 'png' }],
      tool_choice: { type: 'image_generation' },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a fox' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,AQI=' }] }],
    });
    expect(body.tools).toHaveLength(1);
  });

  it('falls back to tool_choice auto when the forced choice is refused', async () => {
    let n = 0;
    const send = vi.fn<HttpTransport>(async (url, init) => {
      n += 1;
      if (n === 1) return reply(400, JSON.stringify({ error: { message: "Unsupported value for 'tool_choice'" } }));
      return streaming(200, imageStream())(url, init);
    });
    const out = await generateCodexImage(opts(send), { prompt: 'a fox', references: [] });
    expect(out.bytes.equals(png)).toBe(true);
    expect(JSON.parse(String(send.mock.calls[1]![1].body)).tool_choice).toBe('auto');
  });

  it('refuses a stream without a picture, quoting what the model said', async () => {
    const send = streaming(200, sse({ type: 'response.output_text.delta', item_id: 'm', delta: 'I cannot draw that.' }, completed()));
    await expect(generateCodexImage(opts(send), { prompt: 'x', references: [] })).rejects.toThrow(/without a picture: “I cannot draw that.”/);
  });

  it('classifies an HTTP failure without echoing it', async () => {
    const send = vi.fn<HttpTransport>(async () => reply(429, JSON.stringify({ error: { code: 'usage_limit_reached', message: 'secret echo' } })));
    await expect(generateCodexImage(opts(send), { prompt: 'x', references: [] })).rejects.toThrow(/plan’s limit/);
  });
});
