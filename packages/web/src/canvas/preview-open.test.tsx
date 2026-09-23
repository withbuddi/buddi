/**
 * A preview that opens by itself, and a page that is reloaded after a write.
 *
 * Both are read from the *shape* of results — a preview descriptor, an
 * `awaiting` process, a `diff` — never from a tool's name: the canvas knows
 * no plugin.
 */
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { ChatMessage } from '../chat/types';
import { resolvePreview } from './resolve';
import { awaitingPreviews, renderablesFrom } from './renderables';
import { useServedPreviews } from './served';
import type { PreviewProps, ViewDescriptor } from './types';
import { PreviewView } from './views/PreviewView';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const START: ViewDescriptor = {
  tool: 'demo.start',
  renderer: 'preview',
  title: 'Preview',
  map: { src: 'preview', awaiting: 'awaiting', title: { path: 'name' }, port: 'port', reloadsItself: 'reloadsItself' },
};
const SHOW: ViewDescriptor = {
  tool: 'demo.show',
  renderer: 'preview',
  title: 'Preview',
  map: { src: 'preview', title: { path: 'name' } },
};
const WRITE: ViewDescriptor = { tool: 'demo.write', renderer: 'diff', map: { diff: 'diff' } };
const descriptors = [START, SHOW, WRITE];

const AT = '2026-09-23T10:00:00.000Z';

function result(id: string, name: string, output: unknown, ok = true): ChatMessage[] {
  return [
    { role: 'assistant', at: AT, blocks: [{ type: 'tool_use', id, name, input: {} }] },
    { role: 'user', at: AT, blocks: [{ type: 'tool_result', toolUseId: id, name, ok, output }] },
  ] as unknown as ChatMessage[];
}

const listening = { name: 'web', port: 5173, preview: '/preview/demo/web/', awaiting: null, reloadsItself: false };
const notYet = { name: 'web', port: null, preview: null, awaiting: '/preview/demo/web/', reloadsItself: true };

describe('a started process', () => {
  it('reads the process it will be, and whether it reloads itself', () => {
    const props = resolvePreview(notYet, START.map as never);
    expect(props.target).toBeNull();
    expect(props.awaiting).toEqual({ plugin: 'demo', name: 'web' });
    expect(props.reloadsItself).toBe(true);
    // Only a real `true` stops the reload a static page needs.
    expect(resolvePreview({ ...notYet, reloadsItself: 'true' }, START.map as never).reloadsItself).toBe(false);
  });

  it('draws as a preview at once when it is already listening, and takes the screen', () => {
    const [tab] = renderablesFrom({ messages: result('s1', 'demo.start', listening), descriptors });
    expect(tab).toMatchObject({ id: 's1', renderer: 'preview', substantial: true });
    expect((tab!.props as PreviewProps).target).toEqual({ plugin: 'demo', name: 'web' });
  });

  it('draws no tab while it is not listening, and one once the dashboard says it is served', () => {
    const messages = result('s1', 'demo.start', notYet);
    expect(renderablesFrom({ messages, descriptors })).toEqual([]);
    expect(awaitingPreviews({ messages, descriptors })).toEqual([{ plugin: 'demo', name: 'web', at: AT }]);

    const [tab] = renderablesFrom({ messages, descriptors, served: new Set(['demo/web']) });
    expect(tab).toMatchObject({ id: 's1', renderer: 'preview', substantial: true });
    expect((tab!.props as PreviewProps).target).toEqual({ plugin: 'demo', name: 'web' });
    // Another process being served opens nothing here.
    expect(renderablesFrom({ messages, descriptors, served: new Set(['demo/api']) })).toEqual([]);
  });

  it('draws no box for a preview that names nothing, and fails as a failure', () => {
    expect(renderablesFrom({ messages: result('s1', 'demo.show', { name: 'web', preview: null }), descriptors })).toEqual([]);
    const [failed] = renderablesFrom({ messages: result('s1', 'demo.start', 'refused', false), descriptors });
    expect(failed).toMatchObject({ tone: 'critical' });
  });

  it('keeps one tab per process: a later preview of it replaces the earlier', () => {
    const messages = [
      ...result('s1', 'demo.start', listening),
      ...result('p1', 'demo.show', { name: 'web', preview: '/preview/demo/web/' }),
    ];
    expect(renderablesFrom({ messages, descriptors }).map((item) => item.id)).toEqual(['p1']);
  });

  it('tells every preview how many files have changed since', () => {
    const messages = [
      ...result('s1', 'demo.start', listening),
      ...result('w1', 'demo.write', { path: 'index.html', diff: '+<h1>hi</h1>' }),
      ...result('w2', 'demo.write', { path: 'index.html', diff: '-<h1>hi</h1>\n+<h1>hello</h1>' }),
    ];
    const preview = renderablesFrom({ messages, descriptors }).find((item) => item.renderer === 'preview');
    expect((preview!.props as PreviewProps).changes).toBe(2);
  });
});

describe('waiting for a preview to be served', () => {
  it('asks until it is served, then stops, and calls it news', async () => {
    const answers = [false, false, true];
    const check = vi.fn(async () => ({ ok: answers.shift() ?? true }));
    const awaiting = [{ plugin: 'demo', name: 'web', at: new Date().toISOString() }];
    const { result: hook } = renderHook(() => useServedPreviews(awaiting, 'c1', { check, everyMs: 5 }));
    await waitFor(() => expect(hook.current.served.has('demo/web')).toBe(true));
    expect(hook.current.live.has('demo/web')).toBe(true);
    const calls = check.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(check.mock.calls.length).toBe(calls);
  });

  it('asks about an old one once, and does not call it news', async () => {
    const check = vi.fn(async () => ({ ok: false }));
    const awaiting = [{ plugin: 'demo', name: 'web', at: '2026-01-01T00:00:00.000Z' }];
    renderHook(() => useServedPreviews(awaiting, 'c1', { check, everyMs: 5 }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(check).toHaveBeenCalledTimes(1);

    const served = vi.fn(async () => ({ ok: true }));
    const { result: hook } = renderHook(() => useServedPreviews(awaiting, 'c2', { check: served, everyMs: 5 }));
    await waitFor(() => expect(hook.current.served.has('demo/web')).toBe(true));
    expect(hook.current.live.size).toBe(0);
  });
});

describe('reloading the frame after a change', () => {
  const TICKETED = 'http://127.0.0.1:4318/preview/demo/web/?ticket=abc';
  const base: PreviewProps = {
    target: { plugin: 'demo', name: 'web' },
    title: 'web',
    output: null,
    port: null,
    awaiting: null,
    reloadsItself: false,
    changes: 3,
  };

  it('reloads a page that does not reload itself, on its clean URL', async () => {
    vi.spyOn(api, 'previewLink').mockResolvedValue({ url: TICKETED });
    const { rerender } = render(<PreviewView props={base} />);
    await waitFor(() => expect(screen.getByTitle('web')).toHaveAttribute('src', TICKETED));
    const first = screen.getByTitle('web');
    // The same count again is not a change.
    rerender(<PreviewView props={{ ...base }} />);
    expect(screen.getByTitle('web')).toBe(first);
    act(() => { rerender(<PreviewView props={{ ...base, changes: 4 }} />); });
    const reloaded = screen.getByTitle('web');
    expect(reloaded).not.toBe(first);
    // The ticket was spent on the first load; the cookie answers for this.
    expect(reloaded).toHaveAttribute('src', 'http://127.0.0.1:4318/preview/demo/web/');
  });

  it('leaves a hot-reloading page to reload itself', async () => {
    vi.spyOn(api, 'previewLink').mockResolvedValue({ url: TICKETED });
    const props = { ...base, reloadsItself: true };
    const { rerender } = render(<PreviewView props={props} />);
    await waitFor(() => expect(screen.getByTitle('web')).toBeInTheDocument());
    const first = screen.getByTitle('web');
    act(() => { rerender(<PreviewView props={{ ...props, changes: 5 }} />); });
    expect(screen.getByTitle('web')).toBe(first);
    expect(first).toHaveAttribute('src', TICKETED);
  });
});
