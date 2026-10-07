/**
 * The Canvas stops stealing focus from a live page (2026-10-07).
 *
 * While an agent signs in on a page, the Page tab keeps the front: a fill
 * opens no tab, a list opens behind it with a dot, and only the agent's own
 * `canvas.show` brings something forward.
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

const live: BrowserStatus = {
  state: 'running', enabled: true, busy: false, hasScreenshot: true,
  session: { id: 's1', agentId: 'keeper', conversationId: 'c1', requestId: 'r1', task: 'Sign in to Wikipedia', expiresAt: new Date().toISOString(), steps: 1, maxSteps: 80 },
  page: { id: 'o1', url: 'https://en.wikipedia.org/', title: 'Wikipedia', capturedAt: new Date().toISOString(), tabs: [] },
};
const idle: BrowserStatus = { state: 'idle', enabled: true, busy: false, hasScreenshot: false };

const props: ChatPageProps = {
  timezone: 'UTC', agentId: 'keeper', onSelectAgent: vi.fn(), attention: new Map(),
  agentsInHeader: false, narrow: false,
  agents: { top: [], bottom: [], middle: [{ id: 'keeper', handle: 'keeper', name: 'Keeper', description: '', available: true, roles: [], provider: 'anthropic', model: 'fixture' }] },
};

const at = (seconds: number): string => new Date(Date.now() - 600_000 + seconds * 1000).toISOString();
const call = (id: string, name: string, input: unknown, output: unknown, when: number): ChatMessage[] => [
  { id: `${id}-use`, role: 'assistant', at: at(when), blocks: [{ type: 'tool_use', id, name, input }] },
  { id: `${id}-result`, role: 'user', at: at(when), blocks: [{ type: 'tool_result', toolUseId: id, name, ok: true, output }] },
];
const rows = [
  { name: 'wikipedia', site: 'en.wikipedia.org', saved: '2026-10-01' },
  { name: 'github', site: 'github.com', saved: '2026-09-12' },
  { name: 'bank', site: 'bank.example', saved: '2026-08-03' },
];
const said = (text: string, when: number): ChatMessage => ({ id: `said-${when}`, role: 'user', at: at(when), blocks: [{ type: 'text', text }] });

let transcript: ChatMessage[] = [];
beforeEach(() => {
  streams.length = 0;
  transcript = [];
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['picture']) })));
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:last-frame', configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true, writable: true });
  vi.spyOn(api, 'browser').mockResolvedValue(live);
  vi.spyOn(api, 'browserControl').mockResolvedValue(live);
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
  vi.spyOn(chatApi, 'canvasTabs').mockResolvedValue({ closed: [], touched: {} });
  vi.spyOn(chatApi, 'saveCanvasTabs').mockResolvedValue(undefined as never);
  vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [{ id: 'c1', agentId: 'keeper', createdAt: new Date().toISOString(), lastMessageAt: null, opening: null, messageCount: 1 }] });
  vi.spyOn(chatApi, 'conversation').mockImplementation(async () => ({ conversationId: 'c1', agentId: 'keeper', messages: transcript }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** A result lands mid-run: the stream says so and the page reads the transcript again. */
async function lands(messages: ChatMessage[], id: string): Promise<void> {
  transcript = [...transcript, ...messages];
  await waitFor(() => expect(streams.length).toBeGreaterThan(0));
  act(() => streams.at(-1)!({ id: id, name: 'tool.result', data: { toolUseId: id, name: 'x' } } as ChatEvent));
}

async function pageInFront(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Page' })).toHaveAttribute('data-state', 'active'));
}

describe('the Canvas with a live page', () => {
  it('keeps the Page in front; a list opens behind it with a dot that clears when opened', async () => {
    transcript = [said('Sign me in to Wikipedia', 0), ...call('n1', 'browser.act', { action: 'navigate', url: 'https://en.wikipedia.org/' }, { observation: { id: 'o1' } }, 1)];
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    await pageInFront();

    await lands(call('l1', 'shed.saved_logins', {}, rows, 2), 'l1');
    const list = await screen.findByRole('tab', { name: 'Shed · Saved logins' });
    expect(list).toHaveAttribute('data-state', 'inactive');
    expect(list).toHaveAttribute('data-unread', 'true');
    expect(screen.getByRole('tab', { name: 'Page' })).toHaveAttribute('data-state', 'active');

    fireEvent.mouseDown(list, { button: 0, ctrlKey: false });
    await waitFor(() => expect(list).toHaveAttribute('data-state', 'active'));
    expect(list).not.toHaveAttribute('data-unread');
  });

  it('gives a fill, a secret list, an observe and a notify no tab at all', async () => {
    transcript = [said('Sign me in to Wikipedia', 0)];
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    await pageInFront();
    await lands([
      ...call('s1', 'secret.list', {}, { secrets: rows.map((row) => ({ name: row.name, site: row.site })) }, 1),
      ...call('s2', 'secret.fill', { name: 'wikipedia' }, { ok: true, filled: ['username', 'password'], page: 'Log in' }, 2),
      ...call('b1', 'browser.act', { action: 'observe' }, { observation: { id: 'o2', elements: rows } }, 3),
      ...call('m1', 'owner.notify', { title: 'Signed in' }, { ok: true, delivered: 'sent to Telegram' }, 4),
    ], 'm1');
    await screen.findByRole('button', { name: /Secret · Fill/ });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Page']);
    expect(screen.getByRole('tab', { name: 'Page' })).toHaveAttribute('data-state', 'active');
  });

  it('still brings a canvas.show forward', async () => {
    transcript = [said('Sign me in to Wikipedia', 0)];
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    await pageInFront();
    transcript = [...transcript, {
      id: 'show', role: 'assistant', at: at(5), blocks: [{ type: 'tool_use', id: 'c1show', name: 'canvas.show', input: { renderer: 'structured', title: 'Your saved logins', data: { value: rows } } }],
    }];
    await lands([], 'c1show');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Your saved logins' })).toHaveAttribute('data-state', 'active'));
  });
});

describe('the Canvas with no live page', () => {
  it('follows the work as before: a list takes the front', async () => {
    vi.mocked(api.browser).mockResolvedValue(idle);
    transcript = [said('Which logins do I have?', 0)];
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    await lands(call('l1', 'shed.saved_logins', {}, rows, 2), 'l1');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Shed · Saved logins' })).toHaveAttribute('data-state', 'active'));
  });

  it('folds the last turn’s tabs into the menu when a new turn starts', async () => {
    vi.mocked(api.browser).mockResolvedValue(idle);
    transcript = [
      said('First question', 0),
      ...call('t1', 'shed.saved_logins', {}, rows, 1),
      ...call('t2', 'shed.beds', {}, rows, 2),
      said('Second question', 10),
      ...call('t3', 'shed.plants', {}, rows, 11),
    ];
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Shed · Plants' })).toHaveAttribute('data-state', 'active'));
    expect(screen.queryByRole('tab', { name: 'Shed · Beds' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Shed · Saved logins' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 more views in this conversation' })).toBeInTheDocument();
  });
});
