/**
 * `bars` — one value per category, on a shared baseline.
 *
 * Negative values are drawn below the baseline in the critical hue, because a
 * bar chart that renders −40 the same length as +40 in the same colour is a
 * chart that lies about the sign.
 */
import type { BarsProps } from '../types';
import { fmtValue } from '../format';

export function Bars({ props }: { props: BarsProps }): JSX.Element {
  if (props.bars.length === 0) return <p className="wb-empty">No categories came back.</p>;

  const values = props.bars.map((bar) => bar.value);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;

  return (
    <div className="wb-bars">
      {props.bars.map((bar) => {
        const fraction = Math.abs(bar.value) / span;
        return (
          <div key={bar.category} className="wb-bar-row">
            <div className="wb-bar-cat" title={bar.category}>
              {bar.category}
            </div>
            <div className="wb-bar-track">
              <div
                className="wb-bar-fill"
                style={{
                  width: `${Math.max(1, fraction * 100)}%`,
                  background: bar.value < 0 ? 'var(--chart-bar-negative)' : 'var(--chart-bar)',
                }}
              />
            </div>
            <div className="wb-bar-val">
              {fmtValue(bar.value, props.unit, props.currency)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
