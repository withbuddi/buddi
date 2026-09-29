/**
 * The plugin rail pages the owner hid (Settings → Appearance → In the rail).
 *
 * Kept by the installation (`GET /api/rail`), and held here as one shared
 * value so the rail and the Settings switches agree the moment one changes:
 * the switch updates the value first and tells the gateway after, and puts it
 * back if the gateway refuses. Every rail page is shown until it is hidden.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api';
import type { PluginPageDescriptor } from '../pages/types';

export const railKey = (page: Pick<PluginPageDescriptor, 'plugin' | 'id'>): string => `${page.plugin}:${page.id}`;

const EMPTY: ReadonlySet<string> = new Set();
let hidden: ReadonlySet<string> = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: ReadonlySet<string>): void {
  hidden = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = (): ReadonlySet<string> => hidden;

/** Read the setting once per page load; a gateway without the route hides nothing. */
export function loadRailHidden(): void {
  if (loaded) return;
  loaded = true;
  Promise.resolve()
    .then(() => api.rail())
    .then((body) => publish(new Set(Array.isArray(body?.hidden) ? body.hidden.filter((k) => typeof k === 'string') : [])))
    .catch(() => {
      /* No server, or an older gateway: every rail page is shown. */
    });
}

/** Hide a page from the rail or show it again: at once here, then on the gateway. */
export async function setRailHidden(page: Pick<PluginPageDescriptor, 'plugin' | 'id'>, hide: boolean): Promise<void> {
  const before = hidden;
  const next = new Set(before);
  if (hide) next.add(railKey(page));
  else next.delete(railKey(page));
  publish(next);
  try {
    await api.setRailHidden(page.plugin, page.id, hide);
  } catch (err) {
    publish(before);
    throw err;
  }
}

/** The hidden set, read from the gateway on first use. */
export function useRailHidden(): ReadonlySet<string> {
  useEffect(loadRailHidden, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The rail pages the rail draws: every one the owner has not hidden. */
export function shownOnRail(pages: PluginPageDescriptor[], hiddenKeys: ReadonlySet<string>): PluginPageDescriptor[] {
  return pages.filter((page) => !hiddenKeys.has(railKey(page)));
}

/** Tests start from nothing hidden and nothing read. */
export function resetRailHiddenForTests(): void {
  hidden = EMPTY;
  loaded = false;
}
