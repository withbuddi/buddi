/**
 * `structured` — the fallback, and the one most tool results will land on.
 *
 * It does not dump a tree. It reads the *shape* of the result first (see
 * `../infer.ts`) and draws whatever that shape actually is: rows that agree on
 * their keys become a table with typed columns, the figures sitting beside
 * those rows become a summary strip above it, one object becomes a list of
 * facts, a handful of strings becomes a list, a failure states its reason, and
 * a result with nothing in it says so in one line instead of drawing an empty
 * grid.
 *
 * Only a genuinely irregular result falls to the tree, and it opens a level so
 * the first screen shows data rather than the word "fields".
 *
 * The raw text is always one click away, because a dashboard that paraphrases
 * a tool result and hides the original is a dashboard you cannot debug with.
 */
import { useMemo, useState } from 'react';
import type { StructuredProps } from '../types';
import { humanise } from '../resolve';
import { fmtValue } from '../format';
import { ROW_CAP, inferShape, isBlank, type Aside, type InferredType, type Stat } from '../infer';
import { json } from '../../format';
import { commandResult } from '../command-result';
import { CommandResult } from './CommandResult';

const DEPTH_LIMIT = 2;

/** Longer than this and a cell shows its head, with the whole of it on hover. */
const CELL_CHARS = 64;

export function Structured({ props }: { props: StructuredProps }): JSX.Element {
  const [raw, setRaw] = useState(false);
  const execution = commandResult(props.value);
  const files = artifactFiles(execution?.result ?? props.value);
  const shape = useMemo(
    () => inferShape(props.value, { failed: props.failed ?? false }),
    [props.value, props.failed],
  );

  return (
    <div>
      {!execution && <ArtifactDownloads files={files} />}
      {raw ? <pre className="ui-code">{json(props.value)}</pre> : execution
        ? <CommandResult value={execution}>{files.length > 0 && <section><h4>Generated files</h4><ArtifactDownloads files={files} /></section>}</CommandResult> : files.length
        ? <details className="wb-aside"><summary>Tool details</summary><Shape shape={shape} /></details>
        : <Shape shape={shape} />}
      <div className="wb-row-end wb-section">
        <button className="ui-btn" data-variant="ghost" data-size="sm" onClick={() => setRaw((value) => !value)} aria-pressed={raw}>
          {raw ? 'Readable' : 'Raw JSON'}
        </button>
      </div>
    </div>
  );
}

/** Only local artifact IDs become links; never trust a tool-provided URL. */
interface ArtifactFile { id: string; filename: string; mime?: string }
function artifactFiles(value: unknown): ArtifactFile[] {
  const artifacts = value && typeof value === 'object' && 'artifacts' in value ? value.artifacts : null;
  if (!Array.isArray(artifacts)) return [];
  return artifacts.filter((file): file is ArtifactFile => file && typeof file.id === 'string' && /^[0-9a-f-]{36}$/i.test(file.id) && typeof file.filename === 'string');
}
function ArtifactDownloads({ files }: { files: ArtifactFile[] }): JSX.Element | null {
  return files.length ? <div className="wb-artifacts">{files.map(file => <div key={file.id}>
    {['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mime ?? '') ? <ArtifactImage file={file} /> : null}
    <a className="ui-btn" href={`/api/artifacts/${encodeURIComponent(file.id)}/download`} download>{file.mime?.startsWith('image/') ? `Download ${file.filename}` : file.filename}</a>
  </div>)}</div> : null;
}
function ArtifactImage({ file }: { file: ArtifactFile }): JSX.Element {
  const [failed, setFailed] = useState(false);
  return failed ? <p className="wb-note">Preview unavailable. You can still download the file.</p>
    : <img className="wb-artifact-image" src={`/api/artifacts/${file.id}/preview`} alt={file.filename} onError={() => setFailed(true)} />;
}

function Shape({ shape }: { shape: ReturnType<typeof inferShape> }): JSX.Element {
  switch (shape.kind) {
    case 'error':
      return (
        <div>
          <p className="wb-fail" role="status">
            {shape.summary}
          </p>
          {shape.detail === null ? null : (
            <details className="wb-aside">
              <summary>What came back with it</summary>
              <div className="wb-tree">{node(shape.detail, 1)}</div>
            </details>
          )}
        </div>
      );

    case 'empty':
      return (
        <div>
          <Stats stats={shape.stats} />
          <p className="wb-note">{shape.note}</p>
        </div>
      );

    case 'table': {
      const records = linkRecords(shape.columns, shape.rows);
      return (
        <div>
          <Stats stats={shape.stats} />
          <Notes notes={shape.notes} />
          {records ? (
            <LinkRecords label={shape.label} plan={records} rows={shape.rows} total={shape.total} />
          ) : (
            <AutoTable
              label={shape.label}
              columns={shape.columns}
              rows={shape.rows}
              total={shape.total}
            />
          )}
          <Asides asides={shape.asides} />
        </div>
      );
    }

    case 'list':
      return (
        <div>
          <Stats stats={shape.stats} />
          <Notes notes={shape.notes} />
          {shape.label ? <h4 className="wb-sub">{shape.label}</h4> : null}
          <ul className="wb-list">
            {shape.items.slice(0, 100).map((item, index) => (
              <li key={index}>{fmtValue(item, 'text', null)}</li>
            ))}
          </ul>
          {shape.total > 100 ? <p className="wb-note">Showing 100 of {shape.total}.</p> : null}
          <Asides asides={shape.asides} />
        </div>
      );

    case 'record':
      return (
        <div>
          <Notes notes={shape.notes} />
          <Pairs pairs={shape.pairs} />
          <Asides asides={shape.asides} />
        </div>
      );

    default:
      return <div className="wb-tree">{node(shape.value, 0)}</div>;
  }
}

/** The figures that sit beside the rows, said once and said first. */
function Stats({ stats }: { stats: Stat[] }): JSX.Element | null {
  if (stats.length === 0) return null;
  return (
    <div className="ui-stats" data-inline="true">
      {stats.map((stat) => (
        <div key={stat.label}>
          <div className="ui-stat-k">{stat.label}</div>
          <div className="ui-stat-v">{text(stat.value, stat.type, stat.currency)}</div>
        </div>
      ))}
    </div>
  );
}

/** Past this, a note is a paragraph for the model, not a line for a person. */
const NOTE_FOLD_CHARS = 200;

function Notes({ notes }: { notes: string[] }): JSX.Element | null {
  if (notes.length === 0) return null;
  const short = notes.filter((note) => note.length <= NOTE_FOLD_CHARS);
  const long = notes.filter((note) => note.length > NOTE_FOLD_CHARS);
  return (
    <>
      {short.map((note) => (
        <p key={note} className="wb-note">
          {note}
        </p>
      ))}
      {long.length > 0 ? (
        <details className="wb-aside">
          <summary>{long.length === 1 ? 'A note that came with this result' : `${long.length} notes that came with this result`}</summary>
          {long.map((note) => <p key={note} className="wb-note">{note}</p>)}
        </details>
      ) : null}
    </>
  );
}

/** One object, read as the facts it states. */
function Pairs({ pairs }: { pairs: Stat[] }): JSX.Element {
  if (pairs.length === 0) return <p className="wb-note">Nothing to show.</p>;
  return (
    <dl className="ui-kv">
      {pairs.map((pair) => (
        <div key={pair.label} className="contents">
          <dt>{pair.label}</dt>
          <dd className={pair.type === 'text' ? undefined : 'tnum'}>
            {text(pair.value, pair.type, pair.currency)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Branches that are neither the table nor a figure: kept, one click away. */
function Asides({ asides }: { asides: Aside[] }): JSX.Element | null {
  if (asides.length === 0) return null;
  return (
    <div className="wb-section">
      {asides.map((aside) => (
        <details key={aside.label} className="wb-aside">
          <summary>{aside.label}</summary>
          <div className="wb-tree">{node(aside.value, 1)}</div>
        </details>
      ))}
    </div>
  );
}

function AutoTable({
  label,
  columns,
  rows,
  total,
}: {
  label: string | null;
  columns: Array<{ key: string; label: string; type: InferredType; currency: string | null }>;
  rows: Array<Record<string, unknown>>;
  total: number;
}): JSX.Element {
  const [all, setAll] = useState(false);
  // Hiding a handful of rows behind a button costs more than showing them.
  const limit = total <= ROW_CAP + 5 ? total : ROW_CAP;
  const shown = all ? rows : rows.slice(0, limit);

  return (
    <div>
      {label ? <h4 className="wb-sub">{label}</h4> : null}
      <div className="ui-table-wrap">
        <table className="ui-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={numeric(column.type) ? 'num' : undefined}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <Cell key={column.key} value={row[column.key]} column={column} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > shown.length ? (
        <p className="wb-note wb-note-row">
          <span>
            Showing {shown.length} of {total}
          </span>
          <button className="ui-btn" onClick={() => setAll(true)}>
            Show all {total}
          </button>
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Rows that are links: a search result, a bookmark, a feed item.
 *
 * A grid is the wrong shape for them — the URL column eats the width and
 * the title wraps into a ribbon. Read as records instead: the title is the
 * link, the host and the short fields are the line under it, the longest
 * text is the description. Decided from the data, never from a tool's name.
 * ------------------------------------------------------------------ */

interface RecordPlan {
  url: string;
  title: string;
  description: string | null;
  meta: string[];
}

const TITLE_KEYS = /^(title|name|headline|subject|label|heading)$/i;
const URL_KEYS = /^(url|link|href|uri|permalink)$/i;

export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value.trim());
}

/** The host, without a leading www, for the line under a title. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** `host/first-bit-of-path…`: enough to tell two links apart, short enough to sit in a cell. */
export function shortUrl(url: string, max = 48): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    const whole = `${parsed.hostname.replace(/^www\./, '')}${path}${parsed.search}`;
    return whole.length > max ? `${whole.slice(0, max - 1)}…` : whole;
  } catch {
    return url.length > max ? `${url.slice(0, max - 1)}…` : url;
  }
}

function averageLength(rows: Array<Record<string, unknown>>, key: string): number {
  const values = rows.map((row) => row[key]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v.length, 0) / values.length;
}

export function linkRecords(
  columns: Array<{ key: string; label: string; type: InferredType }>,
  rows: Array<Record<string, unknown>>,
): RecordPlan | null {
  if (rows.length === 0) return null;
  const textColumns = columns.filter((c) => c.type === 'text');
  // The link column: named like one, or mostly URLs.
  const url = textColumns.find((c) => URL_KEYS.test(c.key) && rows.some((r) => isHttpUrl(r[c.key])))
    ?? textColumns.find((c) => {
      const present = rows.map((r) => r[c.key]).filter((v) => !isBlank(v));
      return present.length > 0 && present.filter(isHttpUrl).length / present.length >= 0.6;
    });
  if (!url) return null;
  const others = textColumns.filter((c) => c.key !== url.key);
  const title = others.find((c) => TITLE_KEYS.test(c.key)) ?? others.find((c) => averageLength(rows, c.key) > 0);
  if (!title) return null;
  const rest = others.filter((c) => c.key !== title.key);
  // The description is the longest text that is not the title; short text is meta.
  const byLength = [...rest].sort((a, b) => averageLength(rows, b.key) - averageLength(rows, a.key));
  const description = byLength[0] && averageLength(rows, byLength[0].key) > 40 ? byLength[0] : null;
  const meta = columns
    .filter((c) => c.key !== url.key && c.key !== title.key && c.key !== description?.key)
    .map((c) => c.key);
  return { url: url.key, title: title.key, description: description?.key ?? null, meta };
}

function LinkRecords({ label, plan, rows, total }: {
  label: string | null;
  plan: RecordPlan;
  rows: Array<Record<string, unknown>>;
  total: number;
}): JSX.Element {
  const [all, setAll] = useState(false);
  const limit = total <= ROW_CAP + 5 ? total : ROW_CAP;
  const shown = all ? rows : rows.slice(0, limit);
  return (
    <div>
      {label ? <h4 className="wb-sub">{label}</h4> : null}
      <ol className="wb-records">
        {shown.map((row, index) => {
          const href = row[plan.url];
          const link = isHttpUrl(href) ? href.trim() : null;
          const title = typeof row[plan.title] === 'string' && (row[plan.title] as string).trim() !== '' ? (row[plan.title] as string) : (link ? shortUrl(link) : 'Untitled');
          const description = plan.description && typeof row[plan.description] === 'string' ? (row[plan.description] as string) : null;
          const host = link ? hostOf(link) : null;
          const meta = plan.meta
            .map((key) => row[key])
            .filter((v) => !isBlank(v) && (typeof v !== 'object'))
            .map((v) => String(v))
            // The host already says where it came from; a source column that repeats it is noise.
            .filter((v) => host === null || v.replace(/^www\./, '') !== host);
          return (
            <li key={index} className="wb-record">
              {link ? (
                <a className="wb-record-title" href={link} target="_blank" rel="noopener noreferrer">{title}</a>
              ) : (
                <span className="wb-record-title">{title}</span>
              )}
              <div className="wb-record-meta">
                {host ? <span className="wb-record-host" title={link ?? undefined}>{host}</span> : null}
                {meta.map((m, i) => <span key={i}>{m.length > 60 ? `${m.slice(0, 59)}…` : m}</span>)}
              </div>
              {description ? <p className="wb-record-desc">{description.length > 280 ? `${description.slice(0, 279)}…` : description}</p> : null}
            </li>
          );
        })}
      </ol>
      {total > shown.length ? (
        <p className="wb-note wb-note-row">
          <span>Showing {shown.length} of {total}</span>
          <button className="ui-btn" onClick={() => setAll(true)}>Show all {total}</button>
        </p>
      ) : null}
    </div>
  );
}

function Cell({
  value,
  column,
}: {
  value: unknown;
  column: { type: InferredType; currency: string | null };
}): JSX.Element {
  if (isBlank(value)) return <td className="wb-cell-soft">—</td>;
  // A link is a link: short on the page, whole on hover, and it opens.
  if (isHttpUrl(value)) {
    const href = value.trim();
    return (
      <td className="wb-cell-link">
        <a href={href} target="_blank" rel="noopener noreferrer" title={href}>{shortUrl(href)}</a>
      </td>
    );
  }
  // A cell holding an object states its size; the raw JSON holds the object.
  if (value !== null && typeof value === 'object') {
    const size = Array.isArray(value)
      ? `${value.length} item${value.length === 1 ? '' : 's'}`
      : `${Object.keys(value as object).length} fields`;
    return (
      <td className="wb-cell-soft" title={json(value)}>
        {size}
      </td>
    );
  }

  const full = text(value, column.type, column.currency);
  const clipped = full.length > CELL_CHARS ? `${full.slice(0, CELL_CHARS - 1)}…` : full;
  return (
    <td
      className={numeric(column.type) ? 'num' : 'wb-cell-text'}
      {...(clipped === full ? {} : { title: full })}
    >
      {clipped}
    </td>
  );
}

function numeric(type: InferredType): boolean {
  return type === 'number' || type === 'currency';
}

/** The printed form of one value. `boolean` is the one type `fmtValue` spells. */
function text(value: unknown, type: InferredType, currency: string | null): string {
  if (value === null || value === undefined) return '—';
  if (type === 'boolean') return value ? 'yes' : 'no';
  return fmtValue(value, type === 'text' ? 'text' : type, currency);
}

/* ------------------------------------------------------------------ *
 * The tree, for results that have no shape worth naming.
 * ------------------------------------------------------------------ */

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
    return depth >= DEPTH_LIMIT ? (
      <Collapsed summary={`${value.length} items`} open={depth === DEPTH_LIMIT}>
        {body}
      </Collapsed>
    ) : (
      body
    );
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
  // The first level past the limit opens by default: a screen that starts by
  // saying "10 fields" has told the owner nothing.
  return depth >= DEPTH_LIMIT ? (
    <Collapsed summary={`${entries.length} fields`} open={depth === DEPTH_LIMIT}>
      {body}
    </Collapsed>
  ) : (
    body
  );
}

function Collapsed({
  summary,
  open,
  children,
}: {
  summary: string;
  open: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <details open={open}>
      <summary className="wb-tree-key">{summary}</summary>
      {children}
    </details>
  );
}
