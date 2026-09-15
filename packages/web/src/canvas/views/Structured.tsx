/**
 * `structured` — the fallback, and the one most tool results will land on.
 *
 * It is a *readable* view of the JSON rather than a dump: keys are given their
 * words back, scalars are typed by colour, arrays say how long they are, and
 * anything deep enough to be noise collapses behind a disclosure the owner can
 * open. The raw text is still one click away, because a dashboard that
 * paraphrases a tool result and hides the original is a dashboard you cannot
 * debug with.
 */
import { useState } from 'react';
import type { StructuredProps } from '../types';
import { humanise } from '../resolve';
import { json } from '../../format';

const DEPTH_LIMIT = 2;

export function Structured({ props }: { props: StructuredProps }): JSX.Element {
  const [raw, setRaw] = useState(false);
  return (
    <div>
      <div className="flex justify-end mb-2">
        <button className="wb-btn" onClick={() => setRaw((value) => !value)} aria-pressed={raw}>
          {raw ? 'Readable' : 'Raw JSON'}
        </button>
      </div>
      {raw ? <pre>{json(props.value)}</pre> : <div className="wb-tree">{node(props.value, 0)}</div>}
    </div>
  );
}

function node(value: unknown, depth: number): JSX.Element {
  if (value === null) return <span className="wb-tree-null">null</span>;
  if (value === undefined) return <span className="wb-tree-null">—</span>;
  if (typeof value === 'number') return <span className="wb-tree-num">{value}</span>;
  if (typeof value === 'boolean') return <span className="wb-tree-bool">{value ? 'true' : 'false'}</span>;
  if (typeof value === 'string') return <span>{value === '' ? <em className="wb-tree-null">empty</em> : value}</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="wb-tree-null">none</span>;
    const body = (
      <div className="wb-tree-branch">
        {value.slice(0, 50).map((item, index) => (
          <div key={index}>
            <span className="wb-tree-key">{index}. </span>
            {node(item, depth + 1)}
          </div>
        ))}
        {value.length > 50 ? <div className="wb-tree-key">…and {value.length - 50} more</div> : null}
      </div>
    );
    return depth >= DEPTH_LIMIT ? <Collapsed summary={`${value.length} items`}>{body}</Collapsed> : body;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className="wb-tree-null">empty</span>;
  const body = (
    <div className={depth === 0 ? undefined : 'wb-tree-branch'}>
      {entries.map(([key, child]) => (
        <div key={key}>
          <span className="wb-tree-key">{humanise(key)}: </span>
          {node(child, depth + 1)}
        </div>
      ))}
    </div>
  );
  return depth >= DEPTH_LIMIT ? <Collapsed summary={`${entries.length} fields`}>{body}</Collapsed> : body;
}

function Collapsed({ summary, children }: { summary: string; children: JSX.Element }): JSX.Element {
  return (
    <details>
      <summary className="wb-tree-key cursor-pointer">{summary}</summary>
      {children}
    </details>
  );
}
