/**
 * The Files tab, on the chat page: there for an agent a plugin keeps a
 * workspace for, absent for one it does not, never taking the screen from
 * what the conversation produced, and read again when a file changes.
 *
 * The plugin (`shed`) and its query names are invented and arrive as data,
 * exactly as `GET /api/pages` would serve them.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, chatApi } from '../api';
import { ChatPage, type ChatPageProps } from './ChatPage';
import type { ChatConversation, ChatEvent } from './types';

const stream = vi.hoisted(() => ({ handlers: [] as Array<(event: ChatEvent) => void> }));
vi.mock('./stream', () => ({
  openChatStream: (options: { onEvent: (event: ChatEvent) => void }) => {
    stream.handlers.push(options.onEvent);
    return { close() {} };
  },
}));

const FILES = { plugin: 'shed', workspace: 'root', list: 'ls', stat: 'info', read: 'cat', archive: 'pack' };

const props: ChatPageProps = {
  timezone: 'UTC', agentId: 'keeper', onSelectAgent: vi.fn(), attention: new Map(),
  agentsInHeader: false, narrow: false,
  agents: { top: [], bottom: [], middle: [{ id: 'keeper', handle: 'keeper', name: 'Keeper', description: '', available: true, roles: [], provider: 'anthropic', model: 'fixture' }] },
};

function pair(id: string, output: unknown): ChatConversation['messages'] {
  return [
    { id: `${id}-a`, role: 'assistant', at: '2026-09-23T10:00:00Z', blocks: [{ type: 'tool_use', id, name: 'shed.thing', input: {} }] },
    { id: `${id}-b`, role: 'user', at: '2026-09-23T10:00:01Z', blocks: [{ type: 'tool_result', toolUseId: id, name: 'shed.thing', ok: true, output }] },
  ];
}

const figures = pair('f1', { pairs: [{ label: 'Rows', value: 3 }] });
const conversation = (messages: ChatConversation['messages']): ChatConversation => ({ conversationId: 'c1', agentId: 'keeper', messages });

let workspace: { name: string; dir: string } | null;
let listed: number;

beforeEach(() => {
  stream.handlers.length = 0;
  workspace = { name: 'garden', dir: '/work/garden' };
  listed = 0;
  vi.spyOn(api, 'browser').mockResolvedValue({ state: 'idle', enabled: true, busy: false, hasScreenshot: false } as never);
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [{ tool: 'shed.thing', renderer: 'keyvalue', title: 'Figures', map: { from: 'pairs' } }] } as never);
  vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [{ id: 'c1', agentId: 'keeper', createdAt: new Date().toISOString(), lastMessageAt: null, opening: null, messageCount: 2 }] } as never);
  vi.spyOn(chatApi, 'conversation').mockResolvedValue(conversation(figures));
  vi.spyOn(api, 'pages').mockResolvedValue({ pages: [], files: [FILES] });
  vi.spyOn(api, 'pageQuery').mockImplementation(async (_plugin, name) => {
    if (name === 'root') return { data: { workspace } } as never;
    if (name === 'ls') {
      listed += 1;
      return { data: { path: '', entries: [{ name: 'index.html', path: 'index.html', kind: 'file', bytes: 1, mtimeMs: 1 }], skipped: 0, truncated: false } } as never;
    }
    throw new Error(name);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const page = () => render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);

describe('the Files tab on a conversation', () => {
  it('appears for an agent with a workspace, and leaves the result it produced on screen', async () => {
    page();
    const tab = await screen.findByRole('tab', { name: 'Files' });
    await waitFor(() => expect(screen.getByRole('tab', { name: /Figures/ })).toHaveAttribute('aria-selected', 'true'));
    expect(tab).toHaveAttribute('aria-selected', 'false');
    expect(api.pageQuery).toHaveBeenCalledWith('shed', 'root', { agent: 'keeper' });
  });

  it('does not appear for an agent without one', async () => {
    workspace = null;
    page();
    await screen.findByRole('tab', { name: /Figures/ });
    await waitFor(() => expect(api.pageQuery).toHaveBeenCalledWith('shed', 'root', { agent: 'keeper' }));
    expect(screen.queryByRole('tab', { name: 'Files' })).toBeNull();
  });

  it('does not appear when no plugin keeps workspaces', async () => {
    vi.mocked(api.pages).mockResolvedValue({ pages: [] });
    page();
    await screen.findByRole('tab', { name: /Figures/ });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('tab', { name: 'Files' })).toBeNull();
  });

  it('reads the folder again when a change to a file comes back, and keeps the owner on it', async () => {
    page();
    const tab = await screen.findByRole('tab', { name: 'Files' });
    fireEvent.mouseDown(tab, { button: 0 });
    await screen.findByText('index.html');
    const before = listed;
    vi.mocked(chatApi.conversation).mockResolvedValue(conversation([...figures, ...pair('w1', { path: 'index.html', diff: '+<h1>hi</h1>' })]));
    await act(async () => { for (const handler of stream.handlers) handler({ id: null, name: 'message.appended', data: {} }); });
    await waitFor(() => expect(listed).toBe(before + 1));
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
  });
});
