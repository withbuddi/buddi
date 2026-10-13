/**
 * The owner's unsaved edits to files on the canvas, by tab, and the version
 * each tab settled on.
 *
 * Held outside the editor because a canvas tab in the back is not mounted:
 * switching to a chart and back must find the edit where it was left. The
 * tab strip reads the same store for its dirty dot; closing a tab with an
 * edit asks first and then discards it (ChatPage), and the page asks before
 * it is closed with one still unsaved. Kept for the page's lifetime only — a
 * draft is not a save, and nothing here reaches the server.
 *
 * A tab's *pin* is the version the owner settled on — the one he saved,
 * took ("Show theirs") or kept his edit over ("Keep mine") — while the
 * conversation still names the same newest file (`target`). Coming forward
 * again, the tab opens that version rather than asking the same question.
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
  /** The file had Windows line endings: the save puts them back. */
  crlf?: boolean;
  /** He chose his version over a copy buddi changed in its workspace: the save writes over it. */
  overwriteWorkspace?: boolean;
}

export interface FilePin {
  /** The file the conversation named when he settled. */
  target: string;
  /** The version he settled on. */
  artifactId: string;
}

let drafts: ReadonlyMap<string, FileDraft> = new Map();
const pins = new Map<string, FilePin>();
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

export function getPin(tabId: string): FilePin | null {
  return pins.get(tabId) ?? null;
}

export function setPin(tabId: string, pin: FilePin | null): void {
  if (pin) pins.set(tabId, pin);
  else pins.delete(tabId);
}

/** For tests: every draft and pin forgotten. */
export function resetDrafts(): void {
  drafts = new Map();
  pins.clear();
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
