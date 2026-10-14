/**
 * A new dashboard build: asked for again when the live stream comes back, and
 * reloaded onto by itself only when the tab is hidden, or the owner is idle
 * with nothing in progress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { OFFICE_MIME } from '@buddi/core/office-files';
import { setDraft } from '../canvas/file-drafts';
import { ArtifactPreview } from '../chat/ArtifactPreview';
import {
  AUTO_RELOAD_KEY,
  UPDATE_CONFIRMED,
  confirmUpdate,
  isChunkLoadError,
  loadChunk,
  updateDeps,
  watchChunkFailures,
  IDLE_MS,
  SAFE_RECHECK_MS,
  announceReconnect,
  safeToReload,
  setLastActivityForTests,
  somethingInProgress,
  useAutoReload,
  useCheckOnReconnect,
} from './freshness';

// The Word viewer's chunk, failing to load: deleted by an update, or a blip.
vi.mock('../chat/office/docx', () => { throw new TypeError('Failed to fetch dynamically imported module: ./assets/docx-OLD.js'); });

let visibility: DocumentVisibilityState = 'visible';
const realUpdateDeps = { ...updateDeps };

beforeEach(() => {
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  window.sessionStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  setDraft('tab-1', null);
  Object.assign(updateDeps, realUpdateDeps);
  vi.unstubAllGlobals();
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
    document.body.innerHTML = '';
    // A file edited on the canvas and not saved is lost by a reload too.
    setDraft('tab-1', { fileId: 'f1', base: 1, baseText: 'a', text: 'ab' });
    expect(somethingInProgress()).toBe(true);
    setDraft('tab-1', null);
    expect(safeToReload({ hidden: true, idleMs: 0, busy: true })).toBe(true);
    expect(safeToReload({ hidden: false, idleMs: IDLE_MS, busy: false })).toBe(true);
    expect(safeToReload({ hidden: false, idleMs: IDLE_MS - 1, busy: false })).toBe(false);
    expect(safeToReload({ hidden: false, idleMs: IDLE_MS, busy: true })).toBe(false);
  });
});

describe('a part of the page that would not load', () => {
  /** The gateway serves `served`; this page is build `own`. */
  function serving(served: string | undefined, own = 'old'): ReturnType<typeof vi.fn> {
    const reload = vi.fn();
    updateDeps.served = vi.fn(async () => served);
    updateDeps.own = () => own;
    updateDeps.reload = reload;
    return reload;
  }

  it('is an ordinary failure while the same build is served: no reload, the error as it was', async () => {
    const reload = serving('old');
    const blip = new TypeError('Failed to fetch dynamically imported module');
    const error = await loadChunk(() => Promise.reject(blip)).catch((e: unknown) => e);
    expect(error).toBe(blip);
    expect(isChunkLoadError(error)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('is an ordinary failure when the gateway cannot say which build it serves', async () => {
    const reload = serving(undefined);
    updateDeps.served = vi.fn(async () => { throw new Error('offline'); });
    expect(await confirmUpdate()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('is an update when another build is served: one reload, never a second for that build', async () => {
    const reload = serving('new');
    const error = await loadChunk(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module'))).catch((e: unknown) => e);
    expect(isChunkLoadError(error)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(AUTO_RELOAD_KEY)).toBe('new');
    // The reloaded page still fails (a cache kept the old bundle): it says updated, and does not loop.
    expect(await confirmUpdate()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads at once, not after a minute idle: the page is already broken', async () => {
    setLastActivityForTests(Date.now());
    const reload = serving('new');
    await confirmUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves it to the avatar’s notice while something is in progress, and tells the shell to read the version', async () => {
    document.body.innerHTML = '<div class="wb-composer" data-busy="true"></div>';
    const reload = serving('new');
    const told = vi.fn();
    window.addEventListener(UPDATE_CONFIRMED, told);
    expect(await confirmUpdate()).toBe(true);
    window.removeEventListener(UPDATE_CONFIRMED, told);
    expect(reload).not.toHaveBeenCalled();
    expect(told).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(AUTO_RELOAD_KEY)).toBeNull();
    // The shell's version read is what the Rail's "Reload to update" comes from.
    const check = vi.fn();
    renderHook(() => useCheckOnReconnect(check));
    act(() => { window.dispatchEvent(new Event(UPDATE_CONFIRMED)); });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('asks on Vite’s own report of a chunk it could not load, once for several at a time', async () => {
    const reload = serving('new');
    const stop = watchChunkFailures();
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    stop();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(updateDeps.served).toHaveBeenCalledTimes(1);
  });

  it('the Office preview says buddi was updated when that is why its viewer would not load', async () => {
    window.sessionStorage.setItem(AUTO_RELOAD_KEY, 'new');
    serving('new');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0x50, 0x4b]), { status: 200 })));
    render(<ArtifactPreview artifactId="a1" filename="Letter.docx" mime={OFFICE_MIME.docx} family="text" />);
    expect(await screen.findByText('buddi was updated. Reload to see the preview.')).toBeInTheDocument();
    expect(screen.queryByText(/Download the file/)).toBeNull();
  });

  it('and to download the file when the same build is served', async () => {
    const reload = serving('old');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0x50, 0x4b]), { status: 200 })));
    render(<ArtifactPreview artifactId="a2" filename="Letter.docx" mime={OFFICE_MIME.docx} family="text" />);
    expect(await screen.findByText('The preview could not be loaded. Download the file to open it.')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });
});
