/**
 * The canvas's tabs per conversation, round-tripped through the server: what
 * one page closes and looks at, the next page reads back — per conversation,
 * and with changes made before the read came back kept on top of it.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatApi, type CanvasTabsState } from '../api';
import { useCanvasTabs } from './canvas-tabs';

let stored: Map<string, CanvasTabsState>;

beforeEach(() => {
  stored = new Map();
  vi.spyOn(chatApi, 'canvasTabs').mockImplementation(async (id) => stored.get(id) ?? { closed: [], touched: {} });
  vi.spyOn(chatApi, 'saveCanvasTabs').mockImplementation(async (id, state) => { stored.set(id, state); return state; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the canvas tabs of a conversation', () => {
  it('round-trips what was closed and looked at, per conversation', async () => {
    const first = renderHook(({ id }) => useCanvasTabs(id, () => 42), { initialProps: { id: 'c1' } });
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    act(() => { first.result.current.close(['t1', 't2']); first.result.current.touch('t3'); });
    expect(first.result.current.closed).toEqual(['t1', 't2']);
    act(() => first.result.current.reopen(['t2']));
    // Written once the changes settle; unmounting flushes what is waiting.
    first.unmount();
    expect(stored.get('c1')).toEqual({ closed: ['t1'], touched: { t3: 42 } });

    const again = renderHook(({ id }) => useCanvasTabs(id), { initialProps: { id: 'c1' } });
    expect(again.result.current.ready).toBe(false);
    await waitFor(() => expect(again.result.current.ready).toBe(true));
    expect(again.result.current.closed).toEqual(['t1']);
    expect(again.result.current.touched).toEqual({ t3: 42 });

    again.rerender({ id: 'c2' });
    await waitFor(() => expect(again.result.current.ready).toBe(true));
    expect(again.result.current.closed).toEqual([]);
  });

  it('keeps a change made before the stored state arrived', async () => {
    stored.set('c1', { closed: ['old'], touched: {} });
    let release: () => void = () => {};
    vi.mocked(chatApi.canvasTabs).mockImplementation(() => new Promise((resolve) => { release = () => resolve(stored.get('c1')!); }));
    const hook = renderHook(() => useCanvasTabs('c1', () => 7));
    await waitFor(() => expect(chatApi.canvasTabs).toHaveBeenCalled());
    act(() => hook.result.current.touch('t9'));
    await act(async () => { release(); });
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(hook.result.current.closed).toEqual(['old']);
    expect(hook.result.current.touched).toEqual({ t9: 7 });
    await waitFor(() => expect(stored.get('c1')).toEqual({ closed: ['old'], touched: { t9: 7 } }));
  });

  it('opens with nothing closed when the server cannot be read', async () => {
    vi.mocked(chatApi.canvasTabs).mockRejectedValue(new Error('offline'));
    const hook = renderHook(() => useCanvasTabs('c1'));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(hook.result.current.closed).toEqual([]);
  });
});
