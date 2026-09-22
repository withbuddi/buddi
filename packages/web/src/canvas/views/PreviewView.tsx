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
import { useEffect, useState, type MouseEvent } from 'react';
import { api } from '../../api';
import type { PreviewProps } from '../types';

export function PreviewView({ props }: { props: PreviewProps }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plugin = props.target?.plugin ?? null;
  const name = props.target?.name ?? null;

  useEffect(() => {
    if (plugin === null || name === null) return undefined;
    let live = true;
    setUrl(null);
    setError(null);
    api
      .previewLink(plugin, name)
      .then((answer) => { if (live) setUrl(answer.url); })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'That preview could not be opened.');
      });
    return () => { live = false; };
  }, [plugin, name]);

  /*
   * A tab of its own, on a ticket of its own.
   *
   * The blank tab is opened *synchronously*, before the request: a
   * `window.open` from inside a promise is a pop-up as far as the browser is
   * concerned and is blocked. The `href` stays on the element for a
   * middle-click or the context menu, which works too — a spent ticket with a
   * live preview cookie is served, which is exactly the case that link is.
   */
  const openInTab = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (plugin === null || name === null) return;
    event.preventDefault();
    const tab = window.open('', '_blank', 'noopener');
    api
      .previewLink(plugin, name)
      .then((answer) => {
        if (tab) tab.location = answer.url;
        else window.location.assign(answer.url);
      })
      .catch((err: unknown) => {
        tab?.close();
        setError(err instanceof Error ? err.message : 'That preview could not be opened.');
      });
  };

  if (props.target === null) {
    return (
      <p className="wb-empty">
        This panel names no preview. A preview is <code>/preview/&lt;plugin&gt;/&lt;name&gt;/</code>,
        and nothing else is framed here.
      </p>
    );
  }

  return (
    <div className="wb-preview">
      <div className="wb-row wb-preview-head">
        {props.title ? <h4 className="wb-doc-title">{props.title}</h4> : null}
        {url ? (
          <a className="wb-preview-open" href={url} target="_blank" rel="noreferrer" onClick={openInTab}>
            Open in a tab
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
        {props.output === null || props.output === '' ? null : (
          <pre className="wb-preview-output">{props.output}</pre>
        )}
      </div>
    </div>
  );
}
