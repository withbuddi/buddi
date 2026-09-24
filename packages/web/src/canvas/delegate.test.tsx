/**
 * The delegate panel: a colleague's run, read while it happens.
 *
 * Three states are worth the screen — working, done, refused — and one rule
 * holds across all of them: nothing here is drawn from what the delegating
 * agent said. The ids come from the recorded call, the contents from the
 * colleague's own transcript.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatApi } from '../api';
import { DelegateView, DELEGATE_POLL_MS, stepOf } from './views/DelegateView';
import { askedByLine } from '../chat/ChatPage';
import { ApprovalDock, APPROVAL_DOCK_ID } from '../chat/ApprovalDock';
import { api } from '../api';
import { fireEvent } from '@testing-library/react';
import { chatRoute } from '../routes';
import { POLL_ERROR_LIMIT } from '../ui/async';
import { renderablesFrom, type DelegatePanelProps } from './renderables';
import type { ChatConversation, ChatMessage, ChatRun } from '../chat/types';

const agents = [
  { id: 'ledger', handle: 'ledger', name: 'Ledger', description: 'Keeps the books', available: true, roles: [], provider: 'fixture', model: 'a-model' },
];

/** One run of the colleague's own conversation, open or finished. */
function run(runId: string, finishedAt: string | null): ChatRun {
  return {
    runId, surface: null, startedAt: '2026-09-21T09:00:00Z', finishedAt,
    turns: null, stopped: null, usage: { input: 0, output: 0 }, actionId: null, resumed: false,
  };
}

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
        runs: [run('r1', null)],
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

  /*
   * Its *own* run. A colleague's conversation can hold several — one of its
   * own delegations, a resumed turn — and the panel follows the one the
   * recorded call names.
   */
  it('keeps working while its own run is open, whatever else has finished', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(
      transcript({ runs: [run('r-other', '2026-09-21T09:00:10Z'), run('r1', null)] }),
    );
    render(<DelegateView conversationId="conv-2" agentId="ledger" runId="r1" agents={agents as never} />);
    await screen.findByText('Ledger');
    await waitFor(() => expect(screen.getByTestId('delegate-view')).toHaveAttribute('data-status', 'working'));
  });

  it('is done when its own run is, and reads once more before it stops asking', async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(chatApi, 'conversation').mockResolvedValue(
      transcript({ runs: [run('r1', '2026-09-21T09:00:10Z'), run('r-other', null)] }),
    );
    await act(async () => {
      render(<DelegateView conversationId="conv-2" agentId="ledger" runId="r1" agents={agents as never} />);
    });

    expect(screen.getByTestId('delegate-view')).toHaveAttribute('data-status', 'done');
    // The read that found the finish, and one more so the last rows are shown.
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(DELEGATE_POLL_MS * 6); });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('shows the answer, and stops asking, once the delegation has come back', async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(chatApi, 'conversation').mockResolvedValue(transcript({}));
    await act(async () => {
      render(
        <DelegateView
          conversationId="conv-2"
          agentId="ledger"
          runId="r1"
          result={{ ok: true, text: 'You spent 412 on groceries.' }}
          agents={agents as never}
        />,
      );
    });

    expect(screen.getByTestId('delegate-answer')).toHaveTextContent('You spent 412 on groceries.');
    expect(screen.getByTestId('delegate-view')).toHaveAttribute('data-status', 'done');
    // Read once, for the record of what happened — and never polled: the
    // clock runs on, and nothing asks again.
    await act(async () => { await vi.advanceTimersByTimeAsync(DELEGATE_POLL_MS * 10); });
    expect(read).toHaveBeenCalledTimes(1);
  });

  /*
   * A delegation that really opened a conversation and then failed — the
   * nested run threw, ran out of turns, met a colleague with no brain. There
   * is a thread to read, and the panel is how the owner reads it. A
   * *refusal* opens no conversation and so opens no panel at all; that is
   * `renderablesFrom`'s business, below.
   */
  it('says a failed delegation failed, and still offers the conversation', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(
      transcript({
        agentId: 'ledger',
        runs: [run('r1', '2026-09-21T09:00:10Z')],
        messages: [
          { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'u1', name: 'orchard.forecast', input: {} }] },
        ],
      }),
    );
    render(
      <DelegateView
        conversationId="conv-2"
        agentId="ledger"
        runId="r1"
        result={{ ok: false, text: 'the nested run ran out of turns' }}
        agents={agents as never}
      />,
    );

    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(await screen.findByTestId('delegate-answer')).toHaveTextContent('the nested run ran out of turns');
    expect(screen.getByRole('link', { name: 'Open this conversation' })).toHaveAttribute(
      'href',
      expect.stringContaining('conv-2'),
    );
  });

  /*
   * A transcript that keeps failing — the gateway restarting, a conversation
   * that is gone — must not be asked for every two seconds until the laptop
   * closes. Each failure doubles the wait, and after `POLL_ERROR_LIMIT` of
   * them in a row the panel stops asking and keeps what it last knew.
   */
  it('backs off and gives up when the transcript keeps failing', async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(chatApi, 'conversation').mockRejectedValue(new Error('gateway is restarting'));
    await act(async () => {
      render(<DelegateView conversationId="conv-2" agentId="ledger" runId="r1" agents={agents as never} />);
    });

    // Far past every backoff step, and then some: whatever is still armed
    // gets its turn, and the count stops where the limit says.
    for (let round = 0; round < POLL_ERROR_LIMIT + 3; round += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000); });
    }
    expect(read).toHaveBeenCalledTimes(POLL_ERROR_LIMIT);
    expect(screen.getByText(/gateway is restarting/)).toBeInTheDocument();
  });

  it('falls back to the transcript for whose conversation to open', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(transcript({ agentId: 'ledger' }));
    // An older call carries the conversation and no colleague id; a link to
    // `/chat//conv-2` goes nowhere.
    render(<DelegateView conversationId="conv-2" agentId="" agents={agents as never} />);

    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Open this conversation' }))
        .toHaveAttribute('href', chatRoute('ledger', 'conv-2')),
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
    // No delegate panel was ever opened: the call carries no ids, because the
    // server strips whatever the model wrote and puts them back only from the
    // event a real delegation writes.
    expect(panels.some((panel) => panel.source === 'delegate')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * A colleague paused on the owner
 * ------------------------------------------------------------------ */

describe('a delegation waiting on an approval', () => {
  const GATE = '11111111-2222-4333-8444-555555555555';
  const gated = (state: string | null): ChatMessage[] => [
    { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'u1', name: 'image.generate', input: { prompt: 'a fisherman' } }] },
    ...(state === null ? [] : [{ id: 'm2', role: 'user', at: '', blocks: [{
      type: 'tool_result' as const, toolUseId: 'u1', name: 'image.generate', ok: !['rejected', 'expired', 'failed'].includes(state),
      output: null, approval: { id: GATE, state },
    }] }]),
  ];

  it('says "Waiting for your approval", draws the gated call as waiting — not green — and sends the owner to the dock', async () => {
    // The colleague's own run is over: it stopped on the gate. That is not done.
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(transcript({ runs: [run('r1', '2026-09-21T09:00:05Z')], messages: gated('pending') }));
    const dock = document.createElement('section');
    dock.id = APPROVAL_DOCK_ID;
    dock.tabIndex = -1;
    document.body.appendChild(dock);

    render(<DelegateView conversationId="conv-2" agentId="ledger" runId="r1" waiting={{ approvalId: GATE }} agents={agents as never} />);

    await waitFor(() => expect(screen.getByTestId('delegate-view')).toHaveAttribute('data-status', 'waiting'));
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for your approval');
    const mark = (await screen.findByText('Image · Generate')).parentElement!.querySelector('.wb-tool-mark');
    expect(mark).toHaveAttribute('data-ok', 'pending');
    expect(screen.getByText('waiting approval')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('delegate-to-approval'));
    expect(document.activeElement).toBe(dock);
    dock.remove();
  });

  it('keeps working, not done, while the colleague carries on after the decision', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(transcript({ runs: [run('r1', '2026-09-21T09:00:05Z')], messages: gated('executing') }));
    render(<DelegateView conversationId="conv-2" agentId="ledger" runId="r1" waiting={{ approvalId: null }} agents={agents as never} />);
    await screen.findByText('Image · Generate');
    expect(screen.getByTestId('delegate-view')).toHaveAttribute('data-status', 'working');
    expect(screen.queryByTestId('delegate-to-approval')).toBeNull();
  });

  it('reads each step off its real state: pending, waiting approval, succeeded, failed', () => {
    expect(stepOf(null)).toMatchObject({ running: true, ok: null });
    const result = (approval?: { id: string; state: string }, ok = true) => ({ type: 'tool_result' as const, toolUseId: 'u1', name: 'x', ok, output: null, ...(approval ? { approval } : {}) });
    expect(stepOf(result({ id: GATE, state: 'pending' }))).toMatchObject({ waiting: true, ok: null, status: 'waiting approval' });
    expect(stepOf(result({ id: GATE, state: 'executing' }))).toMatchObject({ running: true, ok: null });
    expect(stepOf(result({ id: GATE, state: 'succeeded' }))).toMatchObject({ running: false, ok: true, waiting: false });
    expect(stepOf(result({ id: GATE, state: 'rejected' }, false))).toMatchObject({ ok: false, status: 'rejected' });
    expect(stepOf(result(undefined, false))).toMatchObject({ ok: false });
    expect(stepOf(result())).toMatchObject({ ok: true });
  });

  it('keeps the panel open, not done, while the call is waiting on the colleague', () => {
    const panels = renderablesFrom({
      messages: [
        { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'd1', name: 'agent.delegate', input: { conversationId: 'conv-2', agentId: 'ledger', runId: 'r1' } }] },
        { id: 'm2', role: 'user', at: '', blocks: [{
          type: 'tool_result', toolUseId: 'd1', name: 'agent.delegate', ok: true,
          output: { status: 'awaiting-approval', text: '', waitingOn: { action: GATE, tool: 'image.generate' } },
          delegation: { state: 'waiting', approvalId: GATE },
        }] },
      ],
      descriptors: [],
    });
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({ source: 'delegate', tone: 'warning' });
    expect(panels[0]!.props as DelegatePanelProps).toMatchObject({ result: null, waiting: { approvalId: GATE } });
  });

  it('labels the root dock\'s card with who raised it and who asked', async () => {
    const roster = [
      { id: 'illustrator', handle: 'art' },
      { id: 'playground', handle: 'playground' },
    ];
    expect(askedByLine(['illustrator', 'playground'], roster as never)).toBe('@art, asked by @playground');
    expect(askedByLine(['illustrator', 'scout', 'playground'], roster as never)).toBe('@art, asked by @scout, asked by @playground');

    vi.spyOn(api, 'approval').mockResolvedValue({
      id: GATE, tool: 'image.generate', state: 'pending', preview: 'Generate an image', canonicalArgs: { prompt: 'a fisherman' },
      envelope: {}, expiresAt: '2999-01-01T00:00:00Z', choices: [],
    } as never);
    render(
      <ApprovalDock
        approvals={[{ approvalId: GATE, toolUseId: 'd1', askedBy: '@art, asked by @playground' }]}
        timezone="UTC" now={Date.parse('2026-09-21T09:00:00Z')}
        onDecided={() => {}} onSay={() => {}} onOpenFull={() => {}}
      />,
    );
    expect(await screen.findByTestId('approval-dock-asker')).toHaveTextContent('@art, asked by @playground');
  });
});
