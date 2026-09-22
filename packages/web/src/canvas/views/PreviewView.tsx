/**
 * `preview` — a process of the owner's, framed beside what it is printing.
 *
 * The frame is the gateway's proxy (`/preview/<plugin>/<name>/`), which is
 * behind the dashboard's own sign-in; the resolver has already refused any
 * `src` that is not under that prefix, so this file frames what it is handed
 * and nothing else. The frame is sandboxed all the same: the app in it is code
 * the owner is *writing*, which is to say code that is wrong most of the day.
 *
 * "Open in a tab" is not a convenience. An app that sets `X-Frame-Options` or
 * a `frame-ancestors` policy cannot be framed at all and shows an empty box,
 * and the same link in a tab of its own works — so the link is always there,
 * beside the frame rather than under it.
 */
import type { PreviewProps } from '../types';

export function PreviewView({ props }: { props: PreviewProps }): JSX.Element {
  if (props.src === null) {
    return (
      <p className="wb-empty">
        This preview has no address on this dashboard. A preview is served at
        <code> /preview/…</code>, and nothing else is framed here.
      </p>
    );
  }
  return (
    <div className="wb-preview">
      <div className="wb-row wb-preview-head">
        {props.title ? <h4 className="wb-doc-title">{props.title}</h4> : null}
        <a className="wb-preview-open" href={props.src} target="_blank" rel="noreferrer">
          Open in a tab
        </a>
      </div>
      <div className="wb-preview-body">
        <iframe
          className="wb-preview-frame"
          src={props.src}
          title={props.title ?? 'Preview'}
          sandbox="allow-scripts allow-forms allow-same-origin"
        />
        {props.output === null || props.output === '' ? null : (
          <pre className="wb-preview-output">{props.output}</pre>
        )}
      </div>
    </div>
  );
}
