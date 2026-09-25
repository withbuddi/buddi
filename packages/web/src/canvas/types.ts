/**
 * The canvas contract, browser side.
 *
 * This mirrors `packages/core/src/views.ts` exactly. It is written out again
 * rather than imported because the contract crosses a process boundary: the
 * server sends descriptors as JSON over `GET /api/chat/views`, and the page
 * must not pull a Node package (pg, zod, the vault) into a browser bundle to
 * read them. Two copies of a data-only contract is the cheap half of that
 * trade; if one changes, change both.
 *
 * Everything here is a *shape*. Nothing in this package — types, renderers or
 * tests — is allowed to know the name of a plugin's tool.
 */

export type RendererName =
  | 'timeseries'
  | 'table'
  | 'bars'
  | 'keyvalue'
  | 'document'
  | 'diff'
  | 'terminal'
  | 'image'
  | 'preview'
  | 'envelope'
  | 'structured';

export type ValueRef = { path: string } | { const: string | number | boolean | null };

export type Unit = 'number' | 'currency' | 'percent' | 'text' | 'date';

export type Tone = 'good' | 'warning' | 'critical' | 'neutral' | 'accent';

export interface ReferenceLine {
  value: ValueRef;
  label: string;
  tone?: Tone;
}

export interface TimeseriesMap {
  points: string;
  x: string;
  y: string;
  unit?: Unit;
  currency?: ValueRef;
  label?: ValueRef;
  referenceLines?: ReferenceLine[];
  mark?: 'min' | 'max';
  shadeBelow?: ValueRef;
  events?: { path?: string; parent?: string; at: string; label: string; amount?: string };
}

export type ColumnType = 'text' | 'number' | 'currency' | 'date' | 'percent';

export interface ColumnMap {
  key: string;
  label: string;
  type?: ColumnType;
  currency?: ValueRef;
  bar?: { max: ValueRef; thresholds?: Array<{ atLeast: number; tone: Tone }> };
  /**
   * Draw the cell as a pill; `tone` may be a path within the row, and an
   * array value becomes one pill per `{ value, tone }` item. `labels` gives a
   * slug its words.
   */
  pill?: { tone?: Tone | ValueRef; labels?: Record<string, string> };
  /** `wrap` breaks a long value; `truncate` cuts it to one line, whole on hover. */
  fit?: 'wrap' | 'truncate';
  /** A path within the row whose value is the cell's tooltip. */
  hint?: string;
}

export interface TableMap {
  rows: string;
  columns: ColumnMap[];
  summary?: Array<{ label: string; value: ValueRef; unit?: Unit; currency?: ValueRef; tone?: Tone }>;
  groupBy?: { key: string; labels?: Record<string, string> };
  empty?: string;
}

export interface BarsMap {
  bars: string;
  category: string;
  value: string;
  unit?: Unit;
  currency?: ValueRef;
}

export interface KeyValueMap {
  pairs?: Array<{ label: string; value: ValueRef; unit?: Unit; currency?: ValueRef; tone?: Tone }>;
  from?: string;
}

export interface DocumentMap {
  kind?: ValueRef;
  text?: string;
  src?: string;
  title?: ValueRef;
  metadata?: Array<{ label: string; value: ValueRef; unit?: Unit }>;
}

/** A change to read: the diff text, and the facts about it. */
export interface DiffMap {
  /** Path to the diff text — git's unified form or the short `-`/`+` form. */
  diff: string;
  title?: ValueRef;
  metadata?: Array<{ label: string; value: ValueRef; unit?: Unit }>;
}

/** What a command printed: the command on top, the output as a terminal body. */
export interface TerminalMap {
  /** Path to the output text, plain. */
  output: string;
  command?: ValueRef;
  /** Path to the exit code. */
  exitCode?: string;
  /** Path to the elapsed time, in milliseconds. */
  elapsedMs?: string;
  /** Path to how many bytes a cap dropped from the start. */
  omittedBytes?: string;
  metadata?: Array<{ label: string; value: ValueRef; unit?: Unit }>;
}

/** A picture from the Files library: `src` is a path to its id. */
export interface ImageMap {
  src: string;
  title?: ValueRef;
  caption?: ValueRef;
  /** Names the caption and folds it away under that name. */
  captionLabel?: ValueRef;
}

/** A loopback process of the owner's, framed beside what it is printing. */
export interface PreviewMap {
  /** Path to a `/preview/<plugin>/<name>/` string naming which process. */
  src: string;
  title?: ValueRef;
  /** Path to the process's recent output text. */
  output?: string;
  /** Path to the loopback port the process listens on, for a direct link. */
  port?: string;
  /** Path to a `/preview/<plugin>/<name>/` string naming a process not listening yet. */
  awaiting?: string;
  /** Path to a boolean: the process reloads its own page after a change. */
  reloadsItself?: string;
  /** Path to the ports the process's tree listens on, for the picker. */
  ports?: string;
}

export type ViewMap =
  | TimeseriesMap
  | TableMap
  | BarsMap
  | KeyValueMap
  | DocumentMap
  | DiffMap
  | TerminalMap
  | ImageMap
  | PreviewMap
  | Record<string, never>;

export interface ViewDescriptor {
  tool: string;
  renderer: RendererName;
  title?: string;
  map: ViewMap;
}

/* ------------------------------------------------------------------ *
 * What the renderers actually receive — the descriptor already applied.
 * ------------------------------------------------------------------ */

export interface SeriesPoint {
  x: string;
  y: number;
}

export interface TimeseriesProps {
  points: SeriesPoint[];
  unit: Unit;
  currency: string | null;
  label: string | null;
  referenceLines: Array<{ value: number; label: string; tone: Tone }>;
  mark: 'min' | 'max' | null;
  shadeBelow: number | null;
  events: Array<{ at: string; label: string; amount: number | null }>;
}

export interface TableCell {
  value: unknown;
  type: ColumnType;
  currency: string | null;
  bar: { fraction: number; tone: Tone } | null;
}

export interface TableProps {
  columns: Array<{ key: string; label: string; type: ColumnType }>;
  groups: Array<{ label: string | null; rows: TableCell[][] }>;
  summary: Array<{ label: string; value: unknown; unit: Unit; currency: string | null; tone: Tone }>;
  empty: string;
}

export interface BarsProps {
  bars: Array<{ category: string; value: number }>;
  unit: Unit;
  currency: string | null;
}

export interface KeyValueProps {
  pairs: Array<{ label: string; value: unknown; unit: Unit; currency: string | null; tone: Tone }>;
}

export interface DocumentProps {
  kind: 'text' | 'image' | 'pdf';
  text: string | null;
  src: string | null;
  title: string | null;
  metadata: Array<{ label: string; value: unknown; unit: Unit }>;
}

export interface DiffProps {
  diff: string | null;
  title: string | null;
  metadata: Array<{ label: string; value: unknown; unit: Unit }>;
}

export interface TerminalProps {
  /** The command line, drawn as the header. */
  command: string | null;
  /** What it printed, plain text; null when the result carried none. */
  output: string | null;
  exitCode: number | null;
  elapsedMs: number | null;
  /** Bytes a cap dropped from the head, when any were. */
  omittedBytes: number | null;
  metadata: Array<{ label: string; value: unknown; unit: Unit }>;
}

export interface ImageProps {
  /**
   * The library file, by id — a uuid and nothing else, so the only URLs the
   * panel builds are the library's own preview and download routes. Null
   * when the descriptor pointed at something that is not one.
   */
  artifactId: string | null;
  title: string | null;
  caption: string | null;
  /** Set when the caption is folded away under this name. */
  captionLabel?: string | null;
}

export interface PreviewProps {
  /**
   * Which preview to ask the dashboard for a link to, or null when the
   * descriptor named something that is not one.
   *
   * Not a URL: a preview is served on a *different origin* with a credential
   * of its own, and the only way to one is `GET /api/preview/<plugin>/<name>/link`,
   * which mints a single-use ticket. So what a descriptor can say is *which*
   * preview, and the panel goes and asks.
   */
  target: { plugin: string; name: string } | null;
  title: string | null;
  /** What the process has printed lately, shown beside the frame. */
  output: string | null;
  /**
   * The port the process itself listens on, for a `localhost:<port>` link
   * beside the proxied one — reachable only at this machine, which is why
   * the proxied link stays the default.
   */
  port: number | null;
  /**
   * The preview this result will be once its process listens, when it is not
   * listening yet. Such a result draws no tab until the dashboard says the
   * preview is being served; then `target` is this and the tab opens.
   */
  awaiting: { plugin: string; name: string } | null;
  /** True when the process reloads its own page after a change (hot reload). */
  reloadsItself: boolean;
  /**
   * Every port the process's tree listens on that a preview may use, as the
   * plugin checked them. More than one draws a picker; the panel never offers
   * a port that is not in this list.
   */
  ports: number[];
  /**
   * How many changes to files this conversation has made, set by the page.
   * The panel reloads its frame when this grows while it is on screen —
   * unless the process reloads itself.
   */
  changes?: number;
}

export interface EnvelopeProps {
  /** The pending action to load from `GET /api/approvals/:id`. */
  approvalId: string;
}

export interface StructuredProps {
  value: unknown;
  /** The call failed: draw the reason, not a table of its wreckage. */
  failed?: boolean;
}

/**
 * Where a renderable came from, which is also its precedence order.
 *
 * `profile` and `browser` are trusted platform state, not tool results. For a
 * profile, the owner asked
 * what an agent is, and the answer takes a tab beside the work rather than a
 * modal over it. It is listed here so that everything which reasons about a
 * tab — what may be pushed into the overflow, what is allowed to take the
 * screen — can tell it apart from something a run produced.
 */
export type RenderableSource = 'canvas' | 'descriptor' | 'approval' | 'fallback' | 'profile' | 'browser' | 'artifact' | 'delegate' | 'files';

/**
 * What draws a panel.
 *
 * Every `RendererName` is a shape a *plugin* may ask for through a view
 * descriptor. `profile`, `browser` and `artifact` are deliberately not among
 * them: they are the platform's own panels — its configuration, its live
 * browser session, a file the owner attached — and adding them to the renderer
 * registry would let an agent draw a convincing properties panel, or a file
 * that was never sent, out of `canvas.show` with data it made up. `delegate`
 * is the same kind of thing: it draws another conversation of the owner's,
 * read from the server by id, and an agent must not be able to conjure one.
 * So is `files`: the owner's view of the agent's workspace, added by the page.
 */
export type PanelName = RendererName | 'profile' | 'browser' | 'artifact' | 'delegate' | 'files';

/** One thing the canvas can show: a tab and a panel. */
export interface Renderable {
  /** Stable across refreshes — the tool-use id it came from. */
  id: string;
  tool: string;
  title: string;
  renderer: PanelName;
  props: unknown;
  at: string | null;
  tone?: Tone;
  source: RenderableSource;
  /**
   * Held on the strip whatever else arrives, and never pushed into the
   * overflow. The page sets it on platform state that is *happening now* — a
   * browser session an agent is driving — and clears it the moment that state
   * becomes history. A tool result can never ask for it.
   */
  pinned?: boolean;
  /**
   * Whether this has something worth looking at — rows, points, figures, a
   * document. A result with nothing to draw still gets a tab; it just does not
   * take the canvas away from what is already on it.
   */
  substantial: boolean;
}
