/**
 * `document` — a body with its metadata.
 *
 * `src` has already been checked same-origin by the resolver; a descriptor
 * cannot make this page fetch from anywhere else, which is the property the
 * build test asserts from the other side.
 */
import type { DocumentProps } from '../types';
import { fmtValue } from '../format';

export function DocumentView({ props }: { props: DocumentProps }): JSX.Element {
  return (
    <div>
      {props.title ? <h4 className="wb-doc-title">{props.title}</h4> : null}

      {props.metadata.length > 0 ? (
        <dl className="ui-kv wb-block">
          {props.metadata.map((item) => (
            <div key={item.label} className="contents">
              <dt>{item.label}</dt>
              <dd>{fmtValue(item.value, item.unit, null)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {props.kind === 'image' && props.src ? (
        <img src={props.src} alt={props.title ?? 'Attached image'} className="wb-doc-image" />
      ) : props.kind === 'pdf' && props.src ? (
        <object data={props.src} type="application/pdf" className="wb-doc-pdf">
          <a href={props.src}>Open the PDF</a>
        </object>
      ) : props.text ? (
        <div className="wb-doc">{props.text}</div>
      ) : (
        <p className="wb-empty">This document came back with no body.</p>
      )}
    </div>
  );
}
