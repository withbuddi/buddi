/**
 * The Page tab: one tab for the page an agent looks at (docs/browser.md).
 *
 * What is under test is the tab's own promises — who looks where in one line,
 * the picture, Take over and Stop, the paused and closed states, and the
 * asking that stops when the page does. The steps read from the conversation
 * still fold the agent's calls into the tab; the tab no longer lists them.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type BrowserStatus } from '../api';
import { BrowserMenu, BrowserView, BROWSER_POLL_MS, MAX_SCREENSHOT_FAILURES } from './views/BrowserView';

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), csrfToken: () => 'c', api: { session: vi.fn(async () => ({ platform: 'darwin' })), browserControl: vi.fn(), browserPin: vi.fn(), browserSettings: vi.fn(async () => ({})) } }));
import { browserSteps, stepFor, BROWSER_TOOLS } from '../chat/browser';
import { inspectToolCall, renderablesFrom } from './renderables';
import type { ChatMessage } from '../chat/types';

/**
 * jsdom serves no pictures and has no object URLs. The panel keeps the last
 * frame as bytes, so both are stood up here: the fetch that brings the frame
 * back, and the URL the page hands to an `img`.
 */
function keepsFrames(): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['picture']) })));
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:last-frame', configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true, writable: true });
}

beforeEach(keepsFrames);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const status: BrowserStatus = {
  mode: 'extension',
  state: 'running', enabled: true, busy: false, hasScreenshot: true,
  session: { id: 's1', agentId: 'keeper', conversationId: 'c1', requestId: 'r1', task: 'Sign in', expiresAt: new Date().toISOString(), steps: 2, maxSteps: 80 },
  page: { id: 'o1', url: '/statements', title: 'Statements', capturedAt: new Date().toISOString(), tabs: [] },
};

/** Two acts: one that worked, one that did not. */
function acted(): ChatMessage[] {
  return [
    { id: 'm1', role: 'assistant', at: '2026-09-21T09:00:00Z', blocks: [
      { type: 'tool_use', id: 'a1', name: 'browser.act', input: { action: 'navigate', url: '/statements' } },
    ] },
    { id: 'm2', role: 'user', at: '2026-09-21T09:00:01Z', blocks: [
      { type: 'tool_result', toolUseId: 'a1', name: 'browser.act', ok: true, output: { observation: { id: 'o1' } } },
    ] },
    { id: 'm3', role: 'assistant', at: '2026-09-21T09:00:02Z', blocks: [
      { type: 'tool_use', id: 'a2', name: 'browser.act', input: { action: 'click', target: { name: 'Download' } } },
    ] },
    { id: 'm4', role: 'user', at: '2026-09-21T09:00:03Z', blocks: [
      { type: 'tool_result', toolUseId: 'a2', name: 'browser.act', ok: false, error: { message: 'That link moved after the last observation.' }, output: null },
    ] },
  ];
}

describe('steps read from the conversation', () => {
  it('summarises each act with where it went and how it ended', () => {
    expect(browserSteps(acted())).toEqual([
      { id: 'a1', action: 'navigate', target: '/statements', ok: true, awaiting: false, error: null, at: '2026-09-21T09:00:00Z' },
      { id: 'a2', action: 'click', target: 'Download', ok: false, awaiting: false, error: 'That link moved after the last observation.', at: '2026-09-21T09:00:02Z' },
    ]);
  });

  it('never puts what was typed into a field on the screen', () => {
    const typing: ChatMessage[] = [{ id: 'm', role: 'assistant', at: null as never, blocks: [
      { type: 'tool_use', id: 'f1', name: 'browser.act', input: { action: 'fill', value: 'hunter2', target: { ref: 'e12' } } },
    ] }];
    const [step] = browserSteps(typing);
    expect(step).toMatchObject({ action: 'fill', target: 'e12', ok: null });
    expect(JSON.stringify(step)).not.toContain('hunter2');
  });

  it('shows a call still out as working', () => {
    const open = acted().slice(0, 1);
    expect(browserSteps(open)).toEqual([{ id: 'a1', action: 'navigate', target: '/statements', ok: null, awaiting: false, error: null, at: '2026-09-21T09:00:00Z' }]);
  });

  /*
   * A gated act has not happened. Calling it "Done" on the panel, and letting
   * its chat row scroll to a step instead of opening the envelope, would tell
   * the owner a decision they have not made was made for them.
   */
  it('shows a call waiting on the owner as awaiting, and sends its row to the envelope', () => {
    const gated: ChatMessage[] = [
      { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'g1', name: 'browser.act', input: { action: 'click', target: { name: 'Pay' } } }] },
      { id: 'm2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'g1', name: 'browser.act', ok: true, output: 'awaiting owner approval', approval: { id: 'x1', state: 'pending' } }] },
    ];
    expect(browserSteps(gated)[0]).toMatchObject({ awaiting: true, ok: null, error: null });
    expect(stepFor(gated, 'g1')).toBeNull();
    // Decided, it becomes an ordinary step again.
    const decided = structuredClone(gated);
    const result = decided[1]!.blocks[0]!;
    if (result.type === 'tool_result') result.approval = { id: 'x1', state: 'succeeded' };
    expect(browserSteps(decided)[0]).toMatchObject({ awaiting: false, ok: true });
    expect(stepFor(decided, 'g1')).toBe('g1');
    expect(stepFor(decided, 'nothing-like-it')).toBeNull();
  });

});

describe('acts fold into the panel', () => {
  it('opens no tab of its own while the panel is on the canvas', () => {
    expect(renderablesFrom({ messages: acted(), descriptors: [], folded: BROWSER_TOOLS })).toEqual([]);
  });

  /*
   * Today's behaviour, unchanged: the failure keeps its tab because a reason
   * has to be readable in full somewhere, and the successful act earns none
   * because `{observation: …}` is not worth a panel.
   */
  it('falls back to today"s behaviour when no session is alive', () => {
    const tabs = renderablesFrom({ messages: acted(), descriptors: [] });
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ id: 'a2', tone: 'critical', source: 'fallback' });
  });

  /*
   * The inspector is the other way a call's arguments could reach the canvas.
   * The page names the tools whose arguments carry what the owner typed; this
   * holds the typed strings back whatever else is in there.
   */
  it('withholds what was typed when a call is inspected', () => {
    const typing: ChatMessage[] = [{ id: 'm', role: 'assistant', at: '', blocks: [
      { type: 'tool_use', id: 'f1', name: 'browser.act', input: { action: 'fill', value: 'hunter2', target: { ref: 'e12', text: 'also typed' } } },
    ] }];
    const inspected = inspectToolCall(typing, 'f1', { redactInputOf: BROWSER_TOOLS });
    expect(JSON.stringify(inspected?.props)).not.toContain('hunter2');
    expect(JSON.stringify(inspected?.props)).not.toContain('also typed');
    expect(inspected?.props).toMatchObject({ value: { input: { action: 'fill', target: { ref: 'e12' } } } });
    // Another tool's arguments are its own business and are drawn whole.
    const ordinary: ChatMessage[] = [{ id: 'm', role: 'assistant', at: '', blocks: [
      { type: 'tool_use', id: 's1', name: 'shed.write', input: { value: 'kept' } },
    ] }];
    expect(inspectToolCall(ordinary, 's1', { redactInputOf: BROWSER_TOOLS })?.props).toMatchObject({ value: { input: { value: 'kept' } } });
  });

  it('never folds away a decision waiting on the owner', () => {
    const gated: ChatMessage[] = [
      { id: 'm1', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 'g1', name: 'browser.act', input: { action: 'click' } }] },
      { id: 'm2', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 'g1', name: 'browser.act', ok: true, output: 'awaiting owner approval', approval: { id: 'x1', state: 'pending' } }] },
    ];
    expect(renderablesFrom({ messages: gated, descriptors: [], folded: BROWSER_TOOLS })).toMatchObject([{ source: 'approval' }]);
  });
});

describe('the Page tab', () => {
  const card = { kind: 'sign-in' as const, question: 'Amazon needs your sign-in', options: [] };
  it('says who looks where in one quiet line, with Stop and Take over, and no steps or counters', () => {
    render(<BrowserView status={{ ...status, route: 'own', page: { ...status.page!, url: 'https://www.amazon.com/cart', title: 'Your cart' } }} error={null} reload={() => {}} live agentName="Home Manager" />);
    expect(screen.getByTestId('browser-view')).toHaveAttribute('data-live', 'true');
    expect(screen.getByText('Your cart')).toBeInTheDocument();
    expect(screen.getByText('Looking at amazon.com · in buddi’s browser')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take over' })).not.toHaveAttribute('data-variant', 'accent');
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.queryByText(/steps|observation/i)).not.toBeInTheDocument();
  });

  it('names your Chrome and an app when the route is not the own browser', () => {
    const view = render(<BrowserView status={{ ...status, route: 'chrome', page: { ...status.page!, url: 'https://amazon.com/cart' } }} error={null} reload={() => {}} live />);
    expect(screen.getByText('Looking at amazon.com · in your Chrome · background tab')).toBeInTheDocument();
    view.rerender(<BrowserView status={{ ...status, route: 'apps', page: { ...status.page!, url: 'app://x', appId: 'com.apple.iWork.Numbers' } }} error={null} reload={() => {}} live />);
    expect(screen.getByText('Working in Numbers · its own window')).toBeInTheDocument();
  });

  it('waits for the owner with Take over as the accent', () => {
    render(<BrowserView status={{ ...status, needsOwner: card }} error={null} reload={() => {}} live />);
    expect(screen.getByText('Waiting for you · it asks for your sign-in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take over' })).toHaveAttribute('data-variant', 'accent');
  });

  it('stops only its own page; the overflow stops everyone, for an hour or until the owner says', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(api.browserControl).mockResolvedValue(status);
    render(<><BrowserView status={status} error={null} reload={() => {}} live /><BrowserMenu status={{ ...status, settings: { showWindow: false, stopExpiryMinutes: 60 } as never }} reload={() => {}} /></>);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('stop', 's1'));
    await user.click(screen.getByRole('button', { name: 'More for this page' }));
    await user.click(await screen.findByRole('menuitem', { name: /Until I say/ }));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('stop', undefined, { forever: true }));
    await user.click(screen.getByRole('button', { name: 'More for this page' }));
    await user.click(await screen.findByRole('menuitem', { name: /Show the window/ }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith({ showWindow: true }));
  }, 60_000);

  it('takes over in the frame: You have the page, nothing typed is kept, Keyboard and Give it back', async () => {
    let state: BrowserStatus = status;
    vi.mocked(api.browserControl).mockImplementation(async (action) => {
      if (action === 'takeover') { state = { ...status, state: 'paused' }; return { ...state, hand: true }; }
      state = status; return status;
    });
    const view = render(<BrowserView status={state} error={null} reload={() => view.rerender(<BrowserView status={state} error={null} reload={() => {}} live agentName="Home Manager" />)} live agentName="Home Manager" />);
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('takeover', 's1'));
    view.rerender(<BrowserView status={state} error={null} reload={() => {}} live agentName="Home Manager" />);
    expect(await screen.findByText(/^You have the page/)).toBeInTheDocument();
    expect(screen.getByText('Nothing you type here is kept. Home Manager carries on when you give it back.')).toBeInTheDocument();
    expect(screen.getByTestId('remote-hand')).toHaveAttribute('data-bare', 'true');
    expect(screen.getByRole('button', { name: 'Keyboard' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Give it back' }));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('resume', 's1'));
  });

  it('offers buddi’s browser when your Chrome is not there to take over', async () => {
    vi.mocked(api.browserControl).mockResolvedValue({ ...status, hand: false, handReason: 'browser-offline' });
    vi.mocked(api.browserPin).mockResolvedValue(status);
    render(<BrowserView status={{ ...status, route: 'chrome' }} error={null} reload={() => {}} live />);
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    expect(await screen.findByText('Your Chrome isn’t connected.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use buddi’s browser' }));
    await waitFor(() => expect(api.browserPin).toHaveBeenCalledWith('c1', 'own'));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('release', 's1'));
  });

  it('paused: no page, Resume, and when agents look again by themselves', async () => {
    vi.mocked(api.browserControl).mockResolvedValue(status);
    render(<BrowserView status={undefined} error={null} reload={() => {}} live={false} timezone="UTC" paused={{ at: '2026-10-03T10:12:00Z', until: '2026-10-03T11:12:00Z' }} />);
    expect(screen.getByText('Browsing is paused')).toBeInTheDocument();
    expect(screen.getByText(/^By you at .* · until /)).toBeInTheDocument();
    expect(screen.getByText(/No page is open\. Agents look again when you resume, or by themselves at/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('resume'));
  });

  it('asks for the last picture again while the page is open, and keeps the last frame once it closes', async () => {
    vi.useFakeTimers();
    const view = render(<BrowserView status={status} error={null} reload={() => {}} live agentName="Keeper" />);
    const src = (): string => screen.getByAltText(/What Keeper sees/).getAttribute('src') ?? '';
    expect(src()).toBe('/api/browser/screenshot?v=o1&sessionId=s1');
    await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS); });
    expect(src()).toBe('/api/browser/screenshot?v=o1&sessionId=s1&tick=1');
    view.rerender(<BrowserView status={undefined} error={null} reload={() => {}} live={false} agentName="Keeper" />);
    expect(src()).toBe('blob:last-frame');
    expect(screen.getByText('The page is closed. This is the last thing it showed.')).toBeInTheDocument();
    expect(screen.getByText(/^Keeper looked at .* · done/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS * 3); });
    expect(src()).toBe('blob:last-frame');
    expect(screen.getByTestId('browser-view')).toHaveAttribute('data-live', 'false');
  });

  it('pauses while the page is hidden and gives up on a route that will not answer', async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    render(<BrowserView status={status} error={null} reload={() => {}} live agentName="Keeper" />);
    const src = (): string => screen.getByAltText(/What Keeper sees/).getAttribute('src') ?? '';
    await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS * 3); });
    expect(src()).toBe('/api/browser/screenshot?v=o1&sessionId=s1');
    hidden.mockReturnValue(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS); });
    expect(src()).toBe('/api/browser/screenshot?v=o1&sessionId=s1&tick=1');
    for (let attempt = 0; attempt < MAX_SCREENSHOT_FAILURES; attempt += 1) {
      await act(async () => { screen.getByAltText(/What Keeper sees/).dispatchEvent(new Event('error')); });
    }
    const stalled = src();
    await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS * 4); });
    expect(src()).toBe(stalled);
    expect(screen.getByText(/The newest picture didn’t load/)).toBeInTheDocument();
  });

  it('shows no picture at all when it never managed to keep one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, blob: async () => new Blob([]) })));
    const view = render(<BrowserView status={status} error={null} reload={() => {}} live />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    view.rerender(<BrowserView status={undefined} error={null} reload={() => {}} live={false} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('No picture of this page was kept.')).toBeInTheDocument();
  });
});
