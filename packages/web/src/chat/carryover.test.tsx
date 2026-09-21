/**
 * The note a rollover leaves at the top of the fresh conversation.
 *
 * A browser session ends its conversation, and what it learned arrives here as
 * one carried line. It is drawn as a note rather than a bubble: nobody in this
 * thread said it, and a transcript that opens with an instruction the owner
 * never typed is the bug this is supposed to fix, not cause.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, chatApi } from '../api';
import { ChatPage, type ChatPageProps } from './ChatPage';

vi.mock('./stream', () => ({ openChatStream: () => ({ close() {} }) }));

const CARRIED = 'Carried over from the previous conversation: the previous transcript ended after a browser session, so what it saw is summarised here.\nPages visited: Account summary (http://localhost/accounts)';

const props: ChatPageProps = {
  timezone: 'UTC', agentId: 'keeper', onSelectAgent: vi.fn(), attention: new Map(),
  agentsInHeader: false, narrow: false,
  agents: { top: [], bottom: [], middle: [{ id: 'keeper', handle: 'keeper', name: 'Keeper', description: '', available: true, roles: [], provider: 'anthropic', model: 'fixture' }] },
};

beforeEach(() => {
  const idle = { state: 'idle' as const, enabled: true, busy: false, hasScreenshot: false };
  vi.spyOn(api, 'browser').mockResolvedValue(idle);
  vi.spyOn(api, 'browserControl').mockResolvedValue(idle);
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
  vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [{ id: 'c2', agentId: 'keeper', createdAt: new Date().toISOString(), lastMessageAt: null, opening: null, messageCount: 0 }] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('what the previous conversation learned', () => {
  it('is a grey note above the transcript, not a message', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue({
      conversationId: 'c2', agentId: 'keeper', carriedOver: CARRIED,
      messages: [{ id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'text', text: 'Rent clears.' }] }],
    });
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    const note = await screen.findByTestId('chat-carryover');
    expect(note).toHaveTextContent('Carried over from the previous conversation');
    expect(note).toHaveTextContent('/accounts');
    // A note, never a turn: it is outside the message list entirely.
    expect(note.closest('.wb-messages')).toBeNull();
  });

  it('is the only thing a size rollover says: the grey note, no preamble line', async () => {
    // The old thread grew past its budget, so this message lands in a fresh
    // one. What the page shows about that is the carried note and nothing
    // else — the parenthesised "(New conversation — …)" preamble is gone.
    vi.spyOn(chatApi, 'conversation').mockImplementation(async (id: string) =>
      id === 'c3'
        ? { conversationId: 'c3', agentId: 'keeper', carriedOver: CARRIED, messages: [] }
        : { conversationId: 'c2', agentId: 'keeper', messages: [{ id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'text', text: 'Rent clears.' }] }] },
    );
    const send = vi
      .spyOn(chatApi, 'send')
      .mockResolvedValue({ conversationId: 'c3', runId: 'run' });

    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    const area = await screen.findByPlaceholderText(/Message/i);
    fireEvent.change(area, { target: { value: 'and now something else' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(await screen.findByTestId('chat-carryover')).toHaveTextContent(
      'Carried over from the previous conversation',
    );
    expect(screen.queryByTestId('chat-notice')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('New conversation —');
  });

  it('is absent from an ordinary conversation', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue({ conversationId: 'c2', agentId: 'keeper', messages: [] });
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    await waitFor(() => expect(screen.queryByTestId('chat-carryover')).not.toBeInTheDocument());
  });
});
