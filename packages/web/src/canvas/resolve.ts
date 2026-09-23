/**
 * Applying a view descriptor to a tool result.
 *
 * A descriptor is data that arrived over the wire from a plugin the browser
 * has never heard of, so every step here is defensive: a path that misses
 * yields `undefined`, a points array that is not an array yields none, a
 * number that is not a number is dropped rather than drawn at zero. The
 * renderer downstream is then allowed to assume its props are well formed.
 *
 * Nothing in this file knows a domain. It knows paths, numbers and shapes.
 */
import type {
  BarsMap,
  BarsProps,
  ColumnType,
  DiffMap,
  DiffProps,
  DocumentMap,
  DocumentProps,
  ImageMap,
  ImageProps,
  KeyValueMap,
  KeyValueProps,
  PreviewMap,
  PreviewProps,
  RendererName,
  TableCell,
  TableMap,
  TableProps,
  TerminalMap,
  TerminalProps,
  TimeseriesMap,
  TimeseriesProps,
  Tone,
  Unit,
  ValueRef,
  ViewDescriptor,
  ViewMap,
} from './types';

/**
 * Read one path out of a value. `''` and `'$'` are the root; segments are
 * split on dots, and `[0]` indexes an array. A miss is `undefined`, never a
 * throw — the descriptor was written against a shape the tool may since have
 * changed.
 */
export function readPath(source: unknown, path: string): unknown {
  if (path === '' || path === '$') return source;
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    // `series[0]` → `series`, then `0`.
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) return undefined;
    const [, key = '', indexes = ''] = match;
    if (key !== '') {
      if (cursor === null || typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string, unknown>)[key];
    }
    for (const index of indexes.match(/\d+/g) ?? []) {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[Number(index)];
    }
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

/** A literal, or a path into the output. */
export function readRef(source: unknown, ref: ValueRef | undefined): unknown {
  if (!ref) return undefined;
  if ('const' in ref) return ref.const;
  return readPath(source, ref.path);
}

/** A finite number, or null. Strings that are numbers count; `"n/a"` does not. */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/* ------------------------------------------------------------------ *
 * One function per renderer, each turning `map` + `output` into props.
 * ------------------------------------------------------------------ */

export function resolveTimeseries(output: unknown, map: TimeseriesMap): TimeseriesProps {
  const points = asArray(readPath(output, map.points))
    .map((point) => {
      const y = asNumber(readPath(point, map.y));
      const x = asString(readPath(point, map.x));
      return y === null || x === null ? null : { x, y };
    })
    .filter((point): point is { x: string; y: number } => point !== null);

  const referenceLines = (map.referenceLines ?? [])
    .map((line) => {
      const value = asNumber(readRef(output, line.value));
      return value === null ? null : { value, label: line.label, tone: line.tone ?? 'neutral' };
    })
    .filter((line): line is { value: number; label: string; tone: Tone } => line !== null);

  return {
    points,
    unit: map.unit ?? 'number',
    currency: asString(readRef(output, map.currency)),
    label: asString(readRef(output, map.label)),
    referenceLines,
    mark: map.mark ?? null,
    shadeBelow: asNumber(readRef(output, map.shadeBelow)),
    events: resolveEvents(output, map),
  };
}

/**
 * Events come either from their own array, or hang off each point (a day with
 * the things that happen on it). Both are common; neither is special-cased
 * anywhere but here.
 */
function resolveEvents(output: unknown, map: TimeseriesMap): TimeseriesProps['events'] {
  const spec = map.events;
  if (!spec) return [];
  const collected: Array<{ at: string; label: string; amount: number | null }> = [];

  const push = (item: unknown, fallbackAt: string | null): void => {
    const label = asString(readPath(item, spec.label));
    if (label === null) return;
    const at = asString(readPath(item, spec.at)) ?? fallbackAt;
    if (at === null) return;
    collected.push({ at, label, amount: spec.amount ? asNumber(readPath(item, spec.amount)) : null });
  };

  if (spec.parent) {
    for (const point of asArray(readPath(output, map.points))) {
      const at = asString(readPath(point, map.x));
      for (const item of asArray(readPath(point, spec.parent))) push(item, at);
    }
    return collected;
  }
  for (const item of asArray(readPath(output, spec.path ?? map.points))) push(item, null);
  return collected;
}

export function resolveTable(output: unknown, map: TableMap): TableProps {
  const columns = (map.columns ?? []).map((column) => ({
    key: column.key,
    label: column.label,
    type: (column.type ?? 'text') as ColumnType,
  }));

  const toCells = (row: unknown): TableCell[] =>
    (map.columns ?? []).map((column) => {
      const value = readPath(row, column.key);
      let bar: TableCell['bar'] = null;
      if (column.bar) {
        const max = asNumber(readRef(row, column.bar.max)) ?? asNumber(readRef(output, column.bar.max));
        const current = asNumber(value);
        if (max !== null && max > 0 && current !== null) {
          const fraction = Math.max(0, Math.min(1, current / max));
          bar = { fraction, tone: toneFor(fraction * 100, column.bar.thresholds) };
        }
      }
      return {
        value,
        type: (column.type ?? 'text') as ColumnType,
        currency: asString(readRef(row, column.currency)) ?? asString(readRef(output, column.currency)),
        bar,
      };
    });

  const rows = asArray(readPath(output, map.rows));
  const groups = map.groupBy ? groupRows(rows, map.groupBy, toCells) : [{ label: null, rows: rows.map(toCells) }];

  const summary = (map.summary ?? []).map((item) => ({
    label: item.label,
    value: readRef(output, item.value),
    unit: (item.unit ?? 'text') as Unit,
    currency: asString(readRef(output, item.currency)),
    tone: item.tone ?? ('neutral' as Tone),
  }));

  return { columns, groups, summary, empty: map.empty ?? 'Nothing to show.' };
}

function groupRows(
  rows: unknown[],
  groupBy: NonNullable<TableMap['groupBy']>,
  toCells: (row: unknown) => TableCell[],
): TableProps['groups'] {
  const buckets = new Map<string, unknown[]>();
  for (const row of rows) {
    const key = String(readPath(row, groupBy.key) ?? '');
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  return [...buckets.entries()].map(([key, bucket]) => ({
    label: groupBy.labels?.[key] ?? key,
    rows: bucket.map(toCells),
  }));
}

/** The first threshold the value reaches, largest first. */
function toneFor(percent: number, thresholds: Array<{ atLeast: number; tone: Tone }> | undefined): Tone {
  if (!thresholds || thresholds.length === 0) return 'neutral';
  const ordered = [...thresholds].sort((a, b) => b.atLeast - a.atLeast);
  return ordered.find((threshold) => percent >= threshold.atLeast)?.tone ?? 'neutral';
}

export function resolveBars(output: unknown, map: BarsMap): BarsProps {
  const bars = asArray(readPath(output, map.bars))
    .map((bar) => {
      const value = asNumber(readPath(bar, map.value));
      const category = asString(readPath(bar, map.category));
      return value === null || category === null ? null : { category, value };
    })
    .filter((bar): bar is { category: string; value: number } => bar !== null);
  return { bars, unit: map.unit ?? 'number', currency: asString(readRef(output, map.currency)) };
}

export function resolveKeyValue(output: unknown, map: KeyValueMap): KeyValueProps {
  if (map.pairs) {
    return {
      pairs: map.pairs.map((pair) => ({
        label: pair.label,
        value: readRef(output, pair.value),
        unit: (pair.unit ?? 'text') as Unit,
        currency: asString(readRef(output, pair.currency)),
        tone: pair.tone ?? ('neutral' as Tone),
      })),
    };
  }
  const from = readPath(output, map.from ?? '$');
  if (from === null || typeof from !== 'object' || Array.isArray(from)) return { pairs: [] };
  return {
    pairs: Object.entries(from as Record<string, unknown>).map(([key, value]) => ({
      label: humanise(key),
      value,
      unit: 'text' as Unit,
      currency: null,
      tone: 'neutral' as Tone,
    })),
  };
}

export function resolveDocument(output: unknown, map: DocumentMap): DocumentProps {
  const kindRaw = asString(readRef(output, map.kind));
  const kind = kindRaw === 'image' || kindRaw === 'pdf' ? kindRaw : 'text';
  const src = map.src ? asString(readPath(output, map.src)) : null;
  return {
    kind,
    text: map.text ? asString(readPath(output, map.text)) : null,
    // A document source is only ever same-origin: this page makes no external
    // request, and a plugin descriptor is not allowed to make it start.
    src: src && isSameOrigin(src) ? src : null,
    title: asString(readRef(output, map.title)),
    metadata: (map.metadata ?? []).map((item) => ({
      label: item.label,
      value: readRef(output, item.value),
      unit: (item.unit ?? 'text') as Unit,
    })),
  };
}

/**
 * A diff and the facts about it. The diff is read as text and nothing else: a
 * path that lands on an object draws as "no diff", not as `[object Object]`
 * coloured green.
 */
export function resolveDiff(output: unknown, map: DiffMap): DiffProps {
  const diff = map.diff ? readPath(output, map.diff) : undefined;
  return {
    diff: typeof diff === 'string' && diff.trim() !== '' ? diff : null,
    title: asString(readRef(output, map.title)),
    metadata: (map.metadata ?? []).map((item) => ({
      label: item.label,
      value: readRef(output, item.value),
      unit: (item.unit ?? 'text') as Unit,
    })),
  };
}

/**
 * What a command printed. The output is text or nothing; the numbers are
 * numbers or nothing — an exit code of `"0"` from a descriptor pointed at the
 * wrong field is not drawn as a success.
 */
export function resolveTerminal(output: unknown, map: TerminalMap): TerminalProps {
  const text = map.output ? readPath(output, map.output) : undefined;
  const integer = (path: string | undefined): number | null => {
    const value = path ? readPath(output, path) : undefined;
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
  };
  const omitted = integer(map.omittedBytes);
  const elapsed = map.elapsedMs ? readPath(output, map.elapsedMs) : undefined;
  return {
    command: asString(readRef(output, map.command)),
    output: typeof text === 'string' ? text : null,
    exitCode: integer(map.exitCode),
    elapsedMs: typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
    omittedBytes: omitted !== null && omitted > 0 ? omitted : null,
    metadata: (map.metadata ?? []).map((item) => ({
      label: item.label,
      value: readRef(output, item.value),
      unit: (item.unit ?? 'text') as Unit,
    })),
  };
}

const LIBRARY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A library file's id out of whatever the path found: the id itself, or an
 * object carrying it as `id` or `artifactId`. Only a uuid counts — it is the
 * one thing the panel puts in a URL, and it goes in a path the library owns.
 */
export function libraryFileId(value: unknown): string | null {
  const candidate =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)['artifactId'] ?? (value as Record<string, unknown>)['id']
      : value;
  return typeof candidate === 'string' && LIBRARY_ID.test(candidate) ? candidate.toLowerCase() : null;
}

export function resolveImage(output: unknown, map: ImageMap): ImageProps {
  return {
    artifactId: map.src ? libraryFileId(readPath(output, map.src)) : null,
    title: asString(readRef(output, map.title)),
    caption: asString(readRef(output, map.caption)),
  };
}

/**
 * Which preview a descriptor named, or null.
 *
 * A preview is not a URL this page may construct: it is served on another
 * origin, behind a credential the dashboard mints one link at a time. So what
 * a descriptor says is *which* process — spelled as the path
 * `/preview/<plugin>/<name>/`, which is the sentence the plugin already
 * writes — and the panel asks the link route for the rest.
 *
 * Parsed through `URL` rather than matched as a string, so `/preview/a/../..`
 * is read as the `/` it resolves to and refused, rather than passing a
 * `startsWith` and framing the dashboard.
 */
export function previewTarget(src: string): { plugin: string; name: string } | null {
  if (!isSameOrigin(src)) return null;
  let pathname: string;
  try {
    // A `file:` base, not an http one: the resolution is the only thing wanted
    // here, and this file may not name a host at all — the bundle test reads
    // every source for one, because a page that reaches off-origin is the
    // thing that must never ship.
    pathname = new URL(src, 'file:///').pathname;
  } catch {
    return null;
  }
  const match = /^\/preview\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/?$/.exec(pathname);
  if (!match) return null;
  return { plugin: match[1] as string, name: match[2] as string };
}

export function resolvePreview(output: unknown, map: PreviewMap): PreviewProps {
  const src = map.src ? asString(readPath(output, map.src)) : null;
  const port = map.port ? readPath(output, map.port) : null;
  const awaiting = map.awaiting ? asString(readPath(output, map.awaiting)) : null;
  return {
    target: src ? previewTarget(src) : null,
    title: asString(readRef(output, map.title)),
    output: map.output ? asString(readPath(output, map.output)) : null,
    port: typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
    awaiting: awaiting ? previewTarget(awaiting) : null,
    // Only a real `true`: a string "true" from a descriptor pointed at the
    // wrong field would otherwise stop the reload a static page needs.
    reloadsItself: map.reloadsItself ? readPath(output, map.reloadsItself) === true : false,
    ports: map.ports ? previewPorts(readPath(output, map.ports)) : [],
  };
}

/** Real ports, each once, in order; anything else in the list is dropped. */
function previewPorts(value: unknown): number[] {
  const ports = asArray(value).filter(
    (port): port is number => typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535,
  );
  return [...new Set(ports)].sort((a, b) => a - b);
}

/** Relative paths only. Anything with a scheme or `//` host is refused. */
export function isSameOrigin(src: string): boolean {
  return src.startsWith('/') && !src.startsWith('//');
}

/** `lastRunAt` → `Last run at`. Only used for un-described objects. */
export function humanise(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The whole point: descriptor + output → props the generic renderer can draw.
 * An unknown renderer name, or one that needs no map, falls through to
 * `structured` rather than rendering nothing.
 */
export function applyDescriptor(
  descriptor: ViewDescriptor,
  output: unknown,
): { renderer: RendererName; props: unknown } {
  const map = (descriptor.map ?? {}) as ViewMap;
  switch (descriptor.renderer) {
    case 'timeseries':
      return { renderer: 'timeseries', props: resolveTimeseries(output, map as TimeseriesMap) };
    case 'table':
      return { renderer: 'table', props: resolveTable(output, map as TableMap) };
    case 'bars':
      return { renderer: 'bars', props: resolveBars(output, map as BarsMap) };
    case 'keyvalue':
      return { renderer: 'keyvalue', props: resolveKeyValue(output, map as KeyValueMap) };
    case 'document':
      return { renderer: 'document', props: resolveDocument(output, map as DocumentMap) };
    case 'diff':
      return { renderer: 'diff', props: resolveDiff(output, map as DiffMap) };
    case 'terminal':
      return { renderer: 'terminal', props: resolveTerminal(output, map as TerminalMap) };
    case 'image':
      return { renderer: 'image', props: resolveImage(output, map as ImageMap) };
    case 'preview':
      return { renderer: 'preview', props: resolvePreview(output, map as PreviewMap) };
    default:
      return { renderer: 'structured', props: { value: output } };
  }
}
