/**
 * A diff, drawn line by line: what was added tinted green, what was removed
 * tinted red, the headers and hunk markers quiet.
 *
 * Deliberately not a diff *library*. The text arrives already diffed — git's
 * unified format from a summary, or the short `- old` / `+ new` form a write
 * or an edit reports — and all a reader needs from the page is to see at a
 * glance which lines are which. That is a prefix test per line, and it is the
 * same test in the chat's inline body and on the canvas, which is why both
 * draw through this one component.
 */

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/**
 * git's file headers. A removed line that happens to begin `-- ` would look the
 * same as a `--- ` header by prefix alone, so the header is only believed
 * where it names a side (`a/…`, `b/…`) or `/dev/null`, as git writes it.
 */
const HEADER = /^(diff --git |index [0-9a-f]|--- (a\/|\/dev\/null)|\+\+\+ (b\/|\/dev\/null)|new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode|Binary files )/;

/** What a writer says in place of lines: a truncation, or nothing to say. */
const NOTE = /^(… |\.\.\. |\(no change\)$|\\ No newline at end of file)/;

export function diffLines(text: string): DiffLine[] {
  // A trailing newline is the end of the last line, not an empty one after it.
  const lines = text.replace(/\n$/, '').split('\n');
  return lines.map((line) => ({ kind: kindOf(line), text: line }));
}

function kindOf(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (HEADER.test(line) || NOTE.test(line)) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

/**
 * A line with the given phrases marked, case-insensitively: the sentences of
 * a proposal that also appeared in untrusted text, so an instruction that
 * came from a page is visible in the change that would keep it.
 */
function Marked({ text, marks }: { text: string; marks: readonly string[] }): JSX.Element {
  const lower = text.toLowerCase();
  const spans: Array<[number, number]> = [];
  for (const mark of marks) {
    const needle = mark.trim().toLowerCase();
    if (needle === '') continue;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
      spans.push([at, at + needle.length]);
    }
  }
  if (spans.length === 0) return <>{text === '' ? ' ' : text}</>;
  spans.sort((x, y) => x[0] - y[0]);
  const parts: JSX.Element[] = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start < cursor) continue;
    if (start > cursor) parts.push(<span key={`t${cursor}`}>{text.slice(cursor, start)}</span>);
    parts.push(<mark key={`m${start}`} className="wb-diff-mark">{text.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) parts.push(<span key={`t${cursor}`}>{text.slice(cursor)}</span>);
  return <>{parts}</>;
}

/**
 * The lines, in a scrolling block. `limit` cuts the drawing, not the text: the
 * chat shows the head of a long diff and says how much more there is, and
 * `more` is what it offers for the rest — the canvas, where the whole thing is.
 */
export function DiffLines({
  text,
  limit,
  more,
  label = 'Diff',
  marks,
}: {
  text: string;
  limit?: number;
  more?: { label: string; onClick: () => void };
  label?: string;
  /** Phrases to highlight wherever they occur. */
  marks?: readonly string[];
}): JSX.Element {
  const all = diffLines(text);
  const shown = limit === undefined ? all : all.slice(0, limit);
  const hidden = all.length - shown.length;
  return (
    <div className="wb-diff-wrap">
      <pre className="wb-diff" aria-label={label} data-testid="diff">
        {shown.map((line, index) => (
          <span key={index} className="wb-diff-line" data-kind={line.kind}>
            {marks && marks.length > 0 ? <Marked text={line.text} marks={marks} /> : line.text === '' ? ' ' : line.text}
          </span>
        ))}
      </pre>
      {hidden > 0 ? (
        <p className="wb-diff-more">
          {hidden} more line{hidden === 1 ? '' : 's'}
          {more ? (
            <>
              {' · '}
              <button type="button" className="wb-diff-open" onClick={more.onClick}>{more.label}</button>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
