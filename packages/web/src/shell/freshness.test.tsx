/**
 * A new dashboard build: asked for again when the live stream comes back, and
 * reloaded onto by itself only when the tab is hidden, or the owner is idle
 * with nothing in progress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  AUTO_RELOAD_KEY,
  IDLE_MS,
  SAFE_RECHECK_MS,
  announceReconnect,
  safeToReload,
  setLastActivityForTests,
  somethingInProgress,
  useAutoReload,
  useCheckOnReconnect,
} from './freshness';

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  window.sessionStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A page the owner left alone for two minutes. */
const idle = (): void => setLastActivityForTests(Date.now() - 2 * IDLE_MS);

describe('the build check', () => {
  it('asks again right after the live stream reconnects', () => {
    const check = vi.fn();
    renderHook(() => useCheckOnReconnect(check));
    expect(check).not.toHaveBeenCalled();
    act(() => announceReconnect());
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe('the automatic reload', () => {
  it('reloads at once when the tab is hidden, and only once per served build', () => {
    visibility = 'hidden';
    const reload = vi.fn();
    const first = renderHook(() => useAutoReload('new', reload, 'old'));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(AUTO_RELOAD_KEY)).toBe('new');
    first.unmount();
    // The page came back on the old bundle (a cache): it does not loop.
    renderHook(() => useAutoReload('new', reload, 'old'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the build is the same, or unknown', () => {
    visibility = 'hidden';
    const reload = vi.fn();
    renderHook(() => useAutoReload('same', reload, 'same'));
    renderHook(() => useAutoReload(undefined, reload, 'same'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('waits while a composer has text, then reloads once it is empty and the owner idle', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div class="wb-composer" data-busy="true"><textarea>half a thought</textarea></div>';
    idle();
    const reload = vi.fn();
    renderHook(() => useAutoReload('new', reload, 'old'));
    act(() => { vi.advanceTimersByTime(3 * SAFE_RECHECK_MS); });
    expect(reload).not.toHaveBeenCalled();
    document.querySelector('.wb-composer')!.removeAttribute('data-busy');
    idle();
    act(() => { vi.advanceTimersByTime(SAFE_RECHECK_MS); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads while a recording runs or a dialog is open', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div class="wb-listening" role="group" aria-label="Recording"></div>';
    idle();
    const reload = vi.fn();
    renderHook(() => useAutoReload('new', reload, 'old'));
    act(() => { vi.advanceTimersByTime(3 * SAFE_RECHECK_MS); });
    expect(reload).not.toHaveBeenCalled();
    document.body.innerHTML = '<div role="dialog" aria-label="Add a calendar"></div>';
    idle();
    act(() => { vi.advanceTimersByTime(3 * SAFE_RECHECK_MS); });
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps the page while the owner is active, even with nothing in progress', () => {
    vi.useFakeTimers();
    setLastActivityForTests(Date.now());
    const reload = vi.fn();
    renderHook(() => useAutoReload('new', reload, 'old'));
    act(() => { vi.advanceTimersByTime(SAFE_RECHECK_MS); });
    expect(reload).not.toHaveBeenCalled();
  });

  it('says what counts as in progress', () => {
    expect(somethingInProgress()).toBe(false);
    document.body.innerHTML = '<div class="wb-composer"></div>';
    expect(somethingInProgress()).toBe(false);
    document.body.innerHTML = '<div class="wb-composer" data-busy="true"></div>';
    expect(somethingInProgress()).toBe(true);
    expect(safeToReload({ hidden: true, idleMs: 0, busy: true })).toBe(true);
    expect(safeToReload({ hidden: false, idleMs: IDLE_MS, busy: false })).toBe(true);
    expect(safeToReload({ hidden: false, idleMs: IDLE_MS - 1, busy: false })).toBe(false);
    expect(safeToReload({ hidden: false, idleMs: IDLE_MS, busy: true })).toBe(false);
  });
});
