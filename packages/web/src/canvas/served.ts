/**
 * Which previews are being served, for a conversation waiting on some.
 *
 * A dev server started a moment ago is usually not listening yet: its result
 * names the preview it *will* be (`awaiting`) and draws no tab. The plugin
 * keeps watching the process and writes its port down when it binds; this
 * asks the dashboard's `check` route — the same question the preview proxy
 * asks on every request — until the answer is yes, and then the tab opens.
 *
 * Bounded: each preview is asked about every two seconds for a few minutes
 * after its result arrived — a little longer than the plugin watches — and
 * not again once it is served. A result older than that is asked about once,
 * so reopening a conversation whose server is still up still shows it; such a
 * preview is `served` but not `live`, and does not take the screen.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { previewKey } from './renderables';

/** How long after its result a preview is waited for. The plugin watches for three minutes. */
export const SERVED_WATCH_MS = 3.5 * 60_000;
export const SERVED_EVERY_MS = 2_000;

export interface AwaitedPreview {
  plugin: string;
  name: string;
  /** When the result arrived; null is treated as long ago. */
  at: string | null;
}

export interface ServedPreviews {
  /** `<plugin>/<name>` of every preview confirmed served. */
  served: ReadonlySet<string>;
  /** Those confirmed while they were being waited for — news, worth the screen. */
  live: ReadonlySet<string>;
}

export function useServedPreviews(
  awaiting: readonly AwaitedPreview[],
  scope: string | null,
  options: { check?: (plugin: string, name: string) => Promise<{ ok: boolean }>; everyMs?: number } = {},
): ServedPreviews {
  const [state, setState] = useState<ServedPreviews & { scope: string | null }>({
    served: new Set(),
    live: new Set(),
    scope,
  });
  const served = useRef<ReadonlySet<string>>(state.served);
  // Another conversation's previews are not this one's news.
  if (state.scope !== scope) {
    const fresh = { served: new Set<string>(), live: new Set<string>(), scope };
    served.current = fresh.served;
    setState(fresh);
  }
  const check = options.check ?? api.previewCheck;
  const every = options.everyMs ?? SERVED_EVERY_MS;
  const signature = awaiting.map((item) => `${previewKey(item)}@${item.at ?? ''}`).join('|');

  useEffect(() => {
    // Per preview, the latest result's deadline wins: a process restarted
    // under the same name is waited for afresh.
    const pending = new Map<string, { plugin: string; name: string; until: number }>();
    for (const item of awaiting) {
      const key = previewKey(item);
      if (served.current.has(key)) continue;
      const at = item.at === null ? Number.NaN : Date.parse(item.at);
      const until = Number.isNaN(at) ? 0 : at + SERVED_WATCH_MS;
      const known = pending.get(key);
      if (!known || until > known.until) pending.set(key, { plugin: item.plugin, name: item.name, until });
    }
    if (pending.size === 0) return undefined;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      const now = Date.now();
      for (const [key, preview] of [...pending]) {
        const answer = await check(preview.plugin, preview.name).catch(() => null);
        if (stopped) return;
        const live = now <= preview.until;
        if (answer?.ok) {
          pending.delete(key);
          setState((previous) => {
            const next = {
              served: new Set(previous.served).add(key),
              live: live ? new Set(previous.live).add(key) : previous.live,
              scope: previous.scope,
            };
            served.current = next.served;
            return next;
          });
        } else if (!live) {
          // Past its window: asked once, and let go.
          pending.delete(key);
        }
      }
      if (!stopped && pending.size > 0) timer = setTimeout(() => void tick(), every);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // `awaiting` is read through its signature: a new array with the same
    // previews in it is not a reason to start asking again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, scope, check, every]);

  return state;
}
