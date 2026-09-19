import { describe, expect, it, vi } from 'vitest';
import type { CompletionRequest } from './anthropic.js';
import { codexHistory, codexTurnError, createCodexAppServerAdapter } from './codex-app-server.js';
import type { CodexRpc, RpcMessage } from './codex-rpc.js';
import { CODEX_EXPERIMENT_CONFIG } from './codex-policy.js';

const request: CompletionRequest = {
  system: 'You are the owner’s assistant.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'What time is it?' }] }],
  tools: [{ name: 'system.time', description: 'Read the clock', input_schema: { type: 'object', properties: {} } }],
};

function fake(onTurn: (emit: (message: RpcMessage) => void) => void) {
  const messages = new Set<(message: RpcMessage) => void>();
  const closures = new Set<(error: Error) => void>();
  const emit = (message: RpcMessage) => { for (const listener of messages) listener(message); };
  const rpc: CodexRpc = {
    request: vi.fn(async (method) => {
      if (method === 'config/read') return { config: { sandbox_mode: 'read-only', web_search: 'disabled', features: Object.fromEntries(Object.entries(CODEX_EXPERIMENT_CONFIG).filter(([key]) => key.startsWith('features.')).map(([key, value]) => [key.slice(9), value])) } };
      if (method === 'skills/list') return { data: [{ skills: [], errors: [] }] };
      if (method === 'thread/start') return { thread: { id: 'thread1' }, model: 'gpt-5' };
      if (method === 'turn/start') { onTurn(emit); return { turn: { id: 'turn1' } }; }
      return {};
    }),
    notify: vi.fn(),
    onMessage(listener) { messages.add(listener); return () => messages.delete(listener); },
    onClose(listener) { closures.add(listener); return () => closures.delete(listener); },
    close: vi.fn(async () => { for (const listener of closures) listener(new Error('Closed.')); }),
  };
  const adapter = createCodexAppServerAdapter({ model: 'gpt-5', cwd: '/isolated/workspace', connect: () => rpc, timeoutMs: 100 });
  return { adapter, rpc, emit };
}
const notification = (method: string, params: object): RpcMessage => ({ method, params: { threadId: 'thread1', turnId: 'turn1', ...params } });
const call = (tool = 'system_time'): RpcMessage => ({ ...notification('item/tool/call', { callId: 'call1', namespace: null, tool, arguments: {} }), id: 'server1' });

describe('experimental Codex adapter', () => {
  it('classifies native failures without leaking provider text or details', () => {
    const unsupported = codexTurnError({ message: "The 'gpt-5' model is not supported when using Codex with a ChatGPT account. SECRET", codexErrorInfo: 'other', additionalDetails: 'SECRET' });
    expect(unsupported).toMatchObject({ status: 400, type: 'model_not_supported' });
    for (const error of [unsupported,
      codexTurnError({ message: 'SECRET', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }),
      codexTurnError({ message: 'SECRET', codexErrorInfo: 'usageLimitExceeded' }),
      codexTurnError({ message: 'SECRET', codexErrorInfo: { SECRET: { httpStatusCode: 'SECRET' } } })]) {
      expect(error.message + JSON.stringify(error)).not.toContain('SECRET');
    }
    expect(codexTurnError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } })).toMatchObject({ status: 401, type: 'http_error' });
    expect(codexTurnError({ codexErrorInfo: 'usageLimitExceeded' })).toMatchObject({ status: 429 });
  });

  it('retains sanitized notification errors when the final failure omits them', async () => {
    const { adapter, rpc } = fake(emit => {
      emit(notification('error', { error: { message: "The 'gpt-5' model is not supported for this account." } }));
      emit(notification('turn/completed', { turn: { status: 'failed' } }));
    });
    await expect(adapter.complete(request)).rejects.toMatchObject({ status: 400, type: 'model_not_supported' });
    expect(rpc.close).toHaveBeenCalled();
  });

  it('does not fail a successful turn because of a retried error notification', async () => {
    const { adapter } = fake(emit => {
      emit(notification('error', { willRetry: true, error: { codexErrorInfo: 'internalServerError' } }));
      emit(notification('turn/completed', { turn: { status: 'completed' } }));
    });
    expect((await adapter.complete(request)).stopReason).toBe('end_turn');
  });

  it('negotiates experimental APIs, injects history and returns text with cleanup', async () => {
    const { adapter, rpc } = fake((emit) => {
      emit(notification('item/completed', { item: { type: 'agentMessage', text: 'Hello.' } }));
      emit(notification('turn/completed', { turn: { status: 'completed' } }));
    });
    expect(await adapter.complete(request)).toMatchObject({ content: [{ type: 'text', text: 'Hello.' }], stopReason: 'end_turn' });
    expect(rpc.request).toHaveBeenCalledWith('initialize', expect.objectContaining({ capabilities: { experimentalApi: true } }));
    expect(rpc.notify).toHaveBeenCalledWith('initialized');
    expect(rpc.request).toHaveBeenCalledWith('thread/inject_items', expect.objectContaining({ items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What time is it?' }] }] }));
    expect(rpc.close).toHaveBeenCalled();
  });

  it('returns a tool proposal even before turn acknowledgement; never executes or answers it', async () => {
    const { adapter, rpc } = fake((emit) => emit(call()));
    expect(await adapter.complete(request)).toMatchObject({ content: [{ type: 'tool_use', id: 'call1', name: 'system.time', input: {} }], stopReason: 'tool_use' });
    expect(rpc.close).toHaveBeenCalled();
    expect(vi.mocked(rpc.request).mock.calls.map(([method]) => method)).toEqual(['initialize', 'config/read', 'skills/list', 'skills/list', 'thread/start', 'thread/inject_items', 'turn/start']);
    expect(rpc.notify).toHaveBeenCalledTimes(1);
  });

  it('replays tool results and image bytes without flattening roles or call ids', () => {
    const items = codexHistory({ ...request, messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call1', name: 'system.time', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'clock failed', is_error: true }, { type: 'image', mime: 'image/png', data: 'aW1hZ2U=' }] },
    ] }, new Map([['system.time', 'system_time']]));
    expect(items).toEqual([
      { type: 'function_call', call_id: 'call1', name: 'system_time', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call1', output: '[Buddi tool failed]\nclock failed' },
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' }] },
    ]);
  });

  it('rejects ungranted tools and namespaced native calls', async () => {
    for (const message of [call('host_exec'), { ...call(), params: { ...call().params as object, namespace: 'skills' } }]) {
      const { adapter, rpc } = fake((emit) => emit(message));
      await expect(adapter.complete(request)).rejects.toThrow('outside');
      expect(rpc.close).toHaveBeenCalled();
    }
  });

  it('fails closed on native activity and failed turns', async () => {
    for (const message of [notification('item/started', { item: { type: 'commandExecution' } }), notification('turn/completed', { turn: { status: 'failed' } })]) {
      const { adapter, rpc } = fake((emit) => emit(message));
      await expect(adapter.complete(request)).rejects.toThrow();
      expect(rpc.close).toHaveBeenCalled();
    }
  });

  it('ignores events for a different thread', async () => {
    const { adapter } = fake((emit) => {
      emit({ ...call('host_exec'), params: { ...call().params as object, threadId: 'other' } });
      emit(notification('turn/completed', { turn: { status: 'completed' } }));
    });
    expect((await adapter.complete(request)).stopReason).toBe('end_turn');
  });

  it('cancels a running turn and closes its child', async () => {
    const controller = new AbortController();
    const { adapter, rpc } = fake(() => { setTimeout(() => controller.abort(), 1); });
    await expect(adapter.complete({ ...request, signal: controller.signal })).rejects.toThrow('cancelled');
    expect(rpc.request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread1', turnId: 'turn1' });
    expect(rpc.close).toHaveBeenCalled();
  });

  it('bounds stalled turns and prevents unsupported requests before starting a child', async () => {
    const { adapter, rpc } = fake(() => {});
    await expect(adapter.complete({ ...request, maxTokens: 32 })).rejects.toThrow('maxTokens');
    await expect(adapter.complete({ ...request, nativeSearch: { maxUses: 1 } })).rejects.toThrow('search');
    await expect(adapter.complete({ ...request, messages: [{ role: 'user', content: [{ type: 'document', mime: 'application/pdf', data: 'pdf' }] }] })).rejects.toThrow('document');
    expect(rpc.request).not.toHaveBeenCalled();
    await expect(adapter.complete(request)).rejects.toThrow('timed out');
    expect(rpc.close).toHaveBeenCalled();
  });
});
