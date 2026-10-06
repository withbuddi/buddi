/**
 * The screens the installed plugins contribute, read once for the whole shell.
 *
 * The rail needs them to draw its extra entries, Settings needs them to draw
 * its extra tabs, and the place itself needs the descriptor it is drawing. One
 * read, held in the shell, rather than three — and an installation with no
 * such plugin gets an empty list and behaves exactly as it did before.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { PluginPageDescriptor } from './types';

export interface PluginPages {
  all: PluginPageDescriptor[];
  /** The rail entries, in the order the descriptors asked for. */
  rail: PluginPageDescriptor[];
  /** The settings tabs, in the same order. */
  settings: PluginPageDescriptor[];
  find: (plugin: string, page: string) => PluginPageDescriptor | undefined;
}

/** Descriptors in the order they are shown: `order`, then the plugin's own. */
export function orderPages(pages: PluginPageDescriptor[], place: 'rail' | 'settings'): PluginPageDescriptor[] {
  return (pages ?? [])
    .filter((page) => page.place === place)
    .map((page, index) => ({ page, index }))
    .sort((a, b) => (a.page.order ?? 0) - (b.page.order ?? 0) || a.index - b.index)
    .map((entry) => entry.page);
}

/**
 * Fired when the set of plugin pages changed under the shell — a plugin was
 * disabled or enabled — so the rail and Settings read the list again at once.
 */
export const PAGES_CHANGED_EVENT = 'buddi:plugin-pages-changed';

/** Say the plugin pages changed: the shell reads them again. */
export function announcePagesChanged(): void {
  window.dispatchEvent(new Event(PAGES_CHANGED_EVENT));
}

/**
 * Fired when one plugin's own data may have changed: a run used one of its
 * tools and it worked (the attention stream's `pages.changed { plugin }`).
 * `detail` is the plugin's id.
 */
export const PLUGIN_DATA_CHANGED_EVENT = 'buddi:plugin-data-changed';

/** How long a burst of a plugin's tool calls is gathered into one re-read. */
export const PLUGIN_DATA_DEBOUNCE_MS = 500;

/** Say a plugin's data may have changed: its open pages read again. */
export function announcePluginDataChanged(plugin: string): void {
  window.dispatchEvent(new CustomEvent<string>(PLUGIN_DATA_CHANGED_EVENT, { detail: plugin }));
}

/**
 * Call `onChange` when `plugin`'s data may have changed, at most once per
 * burst: a run recording five balances is one re-read, half a second after
 * the last. Only while the caller is mounted — a page nobody is looking at
 * asks nothing.
 */
export function usePluginDataChanged(plugin: string, onChange: () => void, delayMs = PLUGIN_DATA_DEBOUNCE_MS): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const heard = (event: Event): void => {
      if ((event as CustomEvent<string>).detail !== plugin) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; latest.current(); }, delayMs);
    };
    window.addEventListener(PLUGIN_DATA_CHANGED_EVENT, heard);
    return () => {
      window.removeEventListener(PLUGIN_DATA_CHANGED_EVENT, heard);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [plugin, delayMs]);
}

export function usePluginPages(skip = false): PluginPages {
  const [pages, setPages] = useState<PluginPageDescriptor[]>([]);
  useEffect(() => {
    if (skip) return undefined;
    let cancelled = false;
    const read = (): void => {
      // Through a promise, so a gateway that answers 404 and a browser that
      // cannot reach one leave the shell exactly as it was.
      Promise.resolve()
        .then(() => api.pages())
        .then((body) => {
          // Whatever answered, the shell only ever holds a list: a gateway that
          // does not serve this route yet is an installation with no plugin
          // pages, not a broken dashboard.
          if (!cancelled) setPages(Array.isArray(body?.pages) ? body.pages : []);
        })
        .catch(() => {
          /* No server, no session, or an older gateway. The shell is unchanged. */
        });
    };
    read();
    // Again when a plugin was toggled here, and when the tab comes back into
    // view (another tab or the CLI may have toggled one meanwhile).
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') read();
    };
    window.addEventListener(PAGES_CHANGED_EVENT, read);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener(PAGES_CHANGED_EVENT, read);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [skip]);
  return {
    all: pages,
    rail: orderPages(pages, 'rail'),
    settings: orderPages(pages, 'settings'),
    find: (plugin, page) => pages.find((p) => p.plugin === plugin && p.id === page),
  };
}

/**
 * A plugin as the owner knows it: the title of its first rail page ("Mail"
 * for `email`), else its first settings page, else its id with a capital —
 * never the raw id on a card.
 */
export function pluginTitle(plugin: string, pages: readonly PluginPageDescriptor[] | undefined): string {
  const own = (pages ?? []).filter((page) => page.plugin === plugin);
  const first = orderPages(own, 'rail')[0] ?? orderPages(own, 'settings')[0];
  if (first?.title.trim()) return first.title.trim();
  const words = plugin.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : plugin;
}
