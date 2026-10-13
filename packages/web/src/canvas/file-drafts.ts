/**
 * The owner's edits to files on the canvas, by tab: what the editor holds,
 * and on which version of the file it started.
 *
 * Held outside the editor because a canvas tab in the back is not mounted:
 * switching to a chart and back must find the edit where it was left. The
 * tab strip reads the same store for its dirty dot; closing a tab with an
 * edit asks first and then discards it (ChatPage), and the page asks before
 * it is closed with one still unsaved. Kept for the page's lifetime only — a
 * draft is not a save, and nothing here reaches the server.
 *
 * An edit is kept even while it equals its base (typed, then undone): it is
 * still what the editor holds, so a save that comes back meanwhile can tell
 * that the text on screen is no longer what it saved, and keep it as the
 * next edit over the new version. Only an edit that differs is a draft.
 */
import { useMemo, useSyncExternalStore } from 'react';

export interface FileDraft {
  /** The file the edit will be saved onto. */
  fileId: string;
  /** Its conversation: where "Save as new file" keeps the edit if the file is deleted. */
  conversationId?: string | null;
  /** The version the edit started from: what a save names. */
  base: number;
  /** That version's text, to tell an edit from a file left as it was. */
  baseText: string;
  text: string;
  /** The file had Windows line endings: the save puts them back. */
  crlf?: boolean;
  /** He chose his version over a copy buddi changed in its workspace: the save writes over it. */
  overwriteWorkspace?: boolean;
}

/** Every tab's edit, clean or not. */
const edits = new Map<string, FileDraft>();
/** The tabs whose edit differs from its base: a fresh map on each change, for React. */
let dirty: ReadonlyMap<string, FileDraft> = new Map();
const listeners = new Set<() => void>();

function emit(): void {
  const next = new Map<string, FileDraft>();
  for (const [tab, edit] of edits) if (edit.text !== edit.baseText) next.set(tab, edit);
  const same = next.size === dirty.size && [...next].every(([tab, edit]) => dirty.get(tab) === edit);
  if (same) return;
  dirty = next;
  for (const listener of listeners) listener();
}

/** A tab's unsaved edit: null when there is none, or it equals its base. */
export function getDraft(tabId: string): FileDraft | null {
  const edit = edits.get(tabId);
  return edit && edit.text !== edit.baseText ? edit : null;
}

/** What the editor of a tab holds, an edit equal to its base included. */
export function getEdit(tabId: string): FileDraft | null {
  return edits.get(tabId) ?? null;
}

/** Set (or forget, with null) what a tab's editor holds. */
export function setDraft(tabId: string, draft: FileDraft | null): void {
  if (draft) edits.set(tabId, draft);
  else if (!edits.delete(tabId)) return;
  emit();
}

export function isDirty(tabId: string): boolean {
  return dirty.has(tabId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The tabs holding an unsaved edit, live. */
export function useDirtyTabs(): ReadonlyMap<string, FileDraft> {
  return useSyncExternalStore(subscribe, () => dirty, () => dirty);
}

/** Which tabs hold an unsaved edit, changing only when that set does (not on every keystroke). */
export function useDirtyTabIds(): ReadonlySet<string> {
  const key = useSyncExternalStore(subscribe, dirtyKey, dirtyKey);
  return useMemo(() => new Set(key === '' ? [] : key.split('\n')), [key]);
}

function dirtyKey(): string {
  return [...dirty.keys()].sort().join('\n');
}

/** For tests: every edit forgotten. */
export function resetDrafts(): void {
  edits.clear();
  emit();
}

// Leaving the page with an edit unsaved asks first, as any editor does.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (dirty.size === 0) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
