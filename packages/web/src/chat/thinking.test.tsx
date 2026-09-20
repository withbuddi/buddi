/**
 * Thinking, switched from the chat, written to the agent file.
 *
 * The Agents page has had this control for as long as the setting has existed,
 * three clicks from the conversation it changes. Here it sits beside the model
 * name — and goes through the very call that page makes, so a switch made in
 * one place is what the other one shows.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { api, chatApi } from '../api';
import { chatRoute } from '../routes';

vi.mock('./stream', () => ({ openChatStream: () => ({ close() {} }) }));

const agents = [
  { id: 'ada', handle: 'ada', name: 'Ada', description: 'The assistant', available: true, roles: [], provider: 'fixture', model: 'a-model', thinking: 'on' },
  { id: 'local', handle: 'local', name: 'Local', description: 'On this machine', available: true, roles: [], provider: 'fixture', model: 'a-model', thinking: 'off' },
];

beforeEach(() => {
  window.history.replaceState(null, '', chatRoute('ada'));
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  vi.spyOn(api, 'session').mockResolvedValue({ timezone: 'UTC' } as never);
  vi.spyOn(api, 'overview').mockResolvedValue({ approvals: { pending: 0 }, jobs: { failed: 0 } } as never);
  vi.spyOn(api, 'host').mockResolvedValue({ permissions: [], runs: [] });
  vi.spyOn(api, 'browser').mockResolvedValue({ enabled: true, busy: false, state: 'idle', hasScreenshot: false });
  vi.spyOn(api, 'browserControl').mockResolvedValue({ enabled: true, busy: false, state: 'idle', hasScreenshot: false });
  vi.spyOn(api, 'setAgentEngine').mockResolvedValue({ agent: {}, changed: ['thinking'], note: '' } as never);
  vi.spyOn(chatApi, 'agents').mockResolvedValue({ agents, defaultAgentId: 'ada' } as never);
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
  vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [] } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '#/');
  sessionStorage.clear();
});

describe('the thinking switch in the chat', () => {
  it('reflects the agent the owner is talking to', async () => {
    render(<App />);
    const toggle = await screen.findByRole('button', { name: 'Thinking' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // A different agent, a different file, a different answer.
    fireEvent.click(screen.getByTestId('agent-face-local'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute('aria-pressed', 'false'),
    );
  });

  it('writes through the same endpoint the Agents page uses, and moves at once', async () => {
    render(<App />);
    const toggle = await screen.findByRole('button', { name: 'Thinking' });
    fireEvent.click(toggle);
    expect(api.setAgentEngine).toHaveBeenCalledWith('ada', { thinking: 'off' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute('aria-pressed', 'false'),
    );
  });
});
