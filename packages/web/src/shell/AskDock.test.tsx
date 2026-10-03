/**
 * The corner buddi: a button on every page but Home and the chat, a small
 * dock with the front desk's thread, and `/` opening it on a page without a
 * composer of its own.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { api, chatApi, type ApprovalRow } from '../api';
import type { ChatAgent, ChatConversation, ChatEvent } from '../chat/types';
import { AskDock, forgetAskDockThread, showsAskDock } from './AskDock';
import { useSlashToComposer } from './slash';

const stream = vi.hoisted(() => ({ onEvent: null as ((event: ChatEvent) => void) | null, urls: [] as string[] }));
vi.mock('../chat/stream', () => ({
  openChatStream: (options: { url: string; onEvent: (event: ChatEvent) => void }) => {
    stream.onEvent = options.onEvent;
    stream.urls.push(options.url);
    return { close() {}, lastEventId: () => null };
  },
}));

const DESK: ChatAgent = {
  id: 'concierge', handle: 'concierge', name: 'Concierge', description: 'The front desk.', available: true,
  roles: [], provider: 'anthropic', model: 'claude-sonnet-5',
} as ChatAgent;

function transcript(messages: ChatConversation['messages']): ChatConversation {
  return { conversationId: 'c-new', agentId: 'concierge', messages } as unknown as ChatConversation;
}

function emit(name: ChatEvent['name'], data: Record<string, unknown> = {}): void {
  act(() => { stream.onEvent?.({ id: null, name, data }); });
}

/** The shell's part of it: a page with no composer, the hook and the dock. */
function Page({ navigate = vi.fn() }: { navigate?: (route: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  useSlashToComposer(navigate, true, () => setOpen(true));
  return (
    <Tooltip.Provider>
      <p>Files</p>
      <AskDock agent={DESK} agents={[DESK]} timezone="UTC" open={open} onOpenChange={setOpen} navigate={navigate} />
    </Tooltip.Provider>
  );
}

beforeEach(() => {
  forgetAskDockThread();
  stream.onEvent = null;
  stream.urls = [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '#/');
});

describe('where the corner button is', () => {
  it('belongs on Files, Settings, Agents and plugin pages, not on Home, the chat or first run', () => {
    for (const hash of ['#/files', '#/settings/system', '#/agents', '#/activity', '#/p/email/mail']) expect(showsAskDock(hash), hash).toBe(true);
    for (const hash of ['#/', '', '#/chat', '#/chat/concierge/c1', '#/welcome']) expect(showsAskDock(hash), hash).toBe(false);
  });

  async function shellAt(hash: string): Promise<void> {
    window.history.replaceState(null, '', hash);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/api/chat/agents')
      ? new Response(JSON.stringify({ agents: [DESK], defaultAgentId: 'concierge' }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('', { status: 401 })));
    await act(async () => { render(<App />); });
  }

  it('appears in the shell on Files and Settings', async () => {
    await shellAt('#/files');
    expect(await screen.findByRole('button', { name: 'Ask Concierge' })).toBeInTheDocument();
    cleanup();
    await shellAt('#/settings/system');
    expect(await screen.findByRole('button', { name: 'Ask Concierge' })).toBeInTheDocument();
  });

  it('is not in the shell on Home or the chat', async () => {
    await shellAt('#/');
    await waitFor(() => expect(screen.getByPlaceholderText('Message Concierge…')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Ask Concierge' })).not.toBeInTheDocument();
    cleanup();
    await shellAt('#/chat');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByRole('button', { name: 'Ask Concierge' })).not.toBeInTheDocument();
  });
});

describe('the dock', () => {
  it('mentions the team with @ and runs / commands, as every chat does', async () => {
    const navigate = vi.fn();
    const LEDGER = { ...DESK, id: 'ledger', handle: 'ledger', name: 'Ledger', description: 'Money.' } as ChatAgent;
    render(
      <Tooltip.Provider>
        <AskDock agent={DESK} agents={[DESK, LEDGER]} timezone="UTC" open onOpenChange={() => {}} navigate={navigate} />
      </Tooltip.Provider>,
    );
    const box = screen.getByPlaceholderText('Message Concierge…');
    fireEvent.change(box, { target: { value: 'ask @' } });
    expect(within(screen.getByRole('listbox', { name: 'Mention someone' })).getByText(/Ledger/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '/' } });
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.select(box);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('#/chat/ledger');
  });

  it('starts a conversation with the front desk on the first message and streams the reply in place', async () => {
    const navigate = vi.fn();
    vi.spyOn(chatApi, 'startConversation').mockResolvedValue({ conversationId: 'c-new' });
    vi.spyOn(chatApi, 'send').mockResolvedValue({ conversationId: 'c-new', runId: 'r1' } as never);
    const conversation = vi.spyOn(chatApi, 'conversation').mockResolvedValue(transcript([
      { id: 'u1', role: 'user', at: '', blocks: [{ type: 'text', text: 'What is on today?' }] },
    ]));
    render(<Page navigate={navigate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Ask Concierge' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Concierge');
    expect(screen.getByRole('link', { name: 'Open in Chat' })).toHaveAttribute('href', '#/chat/concierge');
    const box = screen.getByPlaceholderText('Message Concierge…');
    expect(box).toHaveFocus();

    fireEvent.change(box, { target: { value: 'What is on today?' } });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(chatApi.startConversation).toHaveBeenCalledWith('concierge');
    expect(chatApi.send).toHaveBeenCalledWith('concierge', { conversationId: 'c-new', text: 'What is on today?' });
    expect(navigate).not.toHaveBeenCalled();
    expect(stream.urls.at(-1)).toContain('c-new');
    expect(screen.getByRole('link', { name: 'Open in Chat' })).toHaveAttribute('href', '#/chat/concierge/c-new');

    // The answer streams into the dock as it is written…
    emit('run.started', { agentId: 'concierge' });
    emit('live', { runId: 'r1', turn: 0, kind: 'text', text: 'Two meetings' });
    expect(screen.getByRole('dialog')).toHaveTextContent('Two meetings');

    // …and stays once the transcript carries it.
    conversation.mockResolvedValue(transcript([
      { id: 'u1', role: 'user', at: '', blocks: [{ type: 'text', text: 'What is on today?' }] },
      { id: 'a1', role: 'assistant', at: '', blocks: [{ type: 'text', text: 'Two meetings and a dentist.' }] },
    ]));
    emit('live.settle', { runId: 'r1', turn: 0 });
    await act(async () => { stream.onEvent?.({ id: null, name: 'message.appended', data: {} }); });
    emit('run.finished', {});
    await waitFor(() => expect(screen.getByText('Two meetings and a dentist.')).toBeInTheDocument());

    // Closed and reopened: the same thread, and the next message continues it.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask Concierge' }));
    await waitFor(() => expect(screen.getByText('Two meetings and a dentist.')).toBeInTheDocument());
    const again = screen.getByPlaceholderText('Message Concierge…');
    fireEvent.change(again, { target: { value: 'And tomorrow?' } });
    await act(async () => { fireEvent.keyDown(again, { key: 'Enter' }); });
    expect(chatApi.startConversation).toHaveBeenCalledTimes(1);
    expect(chatApi.send).toHaveBeenLastCalledWith('concierge', { conversationId: 'c-new', text: 'And tomorrow?' });

    // New starts over.
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(screen.queryByText('Two meetings and a dentist.')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Chat' })).toHaveAttribute('href', '#/chat/concierge');
  });

  it('rings the closed button and thinks in it while a reply streams, and stops when it lands', async () => {
    vi.spyOn(chatApi, 'startConversation').mockResolvedValue({ conversationId: 'c-new' });
    vi.spyOn(chatApi, 'send').mockResolvedValue({ conversationId: 'c-new', runId: 'r1' } as never);
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(transcript([]));
    render(<Page />);
    const fab = (): HTMLElement => screen.getByRole('button', { name: 'Ask Concierge' });
    expect(fab()).not.toHaveAttribute('data-busy');

    fireEvent.click(fab());
    const box = screen.getByPlaceholderText('Message Concierge…');
    fireEvent.change(box, { target: { value: 'What is on today?' } });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    emit('run.started', { agentId: 'concierge' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(fab()).toHaveAttribute('data-busy', 'true');
    expect(fab().querySelector('[data-testid="blob"]')).toHaveAttribute('data-state', 'working');
    emit('run.finished', {});
    await waitFor(() => expect(fab()).not.toHaveAttribute('data-busy'));
    expect(fab().querySelector('[data-testid="blob"]')).toHaveAttribute('data-state', 'idle');
  });

  it('opens on `/` on a page without a composer, and Escape closes it back to the button', async () => {
    const navigate = vi.fn();
    render(<Page navigate={navigate} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => { fireEvent.keyDown(document.body, { key: '/' }); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Message Concierge…')).toHaveFocus();

    act(() => { fireEvent.keyDown(screen.getByPlaceholderText('Message Concierge…'), { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask Concierge' })).toHaveFocus();
  });
});

describe('the dock decides what the full chat decides', () => {
  const pendingRow = (id: string): ApprovalRow => ({
    id, tool: 'calendar.create_event', toolVersion: '1', agentId: 'concierge', conversationId: 'c-new', jobId: null,
    preview: 'Dinner with Marion at Chez Léon, 19:30–21:30.', envelope: {}, canonicalArgs: { title: 'Dinner with Marion' },
    argsHash: 'h', policyVersion: 1, state: 'pending', decidedBy: null, decidedVia: null, decidedAt: null,
    expiresAt: '2999-01-01T00:00:00Z', createdAt: '2026-10-03T10:00:00Z', outcome: null,
  } as ApprovalRow);

  async function openWith(conversation: ChatConversation, navigate = vi.fn()): Promise<void> {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(conversation);
    vi.spyOn(chatApi, 'startConversation').mockResolvedValue({ conversationId: 'c-new' });
    vi.spyOn(chatApi, 'send').mockResolvedValue({ conversationId: 'c-new', runId: 'r1' } as never);
    render(<Page navigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask Concierge' }));
    const box = screen.getByPlaceholderText('Message Concierge…');
    fireEvent.change(box, { target: { value: 'Add dinner with Marion at Chez Léon tonight' } });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
  }

  it('approves a gated call in place, with the composer hidden until it is decided', async () => {
    let state = 'pending';
    vi.spyOn(api, 'approval').mockImplementation(async (id) => ({ ...pendingRow(id), state }) as ApprovalRow);
    vi.spyOn(api, 'overview').mockResolvedValue({} as never);
    const decide = vi.spyOn(api, 'decide').mockImplementation(async (id) => {
      state = 'succeeded';
      return { action: { ...pendingRow(id), state: 'succeeded' }, execution: null } as never;
    });
    await openWith(transcript([
      { id: 'u1', role: 'user', at: '', blocks: [{ type: 'text', text: 'Add dinner with Marion at Chez Léon tonight' }] },
      { id: 'a1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', toolUseId: 't1', name: 'calendar.create_event', input: {} }] },
      { id: 'r1', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 't1', name: 'calendar.create_event', ok: false, output: null, approval: { id: 'act-1', state: 'pending' } }] },
    ] as never));

    const card = await screen.findByTestId('approval-dock');
    expect(within(screen.getByRole('dialog')).getByTestId('composer-slot')).not.toBeVisible();
    const approve = await within(card).findByRole('button', { name: 'Approve' });
    await waitFor(() => expect(approve).toBeEnabled());
    await act(async () => { fireEvent.click(approve); });
    expect(decide).toHaveBeenCalledWith('act-1', 'approve', undefined);
    await waitFor(() => expect(screen.queryByTestId('approval-dock')).not.toBeInTheDocument());
  });

  it('draws the agent\'s question as choices and answers with the one tapped', async () => {
    const answer = vi.spyOn(chatApi, 'answerQuestion').mockResolvedValue({} as never);
    await openWith({
      ...transcript([{ id: 'u1', role: 'user', at: '', blocks: [{ type: 'text', text: 'Add dinner with Marion at Chez Léon tonight' }] }]),
      question: {
        id: 'q1', question: 'Which calendar?', allowOther: false, expiresAt: '2999-01-01T00:00:00Z',
        options: [{ id: 'o1', label: 'Home', hint: null, recommended: true }, { id: 'o2', label: 'Work', hint: null, recommended: false }],
      },
    } as ChatConversation);
    const picker = await screen.findByTestId('question-picker');
    emit('run.finished', {});
    await act(async () => { fireEvent.click(within(picker).getByRole('button', { name: /Work/ })); });
    expect(answer).toHaveBeenCalledWith('q1', { answer: 'Work', optionId: 'o2' });
  });

  it('takes an offer, and a hand-off goes where it leads', async () => {
    const navigate = vi.fn();
    const take = vi.spyOn(api, 'takeOffer').mockResolvedValue({ runId: 'r2' } as never);
    await openWith({
      ...transcript([{ id: 'u1', role: 'user', at: '', blocks: [{ type: 'text', text: 'Add dinner with Marion at Chez Léon tonight' }] }]),
      offers: [
        { id: 'of1', label: 'Remind me at 19:00', prompt: 'Remind me at 19:00', expiresAt: '2999-01-01T00:00:00Z' },
        { id: 'of2', label: 'Add Chef', prompt: '', expiresAt: '2999-01-01T00:00:00Z', handoff: { kind: 'install', package: 'chef', title: 'Chef' } },
      ],
    } as ChatConversation, navigate);
    const offers = await screen.findByTestId('chat-offers');
    await act(async () => { fireEvent.click(within(offers).getByRole('button', { name: 'Remind me at 19:00' })); });
    expect(take).toHaveBeenCalledWith('of1', 'c-new');
    await act(async () => { fireEvent.click(within(offers).getByRole('button', { name: 'Add Chef' })); });
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining('chef'));
  });
});
