/**
 * Experimental, dependency-injected App Server adapter. Intentionally NOT exported
 * by runtime/index or selected by createProvider: the installed-client isolation
 * contract is not yet satisfied (docs/codex-app-server-experiment.md).
 *
 * One child/thread per completion. A tool request is returned as a proposal, then
 * the child is closed BEFORE the caller can execute it through Buddi's registry.
 * Resumption reconstructs history; no subprocess waits through owner approval.
 */
import type { CompletionRequest, CompletionResponse, ContentBlock, RuntimeProvider } from './anthropic.js';
import { toolNameMap } from './anthropic.js';
import { providerCapabilities } from './capabilities.js';
import { initializeCodex, type CodexRpc, type RpcMessage } from './codex-rpc.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function codexHistory(req: CompletionRequest, names: Map<string, string>): unknown[] {
  return req.messages.flatMap((message) => message.content.map((block): unknown => {
    switch (block.type) {
      case 'text': return { type: 'message', role: message.role, content: [{ type: message.role === 'user' ? 'input_text' : 'output_text', text: block.text }] };
      case 'image': return { type: 'message', role: message.role, content: [{ type: 'input_image', image_url: `data:${block.mime};base64,${block.data}` }] };
      case 'tool_use': {
        const name = names.get(block.name);
        if (!name) throw new Error('Codex cannot replay a tool that is no longer granted.');
        return { type: 'function_call', call_id: block.id, name, arguments: JSON.stringify(block.input) };
      }
      case 'tool_result': return { type: 'function_call_output', call_id: block.tool_use_id, output: block.is_error ? `[Buddi tool failed]\n${block.content}` : block.content };
      default: throw new Error(`Codex experiment cannot replay ${block.type} content.`);
    }
  }));
}

export function createCodexAppServerAdapter(options: {
  model: string;
  cwd: string;
  connect(): CodexRpc;
  timeoutMs?: number;
}): RuntimeProvider {
  return {
    capabilities: { ...providerCapabilities('openai'), parallelToolCalls: false, usageReporting: false },
    async complete(req) {
      req.signal?.throwIfAborted();
      // The native turn API has no exact per-completion max-output-token control.
      // Do not pretend Buddi's testing/cost cap was enforced.
      if (req.maxTokens !== undefined) throw new Error('Codex experiment does not support an exact maxTokens cap.');
      if (req.nativeSearch) throw new Error('Codex native search is disabled; use a granted Buddi tool.');
      const mapping = toolNameMap(req.tools, 64, ['request_user_input', 'skills']);
      const names = new Map([...mapping].map(([wire, original]) => [original, wire]));
      const history = codexHistory(req, names);
      const rpc = options.connect();
      let threadId: string | undefined;
      let turnId: string | undefined;
      const content: ContentBlock[] = [];
      const usage = { input: 0, output: 0 };
      let finish!: (response: CompletionResponse) => void;
      let fail!: (error: Error) => void;
      let settled = false;
      const done = new Promise<CompletionResponse>((resolve, reject) => {
        finish = (response) => { if (!settled) { settled = true; resolve(response); } };
        fail = (error) => { if (!settled) { settled = true; reject(error); } };
      });
      // A notification can fail while a setup request is pending.
      void done.catch(() => {});
      const abort = () => {
        fail(new Error('Codex completion cancelled.'));
        if (threadId && turnId) void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        void rpc.close().catch(() => {});
      };
      req.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { fail(new Error('Codex completion timed out.')); void rpc.close().catch(() => {}); }, options.timeoutMs ?? 120_000);
      const offClose = rpc.onClose(fail);
      const offMessage = rpc.onMessage((message: RpcMessage) => {
        if (settled) return;
        const params = record(message.params);
        if (params.threadId !== threadId) return;
        if (turnId && params.turnId && params.turnId !== turnId) return;
        if (message.method === 'item/tool/call') {
          const original = [...names].find(([, wire]) => wire === params.tool)?.[0];
          if (!original || params.namespace || typeof params.callId !== 'string' || message.id === undefined) {
            fail(new Error('Codex requested a tool outside this completion’s grant.'));
          } else {
            content.push({ type: 'tool_use', id: params.callId, name: original, input: params.arguments });
            finish({ content, stopReason: 'tool_use', usage, model: options.model });
          }
          // Do not answer the native tool request. The finally block closes the
          // child after the turn/start acknowledgement, before returning to Buddi.
        } else if (message.method === 'item/completed') {
          const item = record(params.item);
          if (item.type === 'agentMessage' && typeof item.text === 'string') content.push({ type: 'text', text: item.text });
        } else if (message.method === 'item/started') {
          const type = record(params.item).type;
          if (!['agentMessage', 'reasoning', 'userMessage', 'dynamicToolCall'].includes(String(type))) {
            fail(new Error('Codex emitted an unsupported native activity.'));
            void rpc.close().catch(() => {});
          }
        } else if (message.method === 'thread/tokenUsage/updated') {
          const last = record(record(params.tokenUsage).last);
          if (typeof last.inputTokens === 'number') usage.input = last.inputTokens;
          if (typeof last.outputTokens === 'number') usage.output = last.outputTokens;
        } else if (message.method === 'turn/completed') {
          const turn = record(params.turn);
          if (turn.status === 'completed') finish({ content, stopReason: 'end_turn', usage, model: options.model });
          else fail(new Error('Codex turn did not complete successfully.'));
        }
      });
      try {
        if (req.signal?.aborted) abort();
        await initializeCodex(rpc);
        const started = record(await rpc.request('thread/start', {
          model: options.model, cwd: options.cwd, ephemeral: true, environments: [],
          approvalPolicy: 'on-request', sandbox: 'read-only',
          baseInstructions: req.system,
          dynamicTools: req.tools.map((tool) => ({ type: 'function', name: names.get(tool.name), description: tool.description, inputSchema: tool.input_schema })),
        }));
        threadId = record(started.thread).id as string;
        if (!threadId || started.model !== options.model) throw new Error('Codex thread model did not match the requested model.');
        await rpc.request('thread/inject_items', { threadId, items: history });
        const turn = record(await rpc.request('turn/start', { threadId, input: [] }));
        turnId = record(turn.turn).id as string;
        return await done;
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', abort);
        offMessage(); offClose(); await rpc.close();
      }
    },
  };
}
