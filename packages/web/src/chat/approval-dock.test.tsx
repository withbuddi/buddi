/**
 * The approval dock: a pending approval takes the composer's place.
 *
 * The decision is a click and only a click; the text beside it is the owner
 * speaking, delivered the way anything said mid-run is. Several wait in turn,
 * oldest first, and one decided somewhere else leaves the dock when the
 * stream says so.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, chatApi, type ApprovalRow } from '../api';
import { ApprovalDock } from './ApprovalDock';
import { ChatPage, type ChatPageProps } from './ChatPage';
import type { ChatConversation, ChatEvent } from './types';

const stream = vi.hoisted(() => ({ handlers: [] as Array<(event: ChatEvent) => void> }));
vi.mock('./stream', () => ({
  openChatStream: (options: { onEvent: (event: ChatEvent) => void }) => {
    stream.handlers.push(options.onEvent);
    return { close() {} };
  },
}));

function row(id: string, over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id,
    tool: 'shed.run',
    toolVersion: '1',
    agentId: 'keeper',
    conversationId: 'c1',
    jobId: null,
    preview: `It runs ${id}.`,
    envelope: {},
    canonicalArgs: { command: `unzip -l ${id}.zip`, cwd: '/work/garden' },
    argsHash: 'h',
    policyVersion: 1,
    state: 'pending',
    decidedBy: null,
    decidedVia: null,
    decidedAt: null,
    expiresAt: '2999-01-01T00:00:00Z',
    createdAt: '2026-09-23T10:00:00Z',
    outcome: null,
    ...over,
  };
}

const rows = new Map<string, ApprovalRow>();

beforeEach(() => {
  rows.clear();
  stream.handlers.length = 0;
  vi.spyOn(api, 'approval').mockImplementation(async (id) => rows.get(id) ?? row(id));
  vi.spyOn(api, 'overview').mockResolvedValue({} as never);
  vi.spyOn(api, 'decide').mockImplementation(async (id, decision) => {
    const decided = { ...(rows.get(id) ?? row(id)), state: decision === 'approve' ? 'succeeded' : 'rejected' };
    rows.set(id, decided);
    return { action: decided, execution: null };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); try { window.localStorage.clear(); } catch { /* none */ } });

describe('approval dock', () => {
  const two = [
    { approvalId: 'first', toolUseId: 't1' },
    { approvalId: 'second', toolUseId: 't2' },
  ];

  it('shows the oldest first, says how many wait, and advances after each decision', async () => {
    const decided = vi.fn();
    render(<ApprovalDock approvals={two} timezone="UTC" now={0} onDecided={decided} onSay={vi.fn()} onOpenFull={vi.fn()} />);
    const dock = await screen.findByTestId('approval-dock');
    expect(within(dock).getByTestId('approval-dock-count')).toHaveTextContent('1 of 2');
    expect(await within(dock).findByText('unzip -l first.zip')).toBeInTheDocument();
    expect(within(dock).getByText('/work/garden')).toBeInTheDocument();
    expect(within(dock).getByText('Shed · Run')).toBeInTheDocument();
    expect(within(dock).getByText(/^Expires/)).toBeInTheDocument();
    fireEvent.click(within(dock).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('unzip -l second.zip')).toBeInTheDocument();
    expect(api.decide).toHaveBeenCalledWith('first', 'approve', undefined);
    expect(decided).toHaveBeenCalledWith(expect.objectContaining({ id: 'first', state: 'succeeded' }));
    expect(screen.queryByTestId('approval-dock-count')).toBeNull();
  });

  it('puts the primary action on the right', async () => {
    render(<ApprovalDock approvals={two} timezone="UTC" now={0} onDecided={vi.fn()} onSay={vi.fn()} onOpenFull={vi.fn()} />);
    await screen.findByText('unzip -l first.zip');
    const buttons = within(screen.getByTestId('approval-dock')).getAllByRole('button');
    expect(buttons.at(-1)).toHaveTextContent('Approve');
    expect(buttons.at(-2)).toHaveTextContent('Reject');
  });

  it('rejects, then delivers what the owner typed as their message', async () => {
    const say = vi.fn();
    render(<ApprovalDock approvals={two.slice(0, 1)} timezone="UTC" now={0} onDecided={vi.fn()} onSay={say} onOpenFull={vi.fn()} />);
    await screen.findByText('unzip -l first.zip');
    fireEvent.change(screen.getByPlaceholderText('Tell the agent what to do instead (optional)'), { target: { value: 'use tar instead' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(say).toHaveBeenCalledWith('use tar instead'));
    expect(api.decide).toHaveBeenCalledWith('first', 'reject', undefined);
  });

  it('approves nothing on Enter', async () => {
    render(<ApprovalDock approvals={two} timezone="UTC" now={0} onDecided={vi.fn()} onSay={vi.fn()} onOpenFull={vi.fn()} />);
    await screen.findByText('unzip -l first.zip');
    const field = screen.getByPlaceholderText('Tell the agent what to do instead (optional)');
    fireEvent.change(field, { target: { value: 'go ahead' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('sends the remember choice with Approve', async () => {
    rows.set('first', row('first', { choices: [{ key: 'remember', label: 'Remember this in this workspace?', options: ['no', 'yes'], default: 'no' }] }));
    render(<ApprovalDock approvals={two.slice(0, 1)} timezone="UTC" now={0} onDecided={vi.fn()} onSay={vi.fn()} onOpenFull={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('Remember this in this workspace?'), { target: { value: 'yes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('first', 'approve', undefined, { remember: 'yes' }));
  });

  it('opens the full request on the canvas', async () => {
    const open = vi.fn();
    render(<ApprovalDock approvals={two} timezone="UTC" now={0} onDecided={vi.fn()} onSay={vi.fn()} onOpenFull={open} />);
    fireEvent.click(await screen.findByRole('button', { name: 'See the full request on the Canvas' }));
    expect(open).toHaveBeenCalledWith('t1');
  });

  it('lets an expired one go', async () => {
    rows.set('first', row('first', { expiresAt: '2000-01-01T00:00:00Z' }));
    const decided = vi.fn();
    render(<ApprovalDock approvals={two} timezone="UTC" now={Date.now()} onDecided={decided} onSay={vi.fn()} onOpenFull={vi.fn()} />);
    expect(await screen.findByText('unzip -l second.zip')).toBeInTheDocument();
    expect(decided).toHaveBeenCalledWith(expect.objectContaining({ id: 'first', state: 'expired' }));
  });
});

describe('the dock in the chat page', () => {
  const props: ChatPageProps = {
    timezone: 'UTC', agentId: 'keeper', onSelectAgent: vi.fn(), attention: new Map(),
    agentsInHeader: false, narrow: false,
    agents: { top: [], bottom: [], middle: [{ id: 'keeper', handle: 'keeper', name: 'Keeper', description: '', available: true, roles: [], provider: 'anthropic', model: 'fixture' }] },
  };
  const gated = (state: string): ChatConversation => ({ conversationId: 'c1', agentId: 'keeper', messages: [
    { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'gate', name: 'shed.run', input: { command: 'unzip -l a1.zip' } }] },
    { id: 'm2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'gate', name: 'shed.run', ok: state !== 'rejected', output: 'awaiting owner approval', approval: { id: 'a1', state } }] },
  ] });
  const quiet: ChatConversation = { conversationId: 'c1', agentId: 'keeper', messages: [] };

  beforeEach(() => {
    const idle = { state: 'idle' as const, enabled: true, busy: false, hasScreenshot: false };
    vi.spyOn(api, 'browser').mockResolvedValue(idle);
    vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
    vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [{ id: 'c1', agentId: 'keeper', createdAt: new Date().toISOString(), lastMessageAt: null, opening: null, messageCount: 0 }] });
  });

  const composerField = (): HTMLTextAreaElement => screen.getByLabelText(/Message Keeper/) as HTMLTextAreaElement;
  const emit = async (name: ChatEvent['name']): Promise<void> => {
    await act(async () => { for (const handler of stream.handlers) handler({ id: null, name, data: {} }); });
  };

  it('keeps the draft while the dock stands in, and gives it back', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(quiet);
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    await waitFor(() => expect(stream.handlers.length).toBeGreaterThan(0));
    fireEvent.change(composerField(), { target: { value: 'half a thought' } });
    vi.mocked(chatApi.conversation).mockResolvedValue(gated('pending'));
    await emit('message.appended');
    const dock = await screen.findByTestId('approval-dock');
    expect(screen.getByTestId('composer-slot')).toHaveAttribute('hidden');
    await within(dock).findByText('unzip -l a1.zip');
    vi.mocked(chatApi.conversation).mockResolvedValue(gated('succeeded'));
    fireEvent.click(within(dock).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByTestId('approval-dock')).toBeNull());
    expect(screen.getByTestId('composer-slot')).not.toHaveAttribute('hidden');
    expect(composerField().value).toBe('half a thought');
  });

  it('sends the rejection text down the ordinary message path', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(gated('pending'));
    const send = vi.spyOn(chatApi, 'send').mockResolvedValue({ conversationId: 'c1', runId: 'r1', queued: true } as never);
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    const dock = await screen.findByTestId('approval-dock');
    await within(dock).findByText('unzip -l a1.zip');
    fireEvent.change(within(dock).getByPlaceholderText('Tell the agent what to do instead (optional)'), { target: { value: 'list it with tar' } });
    vi.mocked(chatApi.conversation).mockResolvedValue(gated('rejected'));
    fireEvent.click(within(dock).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('keeper', expect.objectContaining({ conversationId: 'c1', text: 'list it with tar' })));
    expect(api.decide).toHaveBeenCalledWith('a1', 'reject', undefined);
  });

  it('leaves when the approval is decided somewhere else', async () => {
    vi.spyOn(chatApi, 'conversation').mockResolvedValue(gated('pending'));
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    await screen.findByTestId('approval-dock');
    expect(screen.getByRole('button', { name: /Approval · shed\.run unzip -l a1\.zip waiting/ })).toBeInTheDocument();
    // Rejected on Telegram: the run resumes, and the stream says so.
    rows.set('a1', row('a1', { state: 'rejected', decidedVia: 'telegram' }));
    vi.mocked(chatApi.conversation).mockResolvedValue(gated('rejected'));
    await emit('run.started');
    await emit('message.appended');
    await waitFor(() => expect(screen.queryByTestId('approval-dock')).toBeNull());
    expect(screen.getByRole('button', { name: /Approval · shed\.run unzip -l a1\.zip rejected/ })).toBeInTheDocument();
    expect(api.decide).not.toHaveBeenCalled();
  });
});
