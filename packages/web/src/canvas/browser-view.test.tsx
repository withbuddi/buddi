/**
 * The Browser panel: one tab for a whole session.
 *
 * What is under test is the panel's own promises — the screen, the steps that
 * were taken on it, and the asking that stops when the session does. The
 * status is the gateway's; the steps are the conversation's own recorded
 * calls.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserStatus } from '../api';
import { BrowserView, BROWSER_POLL_MS, MAX_SCREENSHOT_FAILURES } from './views/BrowserView';
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

  it('draws a gated step as awaiting rather than done', () => {
    const steps = [{ id: 'g1', action: 'click', target: 'Pay', ok: null, awaiting: true, error: null, at: null }];
    render(<BrowserView status={status} error={null} reload={() => {}} steps={steps} live />);
    expect(screen.getByText('Awaiting approval')).toBeInTheDocument();
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

describe('the browser panel', () => {
  it('draws the screen, the steps, and the failure in its own words', () => {
    render(<BrowserView status={status} error={null} reload={() => {}} steps={browserSteps(acted())} live />);
    expect(screen.getByTestId('browser-view')).toHaveAttribute('data-live', 'true');
    // Whose browser this is, and what is on it.
    expect(screen.getByRole('heading', { name: 'Your browser' })).toBeInTheDocument();
    // The address bar, and the step that put it there.
    expect(screen.getAllByText('/statements')).toHaveLength(2);
    expect(screen.getByAltText(/Last browser observation: Statements/)).toBeInTheDocument();
    const steps = screen.getAllByRole('listitem');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveAttribute('data-state', 'ok');
    // The newest step is the one the owner is watching.
    expect(steps[1]).toHaveAttribute('data-newest', 'true');
    expect(steps[0]).not.toHaveAttribute('data-newest');
    const reason = screen.getByText('That link moved after the last observation.');
    expect(reason).toHaveClass('wb-browser-error');
    expect(steps[1]).toHaveAttribute('data-state', 'failed');
  });

  it('marks the step a chat row asked for', () => {
    render(<BrowserView status={status} error={null} reload={() => {}} steps={browserSteps(acted())} live focusedStepId="a1" />);
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('data-focused', 'true');
  });

  it('asks for the last observation again while the session is alive', async () => {
    vi.useFakeTimers();
    const view = render(<BrowserView status={status} error={null} reload={() => {}} steps={[]} live />);
    const src = (): string => screen.getByAltText(/Last browser observation/).getAttribute('src') ?? '';
    expect(src()).toBe('/api/browser/screenshot?v=o1&sessionId=s1');
    await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS); });
    expect(src()).toBe('/api/browser/screenshot?v=o1&sessionId=s1&tick=1');
    await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS); });
    expect(src()).toBe('/api/browser/screenshot?v=o1&sessionId=s1&tick=2');

    /*
     * Ended. The gateway has nothing left: no session, no status, and a
     * screenshot route that answers 404. The panel still shows the frame it
     * kept, the owner's controls are gone, and the asking has stopped.
     */
    view.rerender(<BrowserView status={undefined} error={null} reload={() => {}} steps={[]} live={false} />);
    expect(src()).toBe('blob:last-frame');
    // Still the page it was on, read from the copy this panel kept.
    expect(screen.getByAltText('Last browser observation: Statements')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop all browsers' })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS * 3); });
    expect(src()).toBe('blob:last-frame');
    expect(screen.getByTestId('browser-view')).toHaveAttribute('data-live', 'false');
  });

  /* Nobody is watching a background tab; the owner's machine need not render
     a screenshot every two seconds for it. */
  it('pauses while the page is hidden and gives up on a route that will not answer', async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    render(<BrowserView status={status} error={null} reload={() => {}} steps={[]} live />);
    const src = (): string => screen.getByAltText(/Last browser observation/).getAttribute('src') ?? '';
    await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS * 3); });
    expect(src()).toBe('/api/browser/screenshot?v=o1&sessionId=s1');
    hidden.mockReturnValue(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS); });
    expect(src()).toBe('/api/browser/screenshot?v=o1&sessionId=s1&tick=1');

    // Five refusals in a row and it stops rather than hammering the route.
    for (let attempt = 0; attempt < MAX_SCREENSHOT_FAILURES; attempt += 1) {
      await act(async () => { screen.getByAltText(/Last browser observation/).dispatchEvent(new Event('error')); });
    }
    const stalled = src();
    await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS * 4); });
    expect(src()).toBe(stalled);
    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
  });

  it('keeps the frame it captured even when the route stops serving it', async () => {
    const view = render(<BrowserView status={status} error={null} reload={() => {}} steps={[]} live />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/browser/screenshot?v=o1&sessionId=s1'));
    view.rerender(<BrowserView status={undefined} error={null} reload={() => {}} steps={[]} live={false} />);
    expect(screen.getByAltText(/Last browser observation/)).toHaveAttribute('src', 'blob:last-frame');
  });

  /* No frame ever arrived: say the picture is gone rather than draw a broken
     one from a route that now answers 404. */
  it('shows no picture at all when it never managed to keep one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, blob: async () => new Blob([]) })));
    const view = render(<BrowserView status={status} error={null} reload={() => {}} steps={[]} live />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    view.rerender(<BrowserView status={undefined} error={null} reload={() => {}} steps={[]} live={false} />);
    expect(screen.queryByAltText(/Last browser observation/)).not.toBeInTheDocument();
    expect(screen.getByText(/This session has ended/)).toBeInTheDocument();
  });

  it('says so when nothing has been done on the screen yet', () => {
    render(<BrowserView status={status} error={null} reload={() => {}} steps={[]} live />);
    expect(screen.getByText('No action taken on this screen yet.')).toBeInTheDocument();
  });
});
