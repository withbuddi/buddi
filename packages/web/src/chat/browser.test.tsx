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
  // jsdom serves no pictures and has no object URLs; the panel keeps the last
  // frame as bytes, so both are stood up for it.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['picture']) })));
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:last-frame', configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true, writable: true });
  vi.spyOn(api, 'browser').mockResolvedValue(status);
  vi.spyOn(api, 'browserControl').mockResolvedValue(status);
  vi.spyOn(chatApi, 'views').mockResolvedValue({ views: [] });
  vi.spyOn(chatApi, 'conversations').mockResolvedValue({ conversations: [{ id: 'c1', agentId: 'keeper', createdAt: new Date().toISOString(), lastMessageAt: null, opening: null, messageCount: 0 }] });
  vi.spyOn(chatApi, 'conversation').mockResolvedValue({ conversationId: 'c1', agentId: 'keeper', messages: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

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
  it('refreshes the screenshot and keeps the last one when the session ends', async () => {
    vi.useFakeTimers();
    await act(async () => { render(<ChatPage {...props} />); });
    vi.mocked(api.browser).mockResolvedValue({ ...status, page: { ...status.page!, id: 'o2', title: 'Next page' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByAltText('Last browser observation: Next page').getAttribute('src')).toContain('/api/browser/screenshot?v=o2&sessionId=s1');
    // The session ends: the tab stays, with the last screenshot, no longer live.
    vi.mocked(api.browser).mockResolvedValue({ state: 'idle', enabled: true, busy: false, hasScreenshot: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.queryByRole('tab', { name: 'Browser' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Browser (ended)' })).toBeInTheDocument();
    expect(screen.getByTestId('browser-view')).toHaveAttribute('data-live', 'false');
    // The frame it kept, not a request to a route that now has nothing.
    expect(screen.getByAltText('Last browser observation: Next page')).toHaveAttribute('src', 'blob:last-frame');
    // Global controls are gone with the session that justified them.
    expect(screen.queryByRole('button', { name: 'Stop all browsers' })).not.toBeInTheDocument();
    // And history can be put away.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close Browser (ended) tab' })); });
    expect(screen.queryByRole('tab', { name: 'Browser (ended)' })).not.toBeInTheDocument();
  });

  /* A computer session is remembered as a computer session. */
  it('labels the ended tab from the mode last seen', async () => {
    vi.useFakeTimers();
    // A session of its own: the test above dismissed `s1`, and a dismissal is
    // remembered for the conversation exactly as the owner left it.
    vi.mocked(api.browser).mockResolvedValue({ ...status, mode: 'computer', session: { ...status.session!, id: 's2' } });
    await act(async () => { render(<ChatPage {...props} />); });
    expect(screen.getByRole('tab', { name: 'Computer' })).toBeInTheDocument();
    vi.mocked(api.browser).mockResolvedValue({ state: 'idle', enabled: true, busy: false, hasScreenshot: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByRole('tab', { name: 'Computer (ended)' })).toBeInTheDocument();
  });

  /*
   * A decision the owner has to make is never folded into a panel: the row
   * opens the envelope, and the step says it has not happened.
   */
  it('leaves a gated act to its envelope', async () => {
    vi.mocked(chatApi.conversation).mockResolvedValue({ conversationId: 'c1', agentId: 'keeper', messages: [
      { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'g1', name: 'browser.act', input: { action: 'click', target: { name: 'Pay' } } }] },
      { id: 'm2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'g1', name: 'browser.act', ok: true, output: 'awaiting owner approval', approval: { id: 'a1', state: 'pending' } }] },
    ] });
    vi.spyOn(api, 'approval').mockResolvedValue({ id: 'a1', state: 'pending', tool: 'browser.act', permissionScopes: ['conversation'], preview: 'Click Pay', envelope: {}, canonicalArgs: {} } as never);
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    expect(await screen.findByRole('tab', { name: 'Approval' })).toBeInTheDocument();
    // The panel says the step has not happened.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Browser' }), { button: 0 });
    await waitFor(() => expect(screen.getByTestId('browser-view')).toBeInTheDocument());
    expect(within(screen.getByTestId('browser-view')).getByText('Awaiting approval')).toBeInTheDocument();
    // And its row goes to the envelope, not to the panel.
    fireEvent.click(screen.getByRole('button', { name: /Browser · Act/ }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Approval' })).toHaveAttribute('data-state', 'active'));
  });

  /* What the owner typed is not put on the canvas by the inspector either. */
  it('never opens a raw browser call, whatever the canvas is showing', async () => {
    vi.mocked(api.browser).mockResolvedValue({ state: 'idle', enabled: true, busy: false, hasScreenshot: false });
    vi.mocked(chatApi.conversation).mockResolvedValue({ conversationId: 'c1', agentId: 'keeper', messages: [
      { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'f1', name: 'browser.act', input: { action: 'fill', value: 'hunter2', target: { ref: 'e12' } } }] },
      { id: 'm2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'f1', name: 'browser.act', ok: true, output: { observation: { id: 'o1' } } }] },
    ] });
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    fireEvent.click(await screen.findByRole('button', { name: /Browser · Act/ }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Browser · Act/ })).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain('hunter2');
  });

  /*
   * A dozen acts used to be a dozen tabs, and the one panel worth reading was
   * behind all of them. Now they are one panel's list, and the chat row is the
   * way back to a particular step.
   */
  it('folds every act into the one panel, and a chat row goes to its step', async () => {
    vi.mocked(chatApi.conversation).mockResolvedValue({ conversationId: 'c1', agentId: 'keeper', messages: [
      { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'a1', name: 'browser.act', input: { action: 'navigate', url: '/fixture' } }] },
      { id: 'm2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'a1', name: 'browser.act', ok: true, output: { observation: { id: 'o1' } } }] },
      { id: 'm3', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'a2', name: 'browser.act', input: { action: 'click', target: { name: 'Download' } } }] },
      { id: 'm4', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'a2', name: 'browser.act', ok: false, error: 'The page moved on.', output: null }] },
    ] });
    render(<Tooltip.Provider><ChatPage {...props} /></Tooltip.Provider>);
    expect(await screen.findByRole('tab', { name: 'Browser' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Browser · Act/ })).not.toBeInTheDocument();
    expect(screen.getByText('The page moved on.')).toHaveClass('wb-browser-error');
    fireEvent.click(screen.getAllByRole('button', { name: /Browser · Act/ })[0]!);
    await waitFor(() => expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('data-focused', 'true'));
    expect(screen.queryByRole('tab', { name: /Browser · Act/ })).not.toBeInTheDocument();
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
