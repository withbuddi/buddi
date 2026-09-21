/**
 * The screen an agent is driving, beside the conversation driving it.
 *
 * While a session is alive this is one tab, pinned: the latest screenshot, the
 * page it is on, the mode it is working in, and every step taken so far. The
 * alternative — which is what this replaces — is a tab per `browser.act`, a
 * dozen of them, each holding one input and the word "Completed", with the
 * only panel worth reading buried somewhere behind them.
 *
 * The screenshot is re-requested on a timer rather than streamed: the route
 * hands back whatever the last observation captured, and asking again is the
 * whole of "live". The asking pauses while the tab is in the background,
 * because nobody is looking, and gives up after a few failures rather than
 * hammering a route that has stopped answering.
 *
 * **When the session ends, the gateway has nothing left to serve.** The status
 * falls back to an empty one and the screenshot route answers 404, so a panel
 * that kept asking would end as a broken image over the word "Connecting".
 * This keeps its own copy instead: the last status it saw, and the last frame
 * as bytes held in the page. That copy is what a finished session shows.
 *
 * Nothing here is drawn from a tool result. The session, the page and the mode
 * come from the gateway's own status; the steps come from the conversation's
 * recorded calls.
 */
import { useEffect, useRef, useState } from 'react';
import type { BrowserStatus } from '../../api';
import type { BrowserStep } from '../../chat/browser';
import { BrowserPanel } from '../../views/Browser';

/** How often the last observation is re-requested while a session is alive. */
export const BROWSER_POLL_MS = 2000;

/**
 * How many pictures may fail to arrive before the asking stops. A route that
 * has refused five times in a row is not about to answer the sixth, and the
 * panel still has the last frame that did arrive.
 */
export const MAX_SCREENSHOT_FAILURES = 5;

export interface BrowserViewProps {
  status: BrowserStatus | undefined;
  error: string | null;
  reload: () => void;
  /** This conversation's own actions on the screen, oldest first. */
  steps: readonly BrowserStep[];
  /** Is the session still being driven? */
  live: boolean;
  /** A step the owner clicked in the chat: scrolled to and held. */
  focusedStepId?: string | null;
}

/** Where the route serves the picture for the observation on screen now. */
function screenshotUrl(status: BrowserStatus, refresh?: number): string | null {
  if (!status.hasScreenshot || !status.page) return null;
  const session = status.session ? `&sessionId=${encodeURIComponent(status.session.id)}` : '';
  return `/api/browser/screenshot?v=${encodeURIComponent(status.page.id)}${session}${refresh ? `&tick=${refresh}` : ''}`;
}

export function BrowserView({ status, error, reload, steps, live, focusedStepId = null }: BrowserViewProps): JSX.Element {
  /*
   * One counter, appended to the screenshot's URL. The image element is the
   * poller: a new query means a new request, and nothing here has to hold a
   * picture in memory or diff one.
   */
  const [tick, setTick] = useState(0);
  const [failures, setFailures] = useState(0);
  const stalled = failures >= MAX_SCREENSHOT_FAILURES;

  useEffect(() => {
    if (!live || stalled) return undefined;
    const handle = window.setInterval(() => {
      // A background tab is not being watched. Asking anyway costs the owner's
      // machine a screenshot request every two seconds for nobody.
      if (typeof document !== 'undefined' && document.hidden) return;
      setTick((value) => value + 1);
    }, BROWSER_POLL_MS);
    return () => window.clearInterval(handle);
  }, [live, stalled]);

  // The last status this panel saw while the session was its own. After the
  // release there is nothing to read, and this is the record of what there was.
  const remembered = useRef<BrowserStatus | null>(null);
  if (live && status?.session) remembered.current = status;

  /*
   * The last frame, kept as bytes.
   *
   * Fetched once per observation rather than on every tick: the tick is the
   * image element's business, and this only has to hold whatever was last on
   * the screen. If the fetch fails, or the engine has no object URLs, the
   * panel simply has no frozen frame and says so rather than showing a broken
   * picture.
   */
  const [frame, setFrame] = useState<string | null>(null);
  const held = useRef<string | null>(null);
  const observation = status?.page?.id ?? null;
  useEffect(() => {
    const url = live && status ? screenshotUrl(status) : null;
    if (!url || typeof fetch !== 'function' || typeof URL?.createObjectURL !== 'function') return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok || cancelled) return;
        const bytes = await response.blob();
        if (cancelled) return;
        const object = URL.createObjectURL(bytes);
        if (held.current) URL.revokeObjectURL(held.current);
        held.current = object;
        setFrame(object);
      } catch {
        // The live image element is still trying; a missing copy is not news.
      }
    })();
    return () => { cancelled = true; };
  }, [live, observation]);
  useEffect(() => () => { if (held.current && typeof URL?.revokeObjectURL === 'function') URL.revokeObjectURL(held.current); }, []);

  /*
   * What the panel draws. Alive, the gateway's own status. Ended, the copy
   * this panel kept — with the screenshot admitted as gone if no frame was
   * ever captured, rather than pointing at a route that now answers 404.
   */
  const kept = remembered.current;
  const shown = live ? status : kept ? (frame ? kept : { ...kept, hasScreenshot: false }) : status;

  const newest = steps.at(-1) ?? null;

  return (
    <div className="wb-browser" data-testid="browser-view" data-live={live ? 'true' : 'false'}>
      <BrowserPanel
        data={shown}
        error={error}
        reload={reload}
        compact
        controls={live}
        {...(live ? { refresh: tick } : {})}
        {...(!live && frame ? { screenshotSrc: frame } : {})}
        onScreenshotError={() => setFailures((count) => count + 1)}
        onScreenshotLoad={() => setFailures(0)}
      />
      {!live ? (
        <p className="muted wb-browser-ended" role="status">
          This session has ended. What is on this panel is the last thing it showed.
        </p>
      ) : stalled ? (
        <p className="muted wb-browser-ended" role="status">
          The last observation could not be loaded. Showing what arrived before it.
        </p>
      ) : null}
      <Steps steps={steps} newestId={newest?.id ?? null} focusedId={focusedStepId ?? null} live={live} />
    </div>
  );
}

function Steps({
  steps,
  newestId,
  focusedId,
  live,
}: {
  steps: readonly BrowserStep[];
  newestId: string | null;
  focusedId: string | null;
  live: boolean;
}): JSX.Element {
  const list = useRef<HTMLOListElement | null>(null);

  // A row clicked in the chat is brought into view here. `scrollIntoView` is
  // absent in jsdom and on old engines, hence the guard rather than a call.
  useEffect(() => {
    if (!focusedId || !list.current) return;
    const row = list.current.querySelector(`[data-step="${CSS?.escape ? CSS.escape(focusedId) : focusedId}"]`);
    (row as { scrollIntoView?: (options: ScrollIntoViewOptions) => void } | null)?.scrollIntoView?.({ block: 'nearest' });
  }, [focusedId]);

  if (steps.length === 0) {
    return (
      <p className="muted wb-browser-empty">
        {live ? 'No action taken on this screen yet.' : 'This conversation took no action on the screen.'}
      </p>
    );
  }

  return (
    <section className="wb-browser-steps" aria-label="Steps taken on this screen">
      <ol className="wb-browser-list" ref={list}>
        {steps.map((step, index) => {
          const state = step.awaiting ? 'awaiting' : step.ok === null ? 'running' : step.ok ? 'ok' : 'failed';
          return (
            <li
              key={step.id}
              data-step={step.id}
              className="wb-browser-step"
              data-state={state}
              data-newest={step.id === newestId ? 'true' : undefined}
              data-focused={step.id === focusedId ? 'true' : undefined}
            >
              <span className="wb-browser-index mono">{index + 1}</span>
              <span className="wb-browser-what">
                <strong>{step.action}</strong>
                {step.target ? <span className="muted wb-browser-target">{step.target}</span> : null}
                {step.error ? <span className="wb-browser-error">{step.error}</span> : null}
              </span>
              <span className="wb-browser-outcome" data-state={state}>
                {state === 'awaiting' ? 'Awaiting approval' : state === 'running' ? 'Working' : state === 'ok' ? 'Done' : 'Failed'}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
