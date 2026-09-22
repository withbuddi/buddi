/**
 * The screens the installed plugins contribute, read once for the whole shell.
 *
 * The rail needs them to draw its extra entries, Settings needs them to draw
 * its extra tabs, and the place itself needs the descriptor it is drawing. One
 * read, held in the shell, rather than three — and an installation with no
 * such plugin gets an empty list and behaves exactly as it did before.
 */
import { useEffect, useState } from 'react';
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

export function usePluginPages(): PluginPages {
  const [pages, setPages] = useState<PluginPageDescriptor[]>([]);
  useEffect(() => {
    let cancelled = false;
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
    return () => {
      cancelled = true;
    };
  }, []);
  return {
    all: pages,
    rail: orderPages(pages, 'rail'),
    settings: orderPages(pages, 'settings'),
    find: (plugin, page) => pages.find((p) => p.plugin === plugin && p.id === page),
  };
}
