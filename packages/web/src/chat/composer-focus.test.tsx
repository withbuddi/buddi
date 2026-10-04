/**
 * The cursor lands in the composer: on a thread opened from the list, on New
 * conversation, and on first run's Open buddi (which opens a thread by route).
 * Not while a card stands in the composer's place, and not over a sheet.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, chatApi } from '../api';
import { ChatPage, type ChatPageProps } from './ChatPage';
import type { ChatConversation } from './types';

vi.mock('./stream', () => ({ openChatStream: () => ({ close() {} }) }));

const props: ChatPageProps = {
  timezone: 'UTC', agentId: 'keeper', onSelectAgent: vi.fn(), attention: new Map(),
  agentsInHeader: false, narrow: false,
  agents: { top: [], bottom: [], middle: [{ id: 'keeper', handle: 'keeper', name: 'Keeper', description: '', available: true, roles: [], provider: 'anthropic', model: 'fixture' }] },
};
const quiet: ChatConversation = { conversationId: 'c1', agentId: 'keeper', messages: [] };
const gated: ChatConversation = { conversationId: 'c1', agentId: 'keeper', messages: [
  { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'gate', name: 'shed.run', input: { command: 'unzip -l a1.zip' } }] },
  { id: 'm2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'gate', name: 'shed.run', ok: true, output: 'awaiting owner approval', approval: { id: 'a1', state: 'pending' } }] },
] };
const field = (): HTMLTextAreaElement => screen.getByLabelText(/Message Keeper/) as HTMLTextAreaElement;
const page = (over: Partial<ChatPageProps> = {}): JSX.Element => (
  <Tooltip.Provider>
    <ChatPage {...props} {...over} />
  </Tooltip.Provider>
);

beforeEach(() => {
  const idle = { state: 'idle' as const, enabled: true, busy: false, hasScreenshot: false };
  vi.spyOn(api, 'browser').mockResolvedValue(idle);
  vi.spyOn(api, 'overview').mockResolvedValue({} as never);
  vi.spyOn(api, 'approval').mockResolvedValue({ id: 'a1', tool: 'shed.run', state: 'pending', canonicalArgs: { command: 'unzip -l a1.zip' }, preview: '', expiresAt: '2999-01-01T00:00:00Z', createdAt: '2026-09-23T10:00:00Z' } as never);
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
  vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [] });
  vi.spyOn(chatApi, 'conversation').mockResolvedValue(quiet);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.querySelectorAll('[data-test-sheet]').forEach((node) => node.remove());
});

describe('composer focus', () => {
  it('lands in the composer on a conversation opened from the list (or by Open buddi)', async () => {
    render(page({ requestedConversationId: 'c1' }));
    await waitFor(() => expect(field()).toHaveFocus());
  });

  it('comes back to the composer on New conversation', async () => {
    const view = render(page());
    await waitFor(() => expect(field()).toHaveFocus());
    field().blur();
    expect(field()).not.toHaveFocus();
    view.rerender(page({ newConversationSignal: 1 }));
    await waitFor(() => expect(field()).toHaveFocus());
  });

  it('leaves the focus alone while an approval card stands in the composer’s place', async () => {
    vi.mocked(chatApi.conversation).mockResolvedValue(gated);
    render(page({ requestedConversationId: 'c1' }));
    await screen.findByTestId('approval-dock');
    expectComposerNotFocused();
  });

  it('leaves the focus alone over an open sheet', async () => {
    const sheet = document.createElement('div');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('data-test-sheet', '');
    document.body.appendChild(sheet);
    render(page({ requestedConversationId: 'c1' }));
    await screen.findByLabelText(/Message Keeper/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(field()).not.toHaveFocus();
  });
});

function expectComposerNotFocused(): void {
  expect(screen.getByTestId('composer-slot')).toHaveAttribute('hidden');
  expect(document.activeElement === field()).toBe(false);
}
