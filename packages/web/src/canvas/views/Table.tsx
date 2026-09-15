/**
 * `table` — typed columns, optional bar columns, optional groups, and the
 * figures that summarise them.
 *
 * A bar column shows the same number twice: once as digits and once as a
 * length. That is the whole reason it exists — a utilisation of 71% should be
 * visible before it is read.
 */
import type { TableCell, TableProps } from '../types';
import { fmtValue } from '../format';

export function Table({ props }: { props: TableProps }): JSX.Element {
  const empty = props.groups.every((group) => group.rows.length === 0);

  return (
    <div>
      {props.summary.length > 0 ? (
        <div className="wb-stats">
          {props.summary.map((item) => (
            <div key={item.label}>
              <div className="wb-stat-k">{item.label}</div>
              <div className="wb-stat-v" data-tone={item.tone}>
                {fmtValue(item.value, item.unit, item.currency)}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {empty ? (
        <p className="wb-empty">{props.empty}</p>
      ) : (
        props.groups.map((group, groupIndex) => (
          <div key={group.label ?? groupIndex} className={groupIndex > 0 ? 'mt-5' : ''}>
            {group.label ? <h4 className="wb-stat-k m-0 mb-1.5">{group.label}</h4> : null}
            <div className="wrap overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    {props.columns.map((column) => (
                      <th key={column.key} className={isNumeric(column.type) ? 'num' : undefined}>
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <Cell key={props.columns[cellIndex]?.key ?? cellIndex} cell={cell} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function Cell({ cell }: { cell: TableCell }): JSX.Element {
  const text = fmtValue(cell.value, cell.type, cell.currency);
  if (!cell.bar) {
    return <td className={isNumeric(cell.type) ? 'num' : undefined}>{text}</td>;
  }
  return (
    <td className="num">
      <div className="flex items-center gap-2 justify-end">
        <div
          className="wb-meter"
          role="meter"
          aria-valuenow={Math.round(cell.bar.fraction * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={text}
        >
          <div
            className="wb-meter-fill"
            data-tone={cell.bar.tone}
            style={{ width: `${Math.round(cell.bar.fraction * 100)}%` }}
          />
        </div>
        <span className="tnum">{text}</span>
      </div>
    </td>
  );
}

function isNumeric(type: string): boolean {
  return type === 'number' || type === 'currency' || type === 'percent';
}
