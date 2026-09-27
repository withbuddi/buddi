/**
 * The corner buddi: a button on every page but Home and the chat, a small
 * dock with the front desk's thread, and `/` opening it on a page without a
 * composer of its own.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { chatApi } from '../api';
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
      <AskDock agent={DESK} agents={[DESK]} open={open} onOpenChange={setOpen} navigate={navigate} />
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
