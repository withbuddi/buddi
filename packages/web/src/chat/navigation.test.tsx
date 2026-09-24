import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { api, chatApi } from '../api';
import { chatRoute, parseChatRoute } from '../routes';
import type { ChatConversation } from './types';

vi.mock('./stream', () => ({ openChatStream: () => ({ close() {} }) }));
const agents = ['keeper', 'scout'].map(id => ({ id, handle: id, name: id === 'keeper' ? 'Keeper' : 'Scout', description: '', available: true, roles: [], provider: 'fixture', model: 'fixture' }));
function transcript(id: string): ChatConversation {
  return { conversationId: id, agentId: id.startsWith('scout') ? 'scout' : 'keeper', messages: [{ id: `message-${id}`, role: 'assistant', at: '', blocks: [{ type: 'text', text: `Transcript ${id}` }] }] };
}
beforeEach(() => {
  window.history.replaceState(null, '', '#/chat'); sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  vi.spyOn(api, 'session').mockResolvedValue({ timezone: 'UTC' } as never);
  vi.spyOn(api, 'overview').mockResolvedValue({ approvals: { pending: 0 }, jobs: { failed: 0 } } as never);
  vi.spyOn(api, 'host').mockResolvedValue({ permissions: [], runs: [] });
  vi.spyOn(api, 'browser').mockResolvedValue({ enabled: true, busy: false, state: 'idle', hasScreenshot: false });
  vi.spyOn(api, 'browserControl').mockResolvedValue({ enabled: true, busy: false, state: 'idle', hasScreenshot: false });
  vi.spyOn(chatApi, 'agents').mockResolvedValue({ agents, defaultAgentId: 'keeper' });
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
  vi.spyOn(chatApi, 'conversations').mockImplementation(async agentId => ({ conversations: [
    { id: `${agentId}-latest`, startedAt: '2026-09-18T12:00:00Z', lastMessageAt: '2026-09-18T13:00:00Z', preview: 'Latest task', messageCount: 5 },
    { id: `${agentId}-old`, startedAt: '2026-09-17T12:00:00Z', lastMessageAt: '2026-09-17T13:00:00Z', preview: 'Earlier task', messageCount: 3 },
  ] }));
  vi.spyOn(chatApi, 'conversation').mockImplementation(async id => transcript(id));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '#/'); sessionStorage.clear(); });

describe('chat links and history', () => {
  it('encodes identifiers and rejects malformed routes without throwing', () => {
    expect(parseChatRoute(chatRoute('agent name', 'a/b'))).toEqual({ agentId: 'agent name', conversationId: 'a/b' });
    expect(parseChatRoute('#/chat/%ZZ')).toBeNull();
    expect(parseChatRoute('#/approvals')).toBeNull();
  });
  it('opens an exact conversation from a bookmark instead of selecting the newest', async () => {
    window.history.replaceState(null, '', chatRoute('scout', 'scout-old'));
    render(<App />);
    expect(await screen.findByText('Transcript scout-old')).toBeInTheDocument();
    expect(chatApi.conversations).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-head')).toHaveTextContent('Scout');
    // Name and handle together: the header names the agent and shows the word
    // you type to reach it.
    expect(screen.getByTestId('chat-head')).toHaveTextContent('@scout');
    expect(window.location.hash).toBe(chatRoute('scout', 'scout-old'));
  });
  it('updates agent URLs, opens history entries and responds to browser Back/Forward routes', async () => {
    render(<App />);
    await screen.findByText('Transcript keeper-latest');
    expect(window.location.hash).toBe(chatRoute('keeper', 'keeper-latest'));
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    const link = await screen.findByRole('link', { name: /Earlier task/ });
    expect(link).toHaveAttribute('href', chatRoute('keeper', 'keeper-old'));
    fireEvent.click(link);
    expect(await screen.findByText('Transcript keeper-old')).toBeInTheDocument();
    expect(window.location.hash).toBe(chatRoute('keeper', 'keeper-old'));
    await act(async () => { window.location.hash = chatRoute('scout', 'scout-old'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByText('Transcript scout-old')).toBeInTheDocument();
    expect(screen.queryByText('Transcript keeper-old')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-face-keeper'));
    expect(await screen.findByText('Transcript keeper-latest')).toBeInTheDocument();
    expect(window.location.hash).toBe(chatRoute('keeper', 'keeper-latest'));
  });
  it('supports a fresh conversation link without loading or creating an old thread', async () => {
    window.history.replaceState(null, '', chatRoute('keeper', 'new'));
    render(<App />);
    // The kit's head: "New conversation" on top, then the name and the word you type.
    await screen.findByRole('link', { name: 'Keeper' });
    expect(screen.getByTestId('chat-head')).toHaveTextContent('New conversation');
    expect(screen.getByTestId('chat-head')).toHaveTextContent('@keeper');
    expect(chatApi.conversation).not.toHaveBeenCalled();
    expect(chatApi.conversations).not.toHaveBeenCalled();
    expect(screen.queryByText(/Transcript/)).not.toBeInTheDocument();
  });
  it('replaces a new-conversation URL after sending without losing running state', async () => {
    window.history.replaceState(null, '', chatRoute('keeper', 'new'));
    vi.spyOn(chatApi, 'send').mockResolvedValue({ conversationId: 'keeper-created', runId: 'run' });
    render(<App />);
    const area = await screen.findByRole('textbox');
    fireEvent.change(area, { target: { value: 'Start this task' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(window.location.hash).toBe(chatRoute('keeper', 'keeper-created')));
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(chatApi.send).toHaveBeenCalledWith('keeper', { text: 'Start this task', attachmentIds: [] });
  });
  it('reports a mismatched agent/conversation link without showing the wrong transcript', async () => {
    window.history.replaceState(null, '', chatRoute('keeper', 'scout-old'));
    render(<App />);
    expect(await screen.findByText(/belongs to another agent/)).toBeInTheDocument();
    expect(screen.queryByText('Transcript scout-old')).not.toBeInTheDocument();
  });
  /*
   * A half-typed message is the owner's. Going to look something up in
   * another agent's thread must not cost it.
   */
  it('keeps a half-typed message with its thread across a trip to another agent', async () => {
    render(<App />);
    await screen.findByText('Transcript keeper-latest');
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'the thing I was about to ask' } });

    fireEvent.click(screen.getByTestId('agent-face-scout'));
    await screen.findByText('Transcript scout-latest');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');

    fireEvent.click(screen.getByTestId('agent-face-keeper'));
    await screen.findByText('Transcript keeper-latest');
    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('the thing I was about to ask'),
    );
    window.localStorage.clear();
  });

  it('does not blank the transcript when reselecting the current history entry', async () => {
    render(<App />); await screen.findByText('Transcript keeper-latest');
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    fireEvent.click(await screen.findByRole('link', { name: /Latest task/ }));
    expect(screen.getByText('Transcript keeper-latest')).toBeInTheDocument();
  });
});

describe('dismissible result tabs', () => {
  it('closes a failed panel, remembers dismissal after reload, and reopens from its chip', async () => {
    vi.mocked(chatApi.conversation).mockImplementation(async id => ({ ...transcript(id), messages: [
      { id: 'call', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'failed-tool', name: 'shed.work', input: {} }] },
      { id: 'result', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'failed-tool', name: 'shed.work', ok: false, output: 'Busy' }] },
    ] }));
    const view = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close Shed · Work tab' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Shed · Work' })).not.toBeInTheDocument());
    expect(within(screen.getByTestId('messages')).getByRole('button', { name: /Shed · Work/ })).toBeInTheDocument();
    expect(api.browserControl).not.toHaveBeenCalled();
    view.unmount(); render(<App />);
    const chip = await within(screen.getByTestId('messages')).findByRole('button', { name: /Shed · Work/ });
    expect(screen.queryByRole('tab', { name: 'Shed · Work' })).not.toBeInTheDocument();
    fireEvent.click(chip);
    expect(await screen.findByRole('tab', { name: 'Shed · Work' })).toBeInTheDocument();
  });
});
