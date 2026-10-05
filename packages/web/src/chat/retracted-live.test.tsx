/**
 * An answer the grounding guard withdrew leaves the page at once. The server
 * says `live.settle` with `retracted: true`; the page drops the partial instead
 * of keeping it on screen, settled, until a message that will never carry it.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, chatApi } from '../api';
import { ChatPage, type ChatPageProps } from './ChatPage';
import type { ChatEvent } from './types';

const streams: Array<(event: ChatEvent) => void> = [];
vi.mock('./stream', () => ({
  openChatStream: (opts: { onEvent: (event: ChatEvent) => void }) => {
    streams.push(opts.onEvent);
    return { close() {}, lastEventId: () => null };
  },
}));

const props: ChatPageProps = {
  timezone: 'UTC', agentId: 'keeper', onSelectAgent: vi.fn(), attention: new Map(),
  agentsInHeader: false, narrow: false,
  agents: { top: [], bottom: [], middle: [{ id: 'keeper', handle: 'keeper', name: 'Keeper', description: '', available: true, roles: [], provider: 'anthropic', model: 'fixture' }] },
};

beforeEach(() => {
  streams.length = 0;
  const idle = { state: 'idle' as const, enabled: true, busy: false, hasScreenshot: false };
  vi.spyOn(api, 'browser').mockResolvedValue(idle);
  vi.spyOn(api, 'browserControl').mockResolvedValue(idle);
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
  vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [{ id: 'c1', agentId: 'keeper', createdAt: new Date().toISOString(), lastMessageAt: null, opening: null, messageCount: 1 }] });
  vi.spyOn(chatApi, 'conversation').mockResolvedValue({
    conversationId: 'c1', agentId: 'keeper',
    messages: [{ id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'text', text: 'Rent clears.' }] }],
  } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const emit = (name: ChatEvent['name'], data: Record<string, unknown>): void => {
  act(() => streams.at(-1)!({ id: null, name, data } as ChatEvent));
};

describe('a retracted live answer', () => {
  it('is dropped at once, and the retry streams in its place', async () => {
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    expect(await screen.findByText('Rent clears.')).toBeInTheDocument();
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));

    emit('run.started', { agentId: 'keeper' });
    emit('live', { runId: 'r1', turn: 1, kind: 'text', text: 'CBS News reported a 6-3 ruling.' });
    expect(await screen.findByText(/CBS News reported/)).toBeInTheDocument();
    emit('live.settle', { runId: 'r1', turn: 1, retracted: true });
    expect(screen.queryByText(/CBS News reported/)).not.toBeInTheDocument();

    // The retry streams on its own turn; the withdrawn words never come back.
    emit('live', { runId: 'r1', turn: 2, kind: 'text', text: 'Checked: the vote was 6-3.' });
    expect(screen.getByText(/Checked: the vote was 6-3/)).toBeInTheDocument();
    expect(screen.queryByText(/CBS News reported/)).not.toBeInTheDocument();
  });
});
