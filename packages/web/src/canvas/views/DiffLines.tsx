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
 * The lines, in a scrolling block. `limit` cuts the drawing, not the text: the
 * chat shows the head of a long diff and says how much more there is, and
 * `more` is what it offers for the rest — the canvas, where the whole thing is.
 */
export function DiffLines({
  text,
  limit,
  more,
  label = 'Diff',
}: {
  text: string;
  limit?: number;
  more?: { label: string; onClick: () => void };
  label?: string;
}): JSX.Element {
  const all = diffLines(text);
  const shown = limit === undefined ? all : all.slice(0, limit);
  const hidden = all.length - shown.length;
  return (
    <div className="wb-diff-wrap">
      <pre className="wb-diff" aria-label={label} data-testid="diff">
        {shown.map((line, index) => (
          <span key={index} className="wb-diff-line" data-kind={line.kind}>
            {line.text === '' ? ' ' : line.text}
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
