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
import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { PreviewProps } from '../types';

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

export function PreviewView({ props }: { props: PreviewProps }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [tabUrl, setTabUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const plugin = props.target?.plugin ?? null;
  const name = props.target?.name ?? null;

  useEffect(() => {
    if (plugin === null || name === null) return undefined;
    let live = true;
    setUrl(null);
    setTabUrl(null);
    setError(null);
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
        {props.port !== null ? (
          <a
            className="wb-preview-direct"
            href={`http://localhost:${props.port}/`}
            target="_blank"
            rel="noreferrer noopener"
            title="The process itself, on this machine only."
          >
            localhost:{props.port}
          </a>
        ) : null}
      </div>
      <div className="wb-preview-body">
        {url ? (
          <iframe
            className="wb-preview-frame"
            src={url}
            title={props.title ?? 'Preview'}
            // No `allow-top-navigation`, and no `allow-popups`: a dev server
            // that redirects must not be able to take the dashboard's own tab
            // with it, and the only new tab here is the one the owner clicks.
            sandbox="allow-scripts allow-forms allow-same-origin allow-modals allow-downloads"
          />
        ) : (
          <p className="wb-empty wb-preview-frame">{error ?? 'Opening the preview…'}</p>
        )}
        {hasOutput && showOutput ? <pre className="wb-preview-output">{props.output}</pre> : null}
      </div>
    </div>
  );
}
