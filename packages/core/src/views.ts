/**
 * View descriptors — the fifth thing a plugin may contribute.
 *
 * A plugin knows what its tool output *means*; the dashboard knows how to draw
 * a line, a table, a bar. Neither should know the other. A view descriptor is
 * the join: it says "when `weather.forecast` comes back, draw it as a
 * timeseries, taking the points from `days`, x from `date`, y from `highC`".
 *
 * Two rules make this worth having rather than just shipping a chart per
 * plugin:
 *
 *  1. **The mapping is data, not a function.** It is serialised to JSON and
 *     handed to the browser over `GET /api/chat/views`. No plugin code runs in
 *     the page, no build step changes when a plugin is installed, and an
 *     installation with no finance plugin ships no finance code.
 *
 *  2. **The renderers are generic.** `timeseries`, `table`, `bars`,
 *     `keyvalue`, `document`, `envelope`, `structured` — shapes, not domains.
 *     Nothing in the web package is allowed to know the word "cashflow".
 *
 * A plugin with no descriptors is the normal case: its tool results fall back
 * to `structured`, which is a readable view of the JSON rather than a dump.
 */

/** The renderers the dashboard ships. Shapes, never domains. */
export type RendererName =
  | 'timeseries'
  | 'table'
  | 'bars'
  | 'keyvalue'
  | 'document'
  | 'envelope'
  | 'structured';

/**
 * A value, resolved against the tool's output.
 *
 * `{ path }` reads it out — dots and `[0]` indexes, `''` or `'$'` meaning the
 * whole output. `{ const }` is a literal, which is how a descriptor pins a
 * currency or a threshold the output does not carry.
 */
export type ValueRef = { path: string } | { const: string | number | boolean | null };

/** How a number should read. Not a unit system — just the shape of the digits. */
export type Unit = 'number' | 'currency' | 'percent' | 'text' | 'date';

/**
 * Semantic state. `accent` is the odd one out and earns its place: a draft
 * waiting on the owner is not good, bad or neutral — it is *the thing on this
 * screen*, and the dashboard already has one colour that means exactly that.
 */
export type Tone = 'good' | 'warning' | 'critical' | 'neutral' | 'accent';

/** A horizontal rule on a chart: a floor, a target, a limit. */
export interface ReferenceLine {
  value: ValueRef;
  label: string;
  tone?: Tone;
}

/** Points, and what to say about them. */
export interface TimeseriesMap {
  /** Path to the array of points. */
  points: string;
  /** Paths *within* one point. */
  x: string;
  y: string;
  unit?: Unit;
  /** Currency code when `unit` is `currency`. */
  currency?: ValueRef;
  label?: ValueRef;
  referenceLines?: ReferenceLine[];
  /** Mark the lowest or highest point — the one the owner is looking for. */
  mark?: 'min' | 'max';
  /** Shade every point that falls below this value. Usually the floor. */
  shadeBelow?: ValueRef;
  /**
   * The things that happened on those days, listed beside the chart. `at` and
   * `label` are paths within one event; `parent` is the path from a point to
   * its own events, used when the events hang off the points themselves.
   */
  events?: { path?: string; parent?: string; at: string; label: string; amount?: string };
}

export type ColumnType = 'text' | 'number' | 'currency' | 'date' | 'percent';

export interface ColumnMap {
  /** Path within one row. */
  key: string;
  label: string;
  type?: ColumnType;
  currency?: ValueRef;
  /**
   * Draw this column as a bar as well as a number: state visible in form, not
   * only in digits. `max` is the full-scale value; thresholds colour it.
   */
  bar?: {
    max: ValueRef;
    thresholds?: Array<{ atLeast: number; tone: Tone }>;
  };
  /**
   * Draw this cell as a pill rather than as text — a state, not a number.
   * `tone` may be a path within the row, so a row that already says
   * `"critical"` colours itself and the descriptor lists nothing.
   */
  pill?: { tone?: Tone | ValueRef };
}

export interface TableMap {
  rows: string;
  columns: ColumnMap[];
  /** Figures above the table: totals, counts, what changed. */
  summary?: Array<{ label: string; value: ValueRef; unit?: Unit; currency?: ValueRef; tone?: Tone }>;
  /** Split the rows into named groups by a boolean or string field. */
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
  /** Either an explicit list… */
  pairs?: Array<{ label: string; value: ValueRef; unit?: Unit; currency?: ValueRef; tone?: Tone }>;
  /** …or every entry of the object at this path. */
  from?: string;
}

export interface DocumentMap {
  /** `text` (default), `image` or `pdf`. */
  kind?: ValueRef;
  /** Path to the body, for `text`. */
  text?: string;
  /** Path to a **same-origin** URL, for `image` and `pdf`. */
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

/** One tool, one way of drawing it. */
export interface ViewDescriptor {
  /** The tool whose result this describes, e.g. `weather.forecast`. */
  tool: string;
  renderer: RendererName;
  /** Heading for the canvas tab and panel. Defaults to the tool name. */
  title?: string;
  map: ViewMap;
}

/* ------------------------------------------------------------------ *
 * Validation
 *
 * A descriptor is data that crosses a process boundary and is then read by
 * code that cannot check it — the browser draws whatever it is handed. So it
 * is validated where it enters the system: `ToolRegistry.register` parses every
 * descriptor a manifest carries, and a plugin with a bad one fails to load.
 * A typo is a startup error naming the plugin, the tool and the field, rather
 * than an empty panel nobody can explain.
 * ------------------------------------------------------------------ */
import { z } from 'zod';

/**
 * A path into a tool's output: dotted field names with optional `[n]` indexes.
 * `''` and `'$'` both mean the whole output.
 *
 * Deliberately not an expression language. A descriptor that needs arithmetic
 * is a descriptor whose *tool* should be returning the number.
 */
export const VIEW_PATH = /^(|\$|[A-Za-z_][A-Za-z0-9_]*(\[\d+\])*(\.[A-Za-z_][A-Za-z0-9_]*(\[\d+\])*)*)$/;

/**
 * Exported because `pages.ts` builds on the same grammar: a page descriptor's
 * paths are view paths, and a second definition would be a second thing to
 * keep in step.
 */
export const viewPathSchema = z
  .string()
  .max(200)
  .regex(VIEW_PATH, 'a view path is dotted field names with optional [n] indexes, or "$"');

export const valueRefSchema = z.union([
  z.object({ path: viewPathSchema }).strict(),
  z.object({ const: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict(),
]);

export const unitSchema = z.enum(['number', 'currency', 'percent', 'text', 'date']);
export const toneSchema = z.enum(['good', 'warning', 'critical', 'neutral', 'accent']);
const columnTypeSchema = z.enum(['text', 'number', 'currency', 'date', 'percent']);

const referenceLineSchema = z
  .object({ value: valueRefSchema, label: z.string().min(1), tone: toneSchema.optional() })
  .strict();

const timeseriesMapSchema = z
  .object({
    points: viewPathSchema,
    x: viewPathSchema,
    y: viewPathSchema,
    unit: unitSchema.optional(),
    currency: valueRefSchema.optional(),
    label: valueRefSchema.optional(),
    referenceLines: z.array(referenceLineSchema).max(6).optional(),
    mark: z.enum(['min', 'max']).optional(),
    shadeBelow: valueRefSchema.optional(),
    events: z
      .object({
        path: viewPathSchema.optional(),
        parent: viewPathSchema.optional(),
        at: viewPathSchema,
        label: viewPathSchema,
        amount: viewPathSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const columnMapSchema = z
  .object({
    key: viewPathSchema,
    label: z.string().min(1),
    type: columnTypeSchema.optional(),
    currency: valueRefSchema.optional(),
    bar: z
      .object({
        max: valueRefSchema,
        thresholds: z
          .array(z.object({ atLeast: z.number(), tone: toneSchema }).strict())
          .max(6)
          .optional(),
      })
      .strict()
      .optional(),
    pill: z.object({ tone: z.union([toneSchema, valueRefSchema]).optional() }).strict().optional(),
  })
  .strict();

const summaryFigureSchema = z
  .object({
    label: z.string().min(1),
    value: valueRefSchema,
    unit: unitSchema.optional(),
    currency: valueRefSchema.optional(),
    tone: toneSchema.optional(),
  })
  .strict();

const tableMapSchema = z
  .object({
    rows: viewPathSchema,
    columns: z.array(columnMapSchema).min(1).max(24),
    summary: z.array(summaryFigureSchema).max(12).optional(),
    groupBy: z
      .object({ key: viewPathSchema, labels: z.record(z.string()).optional() })
      .strict()
      .optional(),
    empty: z.string().optional(),
  })
  .strict();

const barsMapSchema = z
  .object({
    bars: viewPathSchema,
    category: viewPathSchema,
    value: viewPathSchema,
    unit: unitSchema.optional(),
    currency: valueRefSchema.optional(),
  })
  .strict();

const keyValueMapSchema = z
  .object({
    pairs: z.array(summaryFigureSchema).max(24).optional(),
    from: viewPathSchema.optional(),
  })
  .strict()
  .refine(
    (map) => map.pairs !== undefined || map.from !== undefined,
    'a keyvalue view needs either `pairs` or `from`',
  );

const documentMapSchema = z
  .object({
    kind: valueRefSchema.optional(),
    text: viewPathSchema.optional(),
    src: viewPathSchema.optional(),
    title: valueRefSchema.optional(),
    metadata: z
      .array(
        z
          .object({ label: z.string().min(1), value: valueRefSchema, unit: unitSchema.optional() })
          .strict(),
      )
      .max(12)
      .optional(),
  })
  .strict()
  .refine(
    (map) => map.text !== undefined || map.src !== undefined,
    'a document view needs either `text` or `src`',
  );

/** The two renderers that need no mapping: they read the output as it stands. */
const emptyMapSchema = z.object({}).strict();

const TOOL_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

const common = {
  tool: z.string().regex(TOOL_NAME, 'a tool name is `plugin.tool`, lower case'),
  title: z.string().min(1).max(60).optional(),
};

/**
 * One descriptor. A discriminated union on `renderer`, so the map is checked
 * against the renderer that will actually draw it — the whole point of
 * validating here rather than in the page.
 */
export const viewDescriptorSchema = z.discriminatedUnion('renderer', [
  z.object({ ...common, renderer: z.literal('timeseries'), map: timeseriesMapSchema }).strict(),
  z.object({ ...common, renderer: z.literal('table'), map: tableMapSchema }).strict(),
  z.object({ ...common, renderer: z.literal('bars'), map: barsMapSchema }).strict(),
  z.object({ ...common, renderer: z.literal('keyvalue'), map: keyValueMapSchema }).strict(),
  z.object({ ...common, renderer: z.literal('document'), map: documentMapSchema }).strict(),
  z.object({ ...common, renderer: z.literal('envelope'), map: emptyMapSchema }).strict(),
  z.object({ ...common, renderer: z.literal('structured'), map: emptyMapSchema }).strict(),
]);

/**
 * Validate a manifest's descriptors, or throw naming the plugin and the tool.
 *
 * `tools` is the set of names the same manifest ships: a descriptor for a tool
 * the plugin does not contribute is a defect — most often a rename that missed
 * this file — and it is caught at load rather than showing up as a panel that
 * never appears.
 */
export function parseViewDescriptors(
  views: readonly unknown[],
  opts: { plugin: string; tools?: readonly string[] },
): ViewDescriptor[] {
  const known = opts.tools ? new Set(opts.tools) : undefined;
  return views.map((raw, index) => {
    const parsed = viewDescriptorSchema.safeParse(raw);
    if (!parsed.success) {
      const where = (raw as { tool?: unknown } | null)?.tool;
      const named = typeof where === 'string' ? ` for ${where}` : ` at index ${index}`;
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`plugin ${opts.plugin}: invalid view descriptor${named} — ${detail}`);
    }
    if (known && !known.has(parsed.data.tool)) {
      throw new Error(
        `plugin ${opts.plugin}: view descriptor names ${parsed.data.tool}, which this plugin does not contribute`,
      );
    }
    return parsed.data as ViewDescriptor;
  });
}
