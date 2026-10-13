/**
 * A text file a turn produced comes to the front of the Canvas (2026-10-13):
 * the command that made it keeps its tab behind, the file's editor is in
 * front, and a canvas the owner closed only counts it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, chatApi, type BrowserStatus } from '../api';
import { isDirty, resetDrafts } from '../canvas/file-drafts';
import { fileTabId } from '../canvas/text-files';
import type { CodeEditorProps } from '../canvas/views/CodeEditor';
import { ChatPage, type ChatPageProps } from './ChatPage';
import type { ChatEvent, ChatMessage } from './types';

const streams: Array<(event: ChatEvent) => void> = [];
vi.mock('./stream', () => ({
  openChatStream: (opts: { onEvent: (event: ChatEvent) => void }) => {
    streams.push(opts.onEvent);
    return { close() {}, lastEventId: () => null };
  },
}));
vi.mock('../canvas/views/CodeEditor', () => ({
  default: (props: CodeEditorProps) => <textarea aria-label={props.label} value={props.value} onChange={(event) => props.onChange(event.target.value)} />,
}));

const idle: BrowserStatus = { state: 'idle', enabled: true, busy: false, hasScreenshot: false };
const props: ChatPageProps = {
  timezone: 'UTC', agentId: 'keeper', onSelectAgent: vi.fn(), attention: new Map(),
  agentsInHeader: false, narrow: false,
  agents: { top: [], bottom: [], middle: [{ id: 'keeper', handle: 'keeper', name: 'Keeper', description: '', available: true, roles: [], provider: 'anthropic', model: 'fixture' }] },
};

const FILE = '00000005-0000-4000-8000-000000000000';
const FILE_TAB = fileTabId(FILE);
const at = (seconds: number): string => new Date(Date.now() - 600_000 + seconds * 1000).toISOString();
const exec = (id: string, when: number): ChatMessage[] => [
  { id: `${id}-use`, role: 'assistant', at: at(when), blocks: [{ type: 'tool_use', id, name: 'host.exec', input: { command: 'python3 sum.py', outputs: ['summary.md'] } }] },
  { id: `${id}-result`, role: 'user', at: at(when), blocks: [{ type: 'tool_result', toolUseId: id, name: 'host.exec', ok: true, output: {
    exitCode: 0, state: 'exited', stdout: 'wrote summary.md\n', stderr: '',
    artifacts: [{ id: FILE, filename: 'summary.md', mime: 'text/markdown', sizeBytes: 12 }],
  } }] },
];
const PICTURE = '00000006-0000-4000-8000-000000000000';
const opened = (id: string, artifactId: string, filename: string, mime: string, when: number): ChatMessage[] => [
  { id: `${id}-use`, role: 'assistant', at: at(when), blocks: [{ type: 'tool_use', id, name: 'canvas.open', input: { name: filename } }] },
  { id: `${id}-result`, role: 'user', at: at(when), blocks: [{ type: 'tool_result', toolUseId: id, name: 'canvas.open', ok: true, output: { opened: true, artifactId, filename, mime } }] },
];
const said = (text: string, when: number): ChatMessage => ({ id: `said-${when}`, role: 'user', at: at(when), blocks: [{ type: 'text', text }] });

let transcript: ChatMessage[] = [];
beforeEach(() => {
  streams.length = 0;
  transcript = [];
  resetDrafts();
  window.sessionStorage.clear();
  vi.spyOn(api, 'browser').mockResolvedValue(idle);
  vi.spyOn(api, 'fileContent').mockResolvedValue({ fileId: 'f0000000-0000-4000-8000-000000000000', version: 1, artifactId: '00000001-0000-4000-8000-000000000000', createdBy: 'scout', conversationId: null, text: '# Summary\n\nAll good\n', sha256: 'a'.repeat(64), sizeBytes: 20, editable: true, truncated: false });
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
  vi.spyOn(chatApi, 'canvasTabs').mockResolvedValue({ closed: [], touched: {} });
  vi.spyOn(chatApi, 'saveCanvasTabs').mockResolvedValue(undefined as never);
  vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [{ id: 'c1', agentId: 'keeper', createdAt: new Date().toISOString(), lastMessageAt: null, opening: null, messageCount: 1 }] });
  vi.spyOn(chatApi, 'conversation').mockImplementation(async () => ({ conversationId: 'c1', agentId: 'keeper', messages: transcript }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function lands(messages: ChatMessage[], id: string): Promise<void> {
  transcript = [...transcript, ...messages];
  await waitFor(() => expect(streams.length).toBeGreaterThan(0));
  act(() => streams.at(-1)!({ id, name: 'tool.result', data: { toolUseId: id, name: 'x' } } as ChatEvent));
}

const page = (): ReturnType<typeof render> => render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);

async function loaded(): Promise<void> {
  await waitFor(() => expect(streams.length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.getAllByText('Summarise the run').length).toBeGreaterThan(0));
}

describe('a generated text file on the Canvas', () => {
  it('opens in front of the command that made it, with a dot while an edit is unsaved', async () => {
    transcript = [said('Summarise the run', 0)];
    page();
    await loaded();
    await lands(exec('x1', 1), 'x1');
    const file = await screen.findByRole('tab', { name: /summary\.md/ });
    await waitFor(() => expect(file).toHaveAttribute('data-state', 'active'));
    expect(screen.getAllByRole('tab').length).toBe(2);
    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Edit' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Edit summary.md' }), { target: { value: '# Summary\n\nMine\n' } });
    await waitFor(() => expect(within(file).getByRole('img', { name: 'Unsaved changes' })).toBeInTheDocument());
  });

  it('asks before closing a tab with an unsaved edit, and discards it only when told', async () => {
    transcript = [said('Summarise the run', 0)];
    page();
    await loaded();
    await lands(exec('x1', 1), 'x1');
    await screen.findByRole('heading', { name: 'Summary' });
    fireEvent.click(screen.getByRole('radio', { name: 'Edit' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Edit summary.md' }), { target: { value: '# Summary\n\nMine\n' } });

    fireEvent.click(screen.getByRole('button', { name: /Close .*summary\.md tab/ }));
    const prompt = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('tab', { name: /summary\.md/ })).toBeInTheDocument();
    expect(isDirty(FILE_TAB)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Close .*summary\.md tab/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard and close' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /summary\.md/ })).toBeNull());
    expect(isDirty(FILE_TAB)).toBe(false);
  });

  it('brings a file the agent opened to the front, in the tab that already holds it', async () => {
    transcript = [said('Summarise the run', 0), ...exec('x1', 1), said('Compare, then show me the summary', 2), {
      id: 'show', role: 'assistant', at: at(3), blocks: [{ type: 'tool_use', id: 'show1', name: 'canvas.show', input: { renderer: 'keyvalue', title: 'Compared', data: { pairs: [{ label: 'Days', value: 3 }] } } }],
    }];
    page();
    await loaded();
    // Something else is in front.
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Compared' })).toHaveAttribute('data-state', 'active'));
    await lands(opened('o1', FILE, 'summary.md', 'text/markdown', 4), 'o1');
    await waitFor(() => expect(screen.getByRole('tab', { name: /summary\.md/ })).toHaveAttribute('data-state', 'active'));
    expect(screen.getAllByRole('tab', { name: /summary\.md/ })).toHaveLength(1);
  });

  it('opens a file that is not text in its preview', async () => {
    transcript = [said('Summarise the run', 0)];
    page();
    await loaded();
    await lands(opened('o2', PICTURE, 'chart.png', 'image/png', 1), 'o2');
    await waitFor(() => expect(screen.getByRole('tab', { name: /chart\.png/ })).toHaveAttribute('data-state', 'active'));
    expect(document.querySelector('.file-preview-image img')).toHaveAttribute('src', `/api/artifacts/${PICTURE}/preview`);
  });

  it('counts an opened file on the button when the owner closed the canvas', async () => {
    transcript = [said('Summarise the run', 0)];
    window.sessionStorage.setItem('buddi.canvas.c1', 'closed');
    page();
    await loaded();
    await lands(opened('o3', FILE, 'summary.md', 'text/markdown', 1), 'o3');
    await screen.findByRole('button', { name: 'Open the canvas, 1 new' });
    expect(screen.getByTestId('canvas')).not.toBeVisible();
  });

  it('only counts on the Canvas button when the owner closed the canvas', async () => {
    transcript = [said('Summarise the run', 0)];
    window.sessionStorage.setItem('buddi.canvas.c1', 'closed');
    page();
    await loaded();
    await lands(exec('x1', 1), 'x1');
    await screen.findByRole('button', { name: 'Open the canvas, 2 new' });
    expect(screen.getByTestId('canvas')).not.toBeVisible();
  });
});

