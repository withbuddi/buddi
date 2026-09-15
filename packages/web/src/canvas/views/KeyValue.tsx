/** `keyvalue` — labelled facts, aligned, with the digits in tabular figures. */
import type { KeyValueProps } from '../types';
import { fmtValue } from '../format';

export function KeyValue({ props }: { props: KeyValueProps }): JSX.Element {
  if (props.pairs.length === 0) return <p className="wb-empty">Nothing to show.</p>;
  return (
    <dl className="wb-kv">
      {props.pairs.map((pair) => (
        <div key={pair.label} className="contents">
          <dt>{pair.label}</dt>
          <dd className="tnum" style={pair.tone === 'neutral' ? undefined : { color: `var(--${pair.tone})` }}>
            {fmtValue(pair.value, pair.unit, pair.currency)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
