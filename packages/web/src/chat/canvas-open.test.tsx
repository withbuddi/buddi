/**
 * The desktop Canvas is closed until used (2026-10-12).
 *
 * A conversation starts with the chat alone; the first thing that lands
 * opens the canvas; once the owner closes it, later arrivals count up on the
 * header's Canvas button instead of reopening it; and the button opens it
 * whenever he likes, empty or not.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, chatApi, type BrowserStatus } from '../api';
import { ChatPage, type ChatPageProps } from './ChatPage';
import type { ChatEvent, ChatMessage } from './types';

const streams: Array<(event: ChatEvent) => void> = [];
vi.mock('./stream', () => ({
  openChatStream: (opts: { onEvent: (event: ChatEvent) => void }) => {
    streams.push(opts.onEvent);
    return { close() {}, lastEventId: () => null };
  },
}));

const idle: BrowserStatus = { state: 'idle', enabled: true, busy: false, hasScreenshot: false };

const props: ChatPageProps = {
  timezone: 'UTC', agentId: 'keeper', onSelectAgent: vi.fn(), attention: new Map(),
  agentsInHeader: false, narrow: false,
  agents: { top: [], bottom: [], middle: [{ id: 'keeper', handle: 'keeper', name: 'Keeper', description: '', available: true, roles: [], provider: 'anthropic', model: 'fixture' }] },
};

const at = (seconds: number): string => new Date(Date.now() - 600_000 + seconds * 1000).toISOString();
const call = (id: string, name: string, output: unknown, when: number): ChatMessage[] => [
  { id: `${id}-use`, role: 'assistant', at: at(when), blocks: [{ type: 'tool_use', id, name, input: {} }] },
  { id: `${id}-result`, role: 'user', at: at(when), blocks: [{ type: 'tool_result', toolUseId: id, name, ok: true, output }] },
];
const rows = [
  { name: 'wikipedia', site: 'en.wikipedia.org', saved: '2026-10-01' },
  { name: 'github', site: 'github.com', saved: '2026-09-12' },
];
const said = (text: string, when: number): ChatMessage => ({ id: `said-${when}`, role: 'user', at: at(when), blocks: [{ type: 'text', text }] });

let transcript: ChatMessage[] = [];
beforeEach(() => {
  streams.length = 0;
  transcript = [];
  window.sessionStorage.clear();
  vi.spyOn(api, 'browser').mockResolvedValue(idle);
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
  vi.spyOn(chatApi, 'canvasTabs').mockResolvedValue({ closed: [], touched: {} });
  vi.spyOn(chatApi, 'saveCanvasTabs').mockResolvedValue(undefined as never);
  vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [{ id: 'c1', agentId: 'keeper', createdAt: new Date().toISOString(), lastMessageAt: null, opening: null, messageCount: 1 }] });
  vi.spyOn(chatApi, 'conversation').mockImplementation(async () => ({ conversationId: 'c1', agentId: 'keeper', messages: transcript }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** A result lands mid-run: the stream says so and the page reads the transcript again. */
async function lands(messages: ChatMessage[], id: string): Promise<void> {
  transcript = [...transcript, ...messages];
  await waitFor(() => expect(streams.length).toBeGreaterThan(0));
  act(() => streams.at(-1)!({ id, name: 'tool.result', data: { toolUseId: id, name: 'x' } } as ChatEvent));
}

const page = (): ReturnType<typeof render> => render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);

async function loaded(): Promise<void> {
  await waitFor(() => expect(streams.length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.getAllByText('Which logins do I have?').length).toBeGreaterThan(0));
}

describe('the desktop Canvas, closed until used', () => {
  it('starts with the conversation alone', async () => {
    transcript = [said('Which logins do I have?', 0)];
    page();
    await loaded();
    expect(screen.getByTestId('canvas')).not.toBeVisible();
    expect(screen.getByTestId('chat-column')).toHaveAttribute('data-solo', 'true');
    expect(screen.queryByLabelText('Resize the conversation column')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open the canvas' })).toBeInTheDocument();
  });

  it('opens by itself when the first result lands', async () => {
    transcript = [said('Which logins do I have?', 0)];
    page();
    await loaded();
    await lands(call('l1', 'shed.saved_logins', rows, 1), 'l1');
    await waitFor(() => expect(screen.getByTestId('canvas')).toBeVisible());
    expect(screen.getByRole('tab', { name: 'Shed · Saved logins' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByTestId('chat-column')).not.toHaveAttribute('data-solo');
    expect(screen.queryByRole('button', { name: /Open the canvas/ })).toBeNull();
  });

  it('opens an earlier conversation that already has results', async () => {
    transcript = [said('Which logins do I have?', 0), ...call('l1', 'shed.saved_logins', rows, 1)];
    page();
    await waitFor(() => expect(screen.getByTestId('canvas')).toBeVisible());
  });

  it('stays closed after the owner closes it, counting what arrives on the button', async () => {
    transcript = [said('Which logins do I have?', 0)];
    page();
    await loaded();
    await lands(call('l1', 'shed.saved_logins', rows, 1), 'l1');
    await waitFor(() => expect(screen.getByTestId('canvas')).toBeVisible());

    fireEvent.click(screen.getByRole('button', { name: 'Close the canvas' }));
    expect(screen.getByTestId('canvas')).not.toBeVisible();
    expect(window.sessionStorage.getItem('buddi.canvas.c1')).toBe('closed');

    await lands(call('l2', 'shed.beds', rows, 2), 'l2');
    const reopen = await screen.findByRole('button', { name: 'Open the canvas, 1 new' });
    expect(screen.getByTestId('canvas')).not.toBeVisible();

    // An explicit canvas.show is counted too, not shown: the owner said closed.
    transcript = [...transcript, { id: 'show', role: 'assistant', at: at(5), blocks: [{ type: 'tool_use', id: 'show1', name: 'canvas.show', input: { renderer: 'structured', title: 'Your saved logins', data: { value: rows } } }] }];
    await lands([], 'show1');
    await screen.findByRole('button', { name: 'Open the canvas, 2 new' });
    expect(screen.getByTestId('canvas')).not.toBeVisible();

    fireEvent.click(reopen);
    await waitFor(() => expect(screen.getByTestId('canvas')).toBeVisible());
    expect(screen.queryByRole('button', { name: /Open the canvas/ })).toBeNull();
  });

  it('remembers the owner’s close for the conversation across a reload', async () => {
    transcript = [said('Which logins do I have?', 0), ...call('l1', 'shed.saved_logins', rows, 1)];
    window.sessionStorage.setItem('buddi.canvas.c1', 'closed');
    page();
    await loaded();
    await screen.findByRole('tab', { hidden: true, name: 'Shed · Saved logins' });
    expect(screen.getByTestId('canvas')).not.toBeVisible();
  });

  it('opens on the owner’s click even when empty, and keeps the tab in front across a close', async () => {
    transcript = [said('Which logins do I have?', 0)];
    page();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Open the canvas' }));
    await waitFor(() => expect(screen.getByTestId('canvas')).toBeVisible());
    expect(screen.getByText(/lands here/)).toBeInTheDocument();
    expect(window.sessionStorage.getItem('buddi.canvas.c1')).toBe('open');

    await lands([...call('l1', 'shed.saved_logins', rows, 1), ...call('l2', 'shed.beds', rows, 2)], 'l2');
    const first = await screen.findByRole('tab', { name: 'Shed · Saved logins' });
    fireEvent.mouseDown(first, { button: 0, ctrlKey: false });
    await waitFor(() => expect(first).toHaveAttribute('data-state', 'active'));

    fireEvent.click(screen.getByRole('button', { name: 'Close the canvas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open the canvas' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Shed · Saved logins' })).toHaveAttribute('data-state', 'active'));
  });

  it('leaves the phone’s sheet alone', async () => {
    transcript = [said('Which logins do I have?', 0), ...call('l1', 'shed.saved_logins', rows, 1)];
    render(<Tooltip.Provider><ChatPage {...props} narrow canvasOpen={false} /></Tooltip.Provider>);
    await loaded();
    expect(screen.queryByTestId('canvas')).toBeNull();
    expect(screen.queryByRole('button', { name: /Open the canvas/ })).toBeNull();
    expect(screen.getByTestId('chat-column')).not.toHaveAttribute('data-solo');
  });
});
