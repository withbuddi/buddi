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
 * whole of "live". The asking stops when the session does — a finished session
 * has a last picture, and a last picture does not change.
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

export function BrowserView({ status, error, reload, steps, live, focusedStepId = null }: BrowserViewProps): JSX.Element {
  /*
   * One counter, appended to the screenshot's URL. The image element is the
   * poller: a new query means a new request, and nothing here has to hold a
   * picture in memory or diff one. It stops advancing when the session ends,
   * so a released session is one last frame rather than a request every two
   * seconds for ever.
   */
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!live) return undefined;
    const handle = window.setInterval(() => setTick((value) => value + 1), BROWSER_POLL_MS);
    return () => window.clearInterval(handle);
  }, [live]);

  const newest = steps.at(-1) ?? null;
  const focused = focusedStepId ?? null;

  return (
    <div className="wb-browser" data-testid="browser-view" data-live={live ? 'true' : 'false'}>
      <BrowserPanel data={status} error={error} reload={reload} compact refresh={live ? tick : undefined} />
      <Steps steps={steps} newestId={newest?.id ?? null} focusedId={focused} live={live} />
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
          const state = step.ok === null ? 'running' : step.ok ? 'ok' : 'failed';
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
                {state === 'running' ? 'Working' : state === 'ok' ? 'Done' : 'Failed'}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
