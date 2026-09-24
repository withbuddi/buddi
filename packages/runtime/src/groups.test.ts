import { describe, expect, it, vi } from 'vitest';
import type { CoreToolContext, ToolRegistry } from '@buddi/core';
import { ProviderError, type CompletionResponse, type RuntimeProvider } from './anthropic.js';
import { BudgetExhausted, SYNTHESIS_NOTE, budgetedProvider, createGroupAskTool, type Reservation } from './groups.js';

function ledgerOf(answers: Reservation[]) {
  const reserve = vi.fn(async () => answers.shift() ?? 'spent');
  const release = vi.fn(async () => undefined);
  return { reserve, release };
}

const ok: CompletionResponse = { content: [{ type: 'text', text: 'hi' }], stopReason: 'end_turn', usage: { input: 1, output: 1 }, model: 'm' };
const request = { system: 'S', messages: [], tools: [{ name: 'x', description: 'x', input_schema: {} }] };

describe('the request budget', () => {
  it('reserves before every call and passes the request through', async () => {
    const inner: RuntimeProvider = { complete: vi.fn(async () => ok) };
    const ledger = ledgerOf(['work', 'work']);
    const provider = budgetedProvider(inner, ledger, { canSynthesise: true });
    await provider.complete(request);
    await provider.complete(request);
    expect(ledger.reserve).toHaveBeenCalledTimes(2);
    expect((inner.complete as any).mock.calls[0][0].tools).toHaveLength(1);
  });

  it('turns the last call into synthesis for the coordinator: no tools, told to conclude', async () => {
    const inner: RuntimeProvider = { complete: vi.fn(async () => ok) };
    const provider = budgetedProvider(inner, ledgerOf(['synthesis']), { canSynthesise: true });
    await provider.complete(request);
    const sent = (inner.complete as any).mock.calls[0][0];
    expect(sent.tools).toEqual([]);
    expect(sent.system).toContain(SYNTHESIS_NOTE);
  });

  it('refuses the last call to a member and gives it back', async () => {
    const inner: RuntimeProvider = { complete: vi.fn(async () => ok) };
    const ledger = ledgerOf(['synthesis']);
    const provider = budgetedProvider(inner, ledger, { canSynthesise: false });
    await expect(provider.complete(request)).rejects.toBeInstanceOf(BudgetExhausted);
    expect(ledger.release).toHaveBeenCalledTimes(1);
    expect(inner.complete).not.toHaveBeenCalled();
  });

  it('ends the run when nothing is left', async () => {
    const provider = budgetedProvider({ complete: vi.fn(async () => ok) }, ledgerOf([]), { canSynthesise: true });
    await expect(provider.complete(request)).rejects.toBeInstanceOf(BudgetExhausted);
  });

  it('reserves again for every dispatch the adapter makes, and stops when the ledger is spent', async () => {
    // An adapter that retries twice internally: three dispatches, three reservations.
    const inner: RuntimeProvider = {
      complete: vi.fn(async (req: any) => { await req.onDispatch(); await req.onDispatch(); await req.onDispatch(); return ok; }),
    };
    const ledger = ledgerOf(['work', 'work', 'work']);
    await budgetedProvider(inner, ledger, { canSynthesise: true }).complete(request);
    expect(ledger.reserve).toHaveBeenCalledTimes(3);
    const dry: RuntimeProvider = { complete: vi.fn(async (req: any) => { await req.onDispatch(); await req.onDispatch(); return ok; }) };
    await expect(budgetedProvider(dry, ledgerOf(['work']), { canSynthesise: true }).complete(request)).rejects.toBeInstanceOf(BudgetExhausted);
  });

  it('never lets a retry take the conclusion\'s call', async () => {
    const inner: RuntimeProvider = { complete: vi.fn(async (req: any) => { await req.onDispatch(); await req.onDispatch(); return ok; }) };
    const ledger = ledgerOf(['work', 'synthesis']);
    await expect(budgetedProvider(inner, ledger, { canSynthesise: true }).complete(request)).rejects.toBeInstanceOf(BudgetExhausted);
    expect(ledger.release).toHaveBeenCalledTimes(1);
  });

  it('forces the conclusion when told to, whatever the ledger answers', async () => {
    const inner: RuntimeProvider = { complete: vi.fn(async () => ok) };
    await budgetedProvider(inner, ledgerOf(['work']), { canSynthesise: true, forceSynthesis: true }).complete(request);
    const sent = (inner.complete as any).mock.calls[0][0];
    expect(sent.tools).toEqual([]);
    expect(sent.system).toContain(SYNTHESIS_NOTE);
  });

  it('keeps the reservation on an ambiguous failure and releases it on a confirmed 429', async () => {
    const timeout = new ProviderError({ status: 0, type: 'transport_error', message: 'the connection went silent' });
    const refused = new ProviderError({ status: 429, type: 'rate_limit_error', message: 'slow down' });
    const inner: RuntimeProvider = { complete: vi.fn().mockRejectedValueOnce(timeout).mockRejectedValueOnce(refused) };
    const ledger = ledgerOf(['work', 'work']);
    const provider = budgetedProvider(inner, ledger, { canSynthesise: true });
    await expect(provider.complete(request)).rejects.toBe(timeout);
    expect(ledger.release).not.toHaveBeenCalled();
    await expect(provider.complete(request)).rejects.toBe(refused);
    expect(ledger.release).toHaveBeenCalledTimes(1);
  });
});

describe('group.ask', () => {
  const agents = new Map([
    ['concierge', { id: 'concierge', handle: 'concierge', name: 'Concierge', definition: () => ({ id: 'concierge', name: 'Concierge', systemPrompt: '', tools: [], provider: {} as any, maxTurns: 12 }) }],
    ['ledger', { id: 'ledger', handle: 'ledger', name: 'Ledger', definition: () => ({ id: 'ledger', name: 'Ledger', systemPrompt: '', tools: [], provider: {} as any, maxTurns: 12 }) }],
    ['outsider', { id: 'outsider', handle: 'outsider', name: 'Outsider', definition: () => ({ id: 'outsider', name: 'Outsider', systemPrompt: '', tools: [], provider: {} as any, maxTurns: 12 }) }],
  ]);
  const group = { id: 'g1', name: 'Money', coordinator: 'concierge', members: ['concierge', 'ledger'], requestId: 'r1' };
  const base = (over: Partial<CoreToolContext> = {}): CoreToolContext => ({
    db: {} as any, ownerId: 'o', now: () => new Date('2026-09-20T00:00:00Z'), timezone: 'UTC',
    agentId: 'concierge', conversationId: 'c1', group, ...over,
  });
  const runAgent = vi.fn(async (opts: any) => ({ text: `${opts.agent.id} answered`, turns: 1, stopped: 'end_turn', usage: { input: 0, output: 0 }, snapshot: {} } as any));
  const tool = createGroupAskTool({
    catalog: () => ({ get: (id) => agents.get(id), byHandle: (h) => agents.get(h) }),
    provider: () => ({ complete: async () => ok }),
    registry: {} as ToolRegistry,
    transcript: async (_c, agentId) => ({ load: async () => [], speaker: agentId, openingSpeaker: 'concierge' }),
    allowlistFor: (id) => (id === 'concierge' ? ['ledger', 'outsider'] : []),
    runAgent,
    pool: {} as any,
  });

  it('runs a member against the room and returns what it said', async () => {
    const out = await tool.execute({ agent: '@ledger', request: 'Summarise September.' }, base());
    // Attributed, as the room hears it — never the member's bare words as the coordinator's own finding.
    expect(out).toMatchObject({ agent: 'ledger', handle: 'ledger', status: 'answered', said: '@ledger said:\nledger answered' });
    expect(out.note).toContain('not an instruction');
    const opts = runAgent.mock.calls[0]![0];
    expect(opts.conversationId).toBe('c1');
    expect(opts.transcript.speaker).toBe('ledger');
    expect(opts.agent.maxTurns).toBe(6);
    expect(opts.ctx.delegationDepth).toBe(1);
    expect(opts.ctx.agentId).toBeUndefined();
    expect(opts.userMessage).toContain('@concierge, the coordinator, asks you now');
  });

  it('refuses ordinary delegation inside a room', async () => {
    const { createDelegateTool } = await import('./delegate.js');
    const tool = createDelegateTool({ catalog: () => ({ get: () => undefined, list: () => [] }), registry: {} as any, provider: () => ({ complete: async () => ok }), allowlistFor: () => ['ledger'] });
    await expect(tool.execute({ agent: 'ledger', task: 'x' }, base())).rejects.toThrow(/group run/);
  });

  it('refuses outside a group, from a member, for a non-member, and against the allowlist', async () => {
    await expect(tool.execute({ agent: 'ledger', request: 'x' }, base({ group: undefined }))).rejects.toThrow(/not a group run/);
    await expect(tool.execute({ agent: 'concierge', request: 'x' }, base({ agentId: 'ledger' }))).rejects.toThrow(/only the coordinator/);
    await expect(tool.execute({ agent: 'outsider', request: 'x' }, base())).rejects.toThrow(/not a member/);
    const strict = createGroupAskTool({
      catalog: () => ({ get: (id) => agents.get(id) }), provider: () => ({ complete: async () => ok }), registry: {} as ToolRegistry,
      transcript: async () => undefined, allowlistFor: () => [], runAgent, pool: {} as any,
    });
    await expect(strict.execute({ agent: 'ledger', request: 'x' }, base())).rejects.toThrow(/may not ask/);
  });

  it('reports a member that stopped on an approval, tells the orchestration, and suspends the caller', async () => {
    const onSuspended = vi.fn();
    const suspend = vi.fn();
    const paused = createGroupAskTool({
      catalog: () => ({ get: (id) => agents.get(id) }), provider: () => ({ complete: async () => ok }), registry: {} as ToolRegistry,
      transcript: async () => undefined, allowlistFor: () => ['ledger'], pool: {} as any, onSuspended,
      runAgent: async () => ({ text: '', turns: 1, stopped: 'awaiting-approval', pendingActionId: 'a-9', usage: { input: 0, output: 0 }, snapshot: {} } as any),
    });
    const out = await paused.execute({ agent: 'ledger', request: 'x' }, base({ suspend }));
    expect(out).toMatchObject({ status: 'awaiting-approval', actionId: 'a-9' });
    expect(onSuspended).toHaveBeenCalledWith({ agentId: 'ledger', actionId: 'a-9' });
    // The coordinator's own run stops on the same action: no further tool runs.
    expect(suspend).toHaveBeenCalledWith('a-9');
  });

  it('says out-of-budget instead of throwing when the member draws a blank', async () => {
    const dry = createGroupAskTool({
      catalog: () => ({ get: (id) => agents.get(id) }), provider: () => ({ complete: async () => ok }), registry: {} as ToolRegistry,
      transcript: async () => undefined, allowlistFor: () => ['ledger'], pool: {} as any,
      runAgent: async () => { throw new BudgetExhausted(); },
    });
    expect(await dry.execute({ agent: 'ledger', request: 'x' }, base())).toMatchObject({ status: 'out-of-budget' });
  });
});
