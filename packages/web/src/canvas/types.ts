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
  | 'envelope'
  | 'structured';

export type ValueRef = { path: string } | { const: string | number | boolean | null };

export type Unit = 'number' | 'currency' | 'percent' | 'text' | 'date';

export type Tone = 'good' | 'warning' | 'critical' | 'neutral';

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

export type ViewMap =
  | TimeseriesMap
  | TableMap
  | BarsMap
  | KeyValueMap
  | DocumentMap
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
export type RenderableSource = 'canvas' | 'descriptor' | 'approval' | 'fallback' | 'profile' | 'browser' | 'artifact';

/**
 * What draws a panel.
 *
 * Every `RendererName` is a shape a *plugin* may ask for through a view
 * descriptor. `profile`, `browser` and `artifact` are deliberately not among
 * them: they are the platform's own panels — its configuration, its live
 * browser session, a file the owner attached — and adding them to the renderer
 * registry would let an agent draw a convincing properties panel, or a file
 * that was never sent, out of `canvas.show` with data it made up.
 */
export type PanelName = RendererName | 'profile' | 'browser' | 'artifact';

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
   * Whether this has something worth looking at — rows, points, figures, a
   * document. A result with nothing to draw still gets a tab; it just does not
   * take the canvas away from what is already on it.
   */
  substantial: boolean;
}
