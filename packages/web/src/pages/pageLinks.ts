/**
 * A plugin page's hash, from outside the shell that holds the page list: a
 * rail place is `#/p/<plugin>/<page>`, a settings entry
 * `#/settings/p.<plugin>[.<page>]`. The list is read once per page load and
 * shared; until it arrives, and for a page it does not name, there is no link.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { pluginPageRoute, pluginSettingsRoute } from '../routes';
import type { PluginPageDescriptor } from './types';

let pages: Promise<PluginPageDescriptor[]> | null = null;

function loadPages(): Promise<PluginPageDescriptor[]> {
  pages ??= Promise.resolve()
    .then(() => api.pages())
    .then((body) => (Array.isArray(body?.pages) ? body.pages : []))
    .catch(() => {
      pages = null;
      return [];
    });
  return pages;
}

/** The hash for a page of a plugin, given where it lives. */
export function pluginPageHref(plugin: string, page: string, place: 'rail' | 'settings'): string {
  return place === 'settings' ? pluginSettingsRoute(plugin, page) : pluginPageRoute(plugin, page);
}

/** Where a link goes and its words: "Settings → Calendar", or the rail place's own title. */
export interface PageTarget {
  href: string;
  label: string;
}

export function usePluginPageHref(link: { plugin: string; page: string } | null): PageTarget | null {
  const [href, setHref] = useState<PageTarget | null>(null);
  const plugin = link?.plugin;
  const page = link?.page;
  useEffect(() => {
    if (!plugin || !page) return undefined;
    let cancelled = false;
    void loadPages().then((list) => {
      const found = list.find((p) => p.plugin === plugin && p.id === page);
      if (cancelled) return;
      setHref(
        found
          ? {
              href: pluginPageHref(plugin, page, found.place),
              label: found.place === 'settings' ? `Settings → ${found.title}` : found.title,
            }
          : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [plugin, page]);
  return href;
}

/** For tests: forget the list read so far. */
export function resetPluginPageLinks(): void {
  pages = null;
}
