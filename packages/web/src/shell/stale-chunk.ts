/**
 * Recovering when this page's own code is gone after an update.
 *
 * The build splits what is loaded late into chunks with hashed names (the
 * Office viewers, the sheet worker, the editor's languages). An update or a
 * rebuild replaces `dist`, so a tab opened before it asks for names the
 * gateway no longer has. Every such failure comes here — Vite's
 * `vite:preloadError` for each `import()` the build wraps, `loadChunk` for a
 * caller that wants to say so, the sheet job for its worker — and the one
 * rule is:
 *
 *  - nothing on the page would be lost (`somethingInProgress`, an unsaved
 *    file edit on the canvas) → reload once, onto the build that is served;
 *  - something would → the banner says "buddi was updated" with Reload, and
 *    nothing moves under the owner's hands;
 *  - the page already reloaded for this within `STALE_CHUNK_WINDOW_MS` → give
 *    up, and the caller's own error shows (`ChunkLoadError` lets it say the
 *    right thing).
 *
 * The reload's time is kept in `sessionStorage`; where storage is refused the
 * page never reloads on its own, since it could not tell a second time from
 * the first. A composer's text, the canvas's tabs and the route survive a
 * reload already (the draft is kept per thread, the tabs on the server, the
 * place in the hash).
 */
import { useSyncExternalStore } from 'react';
import { hasUnsavedEdits } from '../canvas/file-drafts';
import { somethingInProgress } from './freshness';

/** When this tab last reloaded because a chunk was gone. */
export const STALE_CHUNK_RELOAD_KEY = 'buddi.staleChunkReloadAt';
/** A second failure this soon after that reload is not a stale page: give up. */
export const STALE_CHUNK_WINDOW_MS = 30_000;

/** A chunk of this build that could not be loaded: an update replaced it. */
export class ChunkLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'A part of the page could not be loaded', { cause });
    this.name = 'ChunkLoadError';
  }
}

export function isChunkLoadError(error: unknown): error is ChunkLoadError {
  return error instanceof ChunkLoadError;
}

export type StaleOutcome = 'reloading' | 'notice' | 'gave-up';

/** What the rule reads and does; tests swap them. */
export const staleChunkDeps = {
  reload: (): void => window.location.reload(),
  now: (): number => Date.now(),
  busy: (): boolean => somethingInProgress() || hasUnsavedEdits(),
};

/** This page's answer, once decided: every later failure on it gets the same one. */
let decided: StaleOutcome | null = null;
const listeners = new Set<() => void>();

function lastReload(): number | null | 'refused' {
  try {
    const raw = window.sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY);
    const at = raw === null ? NaN : Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return 'refused';
  }
}

function stampReload(): boolean {
  try {
    window.sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(staleChunkDeps.now()));
    return true;
  } catch {
    return false;
  }
}

function decide(outcome: StaleOutcome): StaleOutcome {
  decided = outcome;
  for (const listener of listeners) listener();
  return outcome;
}

/** A chunk of this build failed to load: reload, offer to, or give up. */
export function onStaleChunk(): StaleOutcome {
  if (decided) return decided;
  const last = lastReload();
  if (typeof last === 'number' && staleChunkDeps.now() - last < STALE_CHUNK_WINDOW_MS) return decide('gave-up');
  if (last === 'refused' || staleChunkDeps.busy() || !stampReload()) return decide('notice');
  decide('reloading');
  staleChunkDeps.reload();
  return 'reloading';
}

/** The banner's Reload: the owner asked, so it counts as this window's reload too. */
export function reloadForUpdate(): void {
  stampReload();
  staleChunkDeps.reload();
}

/** Load a chunk; when it is gone, the rule above runs and the caller gets a `ChunkLoadError`. */
export function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  return load().catch((error: unknown) => {
    onStaleChunk();
    throw new ChunkLoadError(error);
  });
}

/** Listen for Vite's own report of a chunk it could not load. Once, from `main.tsx`. */
export function watchStaleChunks(): () => void {
  // Not prevented: the import still rejects, so its caller's error stands if the page stays.
  const onError = (): void => { onStaleChunk(); };
  window.addEventListener('vite:preloadError', onError);
  return () => window.removeEventListener('vite:preloadError', onError);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const showing = (): boolean => decided === 'notice';

/** Whether the banner offers the reload (something was in progress when a chunk was gone). */
export function useStaleNotice(): boolean {
  return useSyncExternalStore(subscribe, showing, showing);
}

/** Tests start each case on a fresh page. */
export function resetStaleChunkForTests(): void {
  decided = null;
  for (const listener of listeners) listener();
}
