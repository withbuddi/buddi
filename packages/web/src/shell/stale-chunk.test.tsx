/**
 * A tab from before an update asks for chunks that are gone: it reloads once
 * onto the served build, offers the reload instead while something is in
 * progress, and gives up (the caller's error stands) on a second failure soon
 * after (`stale-chunk.ts`).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { OFFICE_MIME } from '@buddi/core/office-files';
import { setDraft } from '../canvas/file-drafts';
import { ArtifactPreview } from '../chat/ArtifactPreview';
import { BannerSlot, UPDATED_BANNER, shellBanners } from './BannerSlot';
import {
  STALE_CHUNK_RELOAD_KEY, STALE_CHUNK_WINDOW_MS, isChunkLoadError, loadChunk, onStaleChunk, resetStaleChunkForTests,
  staleChunkDeps, useStaleNotice, watchStaleChunks,
} from './stale-chunk';

// The Word viewer's chunk, deleted by an update.
vi.mock('../chat/office/docx', () => { throw new TypeError('Failed to fetch dynamically imported module: ./assets/docx-OLD.js'); });

const real = { ...staleChunkDeps };
let now = 1_000_000;
const reload = vi.fn();

beforeEach(() => {
  window.sessionStorage.clear();
  resetStaleChunkForTests();
  now = 1_000_000;
  reload.mockReset();
  staleChunkDeps.reload = reload;
  staleChunkDeps.now = () => now;
  staleChunkDeps.busy = real.busy;
});

afterEach(() => {
  cleanup();
  Object.assign(staleChunkDeps, real);
  setDraft('tab-1', null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** The next page load: the module's memory is gone, sessionStorage stays. */
function nextPage(): void {
  resetStaleChunkForTests();
}

describe('a chunk that is gone', () => {
  it('reloads once, and gives up on a second failure within the window', () => {
    expect(onStaleChunk()).toBe('reloading');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY)).toBe(String(now));
    // The same page failing again (Vite's event and the caller's own catch) does not reload twice.
    expect(onStaleChunk()).toBe('reloading');
    expect(reload).toHaveBeenCalledTimes(1);

    nextPage();
    now += STALE_CHUNK_WINDOW_MS - 1;
    expect(onStaleChunk()).toBe('gave-up');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again once the window has passed: a later update is a new one', () => {
    onStaleChunk();
    nextPage();
    now += STALE_CHUNK_WINDOW_MS;
    expect(onStaleChunk()).toBe('reloading');
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('never reloads on its own where storage is refused, since it could not tell the second time', () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new Error('denied'); });
    expect(onStaleChunk()).toBe('notice');
    expect(reload).not.toHaveBeenCalled();
  });

  it('runs on Vite’s own report of a chunk it could not load', () => {
    const stop = watchStaleChunks();
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    stop();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('hands the caller a ChunkLoadError, so it can tell a gone chunk from a failed fetch', async () => {
    const error = await loadChunk(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module'))).catch((e: unknown) => e);
    expect(isChunkLoadError(error)).toBe(true);
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('while something is in progress', () => {
  function Shell(): JSX.Element {
    return <BannerSlot banners={shellBanners({ recovery: false, lost: false, paused: false, updated: useStaleNotice() })} onNavigate={() => {}} />;
  }

  it('a composer holding a message keeps the page: the banner offers Reload instead', () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="wb-composer" data-busy="true"></div>');
    render(<Shell />);
    expect(screen.queryByText(UPDATED_BANNER)).toBeNull();
    act(() => { expect(onStaleChunk()).toBe('notice'); });
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(UPDATED_BANNER);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
    // The owner's reload counts as the window's: a chunk still missing after it gives up rather than loop.
    nextPage();
    expect(onStaleChunk()).toBe('gave-up');
  });

  it('an unsaved edit on the canvas keeps the page too', () => {
    setDraft('tab-1', { fileId: 'f1', base: 1, baseText: 'a', text: 'ab' });
    expect(onStaleChunk()).toBe('notice');
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the Office preview', () => {
  it('says the page was updated, not to download the file, when its viewer’s chunk is gone', async () => {
    window.sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(now));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0x50, 0x4b]), { status: 200 })));
    render(<ArtifactPreview artifactId="a1" filename="Letter.docx" mime={OFFICE_MIME.docx} family="text" />);
    expect(await screen.findByText('This part of buddi was updated. Reload the page to see the preview.')).toBeInTheDocument();
    expect(screen.queryByText(/Download the file/)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('still says to download when it is the file that could not be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    render(<ArtifactPreview artifactId="a2" filename="Sheet.xlsx" mime={OFFICE_MIME.xlsx} family="table" />);
    expect(await screen.findByText('The preview could not be loaded. Download the file to open it.')).toBeInTheDocument();
  });
});
