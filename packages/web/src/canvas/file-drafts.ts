/**
 * The owner's unsaved edits to files on the canvas, by tab.
 *
 * Held outside the editor because a canvas tab in the back is not mounted:
 * switching to a chart and back must find the edit where it was left. The
 * tab strip reads the same store for its dirty dot, and the page asks before
 * it is closed with one still unsaved. Kept for the page's lifetime only — a
 * draft is not a save, and nothing here reaches the server.
 */
import { useSyncExternalStore } from 'react';

export interface FileDraft {
  /** The file the edit will be saved onto. */
  artifactId: string;
  /** The hash of the version the edit started from: what a save names. */
  base: string;
  /** That version's text, to tell an edit from a file left as it was. */
  baseText: string;
  text: string;
}

let drafts: ReadonlyMap<string, FileDraft> = new Map();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getDraft(tabId: string): FileDraft | null {
  return drafts.get(tabId) ?? null;
}

/** Set or drop (null) a tab's draft. A draft equal to its base is no draft. */
export function setDraft(tabId: string, draft: FileDraft | null): void {
  const next = new Map(drafts);
  if (draft && draft.text !== draft.baseText) next.set(tabId, draft);
  else if (!next.delete(tabId)) return;
  drafts = next;
  emit();
}

export function isDirty(tabId: string): boolean {
  return drafts.has(tabId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The tabs holding an unsaved edit, live. */
export function useDirtyTabs(): ReadonlyMap<string, FileDraft> {
  return useSyncExternalStore(subscribe, () => drafts, () => drafts);
}

/** For tests: every draft forgotten. */
export function resetDrafts(): void {
  drafts = new Map();
  emit();
}

// Leaving the page with an edit unsaved asks first, as any editor does.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (drafts.size === 0) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
