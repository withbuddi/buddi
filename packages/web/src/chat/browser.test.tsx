import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, chatApi, type BrowserStatus } from '../api';
import { ChatPage, type ChatPageProps } from './ChatPage';
import { conversationBrowser } from './browser';
import type { ChatConversation } from './types';

vi.mock('./stream', () => ({ openChatStream: () => ({ close() {} }) }));
const status: BrowserStatus = {
  state: 'running', enabled: true, busy: false, hasScreenshot: true,
  session: { id: 's1', agentId: 'keeper', conversationId: 'c1', requestId: 'r1', task: 'Read the fixture', expiresAt: new Date().toISOString(), steps: 1, maxSteps: 80 },
  page: { id: 'o1', url: '/fixture', title: 'Fixture', capturedAt: new Date().toISOString(), tabs: [] },
};
const props: ChatPageProps = {
  timezone: 'UTC', agentId: 'keeper', onSelectAgent: vi.fn(), attention: new Map(),
  agentsInHeader: false, narrow: false,
  agents: { top: [], bottom: [], middle: [{ id: 'keeper', handle: 'keeper', name: 'Keeper', description: '', available: true, roles: [], provider: 'anthropic', model: 'fixture' }] },
};
beforeEach(() => {
  vi.spyOn(api, 'browser').mockResolvedValue(status);
  vi.spyOn(api, 'browserControl').mockResolvedValue(status);
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
  vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [{ id: 'c1', agentId: 'keeper', createdAt: new Date().toISOString(), lastMessageAt: null, opening: null, messageCount: 0 }] });
  vi.spyOn(chatApi, 'conversation').mockResolvedValue({ conversationId: 'c1', agentId: 'keeper', messages: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('conversation browser canvas', () => {
  it('opens small tool results on demand, without creating noisy tabs beforehand', async () => {
    vi.mocked(api.browser).mockResolvedValue({ state: 'idle', enabled: true, busy: false, hasScreenshot: false });
    vi.mocked(chatApi.conversation).mockResolvedValue({ conversationId: 'c1', agentId: 'keeper', messages: [
      { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'tiny', name: 'shed.status', input: { target: 'garden' } }] },
      { id: 'm2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'tiny', name: 'shed.status', ok: true, output: 'All ready' }] },
    ] });
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    const chip = await screen.findByRole('button', { name: /Shed · Status/ });
    expect(screen.queryByRole('tab', { name: /Shed · Status/ })).not.toBeInTheDocument();
    fireEvent.click(chip);
    expect(await screen.findByRole('tab', { name: /Shed · Status/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Raw JSON' }));
    expect(screen.getByText(/"target": "garden"/)).toHaveTextContent('All ready');
  });
  it('restores an approval inside chat after reload and removes it after a decision', async () => {
    vi.mocked(api.browser).mockResolvedValue({ state: 'idle', enabled: true, busy: false, hasScreenshot: false });
    const transcript: ChatConversation = { conversationId: 'c1', agentId: 'keeper', messages: [
      { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'gate', name: 'shed.run', input: { command: 'calculate' } }] },
      { id: 'm2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'gate', name: 'shed.run', ok: true, output: 'awaiting owner approval', approval: { id: 'a1', state: 'pending' } }] },
    ] };
    vi.mocked(chatApi.conversation).mockResolvedValue(transcript);
    const approval = { id: 'a1', state: 'pending', tool: 'shed.run', permissionScopes: ['conversation', 'always'], preview: 'Run calculate', envelope: {}, canonicalArgs: {} } as never;
    vi.spyOn(api, 'approval').mockResolvedValue(approval);
    vi.spyOn(api, 'overview').mockResolvedValue({} as never);
    vi.spyOn(api, 'decide').mockImplementation(async () => {
      const resolved = structuredClone(transcript);
      const block = resolved.messages[1]!.blocks[0]!;
      if (block.type === 'tool_result') { block.approval!.state = 'succeeded'; block.output = '42'; }
      vi.mocked(chatApi.conversation).mockResolvedValue(resolved);
      return { action: { ...approval as object, state: 'succeeded' } as never, execution: { state: 'succeeded' } };
    });
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    const inline = await screen.findByTestId('inline-approval');
    expect(screen.getByTestId('messages')).toContainElement(inline);
    expect(await within(inline).findByRole('button', { name: 'Always: this agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Shed · Run Awaiting approval/ })).toBeInTheDocument();
    fireEvent.click(within(inline).getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(screen.queryByTestId('inline-approval')).not.toBeInTheDocument());
    expect(api.decide).toHaveBeenCalledWith('a1', 'approve', undefined);
  });
  it('opens a matching session beside chat with scoped controls and a full-page link', async () => {
    render(<ChatPage {...props} />);
    expect(await screen.findByRole('tab', { name: 'Browser' })).toHaveAttribute('data-state', 'active');
    expect(await screen.findByAltText('Last browser observation: Fixture')).toHaveAttribute('src', '/api/browser/screenshot?v=o1&sessionId=s1');
    expect(screen.getByRole('link', { name: /Open full browser view/ })).toHaveAttribute('href', '#/browser');
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('takeover', 's1'));
  });
  it.each([
    { agentId: 'elsewhere', conversationId: 'c1' },
    { agentId: 'keeper', conversationId: 'older-thread' },
  ])('never shows another session: %o', async (other) => {
    vi.mocked(api.browser).mockResolvedValue({ ...status, session: { ...status.session!, ...other } });
    await act(async () => { render(<ChatPage {...props} />); });
    expect(screen.queryByRole('tab', { name: 'Browser' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
  it('drops the preview immediately when switching agents', async () => {
    const view = render(<ChatPage {...props} />);
    await screen.findByAltText('Last browser observation: Fixture');
    await act(async () => {
      view.rerender(<ChatPage {...props} agentId="other" />);
    });
    expect(screen.queryByAltText('Last browser observation: Fixture')).not.toBeInTheDocument();
  });
  it('refreshes the screenshot and removes the tab on release', async () => {
    vi.useFakeTimers();
    await act(async () => { render(<ChatPage {...props} />); });
    vi.mocked(api.browser).mockResolvedValue({ ...status, page: { ...status.page!, id: 'o2', title: 'Next page' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByAltText('Last browser observation: Next page')).toHaveAttribute('src', '/api/browser/screenshot?v=o2&sessionId=s1');
    vi.mocked(api.browser).mockResolvedValue({ state: 'idle', enabled: true, busy: false, hasScreenshot: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.queryByRole('tab', { name: 'Browser' })).not.toBeInTheDocument();
  });
  it('uses the existing canvas sheet on narrow screens', async () => {
    render(<ChatPage {...props} narrow canvasOpen />);
    expect(await screen.findByRole('dialog', { name: 'Canvas' })).toBeInTheDocument();
    expect(await screen.findByAltText('Last browser observation: Fixture')).toBeInTheDocument();
  });
  it('keeps other canvas tabs and does not steal focus on each poll', async () => {
    vi.useFakeTimers();
    vi.mocked(chatApi.conversation).mockResolvedValue({ conversationId: 'c1', agentId: 'keeper', messages: [{
      id: 'm1', role: 'assistant', at: new Date().toISOString(), blocks: [{
        type: 'tool_use', id: 'chart1', name: 'canvas.show',
        input: { renderer: 'structured', title: 'Saved chart', data: { value: { apples: 12 } } },
      }],
    }] });
    await act(async () => { render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>); });
    // Start a fresh browser session after the existing result has loaded.
    vi.mocked(api.browser).mockResolvedValue({ ...status, session: { ...status.session!, id: 's2' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByRole('tab', { name: 'Browser' })).toHaveAttribute('data-state', 'active');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Saved chart' }), { button: 0, ctrlKey: false });
    expect(screen.getByRole('tab', { name: 'Saved chart' })).toHaveAttribute('data-state', 'active');
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole('tab', { name: 'Saved chart' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('tab', { name: 'Browser' })).toBeInTheDocument();
  });
  it('does not turn saved tool output into a live browser grant', () => {
    expect(conversationBrowser(undefined, 'keeper', 'c1')).toBeNull();
    expect(conversationBrowser(status, 'keeper', null)).toBeNull();
    expect(conversationBrowser(status, 'keeper', 'c1')).toMatchObject({ source: 'browser', substantial: false });
  });
});
