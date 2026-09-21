/**
 * The Browser panel: one tab for a whole session.
 *
 * What is under test is the panel's own promises — the screen, the steps that
 * were taken on it, and the asking that stops when the session does. The
 * status is the gateway's; the steps are the conversation's own recorded
 * calls.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserStatus } from '../api';
import { BrowserView, BROWSER_POLL_MS } from './views/BrowserView';
import { browserSteps, BROWSER_TOOLS } from '../chat/browser';
import { renderablesFrom } from './renderables';
import type { ChatMessage } from '../chat/types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

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
      { id: 'a1', action: 'navigate', target: '/statements', ok: true, error: null, at: '2026-09-21T09:00:00Z' },
      { id: 'a2', action: 'click', target: 'Download', ok: false, error: 'That link moved after the last observation.', at: '2026-09-21T09:00:02Z' },
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
    expect(browserSteps(open)).toEqual([{ id: 'a1', action: 'navigate', target: '/statements', ok: null, error: null, at: '2026-09-21T09:00:00Z' }]);
  });
});

describe('acts fold into the panel', () => {
  it('opens no tab of its own while the panel is on the canvas', () => {
    expect(renderablesFrom({ messages: acted(), descriptors: [], folded: BROWSER_TOOLS })).toEqual([]);
  });

  it('falls back to a tab each when no session is alive', () => {
    const tabs = renderablesFrom({ messages: acted(), descriptors: [] });
    expect(tabs.map((tab) => tab.id)).toEqual(['a2']);
    expect(tabs[0]).toMatchObject({ tone: 'critical', source: 'fallback' });
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
    expect(src()).toBe('/api/browser/screenshot?v=o1&sessionId=s1&t=1');
    await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS); });
    expect(src()).toBe('/api/browser/screenshot?v=o1&sessionId=s1&t=2');

    // Ended: the last picture is the last picture, and the asking stops.
    view.rerender(<BrowserView status={status} error={null} reload={() => {}} steps={[]} live={false} />);
    const settled = src();
    await act(async () => { await vi.advanceTimersByTimeAsync(BROWSER_POLL_MS * 3); });
    expect(src()).toBe(settled);
    expect(screen.getByTestId('browser-view')).toHaveAttribute('data-live', 'false');
  });

  it('says so when nothing has been done on the screen yet', () => {
    render(<BrowserView status={status} error={null} reload={() => {}} steps={[]} live />);
    expect(screen.getByText('No action taken on this screen yet.')).toBeInTheDocument();
  });
});
