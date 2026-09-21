/**
 * The delegate panel: a colleague's run, read while it happens.
 *
 * Three states are worth the screen — working, done, refused — and one rule
 * holds across all of them: nothing here is drawn from what the delegating
 * agent said. The ids come from the recorded call, the contents from the
 * colleague's own transcript.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatApi } from '../api';
import { DelegateView } from './views/DelegateView';
import { renderablesFrom, type DelegatePanelProps } from './renderables';
import type { ChatConversation, ChatMessage } from '../chat/types';

const agents = [
  { id: 'ledger', handle: 'ledger', name: 'Ledger', description: 'Keeps the books', available: true, roles: [], provider: 'fixture', model: 'a-model' },
];

function transcript(over: Partial<ChatConversation>): ChatConversation {
  return {
    conversationId: 'conv-2',
    agentId: 'ledger',
    messages: [],
    runs: [],
    ...over,
  } as ChatConversation;
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the delegate panel', () => {
  it('says the colleague is working, and draws its tool rows as they land', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(
      transcript({
        runs: [{ runId: 'r1', surface: null, startedAt: '2026-09-21T09:00:00Z', finishedAt: null, turns: null, stopped: null, usage: { input: 0, output: 0 }, actionId: null, resumed: false }],
        messages: [
          { id: 'm1', role: 'assistant', at: '', blocks: [
            { type: 'thinking', text: 'Which month did they mean?' },
            { type: 'tool_use', id: 'u1', name: 'orchard.forecast', input: {} },
          ] },
        ],
      }),
    );

    render(<DelegateView conversationId="conv-2" agentId="ledger" agents={agents as never} />);

    expect(await screen.findByText('Ledger')).toBeInTheDocument();
    expect(screen.getByTestId('delegate-view')).toHaveAttribute('data-status', 'working');
    expect(await screen.findByText('Orchard · Forecast')).toBeInTheDocument();
    expect(screen.getByText('Thoughts')).toBeInTheDocument();
  });

  it('shows the answer, and stops asking, once the delegation has come back', async () => {
    const read = vi.spyOn(chatApi, 'conversation').mockResolvedValue(transcript({}));
    render(
      <DelegateView
        conversationId="conv-2"
        agentId="ledger"
        result={{ ok: true, text: 'You spent 412 on groceries.' }}
        agents={agents as never}
      />,
    );

    expect(await screen.findByTestId('delegate-answer')).toHaveTextContent('You spent 412 on groceries.');
    expect(screen.getByTestId('delegate-view')).toHaveAttribute('data-status', 'done');
    // Read once, for the record of what happened — never polled.
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  });

  it('says a refused delegation failed, and still offers the conversation', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(transcript({}));
    render(
      <DelegateView
        conversationId="conv-2"
        agentId="ledger"
        result={{ ok: false, text: 'delegation refused: "ada" may not delegate to "ledger"' }}
        agents={agents as never}
      />,
    );

    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open this conversation' })).toHaveAttribute(
      'href',
      expect.stringContaining('conv-2'),
    );
  });
});

describe('a delegation on the canvas', () => {
  const call = (input: unknown): ChatMessage => ({
    id: 'm1', role: 'assistant', at: '2026-09-21T09:00:00Z',
    blocks: [{ type: 'tool_use', id: 'u1', name: 'agent.delegate', input }],
  });

  it('opens its panel from the call, before any result exists', () => {
    const [panel, ...rest] = renderablesFrom({
      messages: [call({ agent: 'ledger', task: 'what did we spend?', conversationId: 'conv-2', agentId: 'ledger', runId: 'r1' })],
      descriptors: [],
    });
    expect(rest).toHaveLength(0);
    expect(panel).toMatchObject({ id: 'u1', renderer: 'delegate', source: 'delegate', substantial: true });
    expect(panel!.props as DelegatePanelProps).toEqual({ conversationId: 'conv-2', agentId: 'ledger', runId: 'r1', result: null });
  });

  it('keeps the colleague\'s answer on that same panel instead of opening a second one', () => {
    const panels = renderablesFrom({
      messages: [
        call({ agent: 'ledger', conversationId: 'conv-2', agentId: 'ledger', runId: 'r1' }),
        { id: 'm2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'u1', name: 'agent.delegate', ok: true, output: { text: '412 on groceries', handle: 'ledger' } }] },
      ],
      descriptors: [],
    });
    expect(panels).toHaveLength(1);
    expect((panels[0]!.props as DelegatePanelProps).result).toEqual({ ok: true, text: '412 on groceries' });
  });

  it('leaves a refusal — which opened no conversation — to the ordinary failure tab', () => {
    const panels = renderablesFrom({
      messages: [
        call({ agent: 'legder' }),
        { id: 'm2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'u1', name: 'agent.delegate', ok: false, output: null, error: 'delegation refused: unknown agent "legder"' }] },
      ],
      descriptors: [],
    });
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({ renderer: 'structured', source: 'fallback', tone: 'critical' });
  });
});
