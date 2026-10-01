/**
 * A reaction the owner leaves on Telegram reaches an open page at once: the
 * conversation stream says `reaction`, and the page reads the transcript
 * again instead of waiting for its next reconcile.
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
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('a reaction from Telegram', () => {
  it('is drawn under its message as soon as the stream says so', async () => {
    let reacted = false;
    const reads = vi.spyOn(chatApi, 'conversation').mockImplementation(async () => ({
      conversationId: 'c1', agentId: 'keeper',
      messages: [{ id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'text', text: 'Rent clears.' }],
        ...(reacted ? { feedback: { value: 'up' as const, emoji: '👍', source: 'telegram' } } : {}) }],
    }));
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    expect(await screen.findByText('Rent clears.')).toBeInTheDocument();
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    const before = reads.mock.calls.length;
    reacted = true;
    act(() => streams.at(-1)!({ id: '9', name: 'reaction', data: { messageId: 'm1', value: 'up', emoji: '👍', cleared: false } } as ChatEvent));
    await waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByText('👍')).toBeInTheDocument();
  });
});
