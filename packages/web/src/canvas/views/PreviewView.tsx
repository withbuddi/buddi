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
 * Two consequences worth stating, because they look like bugs otherwise:
 *
 *  - The frame is cross-origin, so nothing here can read its title, its
 *    height or anything else about it. It gets a fixed box.
 *  - "Open in a tab" opens the same ticketed URL. It is not a convenience:
 *    an app that sets `X-Frame-Options` or a `frame-ancestors` policy of its
 *    own cannot be framed at all and shows an empty box, and the same link in
 *    a tab works.
 */
import { useEffect, useState } from 'react';
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
          <a className="wb-preview-open" href={url} target="_blank" rel="noreferrer">
            Open in a tab
          </a>
        ) : null}
      </div>
      <div className="wb-preview-body">
        {url ? (
          <iframe className="wb-preview-frame" src={url} title={props.title ?? 'Preview'} />
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
