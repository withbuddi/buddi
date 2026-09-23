/**
 * `diff` — a change, with the facts about it above.
 *
 * `document` could carry a diff as a body of text, and did; what it could not
 * do is say which lines were added and which were removed, which is the whole
 * of reading a change. This panel is the same shape — a title, metadata, a
 * body — with the body drawn by `DiffLines`, the renderer the chat's inline
 * rows use too, so a write reads the same on the row and on the canvas.
 */
import type { DiffProps } from '../types';
import { fmtValue } from '../format';
import { DiffLines } from './DiffLines';

export function DiffView({ props }: { props: DiffProps }): JSX.Element {
  return (
    <div>
      {props.title ? <h4 className="wb-doc-title mono">{props.title}</h4> : null}

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

      {props.diff ? (
        <DiffLines text={props.diff} label={props.title ? `Diff of ${props.title}` : 'Diff'} />
      ) : (
        <p className="wb-empty">This change came back with no diff.</p>
      )}
    </div>
  );
}
