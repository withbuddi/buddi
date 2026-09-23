/**
 * `preview` — a process of the owner's, framed beside what it is printing.
 *
 * The frame points at **another origin**: previews are served on a second
 * loopback listener with a credential of their own, precisely so that the app
 * in the frame — code an agent wrote a minute ago — is not running on the
 * dashboard's origin with the owner's session inside reach. This panel
 * therefore cannot build the URL itself. It asks
 * `GET /api/preview/<plugin>/<name>/link`, which mints a single-use ticket,
 * and frames what comes back.
 *
 * Three consequences worth stating, because they look like bugs otherwise:
 *
 *  - The frame is cross-origin, so nothing here can read its title, its
 *    height or anything else about it. It gets a fixed box.
 *  - It is sandboxed all the same. The origin is what keeps the app away from
 *    the dashboard's cookies and API; the sandbox is what keeps it from
 *    navigating the *top* window or opening tabs the owner did not ask for,
 *    which no origin boundary prevents. `allow-same-origin` here means "keep
 *    your own origin", which is the preview's, not this page's.
 *  - "Open in a tab" asks for a **fresh** ticket rather than reusing the
 *    frame's URL, whose ticket was spent the moment the frame loaded it. It
 *    is not a convenience: an app that sets `X-Frame-Options` or a
 *    `frame-ancestors` policy of its own cannot be framed at all and shows an
 *    empty box, and the same app in a tab of its own works.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { PreviewProps } from '../types';
import { TerminalBody } from './TerminalView';

/**
 * Is this dashboard open on the machine buddi runs on? Only then does a
 * `localhost:<port>` link mean the process; from the tailnet it means the
 * phone, and is not offered.
 */
function onThisMachine(): boolean {
  const host = window.location.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** The frame's URL without its spent ticket: what a live cookie answers for. */
function withoutTicket(url: string): string {
  try {
    const clean = new URL(url);
    clean.searchParams.delete('ticket');
    return clean.toString();
  } catch {
    return url;
  }
}

/**
 * The ports the picker offers: the ones the plugin checked the process's tree
 * holds, and the one this preview is on. Never anything else.
 */
function portChoices(props: PreviewProps): number[] {
  const ports = new Set(props.ports ?? []);
  if (props.port !== null) ports.add(props.port);
  return [...ports].sort((a, b) => a - b);
}

export function PreviewView({ props }: { props: PreviewProps }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [tabUrl, setTabUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const plugin = props.target?.plugin ?? null;
  const choices = portChoices(props);
  const [picked, setPicked] = useState<number | null>(null);
  // A port the owner picked, while it is still one of the choices.
  const port = picked !== null && choices.includes(picked) ? picked : props.port;
  /*
   * Another port of the same process is the name with the port after a dot —
   * the provider's own convention for it, answered only for a port that
   * process's tree holds. The link route, the ticket and the cookie are the
   * same ones; only the name they are minted for differs.
   */
  const name = props.target
    ? port !== null && port !== props.port
      ? `${props.target.name}.${port}`
      : props.target.name
    : null;

  /*
   * A page that does not reload itself is reloaded after a change.
   *
   * A hot-reloading dev server tells its page over the websocket the proxy
   * carries, and a second reload on top of its own would throw away the
   * state it just kept. A static server tells nobody, so the owner would be
   * looking at the page from before the write. Counted from when the panel
   * came on screen: a change it was not showing is already in the frame it
   * loads.
   *
   * The reload is a fresh frame on the clean URL, not the ticketed one: the
   * ticket was spent on the first load, and the cookie it bought answers for
   * the clean one.
   */
  const changes = props.changes ?? 0;
  const seenChanges = useRef(changes);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    if (changes <= seenChanges.current) return;
    seenChanges.current = changes;
    if (!props.reloadsItself) setReloads((count) => count + 1);
  }, [changes, props.reloadsItself]);

  useEffect(() => {
    if (plugin === null || name === null) return undefined;
    let live = true;
    setUrl(null);
    setTabUrl(null);
    setError(null);
    // A new name is a new ticket: the frame must load it, not a clean URL
    // whose cookie was bought for the other port.
    setReloads(0);
    api
      .previewLink(plugin, name)
      .then((answer) => {
        if (!live) return;
        setUrl(answer.url);
        // Loading the frame spends the ticket and buys the cookie; the clean
        // URL is then what a tab of its own can open on that cookie.
        setTabUrl(withoutTicket(answer.url));
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'That preview could not be opened.');
      });
    return () => { live = false; };
  }, [plugin, name]);

  /*
   * A tab of its own is a plain link, opened by the browser on the click.
   *
   * `window.open` from inside a promise is a pop-up and is blocked, and with
   * `noopener` it hands back nothing to navigate — which is how the tab came
   * up `about:blank`. So the link's `href` is ready before the click: the
   * clean URL, which the cookie the frame bought answers for; and on hover a
   * fresh ticket replaces it, so a cookie that has since expired is not a
   * 401 in the new tab.
   */
  const refreshTabLink = (): void => {
    if (plugin === null || name === null) return;
    api
      .previewLink(plugin, name)
      .then((answer) => setTabUrl(answer.url))
      .catch(() => undefined);
  };

  if (props.target === null) {
    return (
      <p className="wb-empty">
        This panel names no preview. A preview is <code>/preview/&lt;plugin&gt;/&lt;name&gt;/</code>,
        and nothing else is framed here.
      </p>
    );
  }

  const hasOutput = !(props.output === null || props.output === '');
  return (
    <div className="wb-preview" data-output={showOutput || undefined}>
      <div className="wb-row wb-preview-head">
        {props.title ? <h4 className="wb-doc-title">{props.title}</h4> : null}
        {choices.length > 1 ? (
          <select
            className="wb-preview-port"
            aria-label="Port"
            title="The ports this process is listening on."
            value={port ?? ''}
            onChange={(event) => setPicked(Number(event.target.value))}
          >
            {choices.map((choice) => (
              <option key={choice} value={choice}>
                :{choice}
              </option>
            ))}
          </select>
        ) : null}
        {hasOutput ? (
          <button
            type="button"
            className="ui-btn wb-preview-toggle"
            data-variant="ghost"
            data-size="sm"
            aria-pressed={showOutput}
            onClick={() => setShowOutput((value) => !value)}
          >
            {showOutput ? 'Hide output' : 'Output'}
          </button>
        ) : null}
        {tabUrl ? (
          <a
            className="wb-preview-open"
            href={tabUrl}
            target="_blank"
            rel="noreferrer noopener"
            onPointerEnter={refreshTabLink}
            onFocus={refreshTabLink}
            title="Through buddi: works from anywhere the dashboard does, including the tailnet."
          >
            Open in a tab
          </a>
        ) : null}
        {port !== null && onThisMachine() ? (
          <a
            className="wb-preview-direct"
            href={`http://localhost:${port}/`}
            target="_blank"
            rel="noreferrer noopener"
            title="The process itself, on this machine only."
          >
            localhost:{port}
          </a>
        ) : null}
      </div>
      <div className="wb-preview-body">
        {url ? (
          <iframe
            key={reloads}
            className="wb-preview-frame"
            src={reloads === 0 ? url : withoutTicket(url)}
            title={props.title ?? 'Preview'}
            // No `allow-top-navigation`, and no `allow-popups`: a dev server
            // that redirects must not be able to take the dashboard's own tab
            // with it, and the only new tab here is the one the owner clicks.
            sandbox="allow-scripts allow-forms allow-same-origin allow-modals allow-downloads"
          />
        ) : (
          <p className="wb-empty wb-preview-frame">{error ?? 'Opening the preview…'}</p>
        )}
        {hasOutput && showOutput ? <TerminalBody text={props.output ?? ''} className="wb-preview-output" /> : null}
      </div>
    </div>
  );
}
